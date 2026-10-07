/**
 * The main ⇄ db.worker message protocol (07 C9/C10/C11). Structured-clone messages over a worker_threads port (or
 * an in-process MessageChannel when the built worker file is absent, e.g. unit tests of unrelated modules).
 *
 * Main → worker
 *   init {dbFile, config}                once, first message
 *   config {config}                      settings or key changed (the key lives only in this process' memory)
 *   enqueued {count}                     main inserted rows into embed_queue (wake the background lane)
 *   messagesDeleted {ids}                soft delete / forget: drop vectors, bits and queue rows now (07 B9)
 *   sessionFlagged {sessionId}           private / memory-off / deleted / restored: re-read and act
 *   pathChanged {sessionId}              variant switch: re-read on_path for the session's indexed rows (07 C3)
 *   req {id, op, args}                   request/response operations (search, fts, status, …) → res {id, ok, …}
 *   job {id, job}                        bulk jobs (export/import/purge/backup/reindex/…) → job.progress / job.done /
 *   job.cancel {id}                      job.error; cancel stops at the next chunk boundary
 *   job.reply {id, callId, ok, …}        answer to a job's job.call (attachment ingestion during an import)
 *   close                                checkpoint (TRUNCATE), close the DB, reply `closed`
 * Worker → main
 *   ready · status {status} · res · job.progress · job.call · job.done · job.error · log {level, msg, data} · closed
 *
 * Ids cross the boundary as numbers (message/session ids < 2^53); SQL binds them as BigInt inside the worker.
 */
import type { ImportResult } from '@shared/api'
import type { ApiError } from '@shared/errors'
import type { Clock as TimeClock } from '@shared/time'
import type { AttachmentRef } from '@shared/types/domain'
import type { ExportOutput } from '../../data/jobs'
import type { VoyageTier } from '../../providers/voyage/catalogue'

export interface WorkerConfig {
  /** Global memory switch (settings.memory.enabled). Off → the background lane idles; FTS jobs still run. */
  enabled: boolean
  /** Effective request URL (mock origin in test mode) and the key; null key = keyword-only. */
  baseUrl: string
  key: string | null
  embedModel: string
  rerankModel: string | 'none'
  dim: number
  tier: 'auto' | VoyageTier
  /** Load the bit index now (first memory use) instead of lazily. */
  loadIndex?: boolean
  /** Hold the background lane (game mode, low disk — 07 D3/C19); searches keep working. */
  paused?: boolean
}

export interface WorkerStatus {
  /** loading = the bit index is being read (searches run keyword-only meanwhile, 07 C10). */
  index: 'idle' | 'loading' | 'ready'
  indexed: number
  queued: number
  /** Queue rows that failed permanently (skipped inputs) or are waiting after errors. */
  errors: number
  tier: VoyageTier
  rpmUsed: number
  queueEtaSec: number | null
  /** Voyage trouble that degrades memory (auth stops the queue; rate/network/server back off). */
  problem: null | { code: 'provider_auth' | 'provider_rate' | 'provider_overloaded' | 'network' | 'voyage_backlog' | 'provider_not_found' | 'provider_bad_request'; atUtc: number }
  model: string | null
  dim: number | null
  activeGen: number | null
  reindex: { gen: number; done: number; total: number } | null
}

export interface SearchArgs {
  query: string
  /** Allowed session ids (already clamped by the main process, 07 B7/B9); null = every session. */
  sessionIds: number[] | null
  /** Inclusive lower / exclusive upper bound on ts_utc. */
  after: number | null
  before: number | null
  /** May the query and documents go to Voyage (false for private/temporary scopes, 07 B9). */
  voyage: boolean
  rerank: boolean
  /** Absolute deadline (epoch ms of the worker's Date.now()) for the whole operation. */
  deadline: number
  /** How many fused candidates to return. */
  limit: number
  /** Include off-path rows (the UI's "earlier version" hits); memory never does (07 C3). */
  includeOffPath?: boolean
}

export interface SearchItem {
  id: number
  /** 0..1: rerank relevance when reranked, else max(cosine, keyword overlap). */
  score: number
  /** Where the item came from (debugging / tests). */
  via: { keyword?: number; vector?: number; rerank?: number }
  /** Found by words inside a file the message carries (07 C8, F72): the file name and an FTS snippet. */
  attachment?: { name: string; snippet: string }
}

export interface SearchResult {
  items: SearchItem[]
  mode: 'hybrid' | 'keyword'
  /** Why the vector leg was skipped, when it was. */
  degraded?: 'no-key' | 'disabled' | 'loading' | 'budget' | 'voyage-error' | 'not-allowed'
  timings: Record<string, number>
}

export interface FtsPageArgs {
  query: string
  sessionIds: number[] | null
  /** Exclusive upper message id (newest-first paging). */
  beforeId: number | null
  order: 'recent' | 'relevance'
  limit: number
  includeOffPath: boolean
  /** Optional filters (Phase 4, UI search): role, and `tsUtc` ≥ after / < before. */
  role?: 'user' | 'assistant' | null
  after?: number | null
  before?: number | null
}

export interface FtsPageResult {
  items: { id: number; snippet: string; score: number }[]
  next: number | null
}

export interface BackfillEstimate {
  messages: number
  sessions: number
  estTokens: number
  estUsd: number
  estSeconds: number
}

/**
 * Content's export (src/server/data/export.ts) run by the worker on its own connection (platform-int, 07 C9): one
 * session → a .md/.json file, everything → a ZIP with attachments. `nowUtc` is the server clock at the start (test
 * clocks stay in force inside the worker).
 */
export interface ExportJobSpec {
  kind: 'export'
  format: 'md' | 'json'
  sessionUid?: string
  /** Directory for the result (ctx.paths.exports). */
  dir: string
  appVersion: string
  names: { user: string; assistant: string; clock: TimeClock }
  /** The attachment store root (`<sha[0:2]>/<sha>` files) for the ZIP's attachments/. */
  attachmentsRoot: string
  nowUtc: number
}

/**
 * Content's import (src/server/data/import.ts: Vesper JSON/ZIP, ChatGPT, Claude) run by the worker. Attachments go
 * through the main process (the store + extract process) via the `ingestFile` job call.
 */
export interface ImportJobSpec {
  kind: 'import'
  /** The uploaded file, already on disk. */
  file: string
  /** IANA zone for messages that carry none. */
  zone: string
  maxAttachmentBytes: number
  /** Where archive entries are unpacked (the attachment store's tmp dir: same volume as the store). */
  tempDir: string
  nowUtc: number
}

/** Calls a running job makes into the main process (`job.call` → `job.reply`). */
export interface JobCalls {
  /** Store a file as an attachment (sniffed, deduplicated, text extracted); null when refused. */
  ingestFile: { args: { path: string; sha: string; size: number; name: string }; result: AttachmentRef | null }
}
export type JobCallOp = keyof JobCalls

/** Bulk jobs (07 C9). Each runs in transactions ≤ 500 rows / ~20 ms with yields; progress via job.progress. */
export type JobSpec =
  | ExportJobSpec
  | ImportJobSpec
  /**
   * 07 B9: hard-delete the given sessions and those trashed before `deletedBeforeUtc`; with `clearDeletedBodies`, clear
   * messages deleted before that cutoff (all deleted ones without it). `nowUtc` stamps deleted rows that have no
   * delete time yet (their 30 days start then).
   */
  | { kind: 'purge'; sessionIds?: number[]; deletedBeforeUtc?: number; clearDeletedBodies?: boolean; nowUtc?: number }
  | { kind: 'backup'; file: string }
  | { kind: 'checkpoint'; mode: 'PASSIVE' | 'TRUNCATE' }
  | { kind: 'optimize' }
  | { kind: 'reindex'; scope: 'all' | 'missing' }
  | { kind: 'backfill'; sessionIds: number[] | null; nowUtc: number }
  | { kind: 'estimate'; sessionIds: number[] | null }
  | { kind: 'deleteIndex' }

export type JobResult =
  | { kind: 'export'; out: ExportOutput }
  | { kind: 'import'; result: ImportResult }
  | { kind: 'purge'; sessions: number; messages: number; /** deleted messages whose content was cleared */ cleared?: number }
  | { kind: 'backup'; file: string; pages: number }
  | { kind: 'checkpoint' }
  | { kind: 'optimize' }
  | { kind: 'reindex'; queued: number }
  | { kind: 'backfill'; queued: number; estTokens: number }
  | { kind: 'estimate'; estimate: BackfillEstimate }
  | { kind: 'deleteIndex'; vectors: number }

export interface WorkerStats {
  heapUsed: number
  /** Sizes of every long-lived in-memory structure (leak checks: must return to baseline). */
  sizes: Record<string, number>
}

export type ReqOp =
  | { op: 'search'; args: SearchArgs; result: SearchResult }
  | { op: 'fts'; args: FtsPageArgs; result: FtsPageResult }
  | { op: 'status'; args: Record<string, never>; result: WorkerStatus }
  | { op: 'stats'; args: { gc?: boolean }; result: WorkerStats }
  | { op: 'loadIndex'; args: Record<string, never>; result: { indexed: number; ms: number } }
  | { op: 'drain'; args: Record<string, never>; result: { queued: number } }
  /** Phase 3 engine-int (07 D6): embed a likely query ahead of its search (kept 60 s); nothing is searched. */
  | { op: 'prefetch'; args: { query: string }; result: { cached: boolean } }

/** op → {args, result} (for typed requests). */
export type ReqMap = { [O in ReqOp as O['op']]: { args: O['args']; result: O['result'] } }

export type MainToWorker =
  | { t: 'init'; dbFile: string; config: WorkerConfig }
  | { t: 'config'; config: WorkerConfig }
  | { t: 'enqueued'; count: number }
  | { t: 'messagesDeleted'; ids: number[] }
  | { t: 'sessionFlagged'; sessionId: number }
  | { t: 'pathChanged'; sessionId: number }
  | { t: 'req'; id: number; op: ReqOp['op']; args: unknown }
  | { t: 'job'; id: number; job: JobSpec }
  | { t: 'job.cancel'; id: number }
  /** Answer to a running job's `job.call`. */
  | { t: 'job.reply'; id: number; callId: number; ok: true; result: unknown }
  | { t: 'job.reply'; id: number; callId: number; ok: false; error: ApiError }
  | { t: 'close' }
  /** Test builds only: throw an uncaught error inside the worker (crash/restart tests). */
  | { t: '__crash' }

export type WorkerToMain =
  | { t: 'ready' }
  | { t: 'status'; status: WorkerStatus }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: ApiError }
  /** `total` −1 = unknown; `phase` names the step of a data job ('export', 'import'). */
  | { t: 'job.progress'; id: number; done: number; total: number; phase?: string }
  /** A running job needs the main process (attachment ingestion during an import). */
  | { t: 'job.call'; id: number; callId: number; op: JobCallOp; args: unknown }
  | { t: 'job.done'; id: number; result: JobResult }
  | { t: 'job.error'; id: number; error: ApiError }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }
  | { t: 'closed' }
