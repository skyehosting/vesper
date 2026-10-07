/**
 * The one AudioContext of the page (research 07 §2.5: browsers limit contexts, each costs an audio thread), shared by
 * the AudioEngine and MicCapture. Created lazily; resumed on a user gesture (`unlock`); owners `hold` it while they
 * need audio and `release` it after; with no holder for `idleMs` (30 s, 07 D4) it is suspended and resumed on the
 * next hold.
 */
import { count } from './counters'

export const IDLE_SUSPEND_MS = 30_000

/** The subset of AudioContext the core uses (a fake implements it in unit tests). */
export type AudioContextLike = AudioContext

export interface ContextHostOptions {
  create?: () => AudioContextLike
  idleMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
}

interface AudioSessionLike {
  type: string
}

function audioSession(): AudioSessionLike | null {
  // Safari 17+: without a session type the hardware silent switch mutes Web Audio (research 07 §2.5).
  const n = (typeof navigator === 'undefined' ? undefined : navigator) as (Navigator & { audioSession?: AudioSessionLike }) | undefined
  return n?.audioSession ?? null
}

export class ContextHost {
  private ctx: AudioContextLike | null = null
  private readonly holds = new Set<string>()
  private idleTimer: unknown = null
  private unlocked = false
  private idleMs: number
  private readonly create: () => AudioContextLike
  private readonly setT: (fn: () => void, ms: number) => unknown
  private readonly clearT: (t: unknown) => void
  private readonly stateListeners = new Set<() => void>()

  constructor(o: ContextHostOptions = {}) {
    this.create = o.create ?? (() => new AudioContext({ latencyHint: 'interactive' }))
    this.idleMs = o.idleMs ?? IDLE_SUSPEND_MS
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  /** The context if it exists (never creates). */
  peek(): AudioContextLike | null {
    return this.ctx
  }

  /** The context, created on first use (it starts suspended in browsers until a gesture resumes it). */
  get(): AudioContextLike {
    if (this.ctx) return this.ctx
    const s = audioSession()
    if (s && s.type === 'auto') s.type = 'playback'
    const ctx = this.create()
    count('contexts', 1)
    ctx.onstatechange = () => {
      for (const cb of [...this.stateListeners]) cb()
    }
    this.ctx = ctx
    return ctx
  }

  /** Called on `statechange` (running/suspended/interrupted/closed). Returns unsubscribe. */
  onState(cb: () => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  get isUnlocked(): boolean {
    return this.unlocked || this.ctx?.state === 'running'
  }

  /** Create/resume from a user gesture. Resolves true when audio can play. */
  async unlock(): Promise<boolean> {
    const ctx = this.get()
    if (ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch {
        return false
      }
    }
    // A resume() outside a gesture may resolve while the context stays suspended (autoplay policy).
    this.unlocked = ctx.state === 'running'
    if (this.unlocked && this.holds.size === 0) this.armIdle()
    return this.unlocked
  }

  /** `owner` needs the context running (playback, capture). Cancels the idle suspend and resumes if needed. */
  hold(owner: string): Promise<void> {
    this.holds.add(owner)
    this.disarmIdle()
    const ctx = this.get()
    if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      // Allowed without a new gesture once the page has had one (sticky activation); harmless otherwise.
      return ctx.resume().catch(() => undefined)
    }
    return Promise.resolve()
  }

  release(owner: string): void {
    if (!this.holds.delete(owner)) return
    if (this.holds.size === 0) this.armIdle()
  }

  isHeld(owner?: string): boolean {
    return owner ? this.holds.has(owner) : this.holds.size > 0
  }

  /** The idle-suspend timer is pending (it is one of the counted timers). */
  get idleArmed(): boolean {
    return this.idleTimer !== null
  }

  setIdleMs(ms: number): void {
    this.idleMs = ms
    if (this.idleTimer !== null) this.armIdle()
  }

  private armIdle(): void {
    this.disarmIdle()
    if (!this.ctx) return
    count('timers', 1)
    this.idleTimer = this.setT(() => {
      this.idleTimer = null
      count('timers', -1)
      const ctx = this.ctx
      if (ctx && this.holds.size === 0 && ctx.state === 'running') void ctx.suspend().catch(() => undefined)
    }, this.idleMs)
  }

  private disarmIdle(): void {
    if (this.idleTimer === null) return
    this.clearT(this.idleTimer)
    this.idleTimer = null
    count('timers', -1)
  }

  /** Close the context (page teardown, tests). Owners must have released their nodes first. */
  async close(): Promise<void> {
    this.disarmIdle()
    this.holds.clear()
    const ctx = this.ctx
    this.ctx = null
    this.unlocked = false
    if (!ctx) return
    ctx.onstatechange = null
    count('contexts', -1)
    await ctx.close().catch(() => undefined)
  }
}
