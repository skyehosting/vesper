/**
 * Messages on the active path (07 C21): page, timeline, locate, delete/restore. Phase 3 (engine-int): also for
 * temporary chats (07 B9), whose rows live in their own in-memory store — ids are per store, so every lookup goes
 * through the store that holds the session/message.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { MemoryHit } from '@shared/types/domain'
import { findMessage, type ChatStore } from '../chat/temporary'
import type { MessageRow } from '../db/repos'
import type { ServerContext } from '../services'
import { toMessage, toMessagePage } from './convert'
import { parse, route } from './route'
import { storedOrTemporaryOr404 } from './sessions'

const uidParams = z.object({ uid: z.string().min(1).max(64) })

const pageQuery = z.object({
  mode: z.enum(['latest', 'before', 'after', 'around']).default('latest'),
  seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
})

/** The message behind `uid` and the store holding it (vesper.db or a temporary chat). */
export function messageOr404(ctx: ServerContext, uid: string): MessageRow {
  return messageInStoreOr404(ctx, uid).m
}

function messageInStoreOr404(ctx: ServerContext, uid: string): { m: MessageRow; st: ChatStore } {
  const found = findMessage(ctx, uid)
  if (!found) throw new VesperError('not_found')
  const s = found.store.repos.sessions.byId(found.message.sessionId)
  if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
  return { m: found.message, st: found.store }
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/sessions/:uid/messages', (req) => {
    const { s, st } = storedOrTemporaryOr404(ctx, parse(uidParams, req.params).uid)
    const q = parse(pageQuery, req.query)
    if (q.mode !== 'latest' && q.seq === undefined) throw new VesperError('validation', { fields: { seq: `Required for mode=${q.mode}` } })
    const limit = q.limit ?? ctx.settings.get().chat.pageSize
    const page = toMessagePage(st.db, st.repos, s, st.repos.messages.page(s.id, { mode: q.mode, seq: q.seq, limit }))
    // A reply the database refused is kept in memory (07 C19, F28): a reload, a reconnect or a second device sees the
    // row reply.done showed (full text, "not saved"), not the stale streaming checkpoint.
    const unsaved = ctx.services.chat?.unsavedReplies?.(s.uid)
    if (unsaved?.size) {
      page.items = page.items.map((m) => {
        const u = m.deleted ? undefined : unsaved.get(m.uid)
        return u ? { ...u, seq: m.seq, ...(m.variant ? { variant: m.variant } : {}), ...(m.recalled ? { recalled: m.recalled } : {}) } : m
      })
    }
    return page
  })

  route(app, 'GET /api/sessions/:uid/timeline', (req) => {
    const { s, st } = storedOrTemporaryOr404(ctx, parse(uidParams, req.params).uid)
    const { samples } = parse(z.object({ samples: z.coerce.number().int().min(2).max(200).default(24) }), req.query)
    return st.repos.messages.timeline(s.id, samples)
  })

  route(app, 'GET /api/messages/:uid/locate', (req) => {
    const { m, st } = messageInStoreOr404(ctx, parse(uidParams, req.params).uid)
    const s = st.repos.sessions.byId(m.sessionId)!
    const loc = st.repos.branches.locate(m.id)
    return { sessionUid: s.uid, seq: loc.seq, onPath: loc.onPath, branchPath: loc.branchPath }
  })

  // The "Remembered" chip (07 A4): what was recalled for this reply, oldest first (chat-ui, Phase 3; additive).
  const RECALLED_COLS = `DISTINCT m.uid AS messageUid, s.uid AS sessionUid, s.short_id AS shortId, s.title AS sessionTitle, m.tag AS tag, m.body AS body,
            m.ts_utc AS tsUtc, m.tz_offset_min AS tzOffsetMin, m.tz_name AS tzName`
  const RECALLED_WHERE = 'm.deleted = 0 AND m.hidden = 0 AND s.deleted_utc IS NULL'
  const recalled = ctx.db.prepare(
    `SELECT ${RECALLED_COLS}
       FROM memory_injections i
       JOIN messages m ON m.id = i.message_id
       JOIN sessions s ON s.id = m.session_id
      WHERE i.turn_message_id = ? AND ${RECALLED_WHERE}
      ORDER BY m.ts_utc, m.id
      LIMIT 50`
  )
  type RecalledRow = Omit<MemoryHit, 'score'> & { tsUtc: number | bigint; tzOffsetMin: number | bigint }
  route(app, 'GET /api/messages/:uid/recalled', (req) => {
    const { m, st } = messageInStoreOr404(ctx, parse(uidParams, req.params).uid)
    let rows: RecalledRow[]
    if (st.temporary) {
      // A temporary reply's ids are its own store's; what it recalled (vesper.db ids) is recorded there (F71).
      const ids = (st.db.prepare('SELECT DISTINCT message_id FROM memory_injections WHERE turn_message_id = ? LIMIT 50').all(m.id) as { message_id: number | bigint }[]).map((r) =>
        BigInt(r.message_id)
      )
      rows = ids.length
        ? (ctx.db
            .prepare(
              `SELECT ${RECALLED_COLS} FROM messages m JOIN sessions s ON s.id = m.session_id
                WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${RECALLED_WHERE} ORDER BY m.ts_utc, m.id`
            )
            .all(...ids) as RecalledRow[])
        : []
    } else rows = recalled.all(m.id) as RecalledRow[]
    return rows.map((r): MemoryHit => ({ ...r, tsUtc: Number(r.tsUtc), tzOffsetMin: Number(r.tzOffsetMin), score: 1 }))
  })

  route(app, 'DELETE /api/messages/:uid', async (req) => {
    const { m, st } = messageInStoreOr404(ctx, parse(uidParams, req.params).uid)
    const { refresh } = parse(z.object({ refresh: z.literal('1').optional() }), req.query)
    const s = st.repos.sessions.byId(m.sessionId)!
    st.repos.messages.softDelete(m.id, ctx.clock.now())
    // Memory knows only vesper.db ids (a temporary chat is never indexed).
    if (!st.temporary) ctx.services.memory?.onMessagesDeleted([m.id])
    ctx.hub.emit(s.uid, { t: 'message.deleted', sessionUid: s.uid, messageUid: m.uid })
    if (refresh && ctx.services.chat) {
      // "Delete and refresh context": the AI stops seeing it once a new epoch starts (07 B9).
      await ctx.services.chat.newEpoch(s.uid, 'refresh-context').catch((e: unknown) => ctx.log.warn('refresh-context failed', { error: e }))
    }
  })

  route(app, 'POST /api/messages/:uid/restore', (req) => {
    const { m, st } = messageInStoreOr404(ctx, parse(uidParams, req.params).uid)
    // Past its 30 days the daily purge cleared it (07 B9): there is nothing left to bring back.
    if (m.deleted && m.meta.purgedUtc !== undefined) throw new VesperError('not_found')
    const s = st.repos.sessions.byId(m.sessionId)!
    st.repos.messages.restore(m.id)
    if (!st.temporary) ctx.services.memory?.onMessagePersisted(m.id)
    ctx.hub.emit(s.uid, { t: 'message.updated', sessionUid: s.uid, message: toMessage(st.repos.messages.byId(m.id)!, s.uid) })
  })
}
