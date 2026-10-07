/**
 * Bulk data jobs (07 C9): export, import and backup. They run on **db.worker** (its own connection, transactions of
 * ≤ 500 rows / ≤ 20 ms with yields, no read transaction > 1 s) through memory's typed job protocol
 * (`memoryOf(ctx).runJob`, src/server/memory/engine/protocol.ts): src/server/data/worker.ts runs `runExport` /
 * `runImport` inside the worker, the 'backup' job copies the database there. One implementation (platform-int); when
 * no built worker file exists (unit tests of other modules) the same engine runs in-process behind a MessageChannel.
 *
 *   - `BulkJobs` is what the HTTP routes call (ContentServer implements it with worker jobs).
 *   - The job functions (`runExport`, `runImport`) take a `Db` and plain dependencies, never the ServerContext. The
 *     only main-thread callback is `ImportDeps.ingestFile` (attachments need the store + extract process): over the
 *     worker port it is the `ingestFile` job call. Progress goes through `JobIO.progress` (→ WS `job.progress`).
 */
import { setImmediate as yieldLoop, setTimeout as sleep } from 'node:timers/promises'
import { VesperError } from '@shared/errors'
import type { ImportResult } from '@shared/api'

export interface JobIO {
  readonly signal: AbortSignal
  progress(phase: string, done: number, total: number | null): void
  /** Give the event loop a turn when this slice has run long enough (≤ ~15 ms of work between yields). */
  yield(): Promise<void>
}

export interface ExportInput {
  format: 'md' | 'json'
  /** One session (a single .md / .json file) or everything (a .zip). */
  sessionUid?: string
  /** Directory for the result (ctx.paths.exports). */
  dir: string
}

export interface ExportOutput {
  file: string
  fileName: string
  mime: string
  bytes: number
  sessions: number
  messages: number
}

export interface ImportInput {
  /** The uploaded file (JSON or ZIP), already on disk. */
  file: string
}

export interface BackupOutput {
  file: string
  bytes: number
}

export interface BulkJobs {
  export(input: ExportInput, io: JobIO): Promise<ExportOutput>
  import(input: ImportInput, io: JobIO): Promise<ImportResult>
  backup(reason: 'manual' | 'daily', io: JobIO): Promise<BackupOutput>
}

/**
 * A JobIO that yields after ~15 ms of continuous work and forwards progress (throttled to ~4/s). `pauseMs` (db.worker)
 * turns each yield into a short sleep: back-to-back write transactions on the worker's connection would otherwise
 * leave the main connection's busy handler (which retries after 1, 2, 5, 10 … ms) no window to take the write lock.
 */
export function createJobIO(o: { signal?: AbortSignal; onProgress?: (phase: string, done: number, total: number | null) => void; sliceMs?: number; pauseMs?: number } = {}): JobIO {
  const slice = o.sliceMs ?? 15
  const pause = o.pauseMs ?? 0
  let sliceStart = performance.now()
  let lastProgress = 0
  const signal = o.signal ?? new AbortController().signal
  return {
    signal,
    progress(phase, done, total) {
      const now = performance.now()
      if (now - lastProgress < 250 && done !== total) return
      lastProgress = now
      o.onProgress?.(phase, done, total)
    },
    async yield() {
      if (signal.aborted) throw new VesperError('conflict', { message: 'The job was cancelled.' })
      if (performance.now() - sliceStart < slice) return
      if (pause > 0) await sleep(pause)
      else await yieldLoop()
      sliceStart = performance.now()
    }
  }
}

/** One bulk job at a time: a second one while another runs is a `conflict`. */
export class JobLock {
  private running: string | null = null

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new VesperError('conflict', { message: `Vesper is busy with ${this.running}. Try again when it has finished.` })
    this.running = name
    try {
      return await fn()
    } finally {
      this.running = null
    }
  }

  get busy(): string | null {
    return this.running
  }
}
