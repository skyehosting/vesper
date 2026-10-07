/**
 * The one frame scheduler for the presence surface (07 D4). The canvas runs with `frameloop="never"`; this loop decides
 * when to draw (schedule.logic.ts) and calls the active renderer. When the budget is 0 the requestAnimationFrame loop
 * is cancelled outright — at rest, hidden, unfocused-idle or paused the page spends no frames and polls no analyser.
 *
 * Owner: <PresenceHost> (created on mount, disposed on unmount). Listeners: visibilitychange, window focus/blur, one
 * IntersectionObserver on the host element — all removed by dispose().
 */
import type { StarState, StarStyle } from '../../../lib/store/presence'
import { frameBudget, PaceWatch, shouldDraw, type FrameBudget, type ScheduleInput, type SurfaceMode } from '../schedule.logic'

/** What a renderer gets each drawn frame. `dt` is clamped (a frame after a long rest is not a 30 s jump). */
export interface FrameInfo {
  now: number
  dt: number
  poll: boolean
  /** Frames drawn since the scheduler started. */
  index: number
}

export type Renderer = (frame: FrameInfo) => void

export interface SchedulerInputs {
  style: StarStyle
  mode: SurfaceMode
  state: StarState
  paused: boolean
  gameMode: boolean
  reducedMotion: boolean
  maxFps: number
  pauseWhenUnfocused: boolean
  canDraw: boolean
}

export interface SchedulerStats {
  /** Frames handed to a renderer. */
  frames: number
  /** requestAnimationFrame callbacks (drawn or skipped by the throttle). */
  callbacks: number
  /** Frames drawn with analyser polling. */
  polls: number
  running: boolean
  budget: FrameBudget
}

const CALM: ReadonlySet<StarState> = new Set<StarState>(['idle', 'muted', 'error', 'offline'])
const MAX_DT = 0.1

export class FrameScheduler {
  readonly frame: FrameInfo = { now: 0, dt: 0, poll: false, index: 0 }
  private renderer: Renderer | null = null
  private inputs: SchedulerInputs = {
    style: 'orb',
    mode: 'none',
    state: 'idle',
    paused: false,
    gameMode: false,
    reducedMotion: false,
    maxFps: 60,
    pauseWhenUnfocused: true,
    canDraw: false
  }
  private visible = typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  private focused = typeof document === 'undefined' ? true : document.hasFocus()
  private focusOverride: boolean | null = null
  private onScreen = false
  private calmSince = performance.now()
  private transitionUntil = 0
  private interactUntil = 0
  private pulseUntil = 0
  private raf = 0
  private last = 0
  private lastDrawn = 0
  private pendingOne = false
  /** True while tick() runs the renderer: re-entrant kick/interact/pulse/requestFrame must not start a 2nd chain. */
  private inTick = false
  private disposed = false
  private io: IntersectionObserver | null = null
  private observed: Element | null = null
  private budget: FrameBudget = { fps: 0, poll: false, reason: 'init' }
  private readonly listeners = new Set<(b: FrameBudget) => void>()
  private readonly struggleListeners = new Set<() => void>()
  private readonly pace = new PaceWatch()
  /** Adaptive quality is off in test mode unless a spec turns it on (software WebGL is always "slow"). */
  watchPace = true
  readonly stats: SchedulerStats = { frames: 0, callbacks: 0, polls: 0, running: false, budget: this.budget }

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('blur', this.onFocus)
  }

  /** The renderer that draws frames (the GL bridge or the 2D star); null parks the loop. */
  setRenderer(r: Renderer | null): void {
    this.renderer = r
    if (r) this.requestFrame()
    this.evaluate()
  }

  /** Drop `r` if it is still the renderer (a surface that hides must not unhook the one that replaced it). */
  releaseRenderer(r: Renderer): void {
    if (this.renderer === r) this.setRenderer(null)
  }

  update(patch: Partial<SchedulerInputs>): void {
    const prev = this.inputs
    const next = { ...prev, ...patch }
    this.inputs = next
    const now = performance.now()
    if (next.state !== prev.state) {
      if (CALM.has(next.state) && !CALM.has(prev.state)) this.calmSince = now
      this.kick(600)
    }
    if (next.mode !== prev.mode || next.style !== prev.style) {
      this.calmSince = now
      this.kick(700)
    }
    if (next.paused !== prev.paused || next.gameMode !== prev.gameMode || next.reducedMotion !== prev.reducedMotion) this.requestFrame()
    this.evaluate()
  }

  /** A visual crossfade runs for `ms` (state change, stage move, theme/accent change). */
  kick(ms: number): void {
    this.transitionUntil = Math.max(this.transitionUntil, performance.now() + ms)
    this.evaluate()
  }

  /** Constellation: the user is interacting (or the camera eases) for `ms`; also restarts the idle drift window. */
  interact(ms = 400): void {
    const now = performance.now()
    this.interactUntil = Math.max(this.interactUntil, now + ms)
    this.calmSince = now
    this.evaluate()
  }

  /** Constellation: a recall pulse animates for `ms`. */
  pulse(ms: number): void {
    this.pulseUntil = Math.max(this.pulseUntil, performance.now() + ms)
    this.evaluate()
  }

  /** Draw one frame soon even at a 0 budget (resize, move, context restored) — if anyone can see it. */
  requestFrame(): void {
    if (this.disposed) return
    this.pendingOne = true
    this.ensureLoop()
  }

  /** Watch the surface element for off-screen / zero size (07 D4). */
  observe(el: Element | null): void {
    if (el === this.observed) return
    this.io?.disconnect()
    this.io = null
    this.observed = el
    if (!el || typeof IntersectionObserver === 'undefined') {
      this.onScreen = !!el
      this.evaluate()
      return
    }
    this.io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1]
      const visible = !!e && e.isIntersecting && e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0
      if (visible !== this.onScreen) {
        this.onScreen = visible
        if (visible) this.requestFrame()
        this.evaluate()
      }
    })
    this.io.observe(el)
  }

  /** The GPU can't keep the requested rate (PaceWatch): step the quality down. */
  onStruggle(cb: () => void): () => void {
    this.struggleListeners.add(cb)
    return () => void this.struggleListeners.delete(cb)
  }

  onBudget(cb: (b: FrameBudget) => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /** Test builds: pretend the window is (un)focused — e2e windows never take focus. null = real focus. */
  setFocusOverride(v: boolean | null): void {
    this.focusOverride = v
    this.evaluate()
  }

  current(): FrameBudget {
    return this.budget
  }

  input(): Readonly<SchedulerInputs> {
    return this.inputs
  }

  resetStats(): void {
    this.stats.frames = 0
    this.stats.callbacks = 0
    this.stats.polls = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.renderer = null
    this.io?.disconnect()
    this.io = null
    this.listeners.clear()
    this.struggleListeners.clear()
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('blur', this.onFocus)
    this.stats.running = false
  }

  private readonly onVisibility = (): void => {
    this.visible = document.visibilityState === 'visible'
    if (this.visible) this.requestFrame()
    this.evaluate()
  }

  private readonly onFocus = (): void => {
    this.focused = document.hasFocus()
    this.evaluate()
  }

  private scheduleInput(now: number): ScheduleInput {
    const i = this.inputs
    return {
      ...i,
      visible: this.visible,
      onScreen: this.onScreen,
      focused: this.focusOverride ?? this.focused,
      now,
      calmSince: this.calmSince,
      transitionUntil: this.transitionUntil,
      interactUntil: this.interactUntil,
      pulseUntil: this.pulseUntil
    }
  }

  private evaluate(): void {
    if (this.disposed) return
    const b = frameBudget(this.scheduleInput(performance.now()))
    this.setBudget(b)
    if (b.fps > 0 && this.renderer) this.ensureLoop()
  }

  private setBudget(b: FrameBudget): void {
    const changed = b.fps !== this.budget.fps || b.reason !== this.budget.reason || b.poll !== this.budget.poll
    this.budget = b
    this.stats.budget = b
    if (changed) for (const l of [...this.listeners]) l(b)
  }

  private ensureLoop(): void {
    // Inside a tick the end of tick() decides about the next frame (it re-reads the budget a renderer may have raised).
    if (this.raf || this.inTick || this.disposed || !this.renderer) return
    this.raf = requestAnimationFrame(this.tick)
    this.stats.running = true
  }

  private readonly tick = (t: number): void => {
    this.raf = 0
    this.stats.callbacks++
    const b = frameBudget(this.scheduleInput(t))
    this.setBudget(b)
    // A requested single frame draws only where it can be seen and drawn.
    const one = this.pendingOne && this.visible && this.onScreen && this.inputs.canDraw && this.inputs.mode !== 'none'
    this.pendingOne = false
    let draw = one
    if (!draw) {
      const next = shouldDraw(t, this.last, b.fps)
      if (next !== null) {
        this.last = next
        draw = true
      }
    } else {
      this.last = t
    }
    if (draw && this.renderer) {
      if (this.lastDrawn && this.watchPace && this.pace.sample(t - this.lastDrawn, b.fps)) for (const l of [...this.struggleListeners]) l()
      const dt = this.lastDrawn ? Math.min(MAX_DT, (t - this.lastDrawn) / 1000) : 1 / 60
      this.lastDrawn = t
      this.frame.now = t
      this.frame.dt = dt
      this.frame.poll = b.poll
      this.frame.index++
      this.stats.frames++
      if (b.poll) this.stats.polls++
      this.inTick = true
      try {
        this.renderer(this.frame)
      } finally {
        this.inTick = false
      }
    }
    // The renderer may have kicked a crossfade or asked for one more frame: use the budget as it is now.
    const after = this.budget
    if ((after.fps > 0 || this.pendingOne) && this.renderer && !this.disposed) {
      // Exactly one chain: a handle is never overwritten (07 D4, review F44).
      if (!this.raf) this.raf = requestAnimationFrame(this.tick)
      this.stats.running = true
    } else {
      this.stats.running = false
      // The next draw after a rest must not see the whole rest as one huge delta.
      this.lastDrawn = 0
      this.pace.reset()
    }
  }
}
