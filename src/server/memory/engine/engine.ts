/**
 * The db.worker engine (07 C9–C11): its own read-write node:sqlite connection to vesper.db (WAL), the bit index,
 * the VoyageScheduler and the embed-queue drain, memory searches, and bulk jobs. Hosted by src/workers/db.worker.ts
 * on a worker_thread (or, when no built worker file exists, on an in-process MessageChannel).
 *
 * Writes of this connection: vectors, vector_bits, memory_generations, embed_queue updates/deletes, FTS merge steps,
 * and the bulk jobs (import / purge). Every write transaction is ≤ 500 rows and is followed by a yield.
 */
import fs from 'node:fs'
import v8 from 'node:v8'
import vm from 'node:vm'
import { backup } from 'node:sqlite'
import { apiError, type ApiError } from '@shared/errors'
import { formatDate, zoneOf } from '@shared/time'
import type { RoleTag } from '@shared/types/domain'
import { openDb, type Db } from '../../db/sqlite'
import { embedModel, estimateTokens, MAX_BATCH_TOKENS, MAX_INPUTS, rerankModel, type VoyageTier } from '../../providers/voyage/catalogue'
import { createVoyageClient, VoyageError, type VoyageClient } from '../../providers/voyage/client'
import { BitIndex, FLAG_DEAD, FLAG_OFF_PATH, signBits } from './bitIndex'
import type { BackfillEstimate, FtsPageArgs, JobCallOp, JobCalls, JobResult, JobSpec, MainToWorker, SearchArgs, SearchItem, SearchResult, WorkerConfig, WorkerStatus, WorkerToMain } from './protocol'
import { BudgetExceeded, realClock, VoyageScheduler, type SchedulerClock } from './scheduler'
import { purgeRows } from './jobs'
import { runExportJob, runImportJob } from '../../data/worker'
import type { Log } from '../../services'
import { allowedBitmap, ftsPage, keywordLeg, rrf, vectorLeg, type ScopeFilter } from './search'
import { attachmentLine } from './text'
import { big, chunks, marks, num, Stmts, writeTx, yieldNow, type Row } from './sql'
import { embedInputs, overlapScore, rerankDocument } from './text'

const TX_ROWS = 500
const READ_CHUNK = 50_000
/** Id-range slices for the scanning jobs (estimate, backfill, body purge): ≈ 10–20 ms each at 1M rows. */
const SCAN_CHUNK = 10_000
const SKIP = 'skip'
/** Messages still streaming are retried after this. */
const STREAMING_RETRY_MS = 30_000
const MAINTENANCE_MS = 5 * 60_000
const IDLE_MS = 60_000
const WAL_TRUNCATE_BYTES = 64 * 1024 * 1024
const RERANK_TOP = 40
/** Leave this much of the deadline for the rerank round trip; below it the rerank is skipped. */
const RERANK_MIN_MS = 150
/** Backlog worth telling the user about (07 C19 voyage_backlog). */
const BACKLOG_ETA_SEC = 120

interface Gen {
  gen: number
  family: string
  model: string
  dim: number
  state: 'building' | 'active' | 'retired'
}

export interface EngineOptions {
  clock?: SchedulerClock
  random?: () => number
  /** Tests: a client factory (defaults to the fetch client). */
  client?: (cfg: WorkerConfig) => VoyageClient
}

class Cancelled extends Error {}

/** Prefetched query embeddings live this long / this many (07 D6). */
const QUERY_CACHE_MS = 60_000
const QUERY_CACHE_MAX = 16
const PREFETCH_BUDGET_MS = 3_000

interface JobHandle {
  cancelled: boolean
  /** Aborted on cancel/close: data jobs (JobIO) stop at their next yield. */
  ac: AbortController
  /** Pending `job.call`s to the main process. */
  calls: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>
}

type DataJobContext = import('../../data/worker').DataJobContext

/** Log data crosses the port by structured clone: errors become plain {name, message}. */
function safeLogData(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) out[k] = v instanceof Error ? { name: v.name, message: v.message } : v
  return out
}

export class Engine {
  private db: Db | null = null
  private st!: Stmts
  private dbFile = ''
  private cfg: WorkerConfig | null = null
  private client: VoyageClient | null = null
  readonly scheduler: VoyageScheduler
  private index: BitIndex | null = null
  private indexGen: number | null = null
  private indexState: 'idle' | 'loading' | 'ready' = 'idle'
  private loading: Promise<void> | null = null
  private queued = 0
  private skipped = 0
  /** Average tokens per input (ETA): estimated from the first batch, then measured. */
  private avgTokens = 60
  private avgMeasured = false
  private problem: WorkerStatus['problem'] = null
  private stopped = false
  private draining = false
  private drainTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private maintTimer: NodeJS.Timeout | null = null
  private lastActivity = Date.now()
  private lastStatusJson = ''
  private readonly inflight = new Set<AbortController>()
  private readonly jobs = new Map<number, JobHandle>()
  private callSeq = 0
  private reindexTotal = 0
  /**
   * Bumped whenever generations are dropped or the whole index is deleted. Generation numbers are reused (INTEGER
   * PRIMARY KEY: after "delete index" the new gen is 1 again), so a batch that was in flight across such a change must
   * not write its vectors: it captured the old epoch and is discarded.
   */
  private vectorEpoch = 0
  /** True while `deleteIndex` runs (its row deletes yield): no batch starts and none is written. */
  private deletingIndex = false
  private readonly clock: SchedulerClock

  constructor(
    private readonly post: (m: WorkerToMain) => void,
    private readonly o: EngineOptions = {}
  ) {
    this.clock = o.clock ?? realClock
    this.scheduler = new VoyageScheduler(this.clock, o.random)
  }

  // ── message loop ───────────────────────────────────────────────────────────────────────────
  handle(m: MainToWorker): void {
    if (this.stopped && m.t !== 'close') return
    try {
      switch (m.t) {
        case 'init':
          this.init(m.dbFile, m.config)
          break
        case 'config':
          this.configure(m.config)
          break
        case 'enqueued':
          this.queued += m.count
          this.kick(2000)
          this.emitStatus()
          break
        case 'messagesDeleted':
          this.deleteVectors(m.ids)
          break
        case 'sessionFlagged':
          void this.sessionFlagged(m.sessionId).catch((e: unknown) => this.log('warn', 'sessionFlagged failed', e))
          break
        case 'pathChanged':
          this.pathChanged(m.sessionId)
          break
        case 'req':
          void this.request(m.id, m.op, m.args)
          break
        case 'job':
          void this.runJob(m.id, m.job)
          break
        case 'job.cancel': {
          const j = this.jobs.get(m.id)
          if (j) {
            j.cancelled = true
            j.ac.abort()
          }
          break
        }
        case 'job.reply': {
          const call = this.jobs.get(m.id)?.calls.get(m.callId)
          if (!call) break
          this.jobs.get(m.id)?.calls.delete(m.callId)
          if (m.ok) call.resolve(m.result)
          else call.reject(Object.assign(new Error(m.error.message), { info: m.error }))
          break
        }
        case 'close':
          void this.close()
          break
        case '__crash':
          if (__VESPER_TEST__) {
            setImmediate(() => {
              throw new Error('db.worker test crash')
            })
          }
          break
      }
    } catch (e) {
      this.log('error', `handling ${m.t} failed`, e)
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, e?: unknown): void {
    const data = e === undefined ? undefined : { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) }
    this.post({ t: 'log', level, msg, ...(data ? { data } : {}) })
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────
  private init(dbFile: string, cfg: WorkerConfig): void {
    this.dbFile = dbFile
    this.db = openDb(dbFile)
    // The worker checkpoints itself at idle and on shutdown (07 C9).
    this.db.exec('PRAGMA wal_autocheckpoint = 0')
    // Rescoring reads ~400 random 1 KB vectors per search: memory-mapped reads avoid a syscall per page (≈5× faster
    // on Windows, measured). Read-only mapping; Vesper never truncates the main DB file (no VACUUM).
    this.db.exec('PRAGMA mmap_size = 2147418112')
    this.st = new Stmts(this.db)
    this.recount()
    this.maintTimer = setInterval(() => void this.maintenance(), MAINTENANCE_MS)
    this.maintTimer.unref?.()
    this.configure(cfg)
    this.post({ t: 'ready' })
  }

  private configure(cfg: WorkerConfig): void {
    const prev = this.cfg
    this.cfg = cfg
    this.scheduler.setTier(cfg.tier)
    if (!prev || prev.key !== cfg.key || prev.baseUrl !== cfg.baseUrl) {
      this.client = cfg.key ? (this.o.client ? this.o.client(cfg) : createVoyageClient({ baseUrl: cfg.baseUrl, key: cfg.key })) : null
      // A new key or address gets a fresh chance after an auth stop.
      this.problem = null
    }
    if (!prev || prev.embedModel !== cfg.embedModel || prev.dim !== cfg.dim) this.ensureGenerations()
    if (cfg.loadIndex) void this.loadIndex()
    this.kick(0)
    this.emitStatus()
  }

  async close(): Promise<void> {
    if (this.stopped && !this.db) {
      this.post({ t: 'closed' })
      return
    }
    this.stopped = true
    for (const t of [this.drainTimer, this.statusTimer]) if (t) clearTimeout(t)
    if (this.maintTimer) clearInterval(this.maintTimer)
    this.drainTimer = this.statusTimer = this.maintTimer = null
    for (const c of this.inflight) c.abort()
    this.inflight.clear()
    for (const j of this.jobs.values()) this.cancelJob(j)
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* another connection holds a read lock; the next start checkpoints */
      }
      this.st.clear()
      this.db.close()
      this.db = null
    }
    this.index?.clear()
    this.index = null
    this.post({ t: 'closed' })
  }

  private get dbx(): Db {
    if (!this.db) throw new Error('db.worker not initialised')
    return this.db
  }

  // ── generations (07 C10) ───────────────────────────────────────────────────────────────────
  private gens(): Gen[] {
    return (this.st.get('SELECT gen, family, model, dim, state FROM memory_generations ORDER BY gen').all() as Row[]).map((r) => ({
      gen: num(r.gen),
      family: String(r.family),
      model: String(r.model),
      dim: num(r.dim),
      state: String(r.state) as Gen['state']
    }))
  }

  activeGen(): Gen | null {
    return this.gens().find((g) => g.state === 'active') ?? null
  }

  private buildingGen(): Gen | null {
    return this.gens().find((g) => g.state === 'building') ?? null
  }

  /** Where new embeddings go: the generation being built, else the active one. */
  private targetGen(): Gen | null {
    return this.buildingGen() ?? this.activeGen()
  }

  /**
   * Make the generations match the configured model family and dimension: same family + dim → keep the active gen
   * (voyage-4 models share one space); otherwise build a new gen next to the active one and re-embed what the active
   * gen holds. Re-selecting the active family drops a half-built gen.
   */
  private ensureGenerations(): void {
    const cfg = this.cfg
    if (!cfg) return
    const fam = embedModel(cfg.embedModel).family
    const now = Date.now()
    const active = this.activeGen()
    if (!active) {
      this.st.get("INSERT INTO memory_generations (family, model, dim, created_utc, state) VALUES (?, ?, ?, ?, 'active')").run(fam, cfg.embedModel, BigInt(cfg.dim), now)
      return
    }
    const building = this.buildingGen()
    if (active.family === fam && active.dim === cfg.dim) {
      if (active.model !== cfg.embedModel) this.st.get('UPDATE memory_generations SET model = ? WHERE gen = ?').run(cfg.embedModel, BigInt(active.gen))
      if (building) this.dropGeneration(building.gen)
      return
    }
    if (building && building.family === fam && building.dim === cfg.dim) {
      if (building.model !== cfg.embedModel) this.st.get('UPDATE memory_generations SET model = ? WHERE gen = ?').run(cfg.embedModel, BigInt(building.gen))
      return
    }
    if (building) this.dropGeneration(building.gen)
    this.st.get("INSERT INTO memory_generations (family, model, dim, created_utc, state) VALUES (?, ?, ?, ?, 'building')").run(fam, cfg.embedModel, BigInt(cfg.dim), now)
    // Re-embed what the active generation covers (those messages were consented to, 07 C12).
    const n = this.dbx.prepare('INSERT OR IGNORE INTO embed_queue (message_id) SELECT DISTINCT message_id FROM vector_bits WHERE gen = ?').run(BigInt(active.gen)).changes
    this.reindexTotal = num(n)
    this.recount()
  }

  /** Delete a generation and its rows (chunked; the gen row goes first so nothing new is written to it). */
  private dropGeneration(gen: number): void {
    this.vectorEpoch++
    this.st.get('DELETE FROM memory_generations WHERE gen = ?').run(BigInt(gen))
    void this.deleteGenRows(gen).catch((e: unknown) => this.log('warn', 'dropping a generation failed', e))
  }

  private async deleteGenRows(gen: number): Promise<number> {
    let total = 0
    for (;;) {
      if (!this.db) return total
      const ids = (this.st.get('SELECT message_id FROM vector_bits WHERE gen = ? LIMIT ?').all(BigInt(gen), BigInt(TX_ROWS)) as Row[]).map((r) => big(num(r.message_id)))
      if (!ids.length) break
      writeTx(this.dbx, () => {
        this.st.get(`DELETE FROM vectors WHERE gen = ? AND message_id IN (${marks(ids.length)})`).run(BigInt(gen), ...ids)
        this.st.get(`DELETE FROM vector_bits WHERE gen = ? AND message_id IN (${marks(ids.length)})`).run(BigInt(gen), ...ids)
      })
      total += ids.length
      await yieldNow()
    }
    // Rows without bits (should not exist, but never leave vectors behind).
    this.st.get('DELETE FROM vectors WHERE gen = ?').run(BigInt(gen))
    return total
  }

  /** The building gen is complete when nothing is left to embed: it becomes active, the old gen is cleared. */
  private maybeSwap(): void {
    const b = this.buildingGen()
    if (!b || this.queued > 0) return
    const a = this.activeGen()
    writeTx(this.dbx, () => {
      if (a) this.st.get("UPDATE memory_generations SET state = 'retired' WHERE gen = ?").run(BigInt(a.gen))
      this.st.get("UPDATE memory_generations SET state = 'active' WHERE gen = ?").run(BigInt(b.gen))
    })
    this.reindexTotal = 0
    this.log('info', `memory generation ${b.gen} is now active`)
    if (a) {
      void this.deleteGenRows(a.gen)
        .then(() => this.st.get("DELETE FROM memory_generations WHERE gen = ? AND state = 'retired'").run(BigInt(a.gen)))
        .catch((e: unknown) => this.log('warn', 'clearing the retired generation failed', e))
    }
    if (this.indexState !== 'idle') {
      this.index?.clear()
      this.index = null
      this.indexState = 'idle'
      this.indexGen = null
      void this.loadIndex()
    }
    this.emitStatus()
  }

  // ── bit index (07 C10) ─────────────────────────────────────────────────────────────────────
  /** Stream vector_bits of the active gen into memory in 50k-row read chunks. */
  loadIndex(): Promise<void> {
    if (this.indexState === 'ready' && this.indexGen === this.activeGen()?.gen) return Promise.resolve()
    if (this.loading) return this.loading
    const gen = this.activeGen()
    if (!gen) return Promise.resolve()
    this.indexState = 'loading'
    this.emitStatus()
    this.loading = (async () => {
      const idx = new BitIndex(gen.dim)
      const read = this.st.get('SELECT message_id, session_id, ts_utc, bits FROM vector_bits WHERE gen = ? AND message_id > ? ORDER BY message_id LIMIT ?')
      let after = 0n
      for (;;) {
        if (!this.db) return
        const rows = read.all(BigInt(gen.gen), after, BigInt(READ_CHUNK)) as Row[]
        for (const r of rows) {
          const bits = r.bits as Uint8Array
          if (bits.length === gen.dim / 8) idx.add(num(r.message_id), num(r.session_id), num(r.ts_utc), bits)
        }
        if (rows.length < READ_CHUNK) break
        after = big(num(rows[rows.length - 1].message_id))
        await yieldNow()
      }
      this.index = idx
      this.indexGen = gen.gen
      this.indexState = 'ready'
    })()
      .catch((e: unknown) => {
        this.indexState = 'idle'
        this.log('error', 'loading the memory index failed', e)
      })
      .finally(() => {
        this.loading = null
        this.emitStatus()
      })
    return this.loading
  }

  // ── status ─────────────────────────────────────────────────────────────────────────────────
  private recount(): void {
    const q = this.st.get('SELECT count(*) AS c FROM embed_queue WHERE last_error IS NULL OR last_error <> ?').get(SKIP) as Row
    const s = this.st.get('SELECT count(*) AS c FROM embed_queue WHERE last_error = ?').get(SKIP) as Row
    this.queued = num(q.c)
    this.skipped = num(s.c)
  }

  status(): WorkerStatus {
    const cfg = this.cfg
    const model = cfg ? embedModel(cfg.embedModel) : null
    const tier = this.scheduler.tier()
    const batch = model ? this.scheduler.batchTokenCap(model.tier1Tpm, model.maxRequestTokens, MAX_BATCH_TOKENS) : MAX_BATCH_TOKENS
    const eta = model && this.client ? this.scheduler.etaSec(this.queued, this.avgTokens, model.tier1Tpm, batch, MAX_INPUTS) : null
    const active = this.db ? this.activeGen() : null
    const building = this.db ? this.buildingGen() : null
    let problem = this.problem
    // A long queue under rate limiting is the backlog the UI explains (07 C19).
    if (problem?.code === 'provider_rate' && eta !== null && eta > BACKLOG_ETA_SEC) problem = { code: 'voyage_backlog', atUtc: problem.atUtc }
    return {
      index: this.indexState,
      indexed: this.index?.live ?? (active ? this.countGen(active.gen) : 0),
      queued: this.queued,
      errors: this.skipped,
      tier,
      rpmUsed: this.scheduler.rpmUsed(),
      queueEtaSec: eta,
      problem,
      model: active?.model ?? null,
      dim: active?.dim ?? null,
      activeGen: active?.gen ?? null,
      reindex: building ? { gen: building.gen, done: this.countGen(building.gen), total: Math.max(this.reindexTotal, this.countGen(building.gen) + this.queued) } : null
    }
  }

  /** Distinct messages with bits in a gen (only used before the index is loaded, and for re-index progress). */
  private countCache = new Map<number, { at: number; n: number }>()
  /**
   * Query embeddings by (model, dim, text), kept QUERY_CACHE_MS (Phase 3 engine-int, 07 D6): Talk mode starts the
   * embedding of the speech-to-text partial/final (`prefetch`) so the auto-recall that follows finds it ready.
   * In-flight embeddings are shared, so a search arriving mid-prefetch waits for it (within its own deadline).
   */
  private queryCache = new Map<string, { at: number; vec: Float32Array }>()
  private queryInflight = new Map<string, Promise<Float32Array>>()
  private countGen(gen: number): number {
    const c = this.countCache.get(gen)
    const now = Date.now()
    if (c && now - c.at < 30_000) return c.n
    const n = num((this.st.get('SELECT count(*) AS c FROM vector_bits WHERE gen = ? AND chunk = 0').get(BigInt(gen)) as Row).c)
    if (this.countCache.size > 8) this.countCache.clear()
    this.countCache.set(gen, { at: now, n })
    return n
  }

  /** Coalesced status push (≤ 1 per 200 ms, only when something changed). */
  emitStatus(): void {
    if (this.statusTimer || this.stopped) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (this.stopped || !this.db) return
      const s = this.status()
      const json = JSON.stringify(s)
      if (json === this.lastStatusJson) return
      this.lastStatusJson = json
      this.post({ t: 'status', status: s })
    }, 200)
  }

  // ── embed queue: the background lane ────────────────────────────────────────────────────────
  /** Schedule a drain pass after `ms` (replacing a later one). */
  private kick(ms: number): void {
    if (this.stopped || !this.db) return
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drain()
    }, Math.max(0, ms))
    this.drainTimer.unref?.()
  }

  private canEmbed(): boolean {
    const cfg = this.cfg
    return !!cfg && cfg.enabled && !cfg.paused && !!this.client && !this.deletingIndex && this.problem?.code !== 'provider_auth' && this.problem?.code !== 'provider_not_found'
  }

  /** Drain the embed queue in batches until it is empty, rate-limited or Voyage fails (joins a pass in progress). */
  drain(): Promise<void> {
    if (this.stopped || !this.db) return Promise.resolve()
    this.drainP ??= this.drainPass().finally(() => {
      this.drainP = null
    })
    return this.drainP
  }

  private drainP: Promise<void> | null = null

  private async drainPass(): Promise<void> {
    this.draining = true
    try {
      while (!this.stopped && this.db && this.canEmbed()) {
        const gen = this.targetGen()
        if (!gen) break
        const batch = this.nextBatch(gen)
        if (batch === 'empty') {
          this.recount()
          this.maybeSwap()
          const next = this.st.get('SELECT min(next_try_utc) AS t FROM embed_queue WHERE last_error IS NULL OR last_error <> ?').get(SKIP) as Row
          if (next.t !== null && next.t !== undefined) this.kick(Math.max(1000, num(next.t) - Date.now()))
          break
        }
        if (batch === 'again') {
          await yieldNow()
          continue
        }
        const model = embedModel(this.cfg!.embedModel)
        const wait = this.scheduler.backgroundWaitMs(batch.tokens, model.tier1Tpm)
        if (wait > 0) {
          this.kick(wait)
          break
        }
        const ok = await this.embedBatch(gen, batch.items)
        this.recount()
        this.emitStatus()
        if (!ok) break
        await yieldNow()
      }
    } catch (e) {
      this.log('error', 'embedding failed', e)
      this.kick(30_000)
    } finally {
      this.draining = false
      this.emitStatus()
    }
  }

  /**
   * Pick the next batch from the queue (newest first, so fresh messages become searchable soonest). Rows that can't
   * or mustn't be embedded (deleted, hidden, private, memory off, off-path, trivial) are removed on the way.
   */
  private nextBatch(gen: Gen): 'empty' | 'again' | { items: BatchItem[]; tokens: number } {
    const cfg = this.cfg!
    const model = embedModel(cfg.embedModel)
    const cap = this.scheduler.batchTokenCap(model.tier1Tpm, model.maxRequestTokens, MAX_BATCH_TOKENS)
    const now = Date.now()
    const rows = this.st
      .get('SELECT message_id FROM embed_queue WHERE next_try_utc <= ? AND (last_error IS NULL OR last_error <> ?) ORDER BY message_id DESC LIMIT ?')
      .all(now, SKIP, BigInt(MAX_INPUTS)) as Row[]
    if (!rows.length) return 'empty'
    const ids = rows.map((r) => num(r.message_id))
    const msgs = this.st
      .get(
        `SELECT m.id, m.session_id, m.seq, m.tag, m.body, m.ts_utc, m.status, m.on_path, m.hidden, m.deleted, s.private, s.memory, s.deleted_utc
         FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id IN (${marks(ids.length)})`
      )
      .all(...ids.map(big)) as Row[]
    const byId = new Map(msgs.map((m) => [num(m.id), m]))
    const drop: number[] = []
    const later: number[] = []
    const items: BatchItem[] = []
    let tokens = 0
    // The context neighbour must itself be usable: a deleted (forgotten) or hidden message never goes to Voyage as
    // "In reply to:" / "Replying to:" context (07 B9/C18, F15) — then the message is embedded without context.
    const prevStmt = this.st.get('SELECT tag, body FROM messages WHERE session_id = ? AND on_path = 1 AND seq = ? AND deleted = 0 AND hidden = 0')
    const hasGen = this.st.get('SELECT 1 FROM vector_bits WHERE message_id = ? AND gen = ? LIMIT 1')
    for (const id of ids) {
      const m = byId.get(id)
      if (!m || !eligible(m)) {
        drop.push(id)
        continue
      }
      if (String(m.status) === 'streaming') {
        later.push(id)
        continue
      }
      if (hasGen.get(big(id), BigInt(gen.gen))) {
        drop.push(id)
        continue
      }
      const prev = num(m.seq) > 1 ? (prevStmt.get(big(num(m.session_id)), BigInt(num(m.seq) - 1)) as Row | undefined) : undefined
      const inputs = embedInputs({ tag: String(m.tag) as RoleTag, body: String(m.body), prev: prev ? { tag: String(prev.tag) as RoleTag, body: String(prev.body) } : null })
      if (!inputs.length) {
        drop.push(id)
        continue
      }
      const t = inputs.reduce((s, x) => s + estimateTokens(x), 0)
      if (items.length && (tokens + t > cap || items.reduce((s, x) => s + x.inputs.length, 0) + inputs.length > MAX_INPUTS)) break
      items.push({ id, sessionId: num(m.session_id), tsUtc: num(m.ts_utc), inputs: inputs.map((x) => (estimateTokens(x) > cap ? x.slice(0, cap * 5) : x)) })
      tokens += Math.min(t, cap)
    }
    if (drop.length || later.length) {
      writeTx(this.dbx, () => {
        for (const c of chunks(drop, TX_ROWS)) this.st.get(`DELETE FROM embed_queue WHERE message_id IN (${marks(c.length)})`).run(...c.map(big))
        for (const c of chunks(later, TX_ROWS)) this.st.get(`UPDATE embed_queue SET next_try_utc = ? WHERE message_id IN (${marks(c.length)})`).run(now + STREAMING_RETRY_MS, ...c.map(big))
      })
    }
    if (!items.length) return drop.length || later.length ? 'again' : 'empty'
    return { items, tokens }
  }

  /** Embed one batch (splitting it on a 400 until the bad input is isolated). False = stop draining for now. */
  private async embedBatch(gen: Gen, items: BatchItem[], epoch = this.vectorEpoch): Promise<boolean> {
    const cfg = this.cfg!
    const model = embedModel(cfg.embedModel)
    const inputs = items.flatMap((i) => i.inputs)
    const tokens = inputs.reduce((s, x) => s + estimateTokens(x), 0)
    if (!this.avgMeasured) this.avgTokens = Math.max(8, Math.round(tokens / Math.max(1, inputs.length)))
    this.scheduler.record(tokens)
    const ctl = new AbortController()
    this.inflight.add(ctl)
    try {
      const r = await this.client!.embed({ input: inputs, model: cfg.embedModel, inputType: 'document', dim: gen.dim, dtype: 'int8' }, ctl.signal)
      this.scheduler.onSuccess()
      if (this.problem && this.problem.code !== 'provider_auth') this.problem = null
      const measured = (r.tokens || tokens) / Math.max(1, inputs.length)
      this.avgTokens = Math.max(8, Math.round(this.avgMeasured ? 0.7 * this.avgTokens + 0.3 * measured : measured))
      this.avgMeasured = true
      this.writeVectors(gen, items, r.vectors, epoch)
      return true
    } catch (e) {
      if (!(e instanceof VoyageError)) throw e
      if (e.kind === 'aborted') return false
      const at = Date.now()
      switch (e.kind) {
        case 'rate':
          this.scheduler.onRateLimited(e.retryAfterMs)
          this.problem = { code: 'provider_rate', atUtc: at }
          this.kick(this.scheduler.backgroundWaitMs(0, model.tier1Tpm) || 1000)
          return false
        case 'server':
        case 'network':
        case 'timeout':
          this.problem = { code: e.kind === 'server' ? 'provider_overloaded' : 'network', atUtc: at }
          this.kick(this.scheduler.backoff(e.retryAfterMs))
          this.bumpAttempts(items.map((i) => i.id))
          return false
        case 'bad_request':
          if (items.length === 1) {
            this.markSkipped(items[0].id, 'bad_request')
            return true
          }
          {
            const mid = Math.ceil(items.length / 2)
            for (const half of [items.slice(0, mid), items.slice(mid)]) {
              const w = this.scheduler.backgroundWaitMs(half.reduce((s, x) => s + x.inputs.reduce((a, b) => a + estimateTokens(b), 0), 0), model.tier1Tpm)
              if (w > 0) {
                this.kick(w)
                return false
              }
              if (!(await this.embedBatch(gen, half, epoch))) return false
            }
          }
          return true
        case 'auth':
        case 'forbidden':
          this.problem = { code: 'provider_auth', atUtc: at }
          this.log('warn', 'Voyage refused the key; embedding stopped until the key changes')
          return false
        default:
          this.problem = { code: e.kind === 'not_found' || e.kind === 'gone' ? 'provider_not_found' : 'provider_bad_request', atUtc: at }
          return false
      }
    } finally {
      this.inflight.delete(ctl)
    }
  }

  private bumpAttempts(ids: number[]): void {
    writeTx(this.dbx, () => {
      for (const c of chunks(ids, TX_ROWS)) this.st.get(`UPDATE embed_queue SET attempts = attempts + 1 WHERE message_id IN (${marks(c.length)})`).run(...c.map(big))
    })
  }

  private markSkipped(id: number, why: string): void {
    this.st.get('UPDATE embed_queue SET last_error = ?, attempts = attempts + 1 WHERE message_id = ?').run(SKIP, big(id))
    this.log('warn', `an input was rejected by Voyage and is skipped (${why})`)
  }

  /**
   * Write int8 vectors + sign bits and drop the queue rows, re-checking eligibility inside the transaction: a delete,
   * privacy toggle or path switch that happened while the request was in flight wins (07 B9).
   */
  private writeVectors(gen: Gen, items: BatchItem[], vectors: Int8Array[], epoch: number): void {
    // A generation drop or "delete index" happened while the request was in flight: the vectors are stale.
    if (!this.db || epoch !== this.vectorEpoch || this.deletingIndex || !this.genExists(gen.gen)) return
    let v = 0
    const check = this.st.get(
      `SELECT m.on_path, m.hidden, m.deleted, s.private, s.memory, s.deleted_utc FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`
    )
    const delV = this.st.get('DELETE FROM vectors WHERE message_id = ? AND gen = ?')
    const delB = this.st.get('DELETE FROM vector_bits WHERE message_id = ? AND gen = ?')
    const insV = this.st.get('INSERT INTO vectors (message_id, chunk, gen, model, dim, v) VALUES (?, ?, ?, ?, ?, ?)')
    const insB = this.st.get('INSERT INTO vector_bits (message_id, chunk, gen, session_id, ts_utc, bits) VALUES (?, ?, ?, ?, ?, ?)')
    const delQ = this.st.get('DELETE FROM embed_queue WHERE message_id = ?')
    const added: { item: BatchItem; bits: Uint8Array[] }[] = []
    for (const group of chunks(items, Math.max(1, Math.floor(TX_ROWS / 2)))) {
      writeTx(this.dbx, () => {
        for (const item of group) {
          const vecs = vectors.slice(v, v + item.inputs.length)
          v += item.inputs.length
          const m = check.get(big(item.id)) as Row | undefined
          delQ.run(big(item.id))
          if (!m || !eligible(m)) continue
          delV.run(big(item.id), BigInt(gen.gen))
          delB.run(big(item.id), BigInt(gen.gen))
          const bitsList: Uint8Array[] = []
          vecs.forEach((vec, chunk) => {
            const bits = signBits(vec)
            insV.run(big(item.id), BigInt(chunk), BigInt(gen.gen), this.cfg!.embedModel, BigInt(gen.dim), new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
            insB.run(big(item.id), BigInt(chunk), BigInt(gen.gen), big(item.sessionId), item.tsUtc, bits)
            bitsList.push(bits)
          })
          added.push({ item, bits: bitsList })
        }
      })
    }
    const counted = this.countCache.get(gen.gen)
    if (counted) counted.n += added.length
    if (this.index && this.indexGen === gen.gen) {
      for (const a of added) {
        this.index.flagMessages(new Set([a.item.id]), FLAG_DEAD, true)
        for (const bits of a.bits) this.index.add(a.item.id, a.item.sessionId, a.item.tsUtc, bits)
      }
      this.index.compactIfNeeded()
    }
  }

  private genExists(gen: number): boolean {
    return !!this.st.get('SELECT 1 FROM memory_generations WHERE gen = ?').get(BigInt(gen))
  }

  // ── flags from the main process ────────────────────────────────────────────────────────────
  /**
   * Message delete / forget: vectors, bits and queue rows go now (07 B9). The next on-path message was embedded with
   * the deleted one as its "In reply to:" context, so its vectors still encode the deleted text: they go too and it is
   * queued again (only when it had vectors — the owner consented to embedding it; F15).
   */
  private deleteVectors(ids: number[]): void {
    if (!ids.length || !this.db) return
    const requeue: number[] = []
    const gone = new Set(ids)
    writeTx(this.dbx, () => {
      for (const c of chunks(ids, TX_ROWS)) {
        const b = c.map(big)
        for (const r of this.st
          .get(
            `SELECT DISTINCT n.id FROM messages d
               JOIN messages n ON n.session_id = d.session_id AND n.on_path = 1 AND n.seq = d.seq + 1
              WHERE d.id IN (${marks(c.length)}) AND d.on_path = 1 AND n.deleted = 0
                AND EXISTS (SELECT 1 FROM vector_bits vb WHERE vb.message_id = n.id)`
          )
          .all(...b) as Row[])
          if (!gone.has(num(r.id))) requeue.push(num(r.id))
        this.st.get(`DELETE FROM vectors WHERE message_id IN (${marks(c.length)})`).run(...b)
        this.st.get(`DELETE FROM vector_bits WHERE message_id IN (${marks(c.length)})`).run(...b)
        this.st.get(`DELETE FROM embed_queue WHERE message_id IN (${marks(c.length)})`).run(...b)
      }
      for (const c of chunks(requeue, TX_ROWS)) {
        const b = c.map(big)
        this.st.get(`DELETE FROM vectors WHERE message_id IN (${marks(c.length)})`).run(...b)
        this.st.get(`DELETE FROM vector_bits WHERE message_id IN (${marks(c.length)})`).run(...b)
        for (const x of b) this.st.get('INSERT OR IGNORE INTO embed_queue (message_id) VALUES (?)').run(x)
      }
    })
    this.index?.flagMessages(new Set([...ids, ...requeue]), FLAG_DEAD, true)
    if (requeue.length) this.kick(0)
    this.index?.compactIfNeeded()
    this.countCache.clear()
    this.recount()
    this.emitStatus()
  }

  /**
   * Private on → the session's vectors, bits and queue rows are deleted (07 B9: never sent to Voyage, nothing kept).
   * Memory off / deleted → queue rows go (vectors stay until purge; scope clamps exclude the session).
   */
  private async sessionFlagged(sessionId: number): Promise<void> {
    if (!this.db) return
    const s = this.st.get('SELECT private, memory, deleted_utc FROM sessions WHERE id = ?').get(big(sessionId)) as Row | undefined
    const gone = !s
    const priv = gone || num(s.private) === 1
    const out = gone || priv || String(s.memory) === 'off' || s.deleted_utc !== null
    if (!out) return
    const idsOf = this.st.get('SELECT id FROM messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?')
    let after = 0n
    for (;;) {
      if (!this.db) return
      const ids = (idsOf.all(big(sessionId), after, BigInt(TX_ROWS)) as Row[]).map((r) => big(num(r.id)))
      if (!ids.length) break
      writeTx(this.dbx, () => {
        this.st.get(`DELETE FROM embed_queue WHERE message_id IN (${marks(ids.length)})`).run(...ids)
        if (priv) {
          this.st.get(`DELETE FROM vectors WHERE message_id IN (${marks(ids.length)})`).run(...ids)
          this.st.get(`DELETE FROM vector_bits WHERE message_id IN (${marks(ids.length)})`).run(...ids)
        }
      })
      after = ids[ids.length - 1]
      await yieldNow()
    }
    if (priv) {
      this.index?.killSession(sessionId)
      this.index?.compactIfNeeded()
      this.countCache.clear()
    }
    this.recount()
    this.emitStatus()
  }

  /** Variant switch (07 C3): re-read on_path for the session's indexed rows; enqueue newly on-path messages. */
  private pathChanged(sessionId: number): void {
    if (!this.db) return
    if (this.index) {
      const ids = this.index.messagesOfSession(sessionId)
      const on = new Set<number>()
      const off = new Set<number>()
      for (const c of chunks(ids, TX_ROWS)) {
        for (const r of this.st.get(`SELECT id, on_path FROM messages WHERE id IN (${marks(c.length)})`).all(...c.map(big)) as Row[]) {
          ;(num(r.on_path) === 1 ? on : off).add(num(r.id))
        }
      }
      this.index.flagMessages(off, FLAG_OFF_PATH, true)
      this.index.flagMessages(on, FLAG_OFF_PATH, false)
    }
    if (!this.cfg?.enabled) return
    const gen = this.targetGen()
    if (!gen) return
    // Only within the part of the session that was already embedded (its owner consented to that, 07 C12).
    const first = this.st
      .get('SELECT min(b.message_id) AS id FROM vector_bits b JOIN messages m ON m.id = b.message_id WHERE m.session_id = ? AND b.gen = ?')
      .get(big(sessionId), BigInt(gen.gen)) as Row
    if (first.id === null || first.id === undefined) return
    const r = this.st
      .get(
        `INSERT OR IGNORE INTO embed_queue (message_id)
         SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id = ? AND m.on_path = 1 AND m.hidden = 0 AND m.deleted = 0 AND m.id >= ?
           AND s.private = 0 AND s.memory <> 'off' AND s.deleted_utc IS NULL
           AND NOT EXISTS (SELECT 1 FROM vector_bits b WHERE b.message_id = m.id AND b.gen = ?)`
      )
      .run(big(sessionId), big(num(first.id)), BigInt(gen.gen))
    if (num(r.changes) > 0) {
      this.recount()
      this.kick(2000)
    }
    this.emitStatus()
  }

  // ── requests ───────────────────────────────────────────────────────────────────────────────
  private async request(id: number, op: string, args: unknown): Promise<void> {
    this.lastActivity = Date.now()
    try {
      let result: unknown
      switch (op) {
        case 'search':
          result = await this.search(args as SearchArgs)
          break
        case 'fts':
          result = this.fts(args as FtsPageArgs)
          break
        case 'status':
          result = this.status()
          break
        case 'stats':
          result = this.stats((args as { gc?: boolean }).gc === true)
          break
        case 'prefetch':
          result = await this.prefetch(args as { query: string })
          break
        case 'loadIndex': {
          const t0 = performance.now()
          await this.loadIndex()
          result = { indexed: this.index?.live ?? 0, ms: Math.round(performance.now() - t0) }
          break
        }
        case 'drain':
          // Finish a pass already running, then make one more so everything queued so far was attempted.
          await this.drain()
          await this.drain()
          result = { queued: this.queued }
          break
        default:
          throw new Error(`unknown op ${op}`)
      }
      this.post({ t: 'res', id, ok: true, result })
    } catch (e) {
      this.log('warn', `request ${op} failed`, e)
      this.post({ t: 'res', id, ok: false, error: toApiError(e) })
    }
  }

  private stats(gc: boolean): { heapUsed: number; sizes: Record<string, number> } {
    if (gc) {
      let run = (globalThis as { gc?: () => void }).gc
      // Leak tests in test builds: expose V8's collector inside this thread.
      if (!run && __VESPER_TEST__) {
        v8.setFlagsFromString('--expose_gc')
        run = vm.runInNewContext('gc') as () => void
      }
      run?.()
    }
    return {
      heapUsed: process.memoryUsage().heapUsed,
      sizes: {
        inflight: this.inflight.size,
        jobs: this.jobs.size,
        statements: this.st?.size ?? 0,
        schedulerWindow: this.scheduler.windowSize,
        countCache: this.countCache.size,
        queryCache: this.queryCache.size,
        queryInflight: this.queryInflight.size,
        index: this.index?.size ?? 0,
        indexBytes: this.index?.bytes ?? 0
      }
    }
  }

  private filterOf(sessionIds: number[] | null, after: number | null, before: number | null, includeOffPath: boolean): ScopeFilter {
    return { allowed: allowedBitmap(sessionIds), sessionIds, after, before, includeOffPath }
  }

  private fts(a: FtsPageArgs): { items: { id: number; snippet: string; score: number }[]; next: number | null } {
    const f = { ...this.filterOf(a.sessionIds, a.after ?? null, a.before ?? null, a.includeOffPath), role: a.role ?? null }
    return ftsPage(this.st, { query: a.query, f, beforeId: a.beforeId, order: a.order, limit: a.limit })
  }

  /** The memory search pipeline (research 02 §5.3 steps 3–6). */
  async search(a: SearchArgs): Promise<SearchResult> {
    const t0 = performance.now()
    const timings: Record<string, number> = {}
    const f = this.filterOf(a.sessionIds, a.after, a.before, a.includeOffPath === true)
    const kw = keywordLeg(this.st, a.query, f)
    timings.keyword = performance.now() - t0
    let vec: { id: number; cos: number }[] = []
    let degraded: SearchResult['degraded']
    const cfg = this.cfg
    const active = this.activeGen()
    if (!a.voyage) degraded = 'not-allowed'
    else if (!cfg?.enabled) degraded = 'disabled'
    else if (!this.client) degraded = 'no-key'
    else if (!active) degraded = 'loading'
    else if (this.indexState !== 'ready' || this.indexGen !== active.gen) {
      degraded = 'loading'
      void this.loadIndex()
    } else {
      const t1 = performance.now()
      try {
        const q = await this.queryEmbedding(a.query, active, a.deadline)
        timings.embed = performance.now() - t1
        const t2 = performance.now()
        vec = vectorLeg(this.st, this.index!, active.gen, q, f, undefined, timings)
        timings.vector = performance.now() - t2
      } catch (e) {
        degraded = e instanceof BudgetExceeded || (e instanceof VoyageError && (e.kind === 'timeout' || e.kind === 'aborted')) ? 'budget' : 'voyage-error'
        if (e instanceof VoyageError) this.noteForegroundError(e)
      }
    }
    const fused = rrf([kw.map((k) => k.id), vec.map((v) => v.id)]).slice(0, Math.max(a.limit, RERANK_TOP))
    const cos = new Map(vec.map((v) => [v.id, v.cos]))
    const kwRank = new Map(kw.map((k, i) => [k.id, i]))
    const atts = new Map(kw.filter((k) => k.att).map((k) => [k.id, k.att!]))
    const bodies = this.bodies(fused.map((x) => x.id))
    /** The message text plus, for an attachment hit, the matching words of its file (F72). */
    const textOf = (id: number): string => {
      const b = bodies.get(id)!.body
      const att = atts.get(id)
      return att ? `${b}\n${attachmentLine(att)}` : b
    }
    // Local score (0..1) = max(cosine, share of query terms present); the fused rank breaks ties.
    let items: SearchItem[] = fused
      .filter((x) => bodies.has(x.id))
      .map((x) => {
        const c = cos.get(x.id)
        const via: SearchItem['via'] = { ...(kwRank.has(x.id) ? { keyword: kwRank.get(x.id)! + 1 } : {}), ...(c !== undefined ? { vector: Math.round(c * 1000) / 1000 } : {}) }
        const att = atts.get(x.id)
        return { id: x.id, score: Math.max(overlapScore(a.query, textOf(x.id)), c ?? 0), via, ...(att ? { attachment: att } : {}) }
      })
    const mode: SearchResult['mode'] = vec.length || (!degraded && a.voyage) ? 'hybrid' : 'keyword'
    const rm = cfg?.rerankModel ?? 'none'
    let reranked = false
    if (a.rerank && mode === 'hybrid' && !degraded && rm !== 'none' && this.scheduler.tier() !== 'free' && items.length > 1 && a.deadline - Date.now() > RERANK_MIN_MS) {
      const t3 = performance.now()
      try {
        // 07 B9 defence in depth: whatever ids the caller passed, a private, memory-off or trashed chat's text is
        // never sent to Voyage — such items keep their local order after the reranked ones.
        const top = items.filter((it) => bodies.get(it.id)!.shareable).slice(0, RERANK_TOP)
        const local = items.filter((it) => !bodies.get(it.id)!.shareable)
        const docs = top.map((it) => {
          const b = bodies.get(it.id)!
          return rerankDocument(b.tag, formatDate(zoneOf(b.tzName, b.tzOffsetMin).partsAt(b.tsUtc)), textOf(it.id))
        })
        if (top.length) {
          const r = await this.rerank(a.query, docs, rm, a.deadline)
          items = [...r.map((x) => ({ ...top[x.index], score: x.score, via: { ...top[x.index].via, rerank: Math.round(x.score * 1000) / 1000 } })), ...local]
          reranked = true
        }
        timings.rerank = performance.now() - t3
      } catch (e) {
        if (e instanceof VoyageError) this.noteForegroundError(e)
      }
    }
    if (!reranked) {
      const order = new Map(items.map((x, i) => [x.id, i]))
      items.sort((x, y) => y.score - x.score || order.get(x.id)! - order.get(y.id)!)
    }
    timings.total = performance.now() - t0
    return {
      items: items.slice(0, a.limit).map((x) => ({ id: x.id, score: Math.round(x.score * 10000) / 10000, via: x.via, ...(x.attachment ? { attachment: x.attachment } : {}) })),
      mode,
      ...(degraded ? { degraded } : {}),
      timings
    }
  }

  private noteForegroundError(e: VoyageError): void {
    const at = Date.now()
    if (e.kind === 'rate') {
      this.scheduler.onRateLimited(e.retryAfterMs)
      this.problem = { code: 'provider_rate', atUtc: at }
    } else if (e.kind === 'auth' || e.kind === 'forbidden') this.problem = { code: 'provider_auth', atUtc: at }
    else if (e.kind === 'server') this.problem = { code: 'provider_overloaded', atUtc: at }
    else if (e.kind === 'network') this.problem = { code: 'network', atUtc: at }
    this.emitStatus()
  }

  private async withDeadline<T>(deadline: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController()
    this.inflight.add(ctl)
    const timer = setTimeout(() => ctl.abort(), Math.max(1, deadline - Date.now()))
    try {
      return await fn(ctl.signal)
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ctl)
    }
  }

  private async queryEmbedding(query: string, gen: Gen, deadline: number): Promise<Float32Array> {
    const model = this.cfg!.embedModel
    // Same family → the configured model; otherwise the active generation's own model (its space).
    const useModel = embedModel(model).family === gen.family ? model : gen.model
    const info = embedModel(useModel)
    const text = query.slice(0, 8000)
    const key = `${useModel}|${gen.dim}|${text}`
    const hit = this.queryCache.get(key)
    if (hit && Date.now() - hit.at < QUERY_CACHE_MS) return hit.vec
    const running = this.queryInflight.get(key)
    if (running) return this.beforeDeadline(running, deadline)
    const p = this.scheduler
      .foreground(estimateTokens(text), info.tier1Tpm, deadline, () =>
        this.withDeadline(deadline, async (signal) => {
          const r = await this.client!.embed({ input: [text], model: useModel, inputType: 'query', dim: gen.dim, dtype: 'float' }, signal)
          return r.vectors[0]
        })
      )
      .then((vec) => {
        this.queryCache.delete(key)
        this.queryCache.set(key, { at: Date.now(), vec })
        while (this.queryCache.size > QUERY_CACHE_MAX) this.queryCache.delete(this.queryCache.keys().next().value as string)
        return vec
      })
      .finally(() => this.queryInflight.delete(key))
    this.queryInflight.set(key, p)
    return p
  }

  /** `p`, or BudgetExceeded once `deadline` passes (the shared embedding keeps running for its owner). */
  private beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BudgetExceeded()), Math.max(1, deadline - Date.now()))
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  /**
   * Start a query embedding ahead of the search that will need it (07 D6: the first ≥ 4-word stt.partial in Talk
   * mode). Best effort: loads the index if needed; never throws; nothing is searched.
   */
  private async prefetch(a: { query: string }): Promise<{ cached: boolean }> {
    const query = typeof a.query === 'string' ? a.query.trim() : ''
    const active = this.activeGen()
    if (!query || !this.cfg?.enabled || !this.client || !active) return { cached: false }
    if (this.indexState !== 'ready' || this.indexGen !== active.gen) void this.loadIndex().catch(() => undefined)
    try {
      await this.queryEmbedding(query, active, Date.now() + PREFETCH_BUDGET_MS)
      return { cached: true }
    } catch (e) {
      if (e instanceof VoyageError) this.noteForegroundError(e)
      return { cached: false }
    }
  }

  private async rerank(query: string, docs: string[], model: string, deadline: number): Promise<{ index: number; score: number }[]> {
    const instr = `Find earlier chat messages that tell what the user is referring to. Query: ${query.slice(0, 2000)}`
    const tokens = estimateTokens(instr) * docs.length + docs.reduce((s, d) => s + estimateTokens(d), 0)
    return this.scheduler.foreground(tokens, rerankModel(model).tier1Tpm, deadline, () =>
      this.withDeadline(deadline, async (signal) => (await this.client!.rerank({ query: instr, documents: docs, model, topK: docs.length }, signal)).results)
    )
  }

  /** Bodies of candidate messages, and whether their chat may reach Voyage at all (07 B9: not private, memory on, not trashed). */
  private bodies(ids: number[]): Map<number, { tag: RoleTag; body: string; tsUtc: number; tzName: string | null; tzOffsetMin: number; shareable: boolean }> {
    const out = new Map<number, { tag: RoleTag; body: string; tsUtc: number; tzName: string | null; tzOffsetMin: number; shareable: boolean }>()
    for (const c of chunks(ids, 500)) {
      for (const r of this.st
        .get(
          `SELECT m.id, m.tag, m.body, m.ts_utc, m.tz_name, m.tz_offset_min, s.private, s.memory, s.deleted_utc
             FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id IN (${marks(c.length)})`
        )
        .all(...c.map(big)) as Row[]) {
        out.set(num(r.id), {
          tag: String(r.tag) as RoleTag,
          body: String(r.body),
          tsUtc: num(r.ts_utc),
          tzName: r.tz_name === null ? null : String(r.tz_name),
          tzOffsetMin: num(r.tz_offset_min),
          shareable: num(r.private) === 0 && String(r.memory) !== 'off' && r.deleted_utc === null
        })
      }
    }
    return out
  }

  // ── idle maintenance (07 C9) ───────────────────────────────────────────────────────────────
  private async maintenance(): Promise<void> {
    if (!this.db || this.draining || Date.now() - this.lastActivity < IDLE_MS || this.jobs.size) return
    try {
      for (let i = 0; i < 10; i++) {
        this.dbx.exec("INSERT INTO messages_fts (messages_fts, rank) VALUES ('merge', 200)")
        await yieldNow()
        if (!this.db) return
      }
      let wal = 0
      try {
        wal = fs.statSync(`${this.dbFile}-wal`).size
      } catch {
        /* no WAL file */
      }
      this.dbx.exec(`PRAGMA wal_checkpoint(${wal > WAL_TRUNCATE_BYTES ? 'TRUNCATE' : 'PASSIVE'})`)
    } catch (e) {
      this.log('warn', 'idle maintenance failed', e)
    }
  }

  /** After bulk writes (07 C9): checkpoint now — PASSIVE, or TRUNCATE once the WAL is over 64 MB. */
  private checkpointAfterBulk(): void {
    let wal = 0
    try {
      wal = fs.statSync(`${this.dbFile}-wal`).size
    } catch {
      /* no WAL file */
    }
    try {
      this.dbx.exec(`PRAGMA wal_checkpoint(${wal > WAL_TRUNCATE_BYTES ? 'TRUNCATE' : 'PASSIVE'})`)
    } catch {
      /* readers active; the idle checkpoint catches up */
    }
  }

  // ── bulk jobs (07 C9) ──────────────────────────────────────────────────────────────────────
  private cancelJob(j: JobHandle): void {
    j.cancelled = true
    j.ac.abort()
    // A job waiting on the main process (job.call) must not hang on a reply that will never come.
    for (const c of j.calls.values()) c.reject(new Cancelled('cancelled'))
    j.calls.clear()
  }

  /** Counts for leak checks (jobs and their pending main-process calls return to zero). */
  jobSizes(): { jobs: number; calls: number } {
    let calls = 0
    for (const j of this.jobs.values()) calls += j.calls.size
    return { jobs: this.jobs.size, calls }
  }

  private async runJob(id: number, job: JobSpec): Promise<void> {
    const handle: JobHandle = { cancelled: false, ac: new AbortController(), calls: new Map() }
    this.jobs.set(id, handle)
    this.lastActivity = Date.now()
    const progress = (done: number, total: number) => this.post({ t: 'job.progress', id, done, total })
    const check = () => {
      if (handle.cancelled || this.stopped) throw new Cancelled('cancelled')
    }
    const data = {
      signal: handle.ac.signal,
      progress: (phase: string, done: number, total: number | null) => this.post({ t: 'job.progress', id, done, total: total ?? -1, phase }),
      call: <K extends JobCallOp>(op: K, args: JobCalls[K]['args']) =>
        new Promise<JobCalls[K]['result']>((resolve, reject) => {
          check()
          const callId = ++this.callSeq
          handle.calls.set(callId, { resolve: resolve as (v: unknown) => void, reject })
          this.post({ t: 'job.call', id, callId, op, args })
        }),
      log: this.logger()
    }
    try {
      const result = await this.job(job, progress, check, data)
      this.post({ t: 'job.done', id, result })
    } catch (e) {
      this.post({ t: 'job.error', id, error: e instanceof Cancelled ? apiError('conflict', { message: 'The job was cancelled.' }) : toApiError(e) })
      if (!(e instanceof Cancelled)) this.log('warn', `job ${job.kind} failed`, e)
    } finally {
      handle.calls.clear()
      this.jobs.delete(id)
      this.lastActivity = Date.now()
    }
  }

  /** The services Log shape over the worker's log messages (data jobs log through it). */
  private logger(): Log {
    const at =
      (level: 'debug' | 'info' | 'warn' | 'error') =>
      (msg: string, data?: Record<string, unknown>): void =>
        this.post({ t: 'log', level, msg, ...(data ? { data: safeLogData(data) } : {}) })
    const log: Log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => log }
    return log
  }

  private async job(j: JobSpec, progress: (d: number, t: number) => void, check: () => void, data: DataJobContext): Promise<JobResult> {
    switch (j.kind) {
      case 'checkpoint':
        this.dbx.exec(`PRAGMA wal_checkpoint(${j.mode})`)
        return { kind: 'checkpoint' }
      case 'optimize':
        for (let i = 0; i < 50; i++) {
          check()
          this.dbx.exec("INSERT INTO messages_fts (messages_fts, rank) VALUES ('merge', 200)")
          progress(i + 1, 50)
          await yieldNow()
        }
        return { kind: 'optimize' }
      case 'backup': {
        const pages = await backup(this.dbx, j.file)
        return { kind: 'backup', file: j.file, pages: Number(pages) }
      }
      case 'estimate':
        return { kind: 'estimate', estimate: await this.estimate(j.sessionIds, check) }
      case 'backfill': {
        const est = await this.estimate(j.sessionIds, check)
        const queued = await this.enqueueEligible(j.sessionIds, check, progress)
        return { kind: 'backfill', queued, estTokens: est.estTokens }
      }
      case 'reindex': {
        if (j.scope === 'all') {
          const cfg = this.cfg
          const a = this.activeGen()
          if (cfg && a) {
            const b = this.buildingGen()
            if (b) this.dropGeneration(b.gen)
            this.st
              .get("INSERT INTO memory_generations (family, model, dim, created_utc, state) VALUES (?, ?, ?, ?, 'building')")
              .run(embedModel(cfg.embedModel).family, cfg.embedModel, BigInt(cfg.dim), Date.now())
          }
        }
        const queued = await this.enqueueEligible(null, check, progress)
        this.reindexTotal = this.buildingGen() ? queued : 0
        return { kind: 'reindex', queued }
      }
      case 'deleteIndex': {
        let n = 0
        // Batches in flight now are discarded (epoch) and none starts until the rows are gone (canEmbed).
        this.deletingIndex = true
        this.vectorEpoch++
        try {
          for (const g of this.gens()) n += await this.deleteGenRows(g.gen)
          writeTx(this.dbx, () => {
            this.dbx.exec('DELETE FROM memory_generations')
            this.dbx.exec('DELETE FROM embed_queue')
          })
        } finally {
          this.deletingIndex = false
          this.vectorEpoch++
        }
        this.index?.clear()
        this.index = null
        this.indexGen = null
        this.indexState = 'idle'
        this.countCache.clear()
        this.ensureGenerations()
        this.recount()
        this.emitStatus()
        return { kind: 'deleteIndex', vectors: n }
      }
      case 'purge':
        return this.purge(j, check, progress)
      case 'export':
        return { kind: 'export', out: await runExportJob(this.dbx, j, data) }
      case 'import': {
        const result = await runImportJob(this.dbx, j, data)
        // Imported rows are not queued for embedding (backfill consent, 07 C12); counts and the WAL catch up now.
        this.countCache.clear()
        this.recount()
        this.checkpointAfterBulk()
        this.emitStatus()
        return { kind: 'import', result }
      }
    }
  }

  private static ELIGIBLE = `s.private = 0 AND s.deleted_utc IS NULL AND s.memory <> 'off' AND m.on_path = 1 AND m.hidden = 0 AND m.deleted = 0
    AND m.status IN ('complete', 'stopped')`

  private maxMessageId(): number {
    return num((this.st.get('SELECT max(id) AS m FROM messages').get() as Row).m ?? 0)
  }

  /** Count what a backfill would embed (C12), in 50k-id read chunks (no read transaction > 1 s, 07 C9). */
  private async estimate(sessionIds: number[] | null, check: () => void): Promise<BackfillEstimate> {
    const gen = this.targetGen()
    const max = this.maxMessageId()
    const sessions = new Set<number>()
    let messages = 0
    let chars = 0
    const filter = sessionIds ? ` AND m.session_id IN (${marks(sessionIds.length)})` : ''
    const stmt = this.st.get(
      `SELECT m.session_id AS sid, count(*) AS c, sum(length(m.body)) AS chars FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.id > ? AND m.id <= ? AND ${Engine.ELIGIBLE}${filter}
         AND NOT EXISTS (SELECT 1 FROM vector_bits b WHERE b.message_id = m.id AND b.gen = ?)
         AND NOT EXISTS (SELECT 1 FROM embed_queue q WHERE q.message_id = m.id)
       GROUP BY m.session_id`
    )
    for (let lo = 0; lo < max; lo += SCAN_CHUNK) {
      check()
      for (const r of stmt.all(BigInt(lo), BigInt(lo + SCAN_CHUNK), ...(sessionIds ?? []).map(big), BigInt(gen?.gen ?? 0)) as Row[]) {
        sessions.add(num(r.sid))
        messages += num(r.c)
        chars += num(r.chars ?? 0)
      }
      await yieldNow()
    }
    // +25 % for the reply context each input carries (research 02 §5.5).
    const estTokens = Math.ceil((chars / 5) * 1.25)
    const model = embedModel(this.cfg?.embedModel ?? 'voyage-4-lite')
    const avg = messages ? Math.max(8, Math.round(estTokens / messages)) : this.avgTokens
    const batch = this.scheduler.batchTokenCap(model.tier1Tpm, model.maxRequestTokens, MAX_BATCH_TOKENS)
    return {
      messages,
      sessions: sessions.size,
      estTokens,
      estUsd: Math.round(((estTokens * model.usdPerMTok) / 1_000_000) * 100) / 100,
      estSeconds: this.scheduler.etaSec(messages, avg, model.tier1Tpm, batch, MAX_INPUTS) ?? 0
    }
  }

  /** Queue every eligible, not yet embedded message (optionally of some sessions), ≤ 500 rows per transaction. */
  private async enqueueEligible(sessionIds: number[] | null, check: () => void, progress: (d: number, t: number) => void): Promise<number> {
    const gen = this.targetGen()
    const max = this.maxMessageId()
    const filter = sessionIds ? ` AND m.session_id IN (${marks(sessionIds.length)})` : ''
    const pick = this.st.get(
      `SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.id > ? AND m.id <= ? AND ${Engine.ELIGIBLE}${filter}
         AND NOT EXISTS (SELECT 1 FROM vector_bits b WHERE b.message_id = m.id AND b.gen = ?)`
    )
    let queued = 0
    for (let lo = 0; lo < max; lo += SCAN_CHUNK) {
      check()
      const ids = (pick.all(BigInt(lo), BigInt(lo + SCAN_CHUNK), ...(sessionIds ?? []).map(big), BigInt(gen?.gen ?? 0)) as Row[]).map((r) => big(num(r.id)))
      for (const c of chunks(ids, TX_ROWS)) {
        queued += num(writeTx(this.dbx, () => this.st.get(`INSERT OR IGNORE INTO embed_queue (message_id) VALUES ${c.map(() => '(?)').join(',')}`).run(...c).changes))
        await yieldNow()
      }
      progress(Math.min(lo + SCAN_CHUNK, max), max)
    }
    this.recount()
    this.kick(0)
    this.emitStatus()
    return queued
  }

  /** Hard-delete sessions (given, or soft-deleted before a cutoff) and clear bodies of deleted messages (07 B9). */
  /** Hard-delete sessions (given, or soft-deleted before a cutoff) and clear bodies of deleted messages (07 B9). */
  private async purge(j: Extract<JobSpec, { kind: 'purge' }>, check: () => void, progress: (d: number, t: number) => void): Promise<JobResult> {
    const r = await purgeRows(this.dbx, this.st, j, check, progress, (sid) => this.index?.killSession(sid))
    this.index?.compactIfNeeded()
    this.countCache.clear()
    this.recount()
    try {
      this.dbx.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* readers active; the idle checkpoint catches up */
    }
    this.emitStatus()
    return { kind: 'purge', ...r }
  }

}

interface BatchItem {
  id: number
  sessionId: number
  tsUtc: number
  inputs: string[]
}

function eligible(m: Row): boolean {
  return (
    num(m.on_path) === 1 &&
    num(m.hidden) === 0 &&
    num(m.deleted) === 0 &&
    num(m.private) === 0 &&
    String(m.memory) !== 'off' &&
    (m.deleted_utc === null || m.deleted_utc === undefined) &&
    (m.status === undefined || m.status === 'complete' || m.status === 'stopped' || m.status === 'streaming')
  )
}

/** Never upstream bodies or stacks (07 C19). */
function toApiError(e: unknown): ApiError {
  if (e && typeof e === 'object' && 'info' in e && typeof (e as { info: unknown }).info === 'object') return (e as { info: ApiError }).info
  if (e instanceof VoyageError) return apiError(e.kind === 'auth' ? 'provider_auth' : e.kind === 'rate' ? 'provider_rate' : 'memory_unavailable')
  const msg = e instanceof Error ? e.message : ''
  if (/SQLITE_FULL|database or disk is full/i.test(msg)) return apiError('disk_full')
  if (/SQLITE_|database/i.test(msg)) return apiError('db_error')
  return apiError('internal')
}

/** Tier names for the status (re-exported for the main process). */
export type { VoyageTier }
