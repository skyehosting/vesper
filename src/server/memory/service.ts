/**
 * MemoryService (07 C10–C13, services.ts) in the main process. It decides WHAT may be searched (scope clamp, privacy,
 * time window) and how results read (rounds, budget, untrusted formatting); db.worker does the searching, embedding
 * and bulk work. Keyword-only (FTS) whenever Voyage is off, has no key, isn't allowed for the scope, or misses its
 * budget — the chat is never blocked by memory.
 */
import path from 'node:path'
import { VesperError } from '@shared/errors'
import type { SearchQuery } from '@shared/api'
import type { MemoryHit, MemoryStatus, SearchHit, SessionSummary } from '@shared/types/domain'
import { storeOf } from '../chat/temporary'
import { coreOf } from '../core'
import type { MessageRow, SessionRow } from '../db/repos'
import { isBusy, retryBusy } from '../db/sqlite'
import { toMessage, toSummary } from '../http/convert'
import { effectiveVoyageUrl, registerVoyageProvider, voyageKey } from '../providers/voyage'
import type { MemoryQuery, MemoryService, RecallQuery, ScopeCtx, ServerContext } from '../services'
import type { BackfillEstimate, JobResult, JobSpec, SearchItem, SearchResult, WorkerConfig, WorkerStatus } from './engine/protocol'
import { allowedBitmap, attachmentSnippet, ftsPage, keywordLeg } from './engine/search'
import { Stmts } from './engine/sql'
import { attachmentLine, overlapScore } from './engine/text'
import { createFacts, type FactsApi } from './facts'
import { formatHits, formatManifest, type ManifestEntry } from './format'
import { WorkerLink, type JobRunOptions } from './link'
import { epochStartSeq, expandRounds, recentlyInjected, toHit } from './rounds'
import { parseBound, REFUSALS, resolveScope, zoneForSession, type ResolvedScope } from './scope'
import type { EngineOptions } from './engine/engine'
import { normalizeShortId } from '@shared/ids'

/** Budgets (07 C11): auto-recall 400 ms, explicit search 1.2 s. */
export const AUTO_RECALL_BUDGET_MS = 400
export const SEARCH_BUDGET_MS = 1200
const MANIFEST_MAX = 30
const PROGRESS_THROTTLE_MS = 500
const LAZY_START_MS = 30_000
const STATUS_KV = 'memory.status'

export interface MemoryServiceImpl extends MemoryService {
  readonly facts: FactsApi
  readonly link: WorkerLink
  /** True when a Voyage key is saved for the configured base URL. */
  hasKey(): boolean
  /** Start the worker now (first memory use) and load the index. */
  warm(): Promise<void>
  /** The UI search box (GET /api/search). */
  uiSearch(q: SearchQuery): Promise<{ items: SearchHit[]; next: string | null }>
  /** POST /api/memory/recall: a manual /recall within the session's scope (no context exclusion). */
  manualRecall(query: string, sessionUid: string): Promise<MemoryHit[]>
  backfillEstimate(sessionUids?: string[]): Promise<BackfillEstimate>
  backfill(choice: 'all' | 'new' | 'sessions', sessionUids?: string[]): Promise<{ queued: number; estTokens: number; estSeconds: number }>
  manifest(): { sessions: Array<SessionSummary & { links: string[]; linkedFrom: string[] }>; exportedUtc: number }
  /** Forget one message from memory: soft delete (FTS row goes via the trigger) + vectors, bits, queue (07 B9). */
  forget(messageUid: string): void
  /** Drop the whole memory index (vectors, bits, queue, generations); messages stay. */
  deleteIndex(): Promise<{ vectors: number }>
  /** Record which messages were injected into an AI reply (the "Remembered" chip; auto-recall dedupe). */
  recordInjections(sessionUid: string, turnMessageUid: string, hits: Pick<MemoryHit, 'messageUid'>[]): void
  /**
   * Hold or resume background embedding for a reason ('game-mode', 'low-disk', …; 07 D3/C19). Embedding stays held
   * while any reason is set; searches are unaffected.
   */
  setBackgroundPaused(reason: string, paused: boolean): void
  /** Bulk jobs in db.worker (07 C9) — export / import / purge / backup / checkpoint / optimize / reindex (content's export/import since platform-int). */
  runJob(spec: JobSpec, o?: JobRunOptions): Promise<JobResult>
  /**
   * Start the Voyage query embedding for text a search will likely use soon (07 D6: Talk mode's first ≥ 4-word
   * stt.partial, then the final). Only where that search would reach Voyage (scope allows it, key set, not the free
   * tier — its 3 RPM are kept for real searches). Best effort; resolves to whether an embedding is cached.
   * (Additive, Phase 3 engine-int.)
   */
  prefetchQuery(text: string, scope: ScopeCtx): Promise<boolean>
}

export interface MemoryServiceOptions {
  /** Directory of db.worker.js (defaults to the server's workersDir). */
  workersDir?: string
  engine?: EngineOptions
}

const services = new WeakMap<ServerContext, MemoryServiceImpl>()

/** The full memory API (beyond the MemoryService interface) for route modules and other agents. */
export function memoryOf(ctx: ServerContext): MemoryServiceImpl {
  const m = services.get(ctx)
  if (!m) throw new VesperError('memory_unavailable')
  return m
}

export function createMemoryService(ctx: ServerContext, opts: MemoryServiceOptions = {}): MemoryServiceImpl {
  const log = ctx.log.child('memory')
  let keyCache = false
  let closed = false
  let lastBroadcast = ''
  let progressTimer: NodeJS.Timeout | null = null
  let lazyTimer: NodeJS.Timeout | null = null
  const facts = createFacts(ctx)
  let workersDir = opts.workersDir
  if (!workersDir) {
    try {
      workersDir = coreOf(ctx).opts.workersDir
    } catch {
      workersDir = undefined
    }
  }

  const pauses = new Set<string>()

  async function workerConfig(o: { loadIndex?: boolean } = {}): Promise<WorkerConfig> {
    const s = ctx.settings.get().memory
    const key = await voyageKey(ctx)
    keyCache = key !== null
    return {
      enabled: s.enabled,
      baseUrl: effectiveVoyageUrl(s.voyage.baseUrl),
      key,
      embedModel: s.voyage.embedModel,
      rerankModel: s.voyage.rerankModel,
      dim: s.voyage.dim,
      tier: s.voyage.tier,
      ...(pauses.size ? { paused: true } : {}),
      ...(o.loadIndex ? { loadIndex: true } : {})
    }
  }

  const link = new WorkerLink({
    script: workersDir ? path.join(workersDir, 'db.worker.js') : null,
    dbFile: path.join(ctx.paths.roaming, 'vesper.db'),
    log: log.child('worker'),
    config: () => workerConfig(),
    onStatus: () => scheduleProgress(),
    onFailed: () => scheduleProgress(),
    engine: opts.engine
  })

  async function reconfigure(o: { loadIndex?: boolean } = {}): Promise<void> {
    const cfg = await workerConfig(o)
    if (closed) return
    if (!link.started && cfg.enabled && cfg.key) await link.start().catch((e: unknown) => log.warn('starting db.worker failed', { error: e }))
    link.sendIfStarted({ t: 'config', config: cfg })
    scheduleProgress()
  }

  // ── status & memory.progress ────────────────────────────────────────────────────────────────
  function compute(ws: WorkerStatus | null): MemoryStatus {
    const s = ctx.settings.get().memory
    const snap = ws ?? ctx.repos.kv.get<WorkerStatus>(STATUS_KV)
    const base: MemoryStatus = {
      state: 'ready',
      model: snap?.model ?? s.voyage.embedModel,
      dim: snap?.dim ?? s.voyage.dim,
      indexed: snap?.indexed ?? 0,
      queued: snap?.queued ?? 0,
      errors: snap?.errors ?? 0,
      tier: snap?.tier ?? 'unknown',
      queueEtaSec: snap?.queueEtaSec ?? null,
      rpmUsed: ws?.rpmUsed ?? 0,
      reindex: snap?.reindex ?? null
    }
    if (!s.enabled) return { ...base, state: 'disabled', queueEtaSec: null }
    if (link.dead) return { ...base, state: 'error', lastError: { code: 'memory_unavailable', message: 'Memory stopped working; restart Vesper.', atUtc: ctx.clock.now() } }
    if (!keyCache) return { ...base, state: 'keyword-only', queueEtaSec: null }
    const p = ws?.problem
    if (p) {
      const msg = VESPER_MESSAGES[p.code]
      if (p.code === 'provider_auth' || p.code === 'provider_not_found') return { ...base, state: 'error', lastError: { code: p.code, message: msg, atUtc: p.atUtc } }
      return { ...base, state: ws?.index === 'loading' ? 'loading' : 'degraded', lastError: { code: p.code, message: msg, atUtc: p.atUtc } }
    }
    if (ws?.index === 'loading') return { ...base, state: 'loading' }
    return base
  }

  function scheduleProgress(): void {
    if (progressTimer || closed) return
    progressTimer = setTimeout(() => {
      progressTimer = null
      if (closed) return
      const status = compute(link.lastStatus)
      const json = JSON.stringify(status)
      if (json === lastBroadcast) return
      lastBroadcast = json
      ctx.hub.broadcast({ t: 'memory.progress', status })
    }, PROGRESS_THROTTLE_MS)
    progressTimer.unref?.()
  }

  // ── scope helpers ───────────────────────────────────────────────────────────────────────────
  function scopeFor(sc: ScopeCtx): ResolvedScope {
    return resolveScope(ctx, sc, { hasKey: keyCache })
  }

  /** Run the worker search, falling back to a main-thread keyword leg if the worker is unavailable. */
  async function runSearch(query: string, r: ResolvedScope, o: { after: number | null; before: number | null; budgetMs: number; limit: number; rerank: boolean; includeOffPath?: boolean }): Promise<SearchResult> {
    if (!r.sessionIds.length) return { items: [], mode: 'keyword', timings: {} }
    const args = {
      query,
      sessionIds: r.sessionIds,
      after: o.after,
      before: o.before,
      voyage: r.voyage,
      rerank: o.rerank,
      deadline: Date.now() + Math.max(50, o.budgetMs - 25),
      limit: o.limit,
      includeOffPath: o.includeOffPath ?? false
    }
    try {
      return await link.request('search', args, o.budgetMs + 1500)
    } catch (e) {
      log.warn('memory search fell back to the main thread', { error: e })
      const st = new Stmts(ctx.db)
      const kw = keywordLeg(st, query, { allowed: allowedBitmap(r.sessionIds), sessionIds: r.sessionIds, after: o.after, before: o.before, includeOffPath: o.includeOffPath ?? false })
      st.clear()
      const items: SearchItem[] = []
      for (const k of kw.slice(0, o.limit)) {
        const m = ctx.repos.messages.byId(BigInt(k.id))
        if (m) items.push({ id: k.id, score: overlapScore(query, k.att ? `${m.body}\n${attachmentLine(k.att)}` : m.body), via: { keyword: items.length + 1 }, ...(k.att ? { attachment: k.att } : {}) })
      }
      items.sort((a, b) => b.score - a.score)
      return { items, mode: 'keyword', degraded: 'voyage-error', timings: {} }
    }
  }

  function hitsFor(r: ResolvedScope, res: SearchResult, o: { minScore: number; maxRounds: number; auto: boolean; excludeContext: boolean }): MemoryHit[] {
    const settings = ctx.settings.get().memory
    const s = r.session
    return expandRounds(ctx, res.items, {
      minScore: o.minScore,
      maxRounds: o.maxRounds,
      maxTokens: settings.maxRecallTokens,
      exclude: o.auto && s ? recentlyInjected(ctx, s.id) : new Set(),
      contextSessionId: o.excludeContext && s ? s.id : null,
      // Before the session's first epoch exists (its first turn), the message being answered is already persisted
      // (and FTS-indexed): it is in the turn itself, never "recalled" back to the model.
      contextFromSeq: o.excludeContext && s ? (epochStartSeq(ctx, s) ?? latestUserSeq(s)) : null
    })
  }

  // ── the service ─────────────────────────────────────────────────────────────────────────────
  const svc: MemoryServiceImpl = {
    facts,
    link,
    hasKey: () => keyCache,

    async warm() {
      await reconfigure({ loadIndex: true })
      if (!link.started) await link.start()
      await link.request('loadIndex', {}, 60_000)
    },

    async search(q: MemoryQuery, scope: ScopeCtx, budgetMs: number) {
      const r = scopeFor(scope)
      // The refusal reaches the model as such, never as "nothing found" (F27).
      if (r.refused) return { hits: [], mode: 'keyword' as const, refused: r.refused }
      const settings = ctx.settings.get().memory
      const zone = zoneForSession(ctx, r.session)
      const limit = Math.max(1, Math.min(settings.maxRecallRounds, Math.trunc(q.limit ?? settings.maxRecallRounds)))
      const res = await runSearch(q.query, r, { after: parseBound(q.after, zone), before: parseBound(q.before, zone), budgetMs, limit: limit * 4, rerank: true })
      const hits = hitsFor(r, res, { minScore: settings.searchMinScore, maxRounds: limit, auto: false, excludeContext: true })
      return { hits, mode: res.mode }
    },

    async recall(rq: RecallQuery, scope: ScopeCtx) {
      const r = scopeFor({ sessionUid: scope.sessionUid })
      if (r.refused) return { hits: [], refused: r.refused }
      const normalized = normalizeShortId(rq.shortId)
      const short = normalized ?? rq.shortId.replace(/^#/, '').toUpperCase().slice(0, 12)
      const target = normalized ? ctx.repos.sessions.byShortId(normalized) : null
      if (!target || target.deletedUtc !== null) return { hits: [], refused: REFUSALS.unknownSession(short) }
      const self = r.session && r.session.id === target.id
      if (!self && target.private) return { hits: [], refused: REFUSALS.privateSession(short) }
      // Recall reaches the session itself, its links, or any open session when the scope is 'all'.
      const reach = resolveScope(ctx, { sessionUid: scope.sessionUid, requested: 'all' }, { hasKey: keyCache })
      if (!self && !reach.sessionIds.includes(Number(target.id))) {
        // Say why it is out of reach (F30, second pass): the /link hint only when a link would actually help.
        const why =
          target.memory === 'off'
            ? REFUSALS.targetOff(short)
            : !r.session
              ? REFUSALS.temporaryScope(short)
              : reach.scope === 'this'
                ? REFUSALS.scopeThis(short)
                : REFUSALS.notLinked(short)
        return { hits: [], refused: why }
      }
      const settings = ctx.settings.get().memory
      const last = Math.max(1, Math.min(40, Math.trunc(rq.last ?? 20)))
      if (rq.query && rq.query.trim()) {
        const one: ResolvedScope = { ...r, sessionIds: [Number(target.id)], voyage: r.voyage && !target.private }
        const res = await runSearch(rq.query, one, { after: null, before: null, budgetMs: SEARCH_BUDGET_MS, limit: last * 2, rerank: true })
        return { hits: hitsFor(one, res, { minScore: 0, maxRounds: Math.min(settings.maxRecallRounds, Math.ceil(last / 2)), auto: false, excludeContext: !!self }) }
      }
      let rows: MessageRow[]
      if (rq.around) {
        const zone = zoneForSession(ctx, target)
        const at = parseBound(rq.around, zone)
        if (at === null) rows = ctx.repos.messages.tail(target.id, last)
        else {
          const center = seqAtTime(target, at)
          // A window of `last` messages centred on that date, shifted to stay inside the session.
          const start = Math.max(1, Math.min(center - Math.floor(last / 2), target.lastSeq - last + 1))
          rows = ctx.repos.messages.range(target.id, start, last)
        }
      } else rows = ctx.repos.messages.tail(target.id, last)
      const hits = rows.filter((m) => !m.hidden && !m.deleted && m.body.trim() !== '').map((m) => toHit(m, target, 1))
      return { hits }
    },

    async sessions(query: string | undefined, scope: ScopeCtx) {
      const r = scopeFor({ sessionUid: scope.sessionUid, requested: scope.requested ?? 'all' })
      if (r.refused) return { text: r.refused, refused: r.refused }
      const self = r.session
      const zone = zoneForSession(ctx, self)
      const linked = new Set(self ? ctx.repos.sessions.links(self.id).map((l) => Number(l.id)) : [])
      const q = query?.trim().toLowerCase() ?? ''
      const short = q ? normalizeShortId(q) : null
      const rows: SessionRow[] = []
      for (const id of r.sessionIds) {
        const s = ctx.repos.sessions.byId(BigInt(id))
        if (!s) continue
        if (q && !(short && s.shortId === short) && !s.title.toLowerCase().includes(q) && !(s.summary ?? '').toLowerCase().includes(q)) continue
        rows.push(s)
      }
      rows.sort((a, b) => (b.lastMessageUtc ?? b.createdUtc) - (a.lastMessageUtc ?? a.createdUtc))
      const entries: ManifestEntry[] = rows.slice(0, MANIFEST_MAX).map((s) => ({
        shortId: s.shortId,
        title: s.title,
        createdUtc: s.createdUtc,
        lastUtc: s.lastMessageUtc,
        count: s.messageCount,
        summary: s.private ? null : s.summary,
        self: !!self && s.id === self.id,
        linked: linked.has(Number(s.id))
      }))
      return { text: formatManifest(entries, { nowUtc: ctx.clock.now(), zone, total: rows.length, query: q || undefined }) }
    },

    async autoRecall(text: string, scope: ScopeCtx, budgetMs: number) {
      const r = scopeFor(scope)
      if (r.refused || !ctx.settings.get().memory.autoRecall) return []
      const settings = ctx.settings.get().memory
      // Auto-recall stays cheap: k = 3 rounds, the higher threshold, no rerank (research 02 §5.3).
      const res = await runSearch(text.slice(0, 2000), r, { after: null, before: null, budgetMs, limit: 12, rerank: false })
      return hitsFor(r, res, { minScore: settings.autoRecallMinScore, maxRounds: 3, auto: true, excludeContext: true })
    },

    formatResult(hits, o) {
      return formatHits(hits, { ...o, clock: ctx.settings.get().profile.clock })
    },

    onMessagePersisted(messageId: bigint) {
      const settings = ctx.settings.get().memory
      if (!settings.enabled || !keyCache || closed) return
      const m = ctx.repos.messages.byId(messageId)
      if (!m || m.hidden || m.deleted || !m.onPath) return
      const s = ctx.repos.sessions.byId(m.sessionId)
      if (!s || s.private || s.memory === 'off' || s.deletedUtc !== null) return
      try {
        ctx.repos.embedQueue.enqueue(messageId)
      } catch (e) {
        if (!isBusy(e)) throw e
        // 07 C9: db.worker holds the write lock; queue the row a moment later instead of blocking (never lost).
        retryBusy(() => ctx.repos.embedQueue.enqueue(messageId))
          .then(() => link.send({ t: 'enqueued', count: 1 }))
          .catch((err: unknown) => log.warn('could not queue a message for embedding', { error: err }))
        return
      }
      link.send({ t: 'enqueued', count: 1 })
    },

    onSessionFlagsChanged(sessionId: bigint) {
      if (closed) return
      link.send({ t: 'sessionFlagged', sessionId: Number(sessionId) })
    },

    onPathChanged(sessionId: bigint) {
      if (closed) return
      if (link.started) link.sendIfStarted({ t: 'pathChanged', sessionId: Number(sessionId) })
      else if (ctx.settings.get().memory.enabled && keyCache) link.send({ t: 'pathChanged', sessionId: Number(sessionId) })
    },

    onMessagesDeleted(ids: bigint[]) {
      if (closed || !ids.length) return
      link.send({ t: 'messagesDeleted', ids: ids.map(Number) })
    },

    status() {
      return compute(link.lastStatus)
    },

    async reindex(scope: 'all' | 'missing') {
      const r = await link.job({ kind: 'reindex', scope })
      return { queued: r.kind === 'reindex' ? r.queued : 0 }
    },

    async uiSearch(q) {
      const limit = Math.max(1, Math.min(100, Math.trunc(q.limit ?? 30)))
      let sessionIds: number[]
      let one: SessionRow | null = null
      if (q.scope === 'session') {
        if (!q.session) throw new VesperError('validation', { fields: { session: 'Which conversation?' } })
        one = ctx.repos.sessions.byUid(q.session)
        if (!one || one.deletedUtc !== null) throw new VesperError('not_found')
        sessionIds = [Number(one.id)]
      } else {
        sessionIds = (ctx.db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL').all() as { id: number | bigint }[]).map((r) => Number(r.id))
      }
      const sessions = new Map<bigint, SessionRow | null>()
      const sessionOf = (sid: bigint) => {
        if (!sessions.has(sid)) sessions.set(sid, ctx.repos.sessions.byId(sid))
        return sessions.get(sid) ?? null
      }
      const hit = (m: MessageRow, snippet: string, score?: number): SearchHit | null => {
        const s = sessionOf(m.sessionId)
        if (!s) return null
        return { message: toMessage(m, s.uid), session: { uid: s.uid, shortId: s.shortId, title: s.title }, snippet, onPath: m.onPath, ...(score !== undefined ? { score } : {}) }
      }
      if (q.mode === 'semantic') {
        const settings = ctx.settings.get().memory
        const o = { after: q.from ?? null, before: q.to ?? null, budgetMs: SEARCH_BUDGET_MS, limit, includeOffPath: true }
        // 07 B9: the query is the user's own typing and may go to Voyage, but the text of a private, memory-off chat
        // never does (no rerank document, F14). Those chats are searched on this PC only (keyword) and merged in.
        const flags = new Map(
          (ctx.db.prepare('SELECT id, private, memory FROM sessions WHERE deleted_utc IS NULL').all() as { id: number | bigint; private: number | bigint; memory: string }[]).map((r) => [
            Number(r.id),
            Number(r.private) === 0 && r.memory !== 'off'
          ])
        )
        const shareable = sessionIds.filter((id) => flags.get(id) === true)
        const local = sessionIds.filter((id) => flags.get(id) !== true)
        const voyage = settings.enabled && keyCache && shareable.length > 0
        const [far, near] = await Promise.all([
          voyage ? runSearch(q.q, { session: one, scope: 'all', sessionIds: shareable, voyage: true }, { ...o, rerank: true }) : null,
          runSearch(q.q, { session: one, scope: 'all', sessionIds: voyage ? local : sessionIds, voyage: false }, { ...o, rerank: false })
        ])
        const seen = new Set<number>()
        const merged = [...(far?.items ?? []), ...near.items]
          .sort((a, b) => b.score - a.score)
          .filter((it) => !seen.has(it.id) && !!seen.add(it.id))
          .slice(0, limit)
        const items: SearchHit[] = []
        for (const it of merged) {
          const m = ctx.repos.messages.byId(BigInt(it.id))
          if (!m || m.deleted || m.hidden) continue
          if (q.role && m.role !== q.role) continue
          const h = hit(m, it.attachment ? attachmentSnippet(it.attachment) : snippetOf(m.body, q.q), it.score)
          if (h) items.push(h)
        }
        return { items, next: null }
      }
      const before = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : null
      let page: { items: { id: number; snippet: string; score: number }[]; next: number | null }
      try {
        page = await link.request('fts', { query: q.q, sessionIds, beforeId: before, order: q.order ?? 'recent', limit, includeOffPath: true, role: q.role ?? null, after: q.from ?? null, before: q.to ?? null }, 5000)
      } catch (e) {
        if (e instanceof VesperError && e.info.code !== 'memory_unavailable') throw e
        const st = new Stmts(ctx.db)
        page = ftsPage(st, { query: q.q, f: { allowed: allowedBitmap(sessionIds), sessionIds, after: q.from ?? null, before: q.to ?? null, includeOffPath: true, role: q.role ?? null }, beforeId: before, order: q.order ?? 'recent', limit })
        st.clear()
      }
      const items: SearchHit[] = []
      for (const it of page.items) {
        const m = ctx.repos.messages.byId(BigInt(it.id))
        if (!m) continue
        const h = hit(m, it.snippet, q.order === 'relevance' ? it.score : undefined)
        if (h) items.push(h)
      }
      return { items, next: page.next === null ? null : String(page.next) }
    },

    async manualRecall(query, sessionUid) {
      const s = ctx.repos.sessions.byUid(sessionUid)
      if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
      const r = scopeFor({ sessionUid })
      if (r.refused) throw new VesperError('memory_unavailable', { message: r.refused })
      const settings = ctx.settings.get().memory
      const res = await runSearch(query, r, { after: null, before: null, budgetMs: SEARCH_BUDGET_MS, limit: settings.maxRecallRounds * 4, rerank: true })
      return hitsFor(r, res, { minScore: settings.searchMinScore, maxRounds: settings.maxRecallRounds, auto: false, excludeContext: false })
    },

    async backfillEstimate(sessionUids) {
      const ids = sessionUids ? idsOf(sessionUids) : null
      const r = await link.job({ kind: 'estimate', sessionIds: ids })
      if (r.kind !== 'estimate') throw new VesperError('internal')
      return r.estimate
    },

    async backfill(choice, sessionUids) {
      const now = ctx.clock.now()
      const all = (ctx.db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL AND private = 0').all() as { id: number | bigint }[]).map((r) => BigInt(r.id))
      let chosen: bigint[] = []
      if (choice === 'all') chosen = all
      else if (choice === 'sessions') {
        if (!sessionUids?.length) throw new VesperError('validation', { fields: { sessionUids: 'Choose at least one conversation.' } })
        chosen = idsOf(sessionUids).map((n) => BigInt(n))
      }
      // 07 C12: the choice is stored per session (meta.backfill).
      const chosenSet = new Set(chosen)
      for (const sid of all) {
        const s = ctx.repos.sessions.byId(sid)
        if (!s) continue
        const mark = chosenSet.has(sid) ? 'all' : choice === 'sessions' ? (s.meta.backfill === 'all' ? 'all' : 'new') : 'new'
        if (s.meta.backfill !== mark) ctx.repos.sessions.update(sid, { meta: { ...s.meta, backfill: mark } })
      }
      ctx.repos.kv.set('memory.backfill', { choice, atUtc: now })
      if (!chosen.length) return { queued: 0, estTokens: 0, estSeconds: 0 }
      const r = await link.job({ kind: 'backfill', sessionIds: choice === 'all' ? null : chosen.map(Number), nowUtc: now })
      if (r.kind !== 'backfill') throw new VesperError('internal')
      const st = link.lastStatus
      return { queued: r.queued, estTokens: r.estTokens, estSeconds: st?.queueEtaSec ?? 0 }
    },

    manifest() {
      const rows = ctx.db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL ORDER BY created_utc, id').all() as { id: number | bigint }[]
      const sessions = rows
        .map((r) => ctx.repos.sessions.byId(BigInt(r.id)))
        .filter((s): s is SessionRow => !!s)
        .map((s) => ({
          ...toSummary(ctx.db, s),
          links: ctx.repos.sessions.links(s.id).map((l) => l.shortId),
          linkedFrom: ctx.repos.sessions.linkedFrom(s.id).map((l) => l.shortId)
        }))
      return { sessions, exportedUtc: ctx.clock.now() }
    },

    forget(messageUid) {
      const m = ctx.repos.messages.byUid(messageUid)
      if (!m) throw new VesperError('not_found')
      const s = ctx.repos.sessions.byId(m.sessionId)
      if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
      ctx.repos.messages.softDelete(m.id, ctx.clock.now())
      ctx.db.prepare('DELETE FROM memory_injections WHERE message_id = ?').run(m.id)
      svc.onMessagesDeleted([m.id])
      ctx.hub.emit(s.uid, { t: 'message.deleted', sessionUid: s.uid, messageUid: m.uid })
    },

    async deleteIndex() {
      const r = await link.job({ kind: 'deleteIndex' })
      scheduleProgress()
      return { vectors: r.kind === 'deleteIndex' ? r.vectors : 0 }
    },

    recordInjections(sessionUid, turnMessageUid, hits) {
      if (!hits.length) return
      const st = storeOf(ctx, sessionUid)
      const s = st.repos.sessions.byUid(sessionUid)
      const turn = st.repos.messages.byUid(turnMessageUid)
      if (!s || !turn) return
      // A temporary chat's turn ids live in its own in-memory store (they count from 1 like vesper.db's): its rows go
      // to that store's memory_injections and vanish with it (07 B9, F71). The recalled messages are vesper.db's.
      const add = st.temporary
        ? (() => {
            const ins = st.db.prepare('INSERT INTO memory_injections (session_id, message_id, turn_message_id) VALUES (?, ?, ?)')
            return (messageId: bigint) => ins.run(s.id, messageId, turn.id)
          })()
        : (messageId: bigint) => ctx.repos.memoryInjections.add(s.id, messageId, turn.id)
      for (const h of hits) {
        const m = ctx.repos.messages.byUid(h.messageUid)
        if (m) add(m.id)
      }
    },

    runJob(spec, o) {
      return link.job(spec, o)
    },

    async prefetchQuery(text, scope) {
      if (closed) return false
      const r = scopeFor(scope)
      const query = text.slice(0, 2000)
      if (r.refused || !r.voyage || !r.sessionIds.length || !query.trim()) return false
      if ((link.lastStatus?.tier ?? 'unknown') === 'free') return false
      try {
        return (await link.request('prefetch', { query }, 5000)).cached
      } catch {
        return false
      }
    },

    setBackgroundPaused(reason, paused) {
      const had = pauses.size > 0
      if (paused) pauses.add(reason)
      else pauses.delete(reason)
      if (had !== pauses.size > 0) void reconfigure().catch((e: unknown) => log.warn('memory reconfigure failed', { error: e }))
    },

    async close() {
      if (closed) return
      closed = true
      if (progressTimer) clearTimeout(progressTimer)
      if (lazyTimer) clearTimeout(lazyTimer)
      progressTimer = lazyTimer = null
      unhookSettings()
      unhookSecrets()
      if (link.lastStatus) {
        try {
          ctx.repos.kv.set(STATUS_KV, { ...link.lastStatus, problem: null, index: 'idle', rpmUsed: 0 })
        } catch {
          /* the DB may be closing */
        }
      }
      await link.close()
    }
  }

  /**
   * First on-path seq at or after `at`: a binary search over seq (time grows along the path), so a huge session costs
   * ~20 index lookups instead of a scan (07 C9: main-thread statements stay O(page)).
   */
  function seqAtTime(s: SessionRow, at: number): number {
    const tsAt = ctx.db.prepare('SELECT ts_utc FROM messages WHERE session_id = ? AND on_path = 1 AND seq = ?')
    let lo = 1
    let hi = s.lastSeq
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const r = tsAt.get(s.id, BigInt(mid)) as { ts_utc: number } | undefined
      if (r && Number(r.ts_utc) >= at) hi = mid
      else lo = mid + 1
    }
    return Math.max(1, lo)
  }

  /** Seq of the newest on-path user message of `s` (the turn being answered), or past the end when none. */
  function latestUserSeq(s: SessionRow): number {
    const r = ctx.db.prepare("SELECT max(seq) AS seq FROM messages WHERE session_id = ? AND on_path = 1 AND role = 'user'").get(s.id) as { seq: number | bigint | null }
    return r.seq === null ? s.lastSeq + 1 : Number(r.seq)
  }

  function idsOf(uids: string[]): number[] {
    const out: number[] = []
    for (const u of uids) {
      const s = ctx.repos.sessions.byUid(u)
      if (s && s.deletedUtc === null && !s.private) out.push(Number(s.id))
    }
    return out
  }

  const unhookSettings = ctx.settings.subscribe('memory', () => {
    void reconfigure().catch((e: unknown) => log.warn('memory reconfigure failed', { error: e }))
  })
  const unhookSecrets = registerVoyageProvider(ctx, () => {
    void reconfigure().catch((e: unknown) => log.warn('memory reconfigure failed', { error: e }))
  })

  // Lazy start (07 D2): the key check now, the worker 30 s later if memory is on with a key (or at first use).
  void workerConfig()
    .then((cfg) => {
      if (closed) return
      scheduleProgress()
      if (cfg.enabled && cfg.key) {
        lazyTimer = setTimeout(() => {
          lazyTimer = null
          if (!closed) void reconfigure({ loadIndex: true }).catch(() => undefined)
        }, LAZY_START_MS)
        lazyTimer.unref?.()
      }
    })
    .catch((e: unknown) => log.warn('reading the Voyage key failed', { error: e }))

  services.set(ctx, svc)
  ctx.onClose(() => svc.close())
  return svc
}

/** User-facing messages for the worker's problem codes. */
const VESPER_MESSAGES: Record<NonNullable<WorkerStatus['problem']>['code'], string> = {
  provider_auth: 'Voyage AI did not accept the key. Memory uses keyword search until it is fixed.',
  provider_rate: 'Voyage AI is rate-limiting requests; indexing continues more slowly.',
  provider_overloaded: 'Voyage AI is having trouble; indexing will retry.',
  network: "Can't reach Voyage AI; indexing will retry. Memory uses keyword search meanwhile.",
  voyage_backlog: 'Memory is still indexing earlier messages (the free trial allows 3 requests per minute).',
  provider_not_found: 'The Voyage model was not found. Pick another model in Settings → Memory.',
  provider_bad_request: 'Voyage AI rejected a request.'
}

/** A plain-text snippet around the first query term, with «…» marks (semantic hits have no FTS snippet). */
export function snippetOf(body: string, query: string, width = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 2)
  const lower = flat.toLowerCase()
  let at = -1
  let term = ''
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) {
      at = i
      term = t
    }
  }
  if (at < 0) return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  const mark = `${flat.slice(start, at)}«${flat.slice(at, at + term.length)}»${flat.slice(at + term.length, end)}`
  return `${start > 0 ? '…' : ''}${mark}${end < flat.length ? '…' : ''}`
}
