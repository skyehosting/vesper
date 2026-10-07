/**
 * Supervisor of the STT utility process (07 C17, C19, D2): spawned lazily on the first need, loads one model, is
 * killed to unload (the only way native memory really goes back to the OS), and restarts after a crash with backoff —
 * at most 3 restarts in 5 minutes, then `stt_unavailable` until the window passes. Messages posted before the
 * process said `hello` are queued, so callers never race the spawn.
 */
import { VesperError } from '@shared/errors'
import type { WorkerHandle } from '../../platform'
import type { Log } from '../../services'
import type { FromProcess, LoadSpec, ProcessStats, ToProcess } from './protocol'

export type ProcessEvent = FromProcess | { t: 'exit'; code: number; expected: boolean }

export interface SttProcessDeps {
  fork(): WorkerHandle
  log: Log
  now(): number
  loadTimeoutMs?: number
  /** Backoff before restart number n (1-based) inside the crash window. */
  backoffMs?: readonly number[]
}

const CRASH_WINDOW_MS = 5 * 60_000
const MAX_CRASHES = 3
const DEFAULT_BACKOFF = [500, 2000, 5000] as const

interface Pending {
  key: string
  promise: Promise<void>
  resolve(): void
  reject(e: VesperError): void
  timer: NodeJS.Timeout
}

export class SttProcess {
  private h: WorkerHandle | null = null
  private ready = false
  private outbox: ToProcess[] = []
  private loadedKey: string | null = null
  private pending: Pending | null = null
  private expectExit = false
  private exitWaiters: (() => void)[] = []
  private crashes: number[] = []
  private readonly listeners = new Set<(e: ProcessEvent) => void>()
  private statsWaiters: ((s: ProcessStats | null) => void)[] = []
  private spawnedCount = 0
  private backoffTimer: NodeJS.Timeout | null = null
  private backoffResolve: (() => void) | null = null

  constructor(private readonly deps: SttProcessDeps) {}

  get alive(): boolean {
    return this.h !== null
  }

  get pid(): number | undefined {
    return this.h?.pid
  }

  get loaded(): string | null {
    return this.loadedKey
  }

  /** How many processes were started so far (leak tests: N mic sessions must not mean N processes). */
  get spawned(): number {
    return this.spawnedCount
  }

  onEvent(fn: (e: ProcessEvent) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** A process with `spec` loaded. A different spec replaces the process (a model switch frees the old model). */
  async load(spec: LoadSpec): Promise<void> {
    if (this.h && this.loadedKey === spec.key) return
    if (this.pending?.key === spec.key) return this.pending.promise
    if (this.h) await this.stop()
    await this.waitBackoff()
    if (this.pending?.key === spec.key) return this.pending.promise
    if (this.h && this.loadedKey === spec.key) return
    this.spawn()
    let resolve!: () => void
    let reject!: (e: VesperError) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(() => {
      this.deps.log.warn('stt model load timed out')
      this.failPending(new VesperError('stt_unavailable', { status: 503 }))
      this.kill()
    }, this.deps.loadTimeoutMs ?? 120_000)
    timer.unref?.()
    this.pending = { key: spec.key, promise, resolve, reject, timer }
    this.post({ t: 'load', spec })
    return promise
  }

  post(m: ToProcess): void {
    if (!this.h) return
    if (!this.ready) {
      this.outbox.push(m)
      return
    }
    try {
      this.h.postMessage(m)
    } catch (e) {
      this.deps.log.warn('stt post failed', { error: e })
    }
  }

  /** Ask the process for its counters (null when it is not running or does not answer within 2 s). */
  stats(): Promise<ProcessStats | null> {
    if (!this.h) return Promise.resolve(null)
    return new Promise((resolve) => {
      const done = (s: ProcessStats | null) => {
        clearTimeout(timer)
        this.statsWaiters = this.statsWaiters.filter((w) => w !== done)
        resolve(s)
      }
      const timer = setTimeout(() => done(null), 2000)
      this.statsWaiters.push(done)
      this.post({ t: 'stats' })
    })
  }

  /** Graceful unload: the process drops everything and exits; killed if it has not exited within 2 s. */
  async stop(): Promise<void> {
    const h = this.h
    if (!h) return
    this.expectExit = true
    this.failPending(new VesperError('stt_unavailable', { status: 503 }))
    const exited = new Promise<void>((r) => this.exitWaiters.push(r))
    this.post({ t: 'unload' })
    const timer = setTimeout(() => this.kill(), 2000)
    await exited
    clearTimeout(timer)
  }

  kill(): void {
    if (!this.h) return
    this.expectExit = true
    try {
      this.h.kill()
    } catch {
      /* already gone */
    }
  }

  /** Stop and forget timers (server shutdown). */
  async close(): Promise<void> {
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = null
    this.backoffResolve?.()
    this.backoffResolve = null
    await this.stop()
    this.listeners.clear()
  }

  private recentCrashes(): number {
    const now = this.deps.now()
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    return this.crashes.length
  }

  private async waitBackoff(): Promise<void> {
    const n = this.recentCrashes()
    if (n === 0) return
    if (n > MAX_CRASHES) throw new VesperError('stt_unavailable', { status: 503 })
    const table = this.deps.backoffMs ?? DEFAULT_BACKOFF
    const ms = table[Math.min(n, table.length) - 1] ?? 0
    const since = this.deps.now() - this.crashes[this.crashes.length - 1]
    const wait = ms - since
    if (wait <= 0) return
    await new Promise<void>((resolve) => {
      this.backoffResolve = resolve
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null
        this.backoffResolve = null
        resolve()
      }, wait)
    })
  }

  private spawn(): void {
    this.ready = false
    this.outbox = []
    this.loadedKey = null
    this.expectExit = false
    let h: WorkerHandle
    try {
      h = this.deps.fork()
    } catch (e) {
      this.deps.log.error('stt process failed to start', { error: e })
      throw new VesperError('stt_unavailable', { status: 503 })
    }
    this.h = h
    this.spawnedCount++
    h.on('message', (m) => this.onMessage(h, m))
    h.on('exit', (code) => this.onExit(h, code))
    this.deps.log.info('stt process started', { pid: h.pid })
  }

  private onMessage(h: WorkerHandle, raw: unknown): void {
    if (h !== this.h || typeof raw !== 'object' || raw === null) return
    const m = raw as FromProcess
    switch (m.t) {
      case 'hello': {
        this.ready = true
        const queued = this.outbox
        this.outbox = []
        for (const q of queued) this.post(q)
        return
      }
      case 'loaded':
        if (this.pending?.key === m.key) {
          this.loadedKey = m.key
          this.deps.log.info('stt model loaded', { ms: m.ms })
          const p = this.pending
          this.pending = null
          clearTimeout(p.timer)
          p.resolve()
        }
        break
      case 'loadError':
        if (this.pending?.key === m.key) {
          this.deps.log.warn('stt model failed to load', { code: m.code, detail: m.detail })
          this.failPending(new VesperError(m.code, { status: m.code === 'stt_model_missing' ? 409 : 503 }))
          // A process without a model is useless; let it go (and free whatever it holds).
          void this.stop()
        }
        break
      case 'stats':
        for (const w of [...this.statsWaiters]) w(m.stats)
        return
      case 'error':
        this.deps.log.warn('stt process error', { code: m.code, detail: m.detail })
        break
    }
    for (const fn of this.listeners) fn(m)
  }

  private failPending(e: VesperError): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    clearTimeout(p.timer)
    p.reject(e)
  }

  private onExit(h: WorkerHandle, code: number): void {
    if (h !== this.h) return
    const expected = this.expectExit
    this.h = null
    this.ready = false
    this.outbox = []
    this.loadedKey = null
    if (!expected) {
      this.crashes.push(this.deps.now())
      this.deps.log.warn('stt process exited unexpectedly', { code })
    } else this.deps.log.info('stt process stopped')
    this.failPending(new VesperError(expected ? 'stt_unavailable' : 'stt_crashed', { status: 503 }))
    for (const w of [...this.statsWaiters]) w(null)
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const w of waiters) w()
    for (const fn of this.listeners) fn({ t: 'exit', code, expected })
  }
}
