/**
 * System integration (platform-int): game mode (07 D3), resource use + "Unload voice models now" (07 D2), the fixed
 * open-folder set, and the global push-to-talk hotkey relay (07 D6). One instance per ServerContext, created by the
 * `system` WS handler module; `systemOf(ctx)` for routes and the Electron main process.
 *
 * Game-mode effects: `gamemode.changed` broadcast (+ Bootstrap.gameMode), embedding backfill paused
 * (memoryOf(ctx).setBackgroundPaused('game', on)), idle voice models unloaded (STT process, Windows voice host — now
 * and every minute while it lasts), desktop notifications held and delivered as one summary when it ends.
 *
 * Test switches (07 B10): VESPER_SYSSTATE=1 runs the real read-only host in a test run (default: no host in tests);
 * VESPER_SYSSTATE_INTERVAL_MS / VESPER_GAMEMODE_DEBOUNCE_MS / VESPER_GAMEMODE_START_MS shorten its timings.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { OpenFolderTarget, SystemProcessInfo, SystemResources, UnloadVoiceResult } from '@shared/api'
import { VesperError } from '@shared/errors'
import { WalWatch } from '../data/checkpoint'
import { memoryOf } from '../memory/service'
import { sttImpl } from '../providers/stt'
import type { HostSpawn } from '../providers/tts/winttsHost'
import type { ServerContext, WsClient } from '../services'
import { speechOf } from '../speech'
import { isTestMode, testEnv } from '../testMode'
import { GameModeController, type GameModeSetting, type GameModeState } from './gameMode'
import { HealthMonitor } from './health'
import { ReplyEvents } from './replies'
import { installNotifyGate, type NotifyGate } from './notifyGate'
import { SysStateHost, sysstateScript } from './sysstateHost'
import { UpdateRelay, updateActivity } from './updates'
import type { UpdateActivity } from '@shared/updater.logic'

/** 07 D2 budgets on the private working set. */
export const BUDGETS_MB = { trayOnly: 250, windowIdle: 550, withStt: 850 } as const
/** While game mode lasts, idle voice models are unloaded at this cadence. */
const GAME_UNLOAD_EVERY_MS = 60_000

export interface SystemTestDeps {
  /** A fake PowerShell runner for the host. */
  spawn?: HostSpawn
  /** Force the host on/off regardless of OS and test mode. */
  hostEnabled?: boolean
  intervalMs?: number
  debounceMs?: number
  startDelayMs?: number
  backoffMs?: number[]
  /** Free bytes per folder for the low-disk check (fix-platform F66). */
  freeSpace?: (dir: string) => Promise<number | null>
  /** How often the low-disk check runs. */
  healthEveryMs?: number
}

let testDeps: SystemTestDeps | null = null

/** Tests: deps for the next createSystem() (null resets). Test builds only. */
export function setSystemTestDeps(d: SystemTestDeps | null): void {
  if (__VESPER_TEST__) testDeps = d
}

function envMs(name: `VESPER_${string}`): number | undefined {
  const v = Number(testEnv(name))
  return Number.isFinite(v) && v >= 0 ? v : undefined
}

export class SystemServer {
  readonly gameMode: GameModeController
  readonly host: SysStateHost | null
  readonly notifications: NotifyGate
  /** WAL checkpoints through db.worker while it isn't running on its own (07 C9). */
  readonly wal: WalWatch
  /** What the owner must be told about: settings recovered, low disk, a failed backup (Bootstrap.health). */
  readonly health: HealthMonitor
  /** Reply notifications and diagnostic logging (07 B17/B10, F21). */
  readonly replies: ReplyEvents
  /** `update.state` broadcasts from the attached updater (H-v12-updates). */
  readonly updates: UpdateRelay
  private lastHotkeyClient: string | null = null
  private hotkeyDown = false
  private unloadTimer: NodeJS.Timeout | null = null
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly ctx: ServerContext) {
    const log = ctx.log.child('system')
    const deps = __VESPER_TEST__ ? testDeps : null
    const test = isTestMode()
    // Real detection only on Windows; test runs only when asked for (VESPER_SYSSTATE=1 or injected deps).
    const enabled = deps?.hostEnabled ?? (process.platform === 'win32' && (!test || testEnv('VESPER_SYSSTATE') === '1'))
    const intervalMs = deps?.intervalMs ?? envMs('VESPER_SYSSTATE_INTERVAL_MS') ?? 5000
    this.notifications = installNotifyGate(ctx.platform)
    // VESPER_FAKE_FREE_BYTES (tests): every drive reports that much free space (the low-disk path end to end).
    const fakeFree = __VESPER_TEST__ ? envMs('VESPER_FAKE_FREE_BYTES') : undefined
    this.health = new HealthMonitor(ctx, {
      freeSpace: deps?.freeSpace ?? (fakeFree !== undefined ? async () => fakeFree : undefined),
      everyMs: deps?.healthEveryMs ?? (__VESPER_TEST__ ? envMs('VESPER_HEALTH_INTERVAL_MS') : undefined)
    })
    this.health.start()
    this.replies = new ReplyEvents(ctx)
    this.updates = new UpdateRelay(ctx)
    this.host = enabled
      ? new SysStateHost({
          script: sysstateScript(ctx.platform.resourcesDir),
          log: log.child('sysstate'),
          spawn: deps?.spawn,
          intervalMs,
          ...(deps?.backoffMs ? { backoffMs: deps.backoffMs } : {}),
          onState: (s) => this.gameMode.onHostState(s),
          onFailed: () => this.gameMode.onHostFailed()
        })
      : null
    this.gameMode = new GameModeController({
      log,
      setting: () => this.setting(),
      host: this.host,
      selfPids: () => this.selfPids(),
      debounceMs: deps?.debounceMs ?? envMs('VESPER_GAMEMODE_DEBOUNCE_MS') ?? intervalMs + 1000,
      startDelayMs: deps?.startDelayMs ?? envMs('VESPER_GAMEMODE_START_MS'),
      onChange: (next) => this.onGameMode(next)
    })
    this.unsubscribe = ctx.settings.subscribe('performance', () => this.gameMode.apply())
    this.gameMode.apply()
    this.wal = new WalWatch({
      dbFile: path.join(ctx.paths.roaming, 'vesper.db'),
      log,
      checkpoint: async (mode) => {
        // F65 (like 07 H5's data jobs): with db.worker gone for good — or no memory service — the main connection
        // checkpoints itself; otherwise the WAL would grow without bound until a restart.
        let mem: ReturnType<typeof memoryOf> | null = null
        try {
          mem = memoryOf(ctx)
        } catch {
          mem = null
        }
        if (mem && !mem.link.dead) {
          try {
            await mem.runJob({ kind: 'checkpoint', mode })
            return
          } catch (e) {
            if (!mem.link.dead) throw e
          }
        }
        this.checkpointHere(mode)
      },
      idle: () => {
        for (const c of ctx.hub.clients()) if (c.state.visible && c.state.focused) return false
        return true
      }
    })
    this.wal.start()
  }

  private walFallbackLogged = false

  /**
   * WAL checkpoint on the main connection (db.worker is gone): PASSIVE never waits for writers; TRUNCATE runs only when
   * nobody is looking at Vesper (WalWatch decides), and db.worker — the only other writer — is not running.
   */
  private checkpointHere(mode: 'PASSIVE' | 'TRUNCATE'): void {
    if (!this.walFallbackLogged) {
      this.walFallbackLogged = true
      this.ctx.log.warn('database helper unavailable: WAL checkpoints run in the main process')
    }
    this.ctx.db.prepare(`PRAGMA wal_checkpoint(${mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE'})`).get()
  }

  private setting(): GameModeSetting {
    return this.ctx.settings.get().performance?.gameMode ?? 'auto'
  }

  /** Vesper's own processes: the main/server process and (desktop) every process of the app. */
  private selfPids(): Set<number> {
    const pids = new Set<number>([process.pid])
    try {
      for (const m of this.ctx.platform.metrics?.() ?? []) pids.add(m.pid)
    } catch {
      /* metrics are best effort */
    }
    return pids
  }

  private onGameMode(next: GameModeState): void {
    this.ctx.hub.broadcast({ t: 'gamemode.changed', active: next.active, reason: next.reason })
    try {
      memoryOf(this.ctx).setBackgroundPaused('game', next.active)
    } catch {
      /* memory not running in this context */
    }
    this.notifications.hold(next.active)
    if (this.unloadTimer) clearInterval(this.unloadTimer)
    this.unloadTimer = null
    if (next.active) {
      void this.unloadVoice({ onlyIdle: true })
      this.unloadTimer = setInterval(() => void this.unloadVoice({ onlyIdle: true }), GAME_UNLOAD_EVERY_MS)
      this.unloadTimer.unref()
    }
  }

  /**
   * Unload voice models (07 D2/D3): the STT process (only when no mic is open if `onlyIdle`) and the Windows voice
   * host (only when it is not speaking).
   */
  async unloadVoice(o: { onlyIdle: boolean }): Promise<UnloadVoiceResult> {
    let stt = false
    let wintts = false
    try {
      const s = sttImpl(this.ctx)
      if (s) {
        const st = await s.stats()
        if (st.alive && (!o.onlyIdle || st.mics === 0)) {
          await s.unload()
          stt = true
        }
      }
    } catch (e) {
      this.ctx.log.warn('unloading speech recognition failed', { error: e })
    }
    try {
      wintts = (await speechOf(this.ctx)?.providers.host()?.release()) ?? false
    } catch (e) {
      this.ctx.log.warn('stopping the Windows voice host failed', { error: e })
    }
    return { stt, wintts, clientHints: ['highlighter'] }
  }

  /** GET /api/system/resources (07 D2). */
  async resources(): Promise<SystemResources> {
    const processes: SystemProcessInfo[] = []
    const metrics = this.ctx.platform.metrics?.()
    let total = 0
    if (metrics?.length) {
      for (const m of metrics) {
        const privateMB = m.privateKB === null ? null : round1(m.privateKB / 1024)
        const memMB = privateMB ?? round1(m.workingSetKB / 1024)
        total += memMB
        processes.push({ name: processName(m.type, m.name), pid: m.pid, memMB, cpu: round1(m.cpuPercent), type: m.type, privateMB })
      }
    } else {
      const memMB = round1(process.memoryUsage().rss / 1048576)
      total = memMB
      processes.push({ name: 'Vesper server', pid: process.pid, memMB, cpu: this.serverCpu(), type: 'Server', privateMB: null })
    }
    let sttLoaded = false
    try {
      sttLoaded = (await sttImpl(this.ctx)?.stats())?.alive ?? false
    } catch {
      /* best effort */
    }
    return {
      processes,
      totalMB: round1(total),
      budgetsMB: { ...BUDGETS_MB },
      voice: { sttLoaded, winttsRunning: speechOf(this.ctx)?.providers.host()?.running ?? false },
      gameMode: { ...this.gameMode.state }
    }
  }

  private lastCpu = process.cpuUsage()
  private lastCpuAt = process.hrtime.bigint()

  /** The server process' CPU share since the previous call (standalone server). */
  private serverCpu(): number {
    const now = process.hrtime.bigint()
    const cpu = process.cpuUsage(this.lastCpu)
    const elapsedUs = Number(now - this.lastCpuAt) / 1000
    this.lastCpu = process.cpuUsage()
    this.lastCpuAt = now
    return elapsedUs > 0 ? round1(((cpu.user + cpu.system) / elapsedUs) * 100) : 0
  }

  /** The fixed folder for an open-folder target (never a client path). */
  folder(which: OpenFolderTarget): string {
    const p = this.ctx.paths
    switch (which) {
      case 'roaming':
      case 'data':
        return p.roaming
      case 'local':
        return p.local
      case 'backups':
        return p.backups
      case 'exports':
        return p.exports
      case 'logs':
        return p.logs
      case 'models':
        return p.models
    }
  }

  async openFolder(which: OpenFolderTarget): Promise<void> {
    const open = this.ctx.platform.openPath
    if (!open) throw new VesperError('not_implemented', { message: 'Opening folders needs the Vesper app on your PC.' })
    const dir = this.folder(which)
    fs.mkdirSync(dir, { recursive: true })
    const err = await open.call(this.ctx.platform, dir)
    if (err) {
      this.ctx.log.warn('open folder failed', { which, error: err })
      throw new VesperError('internal', { message: "Windows couldn't open that folder." })
    }
  }

  /**
   * The global push-to-talk hotkey was pressed (07 D6; from the main process). Goes to the focused desktop client,
   * else the one it last went to, else the newest desktop client. Presses toggle `down`. False when no desktop
   * client is connected (the press is dropped and the toggle resets).
   */
  hotkey(): boolean {
    const desktops: WsClient[] = []
    for (const c of this.ctx.hub.clients()) if (c.isDesktop) desktops.push(c)
    const target = desktops.find((c) => c.state.focused) ?? desktops.find((c) => c.id === this.lastHotkeyClient) ?? desktops[desktops.length - 1]
    if (!target) {
      this.hotkeyDown = false
      this.lastHotkeyClient = null
      return false
    }
    // A different client starts a fresh toggle (its mic is not open yet).
    if (target.id !== this.lastHotkeyClient) this.hotkeyDown = false
    this.hotkeyDown = !this.hotkeyDown
    this.lastHotkeyClient = target.id
    target.send({ t: 'hotkey.ptt', down: this.hotkeyDown })
    return true
  }

  /**
   * 07 B17 (F21): `fn` gets the devices streaming mic audio to this PC whenever that set changes (the tray's red dot),
   * once right away. Returns an unsubscribe. Nothing happens when speech recognition isn't set up in this context.
   */
  onMicActivity(fn: (devices: { id: string; name: string }[]) => void): () => void {
    const stt = sttImpl(this.ctx)
    if (!stt) return () => undefined
    const named = (ids: string[]) =>
      ids.map((id) => {
        for (const c of this.ctx.hub.clients()) if (c.device.id === id) return { id, name: c.device.name }
        return { id, name: 'A device' }
      })
    const off = stt.onMicActivity((ids) => fn(named(ids)))
    fn(named(stt.streamingDevices()))
    return off
  }

  /** What an unattended update restart would interrupt ('auto' mode, H-v12-updates). */
  updateActivity(): UpdateActivity {
    return updateActivity(this.ctx, this.gameMode.state.active)
  }

  /** Timers and listeners owned here (leak checks). */
  stats(): { unloadTimer: boolean; heldNotifications: number; gameModeTimers: { pending: boolean; start: boolean }; host: ReturnType<SysStateHost['stats']> | null } {
    return { unloadTimer: this.unloadTimer !== null, heldNotifications: this.notifications.held, gameModeTimers: this.gameMode.timers(), host: this.host?.stats() ?? null }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    if (this.unloadTimer) clearInterval(this.unloadTimer)
    this.unloadTimer = null
    this.health.close()
    this.replies.close()
    this.updates.close()
    await this.wal.close()
    await this.gameMode.close()
    this.notifications.close()
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Plain names for the Resource use panel. */
export function processName(type: string, name: string | null): string {
  if (type === 'Browser') return 'Vesper (app + server)'
  if (type === 'Tab') return 'Window'
  if (type === 'GPU') return 'Graphics'
  if (type === 'Utility') return name?.trim() || 'Helper'
  return name?.trim() || type
}

const systems = new WeakMap<ServerContext, SystemServer>()

export function systemOf(ctx: ServerContext): SystemServer | null {
  return systems.get(ctx) ?? null
}

export function createSystem(ctx: ServerContext): SystemServer {
  const s = new SystemServer(ctx)
  systems.set(ctx, s)
  ctx.onClose(() => s.close())
  return s
}
