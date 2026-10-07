/**
 * The main side of db.worker: starts the worker thread lazily (07 D2: on first memory use), correlates requests and
 * jobs, restarts it after a crash (≤ 3 restarts in 5 minutes, 07 C19) and resumes — the embed queue is durable in
 * SQLite, so a restarted worker simply drains it again. When no built worker file exists (unit tests of other
 * modules, `workersDir` without out/main) the same Engine runs in-process behind a MessageChannel.
 */
import fs from 'node:fs'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { apiError, VesperError, type ApiError } from '@shared/errors'
import type { Log } from '../services'
import { Engine, type EngineOptions } from './engine/engine'
import type { JobCallOp, JobCalls, JobResult, JobSpec, MainToWorker, ReqMap, WorkerConfig, WorkerStatus, WorkerToMain } from './engine/protocol'

const RESTART_WINDOW_MS = 5 * 60_000
const MAX_RESTARTS = 3
const CLOSE_TIMEOUT_MS = 5000

export interface LinkOptions {
  /** Built worker script (out/main/db.worker.js); null or missing → in-process engine. */
  script: string | null
  dbFile: string
  log: Log
  /** Current config (key included) — read again on every (re)start. */
  config: () => Promise<WorkerConfig>
  onStatus: (s: WorkerStatus) => void
  /** The worker died for good (restart budget used up). */
  onFailed?: () => void
  /** Tests: options for the in-process engine. */
  engine?: EngineOptions
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout | null }
type PendingJob = Pending & { onProgress?: JobRunOptions['onProgress']; calls?: JobRunOptions['calls']; detach?: () => void }

/** Options of a bulk job (`memoryOf(ctx).runJob`). */
export interface JobRunOptions {
  /** `total` −1 = unknown; `phase` names the step of a data job ('export', 'import'). */
  onProgress?: (done: number, total: number, phase?: string) => void
  signal?: AbortSignal
  /** Main-process services a job may call while it runs (content's import: attachment ingestion). */
  calls?: { [K in JobCallOp]?: (args: JobCalls[K]['args']) => Promise<JobCalls[K]['result']> }
}

export class WorkerLink {
  private worker: Worker | null = null
  private inproc: { engine: Engine; main: MessagePort; side: MessagePort } | null = null
  private starting: Promise<void> | null = null
  private ready = false
  private closing = false
  private failed = false
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly jobs = new Map<number, PendingJob>()
  private restarts: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private closedWaiter: (() => void) | null = null
  lastStatus: WorkerStatus | null = null

  constructor(private readonly o: LinkOptions) {}

  get started(): boolean {
    return this.ready
  }

  get inProcess(): boolean {
    return this.inproc !== null
  }

  get dead(): boolean {
    return this.failed
  }

  /** Counts for leak checks (pending maps return to zero). */
  get sizes(): { pending: number; jobs: number } {
    return { pending: this.pending.size, jobs: this.jobs.size }
  }

  /** Start (once) and resolve when the worker answered `ready`. */
  start(): Promise<void> {
    if (this.closing) return Promise.reject(new VesperError('memory_unavailable'))
    if (this.failed) return Promise.reject(new VesperError('memory_unavailable'))
    if (this.ready) return Promise.resolve()
    this.starting ??= this.spawn().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async spawn(): Promise<void> {
    const config = await this.o.config()
    await new Promise<void>((resolve, reject) => {
      const onMsg = (m: WorkerToMain) => {
        if (m.t === 'ready') {
          this.ready = true
          resolve()
        }
        this.onMessage(m)
      }
      const init: MainToWorker = { t: 'init', dbFile: this.o.dbFile, config }
      const script = this.o.script && fs.existsSync(this.o.script) ? this.o.script : null
      if (script) {
        const w = new Worker(script, { name: 'vesper-db-worker' })
        this.worker = w
        w.on('message', onMsg)
        w.on('error', (e) => {
          this.o.log.error('db.worker crashed', { error: e })
          if (!this.ready) reject(new VesperError('memory_unavailable'))
        })
        w.on('exit', (code) => {
          this.worker = null
          const was = this.ready
          this.ready = false
          if (this.closing) {
            this.closedWaiter?.()
            return
          }
          if (!was) reject(new VesperError('memory_unavailable'))
          this.crashed(code)
        })
        w.postMessage(init)
      } else {
        const ch = new MessageChannel()
        const engine = new Engine((m) => ch.port2.postMessage(m), this.o.engine)
        ch.port2.on('message', (m: MainToWorker) => engine.handle(m))
        ch.port1.on('message', onMsg)
        // In-process ports must not keep a process alive on their own.
        ch.port1.unref()
        ch.port2.unref()
        this.inproc = { engine, main: ch.port1, side: ch.port2 }
        ch.port1.postMessage(init)
      }
    })
  }

  private crashed(code: number): void {
    const err = new VesperError('memory_unavailable')
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
    for (const [id, j] of this.jobs) {
      j.detach?.()
      j.reject(err)
      this.jobs.delete(id)
    }
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restarts.length >= MAX_RESTARTS) {
      this.failed = true
      this.o.log.error('db.worker keeps crashing; memory is unavailable until restart', { code })
      this.o.onFailed?.()
      return
    }
    this.restarts.push(now)
    const delay = 250 * 2 ** (this.restarts.length - 1)
    this.o.log.warn('restarting db.worker', { code, inMs: delay })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch(() => undefined)
    }, delay)
    this.restartTimer.unref?.()
  }

  private onMessage(m: WorkerToMain): void {
    switch (m.t) {
      case 'status':
        this.lastStatus = m.status
        this.o.onStatus(m.status)
        break
      case 'res': {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (p.timer) clearTimeout(p.timer)
        if (m.ok) p.resolve(m.result)
        else p.reject(new VesperError(m.error.code, { ...m.error }))
        break
      }
      case 'job.progress':
        this.jobs.get(m.id)?.onProgress?.(m.done, m.total, m.phase)
        break
      case 'job.call':
        void this.answerCall(m.id, m.callId, m.op, m.args)
        break
      case 'job.done':
      case 'job.error': {
        const j = this.jobs.get(m.id)
        if (!j) return
        this.jobs.delete(m.id)
        j.detach?.()
        if (m.t === 'job.done') j.resolve(m.result)
        else j.reject(new VesperError(m.error.code, { ...m.error }))
        break
      }
      case 'log':
        this.o.log[m.level](m.msg, m.data)
        break
      case 'closed':
        this.closedWaiter?.()
        break
      case 'ready':
        break
    }
  }

  /** Fire-and-forget message (starts the worker if needed). */
  send(m: MainToWorker): void {
    if (this.failed || this.closing) return
    if (!this.ready) {
      this.start()
        .then(() => this.post(m))
        .catch(() => undefined)
      return
    }
    this.post(m)
  }

  /** Send only if running (no lazy start). */
  sendIfStarted(m: MainToWorker): void {
    if (this.ready && !this.closing) this.post(m)
  }

  private post(m: MainToWorker): void {
    if (this.worker) this.worker.postMessage(m)
    else this.inproc?.main.postMessage(m)
  }

  async request<K extends keyof ReqMap>(op: K, args: ReqMap[K]['args'], timeoutMs: number): Promise<ReqMap[K]['result']> {
    await this.start()
    const id = ++this.seq
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new VesperError('memory_unavailable', { message: 'Memory took too long to answer.' }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ t: 'req', id, op, args })
    })
    return result as ReqMap[K]['result']
  }

  /** Run a job's call into the main process and post the reply (unknown op / no handler → an error reply). */
  private async answerCall(id: number, callId: number, op: JobCallOp, args: unknown): Promise<void> {
    const fn = this.jobs.get(id)?.calls?.[op] as ((a: unknown) => Promise<unknown>) | undefined
    let reply: MainToWorker
    try {
      if (!fn) throw new VesperError('internal', { message: `No handler for ${op}.` })
      reply = { t: 'job.reply', id, callId, ok: true, result: await fn(args) }
    } catch (e) {
      reply = { t: 'job.reply', id, callId, ok: false, error: e instanceof VesperError ? e.info : apiError('internal') }
    }
    // The job may have ended (cancelled, worker restarted) meanwhile: then nobody waits for the answer.
    if (this.jobs.has(id) && (this.worker || this.inproc)) this.post(reply)
  }

  async job(spec: JobSpec, o: JobRunOptions = {}): Promise<JobResult> {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const onAbort = () => this.post({ t: 'job.cancel', id })
      o.signal?.addEventListener('abort', onAbort, { once: true })
      this.jobs.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
        onProgress: o.onProgress,
        calls: o.calls,
        detach: () => o.signal?.removeEventListener('abort', onAbort)
      })
      this.post({ t: 'job', id, job: spec })
    })
  }

  /** Test builds: crash the worker thread (restart tests). */
  crashForTest(): void {
    // Never in-process: the throw would take the main process down with it.
    if (__VESPER_TEST__ && this.worker) this.post({ t: '__crash' })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.ready) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CLOSE_TIMEOUT_MS)
        this.closedWaiter = () => {
          clearTimeout(t)
          resolve()
        }
        this.post({ t: 'close' })
      })
    }
    this.closedWaiter = null
    this.ready = false
    const gone: ApiError = apiError('memory_unavailable')
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new VesperError(gone.code))
    }
    this.pending.clear()
    for (const j of this.jobs.values()) {
      j.detach?.()
      j.reject(new VesperError(gone.code))
    }
    this.jobs.clear()
    if (this.worker) {
      const w = this.worker
      this.worker = null
      await w.terminate().catch(() => undefined)
    }
    if (this.inproc) {
      this.inproc.main.close()
      this.inproc.side.close()
      this.inproc = null
    }
  }
}
