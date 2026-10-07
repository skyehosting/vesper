/**
 * content-server's service (ctx.services.content, 07 E2): the attachment store + extract process, the protocols file,
 * bulk data jobs (export/import/backup, run on db.worker — see ../data/jobs.ts) and the daily maintenance tick (backup at idle, attachment GC). One instance per ServerContext,
 * created on first use; `close()` releases the timer and the extract process.
 */
import path from 'node:path'
import { backup as sqliteBackup } from 'node:sqlite'
import type { ImportResult } from '@shared/api'
import { VesperError } from '@shared/errors'
import type { AttachmentRef } from '@shared/types/domain'
import { coreOf } from '../core'
import { MIGRATIONS } from '../db/migrations'
import { BackupManager, dayKey } from '../data/backup'
import { memoryOf } from '../memory/service'
import { checkpointTruncate, runDailyPurge } from '../memory/purge'
import { createJobIO, JobLock, type BackupOutput, type BulkJobs, type ExportInput, type ExportOutput, type ImportInput, type JobIO } from '../data/jobs'
import { runExportJob, runImportJob, type DataJobContext } from '../data/worker'
import type { ExportJobSpec, ImportJobSpec, JobCalls } from '../memory/engine/protocol'
import { ProtocolsStore } from '../protocols/protocols'
import type { ContentService, ServerContext } from '../services'
import { testEnv } from '../testMode'
import { ExtractorPool } from './extractor'
import { systemOf } from '../system'
import { AttachmentStore } from './store'

/** How often the maintenance tick looks for an idle moment (daily backup, attachment GC). */
const TICK_MS = 15 * 60_000
/** A daily backup happens even without an idle moment once the last one is this old. */
const FORCE_BACKUP_AFTER_MS = 36 * 3600_000
/** Uploaded but never sent attachments are kept this long before GC. */
const GC_GRACE_MS = 24 * 3600_000

export interface ContentOptions {
  /** Tests: the extract process script (default <workersDir>/extract.process.js). */
  extractScript?: string
  extractTimeoutMs?: number
  extractIdleMs?: number
  tickMs?: number
}

/** A test-only duration switch (07 B10: undefined outside test builds + VESPER_TEST=1). */
function envMs(name: `VESPER_${string}`): number | undefined {
  const v = Number(testEnv(name))
  return Number.isFinite(v) && v > 0 ? v : undefined
}

export class ContentServer implements ContentService {
  readonly store: AttachmentStore
  readonly extractor: ExtractorPool
  readonly protocolsStore: ProtocolsStore
  readonly backups: BackupManager
  readonly jobs: BulkJobs
  readonly lock = new JobLock()
  /** Aborted at shutdown: running jobs stop at their next yield (a half-imported conversation is removed). */
  readonly shutdown = new AbortController()
  private tick: NodeJS.Timeout | null = null
  private closed = false
  private maintenance: Promise<void> | null = null

  constructor(
    private readonly ctx: ServerContext,
    o: ContentOptions = {}
  ) {
    const log = ctx.log.child('content')
    let workersDir = ''
    try {
      workersDir = coreOf(ctx).opts.workersDir
    } catch {
      /* a context not made by startServer (unit tests pass extractScript) */
    }
    this.extractor = new ExtractorPool({
      script: o.extractScript ?? path.join(workersDir, 'extract.process.js'),
      fork: (script, args, opts) => ctx.platform.forkWorker(script, args, opts),
      log: log.child('extract'),
      timeoutMs: o.extractTimeoutMs ?? envMs('VESPER_EXTRACT_TIMEOUT_MS'),
      idleMs: o.extractIdleMs ?? envMs('VESPER_EXTRACT_IDLE_MS')
    })
    this.store = new AttachmentStore({
      db: ctx.db,
      repos: ctx.repos,
      root: ctx.paths.attachments,
      tempRoot: ctx.paths.temp,
      clock: ctx.clock,
      log: log.child('attachments'),
      extractor: this.extractor,
      maxTextChars: () => ctx.settings.get().chat.attachments.maxTextChars
    })
    this.protocolsStore = new ProtocolsStore(path.join(ctx.paths.roaming, 'protocols.md'), log.child('protocols'))
    this.backups = new BackupManager({
      db: ctx.db,
      dir: ctx.paths.backups,
      dbFile: path.join(ctx.paths.roaming, 'vesper.db'),
      now: () => ctx.clock.now(),
      log: log.child('backup'),
      settings: () => {
        const d = ctx.settings.get().data
        return { daily: d.backupDaily, weekly: d.backupWeekly, extraDir: d.backupExtraDir }
      },
      schemaVersion: Math.max(...MIGRATIONS.map((m) => m.version)),
      // The copy runs on db.worker's connection (07 C9/C20); with the worker gone for good, node:sqlite's backup()
      // here (it steps on the thread pool, the main loop only schedules it).
      copy: (file) =>
        this.onWorker(
          'a backup',
          async () => void (await memoryOf(ctx).runJob({ kind: 'backup', file })),
          async () => void (await sqliteBackup(ctx.db, file)),
          { retry: true }
        )
    })
    this.jobs = this.workerJobs()
    this.tick = setInterval(() => void this.runMaintenance(false), o.tickMs ?? TICK_MS)
    this.tick.unref()
  }

  /**
   * Is db.worker gone for good (≥ 3 crashes in 5 minutes, 07 C19) — or is there no memory service at all? Then the
   * data jobs run in this process instead (Phase 4): export, import and backup must keep working.
   */
  workerGone(): boolean {
    try {
      return memoryOf(this.ctx).link.dead
    } catch {
      return true
    }
  }

  /**
   * Run a data job on db.worker, or — when the worker is gone for good — the SAME job function in this process (its
   * JobIO still yields every ≤ 15 ms slice, so the main loop keeps answering). `retry`: a job that failed because
   * the worker died for good during it is re-run here (export and backup write a fresh file; an import is not
   * retried — its half-written sessions are not known here — and reports the failure).
   */
  private async onWorker<T>(name: string, viaWorker: () => Promise<T>, inProcess: () => Promise<T>, o: { retry: boolean }): Promise<T> {
    const log = this.ctx.log.child('content')
    if (this.workerGone()) {
      log.warn('db.worker is unavailable; running the job in the main process', { job: name })
      return inProcess()
    }
    try {
      return await viaWorker()
    } catch (e) {
      if (!(o.retry && e instanceof VesperError && e.info.code === 'memory_unavailable' && this.workerGone())) throw e
      log.warn('db.worker stopped during the job; running it again in the main process', { job: name })
      return inProcess()
    }
  }

  /** The DataJobContext for a job run in this process (progress and the ingestFile call go straight to `io`/`calls`). */
  private localJobContext(io: JobIO, fallback: string, calls: Partial<{ [K in keyof JobCalls]: (a: JobCalls[K]['args']) => Promise<JobCalls[K]['result']> }> = {}): DataJobContext {
    return {
      signal: io.signal,
      progress: (phase, done, total) => io.progress(phase || fallback, done, total),
      call: async (op, args) => {
        const fn = calls[op] as ((a: typeof args) => Promise<JobCalls[typeof op]['result']>) | undefined
        if (!fn) throw new VesperError('internal', { message: `No handler for ${op}.` })
        return fn(args)
      },
      log: this.ctx.log.child('content')
    }
  }

  /**
   * BulkJobs on db.worker (07 C9; platform-int): content's export/import run inside the worker through memory's job
   * protocol, the backup copy too (BackupManager's `copy`). Attachment ingestion during an import comes back here as
   * the `ingestFile` job call (the store and the extract process live in this process). If the worker is gone for
   * good, the same job functions run here (`onWorker`, Phase 4).
   */
  private workerJobs(): BulkJobs {
    const ctx = this.ctx
    const store = this.store
    const progressOf = (io: JobIO, fallback: string) => (done: number, total: number, phase?: string) => io.progress(phase ?? fallback, done, total < 0 ? null : total)
    const ingestFile = async (f: JobCalls['ingestFile']['args']): Promise<JobCalls['ingestFile']['result']> => {
      try {
        return await store.ingest({ file: f.path, sha: f.sha, size: f.size, name: f.name })
      } catch (e) {
        // A refused file (unsupported, too many pixels) is skipped; the rest of the import continues.
        if (e instanceof VesperError) return null
        throw e
      }
    }
    return {
      export: async (input: ExportInput, io: JobIO): Promise<ExportOutput> => {
        const s = ctx.settings.get()
        const spec: ExportJobSpec = {
          kind: 'export',
          format: input.format,
          ...(input.sessionUid !== undefined ? { sessionUid: input.sessionUid } : {}),
          dir: input.dir,
          appVersion: ctx.platform.version,
          names: { user: s.profile.userName.trim() || 'You', assistant: s.profile.assistantName, clock: s.profile.clock },
          attachmentsRoot: ctx.paths.attachments,
          nowUtc: ctx.clock.now()
        }
        return this.onWorker(
          'an export',
          async () => {
            const r = await memoryOf(ctx).runJob(spec, { signal: io.signal, onProgress: progressOf(io, 'export') })
            if (r.kind !== 'export') throw new VesperError('internal')
            return r.out
          },
          () => runExportJob(ctx.db, spec, this.localJobContext(io, 'export')),
          { retry: true }
        )
      },
      import: async (input: ImportInput, io: JobIO): Promise<ImportResult> => {
        const s = ctx.settings.get()
        const spec: ImportJobSpec = {
          kind: 'import',
          file: input.file,
          zone: s.profile.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          maxAttachmentBytes: s.chat.attachments.maxFileMb * 1024 * 1024,
          tempDir: store.tmpDir,
          nowUtc: ctx.clock.now()
        }
        return this.onWorker(
          'an import',
          async () => {
            const r = await memoryOf(ctx).runJob(spec, { signal: io.signal, onProgress: progressOf(io, 'import'), calls: { ingestFile } })
            if (r.kind !== 'import') throw new VesperError('internal')
            return r.result
          },
          () => runImportJob(ctx.db, spec, this.localJobContext(io, 'import', { ingestFile })),
          { retry: false }
        )
      },
      backup: async (reason: 'manual' | 'daily'): Promise<BackupOutput> => {
        const b = await this.backups.create(reason)
        if (b) return { file: b.file, bytes: b.bytes }
        const today = this.backups.list().find((x) => x.kind === 'daily' && x.file === `vesper-${dayKey(ctx.clock.now())}.db`)
        return { file: today?.file ?? '', bytes: today?.bytes ?? 0 }
      }
    }
  }

  // ── ContentService ──────────────────────────────────────────────────────────────────────────
  attachment(sha: string): AttachmentRef | null {
    return this.store.get(sha)
  }

  readAttachment(sha: string): Promise<Buffer> {
    return this.store.read(sha)
  }

  attachmentText(sha: string): { text: string; chars: number; truncated: boolean } | null {
    return this.store.text(sha)
  }

  forgetTemporary(shas: readonly string[]): void {
    this.store.forgetTemporary(shas)
  }

  protocols(): { text: string; hash: string; isDefault: boolean } {
    return this.protocolsStore.get()
  }

  backup(reason: 'manual' | 'daily'): Promise<{ file: string; bytes: number }> {
    // fix-platform F66: the outcome reaches Settings → Data (+ a toast) through SystemHealth.
    const health = systemOf(this.ctx)?.health
    return this.lock.run('a backup', () =>
      this.jobs.backup(reason, createJobIO({ signal: this.shutdown.signal })).then(
        (r) => (health?.backupSucceeded(), r),
        (e: unknown) => {
          if (!this.shutdown.signal.aborted) health?.backupFailed(reason, e)
          throw e
        }
      )
    )
  }

  // ── Maintenance ─────────────────────────────────────────────────────────────────────────────
  /** Nobody is looking at Vesper right now (no visible, focused client). */
  private idle(): boolean {
    for (const c of this.ctx.hub.clients()) if (c.state.visible && c.state.focused) return false
    return true
  }

  /** Daily backup at idle (forced after 36 h) + attachment GC. `force` runs regardless of idleness (tests). */
  runMaintenance(force: boolean): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.maintenance ??= (async () => {
      try {
        const d = this.ctx.settings.get().data
        const now = this.ctx.clock.now()
        const last = this.backups.list().find((b) => b.kind === 'daily' || b.kind === 'manual')
        const due = !last || dayKey(last.createdUtc) !== dayKey(now)
        const overdue = !last || now - last.createdUtc > FORCE_BACKUP_AFTER_MS
        if (!(force || this.idle() || overdue)) return
        // 07 B9 order (fix-memory-privacy, F16): purge, GC the attachments it freed (their files and extracted text),
        // wal_checkpoint(TRUNCATE) so neither the database file nor its WAL keeps the old pages, and only then the
        // day's backup — which therefore holds none of it.
        const purged = await runDailyPurge(this.ctx).catch((e: unknown) => {
          this.ctx.log.warn('daily purge failed', { error: e })
          return null
        })
        const gc = await this.store.collectGarbage(now - GC_GRACE_MS)
        if (purged?.ran || gc.removed) await checkpointTruncate(this.ctx)
        // Low disk (07 C19, F66): no daily backup until there is space again (the owner was told).
        const health = systemOf(this.ctx)?.health
        if (d.backups && due && !this.lock.busy) await health?.checkDisk()
        if (d.backups && due && !this.lock.busy && !health?.isLowDisk) await this.backup('daily')
      } catch (e) {
        this.ctx.log.warn('maintenance failed', { error: e })
      } finally {
        this.maintenance = null
      }
    })()
    return this.maintenance
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.shutdown.abort()
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    await this.maintenance?.catch(() => undefined)
    await this.extractor.close()
  }
}

const servers = new WeakMap<ServerContext, ContentServer>()

/** The content server of `ctx`, created (and registered for shutdown) on first use. */
export function contentOf(ctx: ServerContext, o?: ContentOptions): ContentServer {
  let c = servers.get(ctx)
  if (!c) {
    c = new ContentServer(ctx, o)
    servers.set(ctx, c)
    const created = c
    ctx.onClose(() => created.close())
  }
  return c
}
