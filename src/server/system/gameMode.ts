/**
 * Game mode (07 D3, spike S8): `performance.gameMode` 'on' forces it, 'off' disables it, 'auto' (default) follows the
 * system-state host (Windows only). Rule from §F S8:
 *   on  ⇔ QUNS 3 (D3D full screen) or 2 (busy), or (the foreground window covers its monitor AND has no WS_CAPTION
 *         AND is not the desktop/taskbar) — and the foreground window is not Vesper itself (any rule; e.g. Vesper's own
 *         full-screen window reports QUNS 2).
 * A detected change must hold for two polls (`debounceMs`, one poll interval plus slack) before it counts, so an
 * alt-tab blink or a full-screen video player opened for a second does not flap the state. The host prints only
 * changes, so "two polls" = "no contrary line within one interval". Effects are applied by the owner (system/index.ts)
 * through `onChange`.
 */
import type { GameModeReason } from '@shared/ws'
import type { Log } from '../services'
import type { SysState, SysStateHost } from './sysstateHost'

export type GameModeSetting = 'auto' | 'on' | 'off'

export interface GameModeState {
  active: boolean
  reason: GameModeReason
}

export const GAME_MODE_OFF: GameModeState = { active: false, reason: 'off' }

/** Pure rule (unit-tested): what one probe says. */
export function classify(s: SysState | null, selfPids: ReadonlySet<number>): GameModeState {
  if (!s || !s.fg || selfPids.has(s.pid)) return GAME_MODE_OFF
  if (s.quns === 3) return { active: true, reason: 'd3d' }
  if (s.quns === 2) return { active: true, reason: 'busy' }
  if (s.covers && !s.caption && !s.shell) return { active: true, reason: 'fullscreen' }
  return GAME_MODE_OFF
}

export interface GameModeDeps {
  log: Log
  setting(): GameModeSetting
  /** The host, or null where detection can't run (not Windows, test runs without VESPER_SYSSTATE). */
  host: SysStateHost | null
  /** Vesper's own process ids (its window must never count as a game). */
  selfPids(): ReadonlySet<number>
  onChange(next: GameModeState, prev: GameModeState): void
  /** Default: one poll interval (5 s) + 1 s slack. */
  debounceMs?: number
  /** Auto mode starts the host this long after start() (startup stays light, 07 D2). Default 10 s. */
  startDelayMs?: number
}

export class GameModeController {
  private current: GameModeState = GAME_MODE_OFF
  private pending: GameModeState | null = null
  private pendingTimer: NodeJS.Timeout | null = null
  private startTimer: NodeJS.Timeout | null = null
  private closed = false
  private readonly debounceMs: number
  private readonly startDelayMs: number

  constructor(private readonly d: GameModeDeps) {
    this.debounceMs = d.debounceMs ?? 6000
    this.startDelayMs = d.startDelayMs ?? 10_000
  }

  get state(): GameModeState {
    return this.current
  }

  /** Apply the current setting (call at start and whenever `performance.gameMode` changes). */
  apply(): void {
    if (this.closed) return
    const mode = this.d.setting()
    if (mode === 'auto') {
      this.clearPending()
      // Detection keeps whatever it last committed; a forced state from 'on' ends now and detection re-evaluates.
      if (this.current.reason === 'forced') this.commit(GAME_MODE_OFF)
      const host = this.d.host
      if (!host) return
      if (host.running) {
        this.consider(classify(host.last, this.d.selfPids()))
        host.probe()
      } else if (!this.startTimer) {
        host.reset()
        this.startTimer = setTimeout(() => {
          this.startTimer = null
          if (!this.closed && this.d.setting() === 'auto') host.start()
        }, this.startDelayMs)
        this.startTimer.unref()
      }
      return
    }
    this.stopDetection()
    this.commit(mode === 'on' ? { active: true, reason: 'forced' } : GAME_MODE_OFF)
  }

  /** A state line from the host. */
  onHostState(s: SysState): void {
    if (this.closed || this.d.setting() !== 'auto') return
    this.consider(classify(s, this.d.selfPids()))
  }

  /** The host gave up: detection reads "off". */
  onHostFailed(): void {
    if (this.d.setting() === 'auto') {
      this.clearPending()
      this.commit(GAME_MODE_OFF)
    }
  }

  private consider(next: GameModeState): void {
    if (same(next, this.current)) {
      this.clearPending()
      return
    }
    if (this.pending && same(next, this.pending)) return
    this.clearPending()
    this.pending = next
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const p = this.pending
      this.pending = null
      if (p && !this.closed && this.d.setting() === 'auto') this.commit(p)
    }, this.debounceMs)
    this.pendingTimer.unref()
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pending = null
  }

  private commit(next: GameModeState): void {
    if (same(next, this.current)) return
    const prev = this.current
    this.current = next
    this.d.log.info('game mode', { active: next.active, reason: next.reason })
    try {
      this.d.onChange(next, prev)
    } catch (e) {
      this.d.log.warn('game mode effects failed', { error: e })
    }
  }

  private stopDetection(): void {
    this.clearPending()
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    // Also cancels a pending restart of a crashed host.
    if (this.d.host) void this.d.host.stop()
  }

  /** Timers owned here (leak checks). */
  timers(): { pending: boolean; start: boolean } {
    return { pending: this.pendingTimer !== null, start: this.startTimer !== null }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearPending()
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    await this.d.host?.stop()
  }
}

function same(a: GameModeState, b: GameModeState): boolean {
  return a.active === b.active && a.reason === b.reason
}
