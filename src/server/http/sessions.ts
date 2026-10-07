/**
 * Sessions: list, CRUD, links (incl. both ways), restore, /continue creation (07 C18), trash, and temporary chats
 * (07 B9: in-memory stores from ../chat/temporary.ts — listed only for the devices that have them open, ended by
 * DELETE). Emptying the trash runs on db.worker (07 C9), never blocking the main thread.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { normalizeShortId } from '@shared/ids'
import type { Session, SessionSummary } from '@shared/types/domain'
import { isTempChat, storeOf, temporaryChatsOf, type ChatStore } from '../chat/temporary'
import { coreOf } from '../core'
import { tx } from '../db/sqlite'
import type { SessionRow } from '../db/repos'
import { memoryOf } from '../memory/service'
import type { ServerContext } from '../services'
import { toSession, toSummary } from './convert'
import { parse, route, who } from './route'

const uidParams = z.object({ uid: z.string().min(1).max(64) })

/**
 * The STORED session behind `:uid` (vesper.db only); deleted sessions only when asked (restore, GET for the trash
 * view). Routes that also serve temporary chats use `storedOrTemporaryOr404`.
 */
export function sessionOr404(ctx: ServerContext, uid: string, o: { allowDeleted?: boolean } = {}): SessionRow {
  const s = ctx.repos.sessions.byUid(uid)
  if (!s || (s.deletedUtc !== null && !o.allowDeleted)) throw new VesperError('not_found')
  return s
}

/**
 * The session behind `:uid` and the store holding it — vesper.db or a temporary chat (07 B9). Internal ids belong to
 * that store: use `st.repos` / `st.db` with them, never ctx.repos.
 */
export function storedOrTemporaryOr404(ctx: ServerContext, uid: string, o: { allowDeleted?: boolean } = {}): { s: SessionRow; st: ChatStore } {
  const st = storeOf(ctx, uid)
  const s = st.repos.sessions.byUid(uid)
  if (!s || (s.deletedUtc !== null && !o.allowDeleted)) throw new VesperError('not_found')
  return { s, st }
}

/** Summary in a store (a temporary chat says so). */
export function summaryIn(st: ChatStore, s: SessionRow): SessionSummary {
  const sum = toSummary(st.db, s)
  return st.temporary ? { ...sum, temporary: true } : sum
}

function linkTarget(ctx: ServerContext, raw: string): SessionRow {
  const short = normalizeShortId(raw)
  const t = short ? ctx.repos.sessions.byShortId(short) : null
  if (!t || t.deletedUtc !== null) throw new VesperError('not_found', { message: `No chat #${raw.replace(/^#/, '')}.` })
  return t
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  filter: z.enum(['all', 'pinned', 'archived', 'trash']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
})

const createBody = z
  .object({
    title: z.string().max(200).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    promptId: z.number().int().positive().optional(),
    links: z.array(z.string().max(20)).max(100).optional(),
    continueFrom: z.string().max(64).optional(),
    speak: z.boolean().optional(),
    speakClientId: z.string().max(64).optional(),
    temporary: z.boolean().optional(),
    private: z.boolean().optional()
  })
  .strict()

const patchBody = z
  .object({
    title: z.string().max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    private: z.boolean().optional(),
    memory: z.enum(['inherit', 'on', 'off']).optional(),
    memoryScope: z.enum(['inherit', 'this', 'linked', 'all']).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    promptId: z.number().int().positive().nullable().optional(),
    llmProfile: z.string().max(64).nullable().optional(),
    model: z.string().max(200).nullable().optional(),
    voice: z.object({ provider: z.string().min(1).max(40), voiceId: z.string().min(1).max(200), model: z.string().max(80).optional() }).nullable().optional()
  })
  .strict()

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const core = coreOf(ctx)
  const repos = core.repos
  const temps = temporaryChatsOf(ctx)
  const fullIn = (st: ChatStore, s: SessionRow): Session => {
    const out = toSession(st.db, st.repos, s)
    return st.temporary ? { ...out, temporary: true } : out
  }
  const full = (s: SessionRow): Session => toSession(ctx.db, repos, s)

  /** Tell the session's subscribers and the sidebars that list it (a temporary chat: only its devices). */
  const changedIn = (st: ChatStore, s: SessionRow) => {
    ctx.hub.emit(s.uid, { t: 'session.updated', sessionUid: s.uid, session: summaryIn(st, s) })
    if (!isTempChat(st)) return ctx.hub.broadcast({ t: 'sessions.changed' })
    for (const d of st.devices) ctx.hub.broadcast({ t: 'sessions.changed' }, { deviceId: d })
  }
  const changed = (s: SessionRow) => changedIn({ temporary: false, ctx, repos, db: ctx.db }, s)

  route(app, 'GET /api/sessions', (req) => {
    const q = parse(listQuery, req.query)
    const r = repos.sessions.list({ q: q.q, cursor: q.cursor, filter: q.filter, limit: q.limit ?? 50 })
    const items = r.items.map((s) => toSummary(ctx.db, s))
    // 07 B9: a temporary chat appears (on the first page, newest first) only for the devices that have it open.
    if (!q.cursor && (q.filter ?? 'all') === 'all') {
      const needle = q.q?.trim().toLowerCase() ?? ''
      const mine = temps
        .forDevice(who(req).deviceId)
        .map((c) => temps.summary(c))
        .filter((x): x is SessionSummary => !!x && (!needle || x.title.toLowerCase().includes(needle)))
        .sort((a, b) => b.updatedUtc - a.updatedUtc)
      items.unshift(...mine)
    }
    return { items, next: r.next }
  })

  route(app, 'POST /api/sessions', (req) => {
    const b = parse(createBody, req.body)
    const now = ctx.clock.now()
    if (b.temporary) {
      // 07 B9: in memory only — no links (nothing to recall it from), no continuation, never private (never stored).
      if (b.links?.length || b.continueFrom !== undefined) throw new VesperError('validation', { message: "A temporary chat can't be linked or continued." })
      let systemPrompt = b.systemPrompt
      if (b.promptId !== undefined) {
        const p = repos.prompts.list().find((x) => x.id === b.promptId)
        if (!p) throw new VesperError('validation', { fields: { promptId: 'No such prompt' } })
        systemPrompt ??= p.body
      }
      const deviceId = who(req).deviceId
      const { chat, session } = temps.create({ title: b.title, systemPrompt, promptId: b.promptId ?? null, deviceId, now })
      ctx.hub.broadcast({ t: 'sessions.changed' }, { deviceId })
      return fullIn(chat, session)
    }
    const links = (b.links ?? []).map((l) => linkTarget(ctx, l))
    let systemPrompt = b.systemPrompt
    if (b.promptId !== undefined) {
      const p = repos.prompts.list().find((x) => x.id === b.promptId)
      if (!p) throw new VesperError('validation', { fields: { promptId: 'No such prompt' } })
      systemPrompt ??= p.body
    }
    const src = b.continueFrom !== undefined ? sessionOr404(ctx, b.continueFrom) : null

    const created = tx(ctx.db, () => {
      let s = repos.sessions.create({
        title: b.title ?? (src ? `${src.title || 'Untitled'} (cont.)` : undefined),
        systemPrompt: systemPrompt ?? src?.systemPrompt,
        promptId: b.promptId ?? src?.promptId ?? null,
        private: b.private ?? src?.private ?? false,
        meta: src ? { continuedFrom: src.uid } : {},
        now
      })
      for (const t of links) repos.sessions.addLink(s.id, t.id, now)
      if (src) {
        // 07 C18: the continuation inherits the source's settings and outgoing links, plus a link to the source.
        s = repos.sessions.update(s.id, { llmProfile: src.llmProfile, model: src.model, voice: src.voice, memory: src.memory, memoryScope: src.memoryScope })
        for (const t of repos.sessions.links(src.id)) repos.sessions.addLink(s.id, t.id, now)
        repos.sessions.addLink(s.id, src.id, now)
        repos.sessions.update(src.id, { meta: { ...src.meta, continuedIn: s.uid } })
      }
      return s
    })
    ctx.hub.broadcast({ t: 'sessions.changed' })
    if (src) {
      changed(repos.sessions.byId(src.id) as SessionRow)
      const chat = ctx.services.chat
      if (chat) {
        chat.startContinuation(created.uid, src.uid, null, { speak: b.speak === true, deviceId: who(req).deviceId, speakClientId: b.speakClientId }).catch((e: unknown) => {
          if (!(e instanceof VesperError && e.info.code === 'not_implemented')) ctx.log.warn('continuation failed', { error: e })
        })
      }
    }
    return full(created)
  })

  route(app, 'GET /api/sessions/:uid', (req) => {
    const { s, st } = storedOrTemporaryOr404(ctx, parse(uidParams, req.params).uid, { allowDeleted: true })
    return fullIn(st, s)
  })

  route(app, 'PATCH /api/sessions/:uid', (req) => {
    const { s, st } = storedOrTemporaryOr404(ctx, parse(uidParams, req.params).uid)
    const b = parse(patchBody, req.body)
    if (b.llmProfile && !ctx.settings.get().llm.profiles.some((p) => p.id === b.llmProfile)) {
      throw new VesperError('validation', { fields: { llmProfile: 'No such AI provider profile' } })
    }
    const next = st.repos.sessions.update(s.id, {
      ...b,
      ...(b.title !== undefined ? { titleAuto: false } : {}),
      ...(b.voice !== undefined ? { voice: b.voice } : {})
    })
    // A temporary chat is unknown to memory (its ids are not vesper.db ids, and it is never indexed).
    if (!st.temporary) {
      if (b.private !== undefined && b.private !== s.private) ctx.services.memory?.onSessionFlagsChanged(s.id)
      else if (b.memory !== undefined && b.memory !== s.memory) ctx.services.memory?.onSessionFlagsChanged(s.id)
    }
    changedIn(st, next)
    return fullIn(st, next)
  })

  route(app, 'DELETE /api/sessions/:uid', async (req) => {
    const uid = parse(uidParams, req.params).uid
    // Closing a temporary chat ends it for good: its turn stops, its store and files are dropped (07 B9).
    if (temps.has(uid)) {
      await temps.end(uid, 'closed')
      return
    }
    const s = sessionOr404(ctx, uid)
    ctx.services.chat?.stop(s.uid)
    repos.sessions.softDelete(s.id, ctx.clock.now())
    ctx.services.memory?.onSessionFlagsChanged(s.id)
    ctx.hub.broadcast({ t: 'session.deleted', sessionUid: s.uid })
    ctx.hub.broadcast({ t: 'sessions.changed' })
  })

  route(app, 'POST /api/sessions/:uid/restore', (req) => {
    const s = sessionOr404(ctx, parse(uidParams, req.params).uid, { allowDeleted: true })
    repos.sessions.restore(s.id)
    ctx.services.memory?.onSessionFlagsChanged(s.id)
    const next = repos.sessions.byId(s.id) as SessionRow
    changed(next)
    return full(next)
  })

  route(app, 'POST /api/sessions/:uid/epoch', async (req) => {
    const { s } = storedOrTemporaryOr404(ctx, parse(uidParams, req.params).uid)
    const { reason } = parse(z.object({ reason: z.enum(['apply-protocols', 'refresh-context']) }), req.body)
    const chat = ctx.services.chat
    if (!chat) throw new VesperError('not_implemented')
    return { epochId: await chat.newEpoch(s.uid, reason) }
  })

  const linkParams = z.object({ uid: z.string().min(1).max(64), shortId: z.string().min(1).max(20) })

  route(app, 'PUT /api/sessions/:uid/links/:shortId', (req) => {
    const p = parse(linkParams, req.params)
    if (temps.has(p.uid)) throw new VesperError('validation', { message: "A temporary chat can't be linked." })
    const s = sessionOr404(ctx, p.uid)
    const t = linkTarget(ctx, p.shortId)
    if (t.id === s.id) throw new VesperError('validation', { message: "A conversation can't link to itself." })
    const { bothWays } = parse(z.object({ bothWays: z.boolean().optional() }), req.body)
    const now = ctx.clock.now()
    repos.sessions.addLink(s.id, t.id, now)
    if (bothWays) repos.sessions.addLink(t.id, s.id, now)
    changed(s)
    changed(t)
    return full(repos.sessions.byId(s.id) as SessionRow)
  })

  route(app, 'DELETE /api/sessions/:uid/links/:shortId', (req) => {
    const p = parse(linkParams, req.params)
    const s = sessionOr404(ctx, p.uid)
    const short = normalizeShortId(p.shortId)
    const t = short ? repos.sessions.byShortId(short) : null
    if (t) {
      repos.sessions.removeLink(s.id, t.id)
      changed(s)
      changed(t)
    }
    return full(repos.sessions.byId(s.id) as SessionRow)
  })

  route(app, 'POST /api/trash/empty', async () => {
    const rows = ctx.db.prepare('SELECT id, uid FROM sessions WHERE deleted_utc IS NOT NULL').all() as { id: number | bigint; uid: string }[]
    const ids = rows.map((r) => BigInt(r.id))
    if (!ids.length) return { purged: 0 }
    await purgeSessions(ctx, ids)
    for (const sid of ids) ctx.services.memory?.onSessionFlagsChanged(sid)
    // Purged sessions are gone for good: drop their WS event rings (Phase 4 leak fix).
    for (const r of rows) ctx.hub.dropSession?.(r.uid)
    ctx.hub.broadcast({ t: 'sessions.changed' })
    return { purged: ids.length }
  })
}

/**
 * Hard-delete sessions and everything that hangs off them (vectors, bits, queue, injections, transcript, epochs,
 * messages, branches, links). 07 C9: on db.worker's purge job (transactions ≤ 500 rows with yields), so emptying a
 * huge trash never blocks the main thread; without the memory service, the same deletes on the main connection.
 */
export async function purgeSessions(ctx: ServerContext, ids: bigint[]): Promise<void> {
  if (!ids.length) return
  let memory: ReturnType<typeof memoryOf> | null = null
  try {
    memory = memoryOf(ctx)
  } catch {
    memory = null
  }
  if (memory) {
    await memory.runJob({ kind: 'purge', sessionIds: ids.map(Number) })
    return
  }
  purgeOnMainThread(ctx, ids)
}

/** The in-transaction fallback (no memory service: unit tests of other areas). */
export function purgeOnMainThread(ctx: ServerContext, ids: bigint[]): void {
  const db = ctx.db
  tx(db, () => {
    for (const sid of ids) {
      const inSession = 'SELECT id FROM messages WHERE session_id = ?'
      for (const t of ['vectors', 'vector_bits', 'embed_queue']) db.prepare(`DELETE FROM ${t} WHERE message_id IN (${inSession})`).run(sid)
      db.prepare('DELETE FROM memory_injections WHERE session_id = ? OR message_id IN (' + inSession + ')').run(sid, sid)
      db.prepare('DELETE FROM transcript WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM epochs WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM branch_choices WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM branches WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM session_links WHERE from_session = ? OR to_session = ?').run(sid, sid)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
      // The cached /continue recap of the chat (07 B9; F16).
      db.prepare('DELETE FROM kv WHERE k = ?').run(`chat.recap:${sid}`)
    }
  })
}
