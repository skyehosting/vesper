/** Wire transcript and epochs (03 §1.2, 07 C1/C4/C5). */
import { djson } from '@shared/djson'
import type { ToolMode } from '@shared/types/domain'
import type { WireBlock, WireRole } from '@shared/types/wire'
import { id, type Db } from '../sqlite'
import type { EpochRow, Repos, TranscriptRow } from '../repos'
import { big, bigOrNull, json, n, setClause, str, strOrNull, type SqlRow, type SqlValue } from './util'

function transcriptFromRow(r: SqlRow): TranscriptRow {
  return {
    id: big(r.id),
    sessionId: big(r.session_id),
    messageId: big(r.message_id),
    part: n(r.part),
    role: str(r.role) as WireRole,
    blocks: json<WireBlock[]>(r.blocks, []),
    bytes: n(r.bytes),
    provider: strOrNull(r.provider),
    model: strOrNull(r.model),
    createdUtc: n(r.created_utc)
  }
}

function epochFromRow(r: SqlRow): EpochRow {
  return {
    id: big(r.id),
    sessionId: big(r.session_id),
    branchId: big(r.branch_id),
    startMessageId: big(r.start_message_id),
    systemJson: str(r.system_json),
    toolsJson: str(r.tools_json),
    protocolsHash: str(r.protocols_hash),
    toolsVersion: n(r.tools_version),
    toolMode: str(r.tool_mode) as ToolMode,
    recap: strOrNull(r.recap),
    recapDraft: strOrNull(r.recap_draft),
    thinkingStripBefore: bigOrNull(r.thinking_strip_before),
    createdUtc: n(r.created_utc)
  }
}

export function createTranscriptRepo(db: Db): Repos['transcript'] {
  const insert = db.prepare(
    'INSERT INTO transcript (session_id, message_id, part, role, blocks, bytes, provider, model, created_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const byId = db.prepare('SELECT * FROM transcript WHERE id = ?')
  const startSeq = db.prepare('SELECT seq FROM messages WHERE id = ?')
  const forEpoch = db.prepare(
    `SELECT t.* FROM messages m JOIN transcript t ON t.message_id = m.id
     WHERE m.session_id = ? AND m.on_path = 1 AND m.seq >= ? ORDER BY m.seq, t.part`
  )
  const forMessage = db.prepare('SELECT * FROM transcript WHERE message_id = ? ORDER BY part')
  const del = db.prepare('DELETE FROM transcript WHERE message_id = ?')

  return {
    append(row) {
      // Serialized once, deterministically: replay must reproduce the exact bytes (03 §1.2).
      const text = djson(row.blocks)
      const res = insert.run(
        id(row.sessionId),
        id(row.messageId),
        BigInt(row.part),
        row.role,
        text,
        Buffer.byteLength(text),
        row.provider,
        row.model,
        row.createdUtc
      )
      return transcriptFromRow(byId.get(big(res.lastInsertRowid)) as SqlRow)
    },
    forEpoch(epoch) {
      let from = 1
      if (epoch.startMessageId !== 0n) {
        const r = startSeq.get(id(epoch.startMessageId)) as SqlRow | undefined
        if (r) from = n(r.seq)
      }
      return (forEpoch.all(id(epoch.sessionId), BigInt(from)) as SqlRow[]).map(transcriptFromRow)
    },
    forMessage(messageId) {
      return (forMessage.all(id(messageId)) as SqlRow[]).map(transcriptFromRow)
    },
    deleteForMessage(messageId) {
      del.run(id(messageId))
    }
  }
}

export function createEpochsRepo(db: Db): Repos['epochs'] {
  const insert = db.prepare(
    `INSERT INTO epochs (session_id, branch_id, start_message_id, system_json, tools_json, protocols_hash, tools_version, tool_mode,
       recap, thinking_strip_before, created_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const byId = db.prepare('SELECT * FROM epochs WHERE id = ?')
  // Effective epoch = the newest one whose start message is on the active path (07 C4); 0 = from the beginning.
  const current = db.prepare(
    `SELECT e.* FROM epochs e LEFT JOIN messages m ON m.id = e.start_message_id
     WHERE e.session_id = ? AND (e.start_message_id = 0 OR m.on_path = 1) ORDER BY e.id DESC LIMIT 1`
  )
  const onPath = db.prepare(
    `SELECT e.* FROM epochs e LEFT JOIN messages m ON m.id = e.start_message_id
     WHERE e.session_id = ? AND (e.start_message_id = 0 OR m.on_path = 1) ORDER BY e.id`
  )
  const get = (eid: bigint): EpochRow => {
    const r = byId.get(id(eid)) as SqlRow | undefined
    if (!r) throw new Error(`epoch ${eid} not found`)
    return epochFromRow(r)
  }
  return {
    create(e) {
      const res = insert.run(
        id(e.sessionId),
        id(e.branchId),
        id(e.startMessageId),
        e.systemJson,
        e.toolsJson,
        e.protocolsHash,
        BigInt(e.toolsVersion),
        e.toolMode,
        e.recap,
        e.thinkingStripBefore === null ? null : id(e.thinkingStripBefore),
        e.now
      )
      return get(big(res.lastInsertRowid))
    },
    current(sessionId) {
      const r = current.get(id(sessionId)) as SqlRow | undefined
      return r ? epochFromRow(r) : null
    },
    onPath(sessionId) {
      return (onPath.all(id(sessionId)) as SqlRow[]).map(epochFromRow)
    },
    update(eid, p) {
      const c: Record<string, SqlValue> = {}
      if (p.recap !== undefined) c.recap = p.recap
      if (p.recapDraft !== undefined) c.recap_draft = p.recapDraft
      if (p.thinkingStripBefore !== undefined) c.thinking_strip_before = p.thinkingStripBefore === null ? null : id(p.thinkingStripBefore)
      if (Object.keys(c).length) {
        const { sql, values } = setClause(c)
        db.prepare(`UPDATE epochs SET ${sql} WHERE id = ?`).run(...values, id(eid))
      }
      return get(eid)
    }
  }
}
