/** Sessions and directional links (03 §1, 07 B9/C13/C18). */
import { randomBytes, randomUUID } from 'node:crypto'
import { makeShortId } from '@shared/ids'
import type { MemoryScope, SessionVoice, ToolMode, MemoryMode } from '@shared/types/domain'
import { id, type Db } from '../sqlite'
import type { Repos, SessionRow } from '../repos'
import { atomic, big, bigOrNull, bool, json, jsonOrNull, n, nOrNull, setClause, str, strOrNull, type SqlRow, type SqlValue } from './util'

export function sessionFromRow(r: SqlRow): SessionRow {
  return {
    id: big(r.id),
    uid: str(r.uid),
    shortId: str(r.short_id),
    title: str(r.title),
    titleAuto: bool(r.title_auto),
    createdUtc: n(r.created_utc),
    updatedUtc: n(r.updated_utc),
    lastMessageUtc: nOrNull(r.last_message_utc),
    pinned: bool(r.pinned),
    archived: bool(r.archived),
    deletedUtc: nOrNull(r.deleted_utc),
    private: bool(r.private),
    memory: str(r.memory) as MemoryMode,
    memoryScope: str(r.memory_scope) as MemoryScope | 'inherit',
    systemPrompt: str(r.system_prompt),
    promptId: nOrNull(r.prompt_id),
    llmProfile: strOrNull(r.llm_profile),
    model: strOrNull(r.model),
    voice: jsonOrNull<SessionVoice>(r.voice),
    toolMode: strOrNull(r.tool_mode) as ToolMode | null,
    activeBranch: bigOrNull(r.active_branch),
    messageCount: n(r.message_count),
    lastSeq: n(r.last_seq),
    summary: strOrNull(r.summary),
    summaryUtc: nOrNull(r.summary_utc),
    meta: json<Record<string, unknown>>(r.meta, {})
  }
}

type SessionPatch = Partial<Omit<SessionRow, 'id' | 'uid' | 'shortId' | 'createdUtc'>>

/** SessionRow field → column + SQLite value. */
function patchColumns(p: SessionPatch): Record<string, SqlValue> {
  const c: Record<string, SqlValue> = {}
  const b = (v: boolean) => (v ? 1 : 0)
  if (p.title !== undefined) c.title = p.title
  if (p.titleAuto !== undefined) c.title_auto = b(p.titleAuto)
  if (p.updatedUtc !== undefined) c.updated_utc = p.updatedUtc
  if (p.lastMessageUtc !== undefined) c.last_message_utc = p.lastMessageUtc
  if (p.pinned !== undefined) c.pinned = b(p.pinned)
  if (p.archived !== undefined) c.archived = b(p.archived)
  if (p.deletedUtc !== undefined) c.deleted_utc = p.deletedUtc
  if (p.private !== undefined) c.private = b(p.private)
  if (p.memory !== undefined) c.memory = p.memory
  if (p.memoryScope !== undefined) c.memory_scope = p.memoryScope
  if (p.systemPrompt !== undefined) c.system_prompt = p.systemPrompt
  if (p.promptId !== undefined) c.prompt_id = p.promptId
  if (p.llmProfile !== undefined) c.llm_profile = p.llmProfile
  if (p.model !== undefined) c.model = p.model
  if (p.voice !== undefined) c.voice = p.voice === null ? null : JSON.stringify(p.voice)
  if (p.toolMode !== undefined) c.tool_mode = p.toolMode
  if (p.activeBranch !== undefined) c.active_branch = p.activeBranch
  if (p.messageCount !== undefined) c.message_count = p.messageCount
  if (p.lastSeq !== undefined) c.last_seq = p.lastSeq
  if (p.summary !== undefined) c.summary = p.summary
  if (p.summaryUtc !== undefined) c.summary_utc = p.summaryUtc
  if (p.meta !== undefined) c.meta = JSON.stringify(p.meta)
  return c
}

/** Opaque list cursor: the (updated_utc, id) of the last item. */
function encodeCursor(r: SessionRow): string {
  return Buffer.from(`${r.updatedUtc}:${r.id}`).toString('base64url')
}

function decodeCursor(c: string): { updated: number; id: bigint } | null {
  const m = /^(\d+):(\d+)$/.exec(Buffer.from(c, 'base64url').toString())
  return m ? { updated: Number(m[1]), id: BigInt(m[2]) } : null
}

export function createSessionsRepo(db: Db): Repos['sessions'] {
  const byUidStmt = db.prepare('SELECT * FROM sessions WHERE uid = ?')
  const byShortStmt = db.prepare('SELECT * FROM sessions WHERE short_id = ?')
  const byIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const shortExists = db.prepare('SELECT 1 FROM sessions WHERE short_id = ?')
  const insert = db.prepare(
    `INSERT INTO sessions (uid, short_id, title, title_auto, created_utc, updated_utc, private, system_prompt, prompt_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertRoot = db.prepare(`INSERT INTO branches (session_id, parent_branch, fork_seq, created_utc, reason) VALUES (?, NULL, 1, ?, 'root')`)
  const setActive = db.prepare('UPDATE sessions SET active_branch = ? WHERE id = ?')
  const linksStmt = db.prepare(
    `SELECT s.* FROM session_links l JOIN sessions s ON s.id = l.to_session
     WHERE l.from_session = ? AND s.deleted_utc IS NULL ORDER BY l.created_utc, s.id`
  )
  const linkedFromStmt = db.prepare(
    `SELECT s.* FROM session_links l JOIN sessions s ON s.id = l.from_session
     WHERE l.to_session = ? AND s.deleted_utc IS NULL ORDER BY l.created_utc, s.id`
  )
  const addLinkStmt = db.prepare('INSERT OR IGNORE INTO session_links (from_session, to_session, created_utc) VALUES (?, ?, ?)')
  const removeLinkStmt = db.prepare('DELETE FROM session_links WHERE from_session = ? AND to_session = ?')
  const linkedIds = db.prepare(
    `SELECT s.id FROM session_links l JOIN sessions s ON s.id = l.to_session
     WHERE l.from_session = ? AND s.deleted_utc IS NULL AND s.private = 0`
  )
  const allIds = db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL AND private = 0')

  const byId = (sid: bigint): SessionRow | null => {
    const r = byIdStmt.get(id(sid)) as SqlRow | undefined
    return r ? sessionFromRow(r) : null
  }

  function newShortId(): string {
    for (let i = 0; i < 20; i++) {
      const s = makeShortId((k) => randomBytes(k))
      if (!shortExists.get(s)) return s
    }
    throw new Error('could not allocate a short id')
  }

  return {
    create(o) {
      return atomic(db, () => {
        const res = insert.run(
          randomUUID(),
          newShortId(),
          o.title ?? '',
          o.title ? 0 : 1,
          o.now,
          o.now,
          o.private ? 1 : 0,
          o.systemPrompt ?? '',
          o.promptId ?? null,
          JSON.stringify(o.meta ?? {})
        )
        const sid = big(res.lastInsertRowid)
        const branch = big(insertRoot.run(sid, o.now).lastInsertRowid)
        setActive.run(branch, sid)
        return byId(sid) as SessionRow
      })
    },
    byUid(uid) {
      const r = byUidStmt.get(uid) as SqlRow | undefined
      return r ? sessionFromRow(r) : null
    },
    byShortId(shortId) {
      const r = byShortStmt.get(shortId) as SqlRow | undefined
      return r ? sessionFromRow(r) : null
    },
    byId,
    list(o) {
      const where: string[] = []
      const params: SqlValue[] = []
      switch (o.filter ?? 'all') {
        case 'trash':
          where.push('deleted_utc IS NOT NULL')
          break
        case 'pinned':
          where.push('deleted_utc IS NULL AND pinned = 1')
          break
        case 'archived':
          where.push('deleted_utc IS NULL AND archived = 1')
          break
        default:
          where.push('deleted_utc IS NULL AND archived = 0')
      }
      if (o.q && o.q.trim()) {
        const q = o.q.trim()
        const short = q.replace(/^#/, '').toUpperCase()
        where.push(`(title LIKE ? ESCAPE '\\' OR short_id = ?)`)
        params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, short)
      }
      if (o.cursor) {
        const c = decodeCursor(o.cursor)
        if (c) {
          where.push('(updated_utc < ? OR (updated_utc = ? AND id < ?))')
          params.push(c.updated, c.updated, c.id)
        }
      }
      const limit = Math.max(1, Math.min(500, Math.trunc(o.limit)))
      const rows = db
        .prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY updated_utc DESC, id DESC LIMIT ?`)
        .all(...params, BigInt(limit + 1)) as SqlRow[]
      const items = rows.slice(0, limit).map(sessionFromRow)
      return { items, next: rows.length > limit ? encodeCursor(items[items.length - 1]) : null }
    },
    update(sid, patch) {
      const cols = patchColumns(patch)
      if (Object.keys(cols).length) {
        const { sql, values } = setClause(cols)
        db.prepare(`UPDATE sessions SET ${sql} WHERE id = ?`).run(...values, id(sid))
      }
      const row = byId(sid)
      if (!row) throw new Error(`session ${sid} not found`)
      return row
    },
    softDelete(sid, now) {
      db.prepare('UPDATE sessions SET deleted_utc = ? WHERE id = ?').run(now, id(sid))
    },
    restore(sid) {
      db.prepare('UPDATE sessions SET deleted_utc = NULL WHERE id = ?').run(id(sid))
    },
    links(sid) {
      return (linksStmt.all(id(sid)) as SqlRow[]).map(sessionFromRow)
    },
    linkedFrom(sid) {
      return (linkedFromStmt.all(id(sid)) as SqlRow[]).map(sessionFromRow)
    },
    addLink(from, to, now) {
      if (from === to) return
      addLinkStmt.run(id(from), id(to), now)
    },
    removeLink(from, to) {
      removeLinkStmt.run(id(from), id(to))
    },
    accessibleIds(sid, scope) {
      const self = byId(sid)
      if (!self || self.deletedUtc !== null) return []
      if (scope === 'this') return [self.id]
      // A private session never appears in another session's scope (07 B9); it still searches itself.
      const others = scope === 'linked' ? (linkedIds.all(id(sid)) as SqlRow[]) : (allIds.all() as SqlRow[])
      const out = [self.id]
      for (const r of others) {
        const v = big(r.id)
        if (v !== self.id) out.push(v)
      }
      return out
    }
  }
}
