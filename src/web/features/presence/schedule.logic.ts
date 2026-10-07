/**
 * The Star frame budget (07 D4, D3, D9; pure). One function decides how many frames per second the single canvas (or
 * the 2D star) may draw right now, and whether the audio analysers may be polled:
 *
 *   hidden / minimized / off-screen / no surface   → 0, no polling
 *   user pause (07 D9)                             → 0 (Constellation still answers direct interaction)
 *   game mode (07 D3)                              → static: 0, ≤ 10 while speaking or listening
 *   speaking / listening / crossfade               → ≤ 60 (unfocused + pauseWhenUnfocused: ≤ 30)
 *   thinking-like states                           → ≤ 30 (unfocused: ≤ 15)
 *   idle                                           → ≤ 20 for 20 s, then REST at 0 (last frame kept)
 *   unfocused + idle (pauseWhenUnfocused)          → 0
 *   reduced motion                                 → ≤ 20, idle rests after the crossfade
 *   everything                                     → ≤ maxFps
 */
import type { StarState, StarStyle } from '../../lib/store/presence.logic'
import { isAudioState, isBusyState } from './state.logic'

export const IDLE_FPS = 20
export const IDLE_REST_AFTER_MS = 20_000
export const BUSY_FPS = 30
export const ACTIVE_FPS = 60
export const GAME_MODE_FPS = 10
export const REDUCED_FPS = 20

export type SurfaceMode = 'star' | 'constellation' | 'none'

export interface ScheduleInput {
  style: StarStyle
  /** What the surface shows: the Star, the Constellation map, or nothing (no target / canvas parked). */
  mode: SurfaceMode
  state: StarState
  /** document.visibilityState === 'visible' */
  visible: boolean
  /** The surface intersects the viewport and has a size. */
  onScreen: boolean
  focused: boolean
  pauseWhenUnfocused: boolean
  gameMode: boolean
  paused: boolean
  reducedMotion: boolean
  maxFps: number
  /** The renderer can draw (WebGL context present; always true for the 2D star). */
  canDraw: boolean
  now: number
  /** When the current calm state began (idle/muted/error/offline in star mode; last activity in constellation). */
  calmSince: number
  /** A crossfade (state change, move between stages, style or theme change) runs until this time. */
  transitionUntil: number
  /** Constellation: the user is dragging/zooming, or the camera is still easing, until this time. */
  interactUntil: number
  /** Constellation: a recalled-source pulse runs until this time. */
  pulseUntil: number
}

export interface FrameBudget {
  fps: number
  /** Read the audio LevelSources this frame. */
  poll: boolean
  /** Why (tests and the dev overlay). */
  reason: string
}

const ZERO = (reason: string): FrameBudget => ({ fps: 0, poll: false, reason })

export function frameBudget(i: ScheduleInput): FrameBudget {
  if (i.mode === 'none') return ZERO('no-surface')
  if (i.mode === 'star' && i.style === 'off') return ZERO('style-off')
  if (!i.canDraw) return ZERO('no-context')
  if (!i.visible) return ZERO('hidden')
  if (!i.onScreen) return ZERO('off-screen')
  const cap = (fps: number, reason: string, poll = false): FrameBudget => {
    const n = Math.min(fps, i.maxFps)
    return n > 0 ? { fps: n, poll, reason } : ZERO(reason)
  }
  const unfocused = !i.focused && i.pauseWhenUnfocused

  if (i.mode === 'constellation') {
    if (i.now < i.interactUntil) return cap(ACTIVE_FPS, 'interacting')
    if (i.paused) return ZERO('paused')
    if (i.gameMode) return ZERO('game-mode')
    if (i.now < i.transitionUntil) return cap(ACTIVE_FPS, 'transition')
    if (unfocused) return ZERO('unfocused')
    if (i.now < i.pulseUntil) return cap(BUSY_FPS, 'recall-pulse')
    if (i.reducedMotion) return ZERO('reduced-rest')
    if (i.now - i.calmSince < IDLE_REST_AFTER_MS) return cap(IDLE_FPS, 'drift')
    return ZERO('rest')
  }

  if (i.paused) return ZERO('paused')
  const audio = isAudioState(i.state)
  if (i.gameMode) return audio ? cap(GAME_MODE_FPS, 'game-mode-audio', true) : ZERO('game-mode')
  if (i.reducedMotion) {
    if (audio) return cap(REDUCED_FPS, 'reduced-audio', true)
    if (i.now < i.transitionUntil) return cap(REDUCED_FPS, 'reduced-transition')
    if (isBusyState(i.state)) return cap(10, 'reduced-busy')
    return ZERO('reduced-rest')
  }
  if (audio) return cap(unfocused ? 30 : ACTIVE_FPS, unfocused ? 'audio-unfocused' : 'audio', true)
  if (i.now < i.transitionUntil) return cap(ACTIVE_FPS, 'transition')
  if (isBusyState(i.state)) return cap(unfocused ? 15 : BUSY_FPS, unfocused ? 'busy-unfocused' : 'busy')
  if (unfocused) return ZERO('unfocused')
  if (i.now - i.calmSince < IDLE_REST_AFTER_MS) return cap(IDLE_FPS, 'idle')
  return ZERO('rest')
}

/**
 * Throttle for a requestAnimationFrame loop: draw when at least one frame interval passed (with ~1 ms slack so a
 * 60 Hz display really gets 60). Returns the next `last` timestamp, or null to skip this callback.
 */
export function shouldDraw(now: number, last: number, fps: number): number | null {
  if (fps <= 0) return null
  const interval = 1000 / fps
  const since = now - last
  if (since < interval - 1.5) return null
  // Keep the cadence (no drift) unless we fell far behind.
  return since > interval * 2 ? now : last + interval
}

/**
 * Graceful on integrated GPUs (research 07 §2.6 "adaptive quality"): while the scheduler asks for ≥ 45 fps, watch
 * the frame intervals actually achieved. If they stay at well under two thirds of the target for ~2 s of frames, the
 * GPU can't keep up: report it once (the host steps the quality down: high → medium → low) and start over.
 */
export class PaceWatch {
  private ema = 0
  private samples = 0

  /** Feed one drawn frame's interval; true = step the quality down now. */
  sample(intervalMs: number, targetFps: number): boolean {
    if (targetFps < 45 || intervalMs <= 0 || intervalMs > 500) return false
    this.ema = this.samples === 0 ? intervalMs : this.ema + (intervalMs - this.ema) * 0.05
    this.samples++
    if (this.samples < 120) return false
    const struggling = this.ema > (1000 / targetFps) * 1.7
    if (struggling) this.reset()
    return struggling
  }

  reset(): void {
    this.ema = 0
    this.samples = 0
  }
}

/** One step down the quality ladder per report (never below low). */
export function degradeQuality(q: 'low' | 'medium' | 'high', steps: number): 'low' | 'medium' | 'high' {
  const ladder = ['high', 'medium', 'low'] as const
  return ladder[Math.min(2, ladder.indexOf(q) + Math.max(0, steps))]
}
