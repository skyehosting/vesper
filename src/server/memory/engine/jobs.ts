/**
 * The row-level bulk job of db.worker's memory side (07 C9): purge (hard delete), in transactions of ≤ 500 rows with
 * a yield between them, checking for cancellation at every chunk boundary. Export, import and backup are content's
 * (src/server/data/*), run on this worker by src/server/data/worker.ts — one implementation (platform-int).
 */
import { djson } from '@shared/djson'
import type { WireBlock } from '@shared/types/wire'
import type { Db } from '../../db/sqlite'
import type { JobSpec } from './protocol'
import { RecordIndex, recordKeys, redactRecalledBlocks } from './redact'
import { big, chunks, marks, num, writeTx, yieldNow, type Row, type Stmts } from './sql'

/** What a purged message's wire turns keep (07 B9): their shape (roles, tool ids), never their text. */
export const PURGED_TEXT = '(deleted)'

/**
 * The wire blocks of a purged message with every piece of its content gone: text, results and recalled records
 * become "(deleted)", attachments a "(deleted)" text block, tool inputs empty; reasoning payloads are dropped (only a
 * recent turn's are ever replayed). Tool-call ids and roles stay, so the transcript still pairs calls with results.
 */
export function redactBlocks(blocks: WireBlock[]): WireBlock[] {
  const out: WireBlock[] = []
  for (const b of blocks) {
    switch (b.t) {
      case 'text':
      case 'memory_result':
      case 'image':
      case 'document':
      case 'file_text':
        if (!out.some((x) => x.t === 'text' && x.text === PURGED_TEXT)) out.push({ t: 'text', text: PURGED_TEXT })
        break
      case 'tool_call':
        out.push({ t: 'tool_call', id: b.id, name: b.name, input: {} })
        break
      case 'tool_result':
        out.push({ t: 'tool_result', id: b.id, text: PURGED_TEXT, ...(b.isError ? { isError: true } : {}) })
        break
      case 'reasoning':
        break
      case 'system_note':
        out.push(b)
        break
    }
  }
  return out.length ? out : [{ t: 'text', text: PURGED_TEXT }]
}

const TX_ROWS = 500
/** A messages.meta field, NULL when meta is not valid JSON (json_extract would throw and stop the purge). */
const META = (field: string): string => `(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.${field}') END)`
const SCAN_CHUNK = 10_000

type Progress = (done: number, total: number) => void

/**
 * Replace the recalled records of messages about to lose their content in EVERY chat's wire transcript (F16 second
 * pass; ./redact.ts). Scans transcript rows holding a memory/tool result in id slices, rewriting in ≤ 500-row
 * transactions with yields. Runs before the content goes, so a cancelled purge leaves nothing unredacted behind.
 */
async function redactRecalledCopies(db: Db, st: Stmts, victims: { body: string; attachments: string }[], check: () => void): Promise<number> {
  const index = new RecordIndex()
  for (const v of victims) for (const k of recordKeys(v.body, v.attachments)) index.add(k)
  if (!index.size) return 0
  const max = num((st.get('SELECT max(id) AS m FROM transcript').get() as Row).m ?? 0)
  const pick = st.get(
    `SELECT id, blocks FROM transcript WHERE id > ? AND id <= ?
       AND (instr(blocks, '"t":"memory_result"') > 0 OR instr(blocks, '"t":"tool_result"') > 0)`
  )
  const upd = st.get('UPDATE transcript SET blocks = ?, bytes = ? WHERE id = ?')
  let rows = 0
  for (let lo = 0; lo < max; lo += SCAN_CHUNK) {
    check()
    const changed: { id: bigint; text: string }[] = []
    for (const r of pick.all(BigInt(lo), BigInt(lo + SCAN_CHUNK)) as Row[]) {
      let blocks: unknown
      try {
        blocks = JSON.parse(String(r.blocks))
      } catch {
        continue
      }
      if (!Array.isArray(blocks)) continue
      const next = redactRecalledBlocks(blocks as WireBlock[], index)
      if (next) changed.push({ id: big(num(r.id)), text: djson(next) })
    }
    for (const c of chunks(changed, TX_ROWS)) {
      writeTx(db, () => {
        for (const x of c) upd.run(x.text, Buffer.byteLength(x.text), x.id)
      })
      await yieldNow()
    }
    rows += changed.length
    await yieldNow()
  }
  return rows
}

export async function purgeRows(
  db: Db,
  st: Stmts,
  j: Extract<JobSpec, { kind: 'purge' }>,
  check: () => void,
  progress: Progress,
  onSessionGone: (sessionId: number) => void
): Promise<{ sessions: number; messages: number; cleared: number }> {
  const ids = new Set<number>(j.sessionIds ?? [])
  if (j.deletedBeforeUtc !== undefined) {
    for (const r of st.get('SELECT id FROM sessions WHERE deleted_utc IS NOT NULL AND deleted_utc < ?').all(j.deletedBeforeUtc) as Row[]) ids.add(num(r.id))
  }
  let messages = 0
  let clearedCount = 0
  let done = 0
  // 07 B9: a deleted message can be restored for 30 days (meta.deletedUtc, stamped at delete); after that its
  // content goes for good. Without a cutoff every deleted message is cleared now. A deleted row from before the
  // stamp existed starts its 30 days now. Found first: their recalled copies elsewhere go before their content.
  const due: Row[] = []
  if (j.clearDeletedBodies) {
    const cutoff = j.deletedBeforeUtc
    const now = j.nowUtc ?? Date.now()
    const max = num((st.get('SELECT max(id) AS m FROM messages').get() as Row).m ?? 0)
    for (let lo = 0; lo < max; lo += SCAN_CHUNK) {
      check()
      const lohi = [BigInt(lo), BigInt(lo + SCAN_CHUNK)] as const
      if (cutoff !== undefined) {
        writeTx(db, () =>
          st
            .get(
              `UPDATE messages SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.deletedUtc', ?)
                WHERE id > ? AND id <= ? AND deleted = 1 AND ${META('deletedUtc')} IS NULL`
            )
            .run(now, ...lohi)
        )
      }
      const rows = (
        cutoff === undefined
          ? st
              .get(`SELECT id, session_id, body, attachments FROM messages WHERE id > ? AND id <= ? AND deleted = 1 AND ${META('purgedUtc')} IS NULL`)
              .all(...lohi)
          : st
              .get(
                `SELECT id, session_id, body, attachments FROM messages WHERE id > ? AND id <= ? AND deleted = 1 AND ${META('deletedUtc')} < ?
                   AND ${META('purgedUtc')} IS NULL`
              )
              .all(...lohi, cutoff)
      ) as Row[]
      for (const r of rows) if (!ids.has(num(r.session_id))) due.push(r)
      await yieldNow()
    }
  }
  // Every message of a purged chat and every message due for clearing: their records recalled into other chats.
  const victims: { body: string; attachments: string }[] = due.map((r) => ({ body: String(r.body ?? ''), attachments: String(r.attachments ?? '[]') }))
  for (const sid of ids) {
    check()
    for (const r of st.get('SELECT body, attachments FROM messages WHERE session_id = ?').all(big(sid)) as Row[])
      victims.push({ body: String(r.body ?? ''), attachments: String(r.attachments ?? '[]') })
  }
  await redactRecalledCopies(db, st, victims, check)
  for (const sid of ids) {
    check()
    const S = big(sid)
    const idsOf = st.get('SELECT id FROM messages WHERE session_id = ? ORDER BY id LIMIT ?')
    for (;;) {
      check()
      const m = (idsOf.all(S, BigInt(TX_ROWS)) as Row[]).map((r) => big(num(r.id)))
      if (!m.length) break
      writeTx(db, () => {
        const q = marks(m.length)
        for (const t of ['vectors', 'vector_bits', 'embed_queue']) st.get(`DELETE FROM ${t} WHERE message_id IN (${q})`).run(...m)
        st.get(`DELETE FROM memory_injections WHERE message_id IN (${q})`).run(...m)
        st.get(`DELETE FROM transcript WHERE message_id IN (${q})`).run(...m)
        st.get(`DELETE FROM messages WHERE id IN (${q})`).run(...m)
      })
      messages += m.length
      await yieldNow()
    }
    writeTx(db, () => {
      for (const sql of [
        'DELETE FROM memory_injections WHERE session_id = ?',
        'DELETE FROM transcript WHERE session_id = ?',
        'DELETE FROM epochs WHERE session_id = ?',
        'DELETE FROM branch_choices WHERE session_id = ?',
        'DELETE FROM branches WHERE session_id = ?',
        'DELETE FROM sessions WHERE id = ?'
      ])
        st.get(sql).run(S)
      // The /continue recap cached for the chat (an extractive recap quotes it, F16).
      st.get('DELETE FROM kv WHERE k = ?').run(`chat.recap:${sid}`)
      st.get('DELETE FROM session_links WHERE from_session = ? OR to_session = ?').run(S, S)
    })
    onSessionGone(sid)
    progress(++done, ids.size)
    await yieldNow()
  }
  if (j.clearDeletedBodies) {
    const now = j.nowUtc ?? Date.now()
    const cleared = new Set<number>()
    for (const c of chunks(due, TX_ROWS)) {
      check()
      const m = c.map((r) => big(num(r.id)))
      const q = marks(m.length)
      writeTx(db, () => {
        st.get(
          `UPDATE messages SET body = '', attachments = '[]', meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.purgedUtc', ?) WHERE id IN (${q})`
        ).run(now, ...m)
        for (const t of ['vectors', 'vector_bits', 'embed_queue']) st.get(`DELETE FROM ${t} WHERE message_id IN (${q})`).run(...m)
        st.get(`DELETE FROM memory_injections WHERE message_id IN (${q}) OR turn_message_id IN (${q})`).run(...m, ...m)
        const upd = st.get('UPDATE transcript SET blocks = ?, bytes = ? WHERE id = ?')
        for (const r of st.get(`SELECT id, blocks FROM transcript WHERE message_id IN (${q})`).all(...m) as Row[]) {
          let blocks: WireBlock[] = []
          try {
            blocks = JSON.parse(String(r.blocks)) as WireBlock[]
          } catch {
            blocks = []
          }
          const text = djson(redactBlocks(Array.isArray(blocks) ? blocks : []))
          upd.run(text, Buffer.byteLength(text), big(num(r.id)))
        }
        // A cached /continue recap of that chat may quote the message (extractive recap).
        for (const sid of new Set(c.map((r) => num(r.session_id)))) st.get('DELETE FROM kv WHERE k = ?').run(`chat.recap:${sid}`)
      })
      for (const r of c) cleared.add(num(r.id))
      await yieldNow()
    }
    clearedCount = cleared.size
  }
  return { sessions: ids.size, messages, cleared: clearedCount }
}
