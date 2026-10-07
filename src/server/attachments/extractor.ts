/**
 * Supervisor of the extract process (07 B6, C19). One process, started on the first job, one job at a time; each job
 * gets `timeoutMs` (30 s) after which the process is killed and the job fails with 'timeout'. A crash fails the job
 * in flight with 'crashed'; the next job starts a fresh process (after a short backoff once more than 3 died within
 * 5 minutes). The process exits after `idleMs` without work (07 D2). Every timer and process has one owner here and
 * `close()` releases all of them.
 */
import fs from 'node:fs'
import type { Platform, WorkerHandle } from '../platform'
import type { Log } from '../services'

export type ExtractKind = 'pdf' | 'docx' | 'text'
export type ExtractFailure = 'timeout' | 'crashed' | 'archive_refused' | 'unreadable' | 'unsupported' | 'unavailable'
export type ExtractResult = { ok: true; text: string; truncated: boolean; extractor: string } | { ok: false; code: ExtractFailure }

export interface ExtractorOptions {
  /** Absolute path of the built extract.process.js. */
  script: string
  fork: Platform['forkWorker']
  log: Log
  timeoutMs?: number
  idleMs?: number
  maxQueue?: number
}

export interface ExtractLimits {
  maxChars: number
  maxPages: number
}

interface Job {
  id: number
  file: string
  kind: ExtractKind | `test:${string}`
  limits: ExtractLimits
  resolve(r: ExtractResult): void
}

interface Proc {
  handle: WorkerHandle
  exited: Promise<void>
  alive: boolean
}

const CRASH_WINDOW_MS = 5 * 60_000
const MEMORY_ARG = '--max-old-space-size=512'

export class ExtractorPool {
  private readonly timeoutMs: number
  private readonly idleMs: number
  private readonly maxQueue: number
  private readonly queue: Job[] = []
  private proc: Proc | null = null
  private active: Job | null = null
  private jobTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private backoffTimer: NodeJS.Timeout | null = null
  private crashes: number[] = []
  private nextId = 1
  private closed = false
  private missingLogged = false
  /** Counters for tests and the resource panel. */
  readonly counters = { spawned: 0, killed: 0, crashed: 0, timedOut: 0, completed: 0 }

  constructor(private readonly o: ExtractorOptions) {
    this.timeoutMs = o.timeoutMs ?? 30_000
    this.idleMs = o.idleMs ?? 60_000
    this.maxQueue = o.maxQueue ?? 64
  }

  /** Extract text from `file`; never rejects. */
  extract(file: string, kind: Job['kind'], limits: ExtractLimits): Promise<ExtractResult> {
    if (this.closed) return Promise.resolve({ ok: false, code: 'unavailable' })
    if (this.queue.length >= this.maxQueue) return Promise.resolve({ ok: false, code: 'unavailable' })
    if (!fs.existsSync(this.o.script)) {
      if (!this.missingLogged) this.o.log.error('extract process script missing', { script: this.o.script })
      this.missingLogged = true
      return Promise.resolve({ ok: false, code: 'unavailable' })
    }
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, file, kind, limits, resolve })
      this.pump()
    })
  }

  /** Is a process running right now (tests: back to none after idle/close)? */
  get running(): boolean {
    return this.proc !== null
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  private pump(): void {
    if (this.closed || this.active || this.backoffTimer || !this.queue.length) return
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const now = Date.now()
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    if (!this.proc && this.crashes.length > 3) {
      const wait = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 4))
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null
        this.pump()
      }, wait)
      this.backoffTimer.unref()
      return
    }
    const job = this.queue.shift() as Job
    let proc: Proc
    try {
      proc = this.proc ?? this.spawn()
    } catch (e) {
      this.o.log.error('could not start the extract process', { error: e })
      job.resolve({ ok: false, code: 'unavailable' })
      this.pump()
      return
    }
    this.active = job
    this.jobTimer = setTimeout(() => this.onTimeout(job), this.timeoutMs)
    this.jobTimer.unref()
    proc.handle.postMessage({ t: 'extract', id: job.id, file: job.file, kind: job.kind, maxChars: job.limits.maxChars, maxPages: job.limits.maxPages })
  }

  private spawn(): Proc {
    // 07 B6 heap cap: every Platform passes execArgv to the child (utilityProcess and node fork alike).
    const handle = this.o.fork(this.o.script, [], { name: 'extract', execArgv: [MEMORY_ARG] })
    this.counters.spawned++
    let onExit: () => void = () => undefined
    const exited = new Promise<void>((r) => (onExit = r))
    const proc: Proc = { handle, exited, alive: true }
    handle.on('message', (m) => this.onMessage(proc, m))
    handle.on('exit', (code) => {
      proc.alive = false
      onExit()
      this.onExit(proc, code)
    })
    this.proc = proc
    return proc
  }

  private finish(job: Job, r: ExtractResult): void {
    if (this.active !== job) return
    if (this.jobTimer) clearTimeout(this.jobTimer)
    this.jobTimer = null
    this.active = null
    if (r.ok) this.counters.completed++
    job.resolve(r)
    if (this.queue.length) this.pump()
    else this.armIdle()
  }

  private onMessage(proc: Proc, m: unknown): void {
    if (proc !== this.proc || typeof m !== 'object' || m === null) return
    const msg = m as { t?: string; id?: number; text?: unknown; truncated?: unknown; extractor?: unknown; code?: unknown }
    const job = this.active
    if (!job || msg.id !== job.id) return
    if (msg.t === 'done' && typeof msg.text === 'string') {
      this.finish(job, { ok: true, text: msg.text, truncated: msg.truncated === true, extractor: typeof msg.extractor === 'string' ? msg.extractor : 'unknown' })
    } else if (msg.t === 'failed') {
      const code = (['archive_refused', 'unreadable', 'unsupported'] as const).find((c) => c === msg.code) ?? 'unreadable'
      this.finish(job, { ok: false, code })
    }
  }

  private onExit(proc: Proc, code: number): void {
    if (proc !== this.proc) return
    this.proc = null
    const job = this.active
    if (job) {
      this.counters.crashed++
      this.crashes.push(Date.now())
      this.o.log.warn('extract process exited during a job', { code, kind: job.kind })
      this.finish(job, { ok: false, code: 'crashed' })
    }
  }

  private onTimeout(job: Job): void {
    if (this.active !== job) return
    this.counters.timedOut++
    this.crashes.push(Date.now())
    this.o.log.warn('extraction timed out; killing the extract process', { kind: job.kind })
    this.kill()
    this.finish(job, { ok: false, code: 'timeout' })
  }

  private armIdle(): void {
    if (this.idleTimer || !this.proc || this.closed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.active && !this.queue.length) this.kill()
    }, this.idleMs)
    this.idleTimer.unref()
  }

  private kill(): Promise<void> {
    const p = this.proc
    this.proc = null
    if (!p) return Promise.resolve()
    if (p.alive) {
      this.counters.killed++
      try {
        p.handle.kill()
      } catch {
        /* already gone */
      }
    }
    return p.exited
  }

  /** Fail queued jobs, kill the process and wait (briefly) for it to exit. */
  async close(): Promise<void> {
    this.closed = true
    for (const t of [this.jobTimer, this.idleTimer, this.backoffTimer]) if (t) clearTimeout(t)
    this.jobTimer = this.idleTimer = this.backoffTimer = null
    const active = this.active
    this.active = null
    for (const j of this.queue.splice(0)) j.resolve({ ok: false, code: 'unavailable' })
    active?.resolve({ ok: false, code: 'unavailable' })
    const exited = this.kill()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000).unref())])
  }
}
