/**
 * Client of the system-state host (resources/sysstate.ps1, spike S8 in 07 §F): one hidden, READ-ONLY
 * `powershell.exe -File sysstate.ps1` that polls the foreground window and SHQueryUserNotificationState every 5 s and
 * prints a JSON line only when something changed. Same hygiene as the wintts host (07 D2/C19): started on demand,
 * restarted with backoff after a crash (≤ 3 starts per 5 minutes, then it stays off and game mode reads "off"),
 * stopped by closing its stdin (the script exits on EOF) and killed if it lingers. The runner is injectable so tests
 * drive crashes and states without Windows.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Log } from '../services'
import { isTestMode } from '../testMode'
import { defaultSpawn, type HostProcess, type HostSpawn } from '../providers/tts/winttsHost'

/** One probe of the foreground state (see the script header for the fields). */
export interface SysState {
  quns: number
  fg: boolean
  covers: boolean
  caption: boolean
  shell: boolean
  pid: number
  cls: string
}

export interface SysStateHostOptions {
  script: string
  log: Log
  onState(s: SysState): void
  /** The host gave up (restart budget used up). */
  onFailed?(): void
  spawn?: HostSpawn
  /** Poll interval passed to the script (default 5000 ms). */
  intervalMs?: number
  /** Delay before each restart after a crash, by attempt (default 1 s, 5 s, 30 s). */
  backoffMs?: readonly number[]
  maxStarts?: number
  startWindowMs?: number
  now?: () => number
}

/** resources/sysstate.ps1 (extraResources when packaged); test runs also look in the working tree. */
export function sysstateScript(resourcesDir: string): string {
  const shipped = path.join(resourcesDir, 'sysstate.ps1')
  if (fs.existsSync(shipped) || !isTestMode()) return shipped
  return path.resolve('resources', 'sysstate.ps1')
}

/** Parse one line of the host; null for anything that is not a well-formed state. */
export function parseStateLine(line: string): SysState | { ready: true; pid: number } | null {
  let m: unknown
  try {
    m = JSON.parse(line)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  if (o.t === 'ready') return { ready: true, pid: typeof o.pid === 'number' ? o.pid : 0 }
  if (o.t !== 'state') return null
  const b = (k: string) => o[k] === true
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0)
  return { quns: n('quns'), fg: b('fg'), covers: b('covers'), caption: b('caption'), shell: b('shell'), pid: n('pid'), cls: typeof o.cls === 'string' ? o.cls.slice(0, 256) : '' }
}

export class SysStateHost {
  private child: HostProcess | null = null
  private buf = ''
  private starts: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private wanted = false
  private failed = false
  private exits = new Map<HostProcess, Promise<void>>()
  /** Processes spawned so far (tests: restart budget, "one host"). */
  spawned = 0
  /** The newest state the host reported (null until the first line). */
  last: SysState | null = null
  private readonly o: Required<Omit<SysStateHostOptions, 'onFailed'>> & Pick<SysStateHostOptions, 'onFailed'>

  constructor(o: SysStateHostOptions) {
    this.o = { intervalMs: 5000, backoffMs: [1000, 5000, 30_000], maxStarts: 3, startWindowMs: 5 * 60_000, spawn: defaultSpawn, now: Date.now, ...o }
  }

  get running(): boolean {
    return this.child !== null
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get gaveUp(): boolean {
    return this.failed
  }

  stats(): { running: boolean; pid: number | undefined; spawned: number; restartTimer: boolean; exits: number } {
    return { running: this.running, pid: this.pid, spawned: this.spawned, restartTimer: this.restartTimer !== null, exits: this.exits.size }
  }

  /** Run the host (idempotent). A host that gave up stays off until `reset()`. */
  start(): void {
    this.wanted = true
    if (this.child || this.restartTimer || this.failed) return
    this.spawn()
  }

  /** Ask for a fresh state line now (the next poll would report it only if it changed). */
  probe(): void {
    this.child?.stdin.write('{"op":"probe"}\n')
  }

  /** Allow starts again after the host gave up (e.g. the owner switched game mode off and on). */
  reset(): void {
    this.failed = false
    this.starts = []
  }

  private spawn(): void {
    const now = this.o.now()
    this.starts = this.starts.filter((t) => now - t < this.o.startWindowMs)
    if (this.starts.length >= this.o.maxStarts) {
      this.failed = true
      this.o.log.warn('system-state host keeps failing; game-mode detection is off until restart')
      this.o.onFailed?.()
      return
    }
    this.starts.push(now)
    let child: HostProcess
    try {
      child = this.o.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.o.script, '-IntervalMs', String(this.o.intervalMs)])
    } catch (e) {
      this.o.log.warn('system-state host could not start', { error: e instanceof Error ? e.message : String(e) })
      this.scheduleRestart()
      return
    }
    this.spawned++
    this.child = child
    this.buf = ''
    let markExited!: () => void
    this.exits.set(
      child,
      new Promise<void>((r) => (markExited = r)).then(() => void this.exits.delete(child))
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(child, d))
    child.stderr.on('data', (d: string) => this.o.log.debug('sysstate stderr', { bytes: d.length }))
    // EPIPE after the host died must not become an unhandled stream error.
    child.stdin.on('error', (e) => this.o.log.debug('sysstate stdin', { error: e.message }))
    child.on('error', (e) => {
      this.o.log.warn('system-state host failed to run', { error: e.message })
      this.onExit(child, null)
      markExited()
    })
    child.on('exit', (code) => {
      this.onExit(child, code)
      markExited()
    })
  }

  private onData(child: HostProcess, d: string): void {
    if (child !== this.child) return
    this.buf += d
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      const m = parseStateLine(line)
      if (!m) {
        this.o.log.warn('system-state host wrote a malformed line')
        continue
      }
      if ('ready' in m) continue
      this.last = m
      this.o.onState(m)
    }
    if (this.buf.length > 64 * 1024) this.buf = '' // a broken host never grows memory without bound
  }

  private onExit(child: HostProcess, code: number | null): void {
    if (child !== this.child) return
    this.child = null
    this.buf = ''
    if (!this.wanted) return
    this.o.log.warn('system-state host exited', { code })
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.wanted) return
    const attempt = Math.max(0, this.starts.length - 1)
    const delay = this.o.backoffMs[Math.min(attempt, this.o.backoffMs.length - 1)] ?? 1000
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.wanted && !this.child) this.spawn()
    }, delay)
    this.restartTimer.unref()
  }

  /** Stop the host (stdin EOF; kill after 2 s). `start()` later spawns a fresh one. */
  async stop(): Promise<void> {
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.last = null
    if (!child) return
    this.child = null
    this.buf = ''
    try {
      child.stdin.end()
    } catch {
      /* closed */
    }
    const exited = this.exits.get(child) ?? Promise.resolve()
    let t: NodeJS.Timeout | null = null
    const timeout = new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), 2000)))
    if ((await Promise.race([exited.then(() => 'exited' as const), timeout])) === 'timeout') {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      let t2: NodeJS.Timeout | null = null
      await Promise.race([exited, new Promise((r) => (t2 = setTimeout(r, 2000)))])
      if (t2) clearTimeout(t2)
    }
    if (t) clearTimeout(t)
  }
}
