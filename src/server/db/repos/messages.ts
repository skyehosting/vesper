/**
 * Messages on the active path (07 C3): every page is a keyset scan on the partial index
 * `messages_path (session_id, seq) WHERE on_path = 1`, so the cost does not grow with regenerations or branches.
 * On-path seqs are dense (1..lastSeq), which makes hasBefore/hasAfter exact without counting.
 */
import { randomUUID } from 'node:crypto'
import type { AttachmentRef, MessageStatus, Role, RoleTag, Usage } from '@shared/types/domain'
import { id, type Db } from '../sqlite'
import type { MessageRow, Page, Repos } from '../repos'
import { atomic, big, bool, json, jsonOrNull, n, nOrNull, setClause, str, strOrNull, type SqlRow, type SqlValue } from './util'

export function messageFromRow(r: SqlRow): MessageRow {
  return {
    id: big(r.id),
    uid: str(r.uid),
    sessionId: big(r.session_id),
    branchId: big(r.branch_id),
    seq: n(r.seq),
    role: str(r.role) as Role,
    tag: str(r.tag) as RoleTag,
    body: str(r.body),
    tsUtc: n(r.ts_utc),
    tzOffsetMin: n(r.tz_offset_min),
    tzName: strOrNull(r.tz_name),
    device: strOrNull(r.device),
    status: str(r.status) as MessageStatus,
    error: jsonOrNull<{ code: string; message: string }>(r.error),
    provider: strOrNull(r.provider),
    model: strOrNull(r.model),
    usage: jsonOrNull<Usage>(r.usage),
    attachments: json<AttachmentRef[]>(r.attachments, []),
    onPath: bool(r.on_path),
    hidden: bool(r.hidden),
    deleted: bool(r.deleted),
    spokenChars: nOrNull(r.spoken_chars),
    interrupted: bool(r.interrupted),
    meta: json<Record<string, unknown>>(r.meta, {})
  }
}

export const tagFor = (role: Role): RoleTag => (role === 'user' ? 'user response' : 'ai response')

export function createMessagesRepo(db: Db): Repos['messages'] {
  const sessionState = db.prepare('SELECT active_branch, last_seq FROM sessions WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO messages (uid, session_id, branch_id, seq, role, tag, body, ts_utc, tz_offset_min, tz_name, device, status,
       provider, model, attachments, on_path, hidden, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
  const afterAppend = db.prepare(
    `UPDATE sessions SET last_seq = ?, message_count = message_count + ?,
       last_message_utc = MAX(COALESCE(last_message_utc, 0), ?), updated_utc = MAX(updated_utc, ?) WHERE id = ?`
  )
  const byUidStmt = db.prepare('SELECT * FROM messages WHERE uid = ?')
  const byIdStmt = db.prepare('SELECT * FROM messages WHERE id = ?')
  const lastSeqStmt = db.prepare('SELECT last_seq FROM sessions WHERE id = ?')
  const latest = db.prepare('SELECT * FROM messages WHERE session_id = ? AND on_path = 1 ORDER BY seq DESC LIMIT ?')
  const before = db.prepare('SELECT * FROM messages WHERE session_id = ? AND on_path = 1 AND seq < ? ORDER BY seq DESC LIMIT ?')
  const after = db.prepare('SELECT * FROM messages WHERE session_id = ? AND on_path = 1 AND seq > ? ORDER BY seq ASC LIMIT ?')
  const fromSeq = db.prepare('SELECT * FROM messages WHERE session_id = ? AND on_path = 1 AND seq >= ? ORDER BY seq ASC LIMIT ?')
  const atSeq = db.prepare('SELECT seq, ts_utc FROM messages WHERE session_id = ? AND on_path = 1 AND seq = ?')
  const setDeleted = db.prepare('UPDATE messages SET deleted = ? WHERE id = ?')
  // 07 B9 (F16): when a message was deleted, so the daily purge clears it after its 30 restorable days.
  const stampDeleted = db.prepare("UPDATE messages SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.deletedUtc', ?) WHERE id = ?")
  const unstampDeleted = db.prepare("UPDATE messages SET meta = json_remove(meta, '$.deletedUtc') WHERE id = ? AND json_valid(meta)")
  const bumpCount = db.prepare('UPDATE sessions SET message_count = MAX(0, message_count + ?) WHERE id = ?')
  const bumpLastUtc = db.prepare('UPDATE sessions SET last_message_utc = MAX(COALESCE(last_message_utc, 0), ?) WHERE id = ?')

  const byId = (mid: bigint): MessageRow | null => {
    const r = byIdStmt.get(id(mid)) as SqlRow | undefined
    return r ? messageFromRow(r) : null
  }
  const rows = (stmt: { all(...p: SqlValue[]): unknown[] }, ...p: SqlValue[]) => (stmt.all(...p) as SqlRow[]).map(messageFromRow)

  function lastSeqOf(sessionId: bigint): number {
    const r = lastSeqStmt.get(id(sessionId)) as SqlRow | undefined
    return r ? n(r.last_seq) : 0
  }

  function pageOf(items: MessageRow[], lastSeq: number): Page<MessageRow> {
    if (!items.length) return { items, loSeq: 0, hiSeq: 0, lastSeq, hasBefore: false, hasAfter: false }
    const loSeq = items[0].seq
    const hiSeq = items[items.length - 1].seq
    return { items, loSeq, hiSeq, lastSeq, hasBefore: loSeq > 1, hasAfter: hiSeq < lastSeq }
  }

  function setDeletedFlag(mid: bigint, deleted: boolean, now?: number): void {
    atomic(db, () => {
      const m = byId(mid)
      if (!m || m.deleted === deleted) return
      setDeleted.run(deleted ? 1 : 0, id(mid))
      if (deleted && now !== undefined) stampDeleted.run(now, id(mid))
      else if (!deleted) unstampDeleted.run(id(mid))
      if (m.onPath && !m.hidden) bumpCount.run(deleted ? -1 : 1, id(m.sessionId))
    })
  }

  return {
    append(m) {
      return atomic(db, () => {
        const s = sessionState.get(id(m.sessionId)) as SqlRow | undefined
        if (!s || s.active_branch === null) throw new Error(`session ${m.sessionId} not found`)
        const seq = n(s.last_seq) + 1
        const res = insert.run(
          randomUUID(),
          id(m.sessionId),
          big(s.active_branch),
          BigInt(seq),
          m.role,
          tagFor(m.role),
          m.body,
          m.tsUtc,
          m.tzOffsetMin,
          m.tzName,
          m.device,
          m.status ?? 'complete',
          m.provider ?? null,
          m.model ?? null,
          JSON.stringify(m.attachments ?? []),
          m.hidden ? 1 : 0,
          JSON.stringify(m.meta ?? {})
        )
        afterAppend.run(BigInt(seq), m.hidden ? 0 : 1, m.tsUtc, m.tsUtc, id(m.sessionId))
        return byId(big(res.lastInsertRowid)) as MessageRow
      })
    },
    byUid(uid) {
      const r = byUidStmt.get(uid) as SqlRow | undefined
      return r ? messageFromRow(r) : null
    },
    byId,
    update(mid, p) {
      const c: Record<string, SqlValue> = {}
      if (p.body !== undefined) c.body = p.body
      if (p.status !== undefined) c.status = p.status
      if (p.error !== undefined) c.error = p.error === null ? null : JSON.stringify(p.error)
      if (p.usage !== undefined) c.usage = p.usage === null ? null : JSON.stringify(p.usage)
      if (p.provider !== undefined) c.provider = p.provider
      if (p.model !== undefined) c.model = p.model
      if (p.tsUtc !== undefined) c.ts_utc = p.tsUtc
      if (p.spokenChars !== undefined) c.spoken_chars = p.spokenChars
      if (p.interrupted !== undefined) c.interrupted = p.interrupted ? 1 : 0
      if (p.meta !== undefined) c.meta = JSON.stringify(p.meta)
      if (p.attachments !== undefined) c.attachments = JSON.stringify(p.attachments)
      return atomic(db, () => {
        if (Object.keys(c).length) {
          const { sql, values } = setClause(c)
          db.prepare(`UPDATE messages SET ${sql} WHERE id = ?`).run(...values, id(mid))
        }
        const row = byId(mid)
        if (!row) throw new Error(`message ${mid} not found`)
        if (p.tsUtc !== undefined && row.onPath) bumpLastUtc.run(p.tsUtc, id(row.sessionId))
        return row
      })
    },
    page(sessionId, o) {
      const sid = id(sessionId)
      const limit = BigInt(Math.max(1, Math.min(1000, Math.trunc(o.limit))))
      const lastSeq = lastSeqOf(sessionId)
      const seq = BigInt(Math.trunc(o.seq ?? lastSeq + 1))
      switch (o.mode) {
        case 'before':
          return pageOf(rows(before, sid, seq, limit).reverse(), lastSeq)
        case 'after':
          return pageOf(rows(after, sid, seq, limit), lastSeq)
        case 'around': {
          const half = limit / 2n
          const up = rows(before, sid, seq, half).reverse()
          const down = rows(fromSeq, sid, seq, limit - half)
          return pageOf([...up, ...down], lastSeq)
        }
        default:
          return pageOf(rows(latest, sid, limit).reverse(), lastSeq)
      }
    },
    timeline(sessionId, samples) {
      const lastSeq = lastSeqOf(sessionId)
      if (lastSeq < 1) return []
      const k = Math.max(1, Math.min(lastSeq, Math.trunc(samples)))
      const out: { seq: number; tsUtc: number }[] = []
      let prev = 0
      for (let i = 0; i < k; i++) {
        const seq = k === 1 ? lastSeq : Math.round(1 + (i * (lastSeq - 1)) / (k - 1))
        if (seq === prev) continue
        prev = seq
        const r = atSeq.get(id(sessionId), BigInt(seq)) as SqlRow | undefined
        if (r) out.push({ seq: n(r.seq), tsUtc: n(r.ts_utc) })
      }
      return out
    },
    tail(sessionId, count, opts) {
      const beforeSeq = opts?.beforeSeq ?? lastSeqOf(sessionId) + 1
      return rows(before, id(sessionId), BigInt(beforeSeq), BigInt(Math.max(0, count))).reverse()
    },
    range(sessionId, from, limit) {
      return rows(fromSeq, id(sessionId), BigInt(from), BigInt(Math.max(0, limit)))
    },
    softDelete(mid, now) {
      setDeletedFlag(mid, true, now)
    },
    restore(mid) {
      setDeletedFlag(mid, false)
    },
    previousOnPath(sessionId, beforeSeq) {
      const r = before.get(id(sessionId), BigInt(beforeSeq), 1n) as SqlRow | undefined
      return r ? messageFromRow(r) : null
    },
    recoverStreaming() {
      const r = db
        .prepare(
          `UPDATE messages SET status = CASE WHEN body = '' THEN 'error' ELSE 'stopped' END,
             error = CASE WHEN body = '' THEN '{"code":"internal","message":"Vesper closed before the reply finished."}' ELSE error END
           WHERE status = 'streaming'`
        )
        .run()
      return Number(r.changes)
    }
  }
}
