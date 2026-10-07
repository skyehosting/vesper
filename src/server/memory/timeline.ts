/**
 * The memory viewer's timeline (R7; GET /api/memory/timeline — memory-ui, Phase 3). What the AI can remember, as the
 * owner asked for it: every visible on-path message with its tag ("user response" / "ai response"), the machine
 * timestamp and the session id. Hidden turns, tombstones (forgotten/deleted), off-path variants and trashed sessions
 * are left out — the same rows memory searches (07 C3).
 *
 * Two keyset orders, both O(page):
 *   - one session: its own order, on the partial index `messages_path (session_id, seq) WHERE on_path = 1`;
 *   - all sessions: machine time, on `messages_time (ts_utc)` with `id` as the tiebreak (imports keep their original
 *     timestamps, so time — not insertion id — is the order a person expects).
 * Cursors are opaque strings: `s<seq>` or `t<ts>:<id>`.
 */
import { VesperError } from '@shared/errors'
import type { MemoryTimelineQuery } from '@shared/api'
import type { TimelineEntry } from '@shared/types/domain'
import type { Db } from '../db/sqlite'
import type { Repos, SessionRow } from '../db/repos'
import { messageFromRow } from '../db/repos/messages'
import type { SqlRow } from '../db/repos/util'
import { toMessage } from '../http/convert'

export const TIMELINE_LIMITS = { default: 50, max: 200 } as const

type Cursor = { kind: 's'; seq: number } | { kind: 't'; ts: number; id: number }

export function parseTimelineCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  let m = /^s(\d{1,15})$/.exec(raw)
  if (m) return { kind: 's', seq: Number(m[1]) }
  m = /^t(-?\d{1,16}):(\d{1,18})$/.exec(raw)
  if (m) return { kind: 't', ts: Number(m[1]), id: Number(m[2]) }
  throw new VesperError('validation', { fields: { cursor: 'Unknown cursor' } })
}

export function memoryTimeline(db: Db, repos: Repos, q: MemoryTimelineQuery): { items: TimelineEntry[]; next: string | null } {
  const limit = Math.max(1, Math.min(TIMELINE_LIMITS.max, Math.trunc(q.limit ?? TIMELINE_LIMITS.default)))
  const cursor = parseTimelineCursor(q.cursor)
  const where: string[] = ['m.deleted = 0', 'm.hidden = 0', 'm.on_path = 1']
  const args: (number | bigint | string)[] = []
  if (q.role) {
    where.push('m.role = ?')
    args.push(q.role)
  }
  if (q.fromUtc !== undefined) {
    where.push('m.ts_utc >= ?')
    args.push(q.fromUtc)
  }
  if (q.toUtc !== undefined) {
    where.push('m.ts_utc <= ?')
    args.push(q.toUtc)
  }

  let one: SessionRow | null = null
  let sql: string
  if (q.session) {
    one = repos.sessions.byUid(q.session)
    if (!one || one.deletedUtc !== null) throw new VesperError('not_found')
    if (cursor && cursor.kind !== 's') throw new VesperError('validation', { fields: { cursor: 'Cursor from another view' } })
    where.unshift('m.session_id = ?')
    args.unshift(one.id)
    if (cursor) {
      where.push('m.seq < ?')
      args.push(cursor.seq)
    }
    sql = `SELECT m.* FROM messages m INDEXED BY messages_path WHERE ${where.join(' AND ')} ORDER BY m.seq DESC LIMIT ?`
  } else {
    if (cursor && cursor.kind !== 't') throw new VesperError('validation', { fields: { cursor: 'Cursor from another view' } })
    if (cursor) {
      where.push('(m.ts_utc < ? OR (m.ts_utc = ? AND m.id < ?))')
      args.push(cursor.ts, cursor.ts, cursor.id)
    }
    where.push('s.deleted_utc IS NULL')
    sql = `SELECT m.* FROM messages m INDEXED BY messages_time JOIN sessions s ON s.id = m.session_id
      WHERE ${where.join(' AND ')} ORDER BY m.ts_utc DESC, m.id DESC LIMIT ?`
  }

  // One extra row tells whether there is a next page.
  const rows = db.prepare(sql).all(...args, limit + 1) as SqlRow[]
  const sessions = new Map<bigint, SessionRow | null>()
  const sessionOf = (sid: bigint): SessionRow | null => {
    if (one && one.id === sid) return one
    if (!sessions.has(sid)) sessions.set(sid, repos.sessions.byId(sid))
    return sessions.get(sid) ?? null
  }
  const items: TimelineEntry[] = []
  for (const r of rows.slice(0, limit)) {
    const m = messageFromRow(r)
    const s = sessionOf(m.sessionId)
    if (!s) continue
    items.push({ message: toMessage(m, s.uid), session: { uid: s.uid, shortId: s.shortId, title: s.title, private: s.private } })
  }
  let next: string | null = null
  if (rows.length > limit) {
    const last = messageFromRow(rows[limit - 1])
    next = one ? `s${last.seq}` : `t${last.tsUtc}:${last.id}`
  }
  return { items, next }
}
