/**
 * Search legs that run inside db.worker (research 02 §5.3, research 03 §3.4):
 * - keyword: FTS5 over the newest 2,000 matches (bounded by the scope's id range when the scope is small), ranked by
 *   bm25 — the candidate cap keeps a very common term at ≤ 40 ms on 1M rows;
 * - vector: the bit index picks ~400 candidates, int8 vectors from SQLite rescore them (cosine with the float query);
 * - fusion: Reciprocal Rank Fusion, score = Σ 1 / (60 + rank).
 * Every leg re-checks on_path / hidden / deleted against `messages`, so the in-memory flags are only a prefilter.
 * Words inside attachments (07 C8 `attachment_fts`, F72) count as keyword matches of the messages carrying the file
 * (`message_attachments`, migration 10), filtered exactly like message hits.
 */
import { BitIndex, signBits } from './bitIndex'
import { ftsAndQuery, ftsOrQuery } from './text'
import { big, marks, num, type Row, type Stmts } from './sql'

export const KEYWORD_CANDIDATES = 2000
export const LEG_K = 50
export const RESCORE_K = 400
export const RRF_K = 60
/** Attachment texts considered per query (attachments are few next to messages). */
export const ATTACHMENT_CANDIDATES = 200
/** Messages per matching file (the same file sent again in many chats). */
const MESSAGES_PER_FILE = 50

export interface ScopeFilter {
  /** allowed[sessionId] → searchable; null = every session. */
  allowed: Uint8Array | null
  sessionIds: number[] | null
  after: number | null
  before: number | null
  includeOffPath: boolean
  /** Only this role (UI search filter, Phase 4); rows must then carry `role`. */
  role?: 'user' | 'assistant' | null
}

export function allowedBitmap(ids: number[] | null): Uint8Array | null {
  if (ids === null) return null
  let max = 0
  for (const id of ids) if (id > max) max = id
  const out = new Uint8Array(max + 1)
  for (const id of ids) if (id >= 0) out[id] = 1
  return out
}

/**
 * The id range of a small scope's on-path messages (ids grow along a path, 07 C3), so FTS scans only that range.
 * Null when the scope is large or unrestricted.
 */
export function idBounds(st: Stmts, sessionIds: number[] | null, includeOffPath: boolean): { lo: bigint; hi: bigint | null } | null {
  if (sessionIds === null || sessionIds.length === 0 || sessionIds.length > 32) return null
  let lo: number | null = null
  let hi: number | null = null
  const first = st.get('SELECT id FROM messages WHERE session_id = ? AND on_path = 1 ORDER BY seq ASC LIMIT 1')
  const last = st.get('SELECT id FROM messages WHERE session_id = ? AND on_path = 1 ORDER BY seq DESC LIMIT 1')
  for (const sid of sessionIds) {
    const a = first.get(big(sid)) as Row | undefined
    const b = last.get(big(sid)) as Row | undefined
    if (!a || !b) continue
    lo = lo === null ? num(a.id) : Math.min(lo, num(a.id))
    hi = hi === null ? num(b.id) : Math.max(hi, num(b.id))
  }
  if (lo === null || hi === null) return { lo: 1n, hi: 0n } // nothing on path: an empty range
  // Off-path variants are created later than the path around them, so their ids can exceed the last on-path id.
  return { lo: big(lo), hi: includeOffPath ? null : big(hi) }
}

/** The attachment whose text matched (F72): its file name and an FTS snippet with «…» marks. */
export interface AttachmentMatch {
  name: string
  snippet: string
}

interface KwRow {
  id: number
  rank: number
  att?: AttachmentMatch
}

function passes(r: Row, f: ScopeFilter): boolean {
  if (num(r.hidden) !== 0) return false
  if (!f.includeOffPath && num(r.on_path) !== 1) return false
  const sid = num(r.session_id)
  if (f.allowed && (sid >= f.allowed.length || f.allowed[sid] === 0)) return false
  const ts = num(r.ts_utc)
  if (f.after !== null && ts < f.after) return false
  if (f.before !== null && ts >= f.before) return false
  if (f.role && r.role !== f.role) return false
  return true
}

/** Keyword leg for memory: OR of the query terms, bm25 over the newest capped matches, filtered to the scope. */
export function keywordLeg(st: Stmts, query: string, f: ScopeFilter, k = LEG_K): KwRow[] {
  const match = ftsOrQuery(query)
  if (!match) return []
  return mergeRanked(rankedMatches(st, match, f, k), attachmentMatches(st, match, f, k), k)
}

/** Two bm25-ranked lists as one (lower rank first), each message once; a message found both ways keeps its file. */
function mergeRanked(a: KwRow[], b: KwRow[], k: number): KwRow[] {
  if (!b.length) return a
  const att = new Map(b.map((r) => [r.id, r.att]))
  const seen = new Set<number>()
  const out: KwRow[] = []
  for (const r of [...a, ...b].sort((x, y) => x.rank - y.rank)) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r.att || !att.has(r.id) ? r : { ...r, att: att.get(r.id) })
    if (out.length >= k) break
  }
  return out
}

/**
 * Messages carrying a file whose extracted text matches (07 C8, F72), best file first; deleted, hidden, off-path and
 * out-of-scope messages are skipped like message hits. `rank` is the file's bm25.
 */
export function attachmentMatches(st: Stmts, match: string, f: ScopeFilter, k: number): KwRow[] {
  const files = st
    .get(
      `SELECT t.sha AS sha, bm25(attachment_fts) AS r, snippet(attachment_fts, 0, '«', '»', '…', 16) AS s
         FROM attachment_fts JOIN attachment_text t ON t.id = attachment_fts.rowid
        WHERE attachment_fts MATCH ? ORDER BY r LIMIT ?`
    )
    .all(match, BigInt(ATTACHMENT_CANDIDATES)) as Row[]
  if (!files.length) return []
  const nameOf = st.get('SELECT name FROM attachments WHERE sha = ?')
  const carriers = st.get(
    `SELECT m.id, m.session_id, m.ts_utc, m.on_path, m.hidden, m.deleted, m.role FROM message_attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.sha = ? ORDER BY m.id DESC LIMIT ?`
  )
  const out: KwRow[] = []
  const seen = new Set<number>()
  for (const file of files) {
    const name = (nameOf.get(String(file.sha)) as Row | undefined)?.name
    for (const r of carriers.all(String(file.sha), BigInt(MESSAGES_PER_FILE)) as Row[]) {
      const id = num(r.id)
      if (num(r.deleted) !== 0 || !passes(r, f) || seen.has(id)) continue
      seen.add(id)
      out.push({ id, rank: Number(file.r), att: { name: typeof name === 'string' ? name : 'attachment', snippet: String(file.s) } })
      if (out.length >= k) return out
    }
  }
  return out
}

/** The UI snippet of an attachment hit: `file.pdf: …«match»…`. */
export function attachmentSnippet(a: AttachmentMatch): string {
  return `${a.name}: ${a.snippet}`
}

function rankedMatches(st: Stmts, match: string, f: ScopeFilter, k: number): KwRow[] {
  const b = idBounds(st, f.sessionIds, f.includeOffPath)
  if (b && b.hi !== null && b.hi < b.lo) return []
  const cand = b
    ? b.hi === null
      ? st.get('SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid >= ? ORDER BY rowid DESC LIMIT ?').all(match, b.lo, BigInt(KEYWORD_CANDIDATES))
      : st.get('SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid BETWEEN ? AND ? ORDER BY rowid DESC LIMIT ?').all(match, b.lo, b.hi, BigInt(KEYWORD_CANDIDATES))
    : st.get('SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT ?').all(match, BigInt(KEYWORD_CANDIDATES))
  if (!cand.length) return []
  let lo = Infinity
  let hi = -Infinity
  for (const r of cand as Row[]) {
    const id = num(r.id)
    if (id < lo) lo = id
    if (id > hi) hi = id
  }
  const rows = st
    .get(
      `SELECT f.rowid AS id, bm25(messages_fts) AS r, m.session_id, m.ts_utc, m.on_path, m.hidden, m.role
       FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND f.rowid BETWEEN ? AND ? ORDER BY r LIMIT ?`
    )
    .all(match, big(lo), big(hi), BigInt(KEYWORD_CANDIDATES)) as Row[]
  const out: KwRow[] = []
  for (const r of rows) {
    if (!passes(r, f)) continue
    out.push({ id: num(r.id), rank: Number(r.r) })
    if (out.length >= k) break
  }
  return out
}

export interface VecRow {
  id: number
  cos: number
}

/** Vector leg: bit-scan candidates, then int8 cosine against the float query from SQLite rows of `gen`. */
export function vectorLeg(st: Stmts, index: BitIndex, gen: number, q: Float32Array, f: ScopeFilter, k = LEG_K, timings?: Record<string, number>): VecRow[] {
  let norm = 0
  for (let i = 0; i < q.length; i++) norm += q[i] * q[i]
  norm = Math.sqrt(norm) || 1
  const t0 = performance.now()
  const slots = index.scan(signBits(q), { allowed: f.allowed, after: f.after, before: f.before }, RESCORE_K)
  if (timings) timings.scan = performance.now() - t0
  if (!slots.length) return []
  const ids = [...new Set(slots.map((s) => index.msgIds[s]))]
  const rows = st
    .get(
      `SELECT v.message_id AS id, v.v AS v FROM vectors v JOIN messages m ON m.id = v.message_id
       WHERE v.gen = ? AND v.message_id IN (${marks(ids.length)}) AND m.deleted = 0 AND m.hidden = 0${f.includeOffPath ? '' : ' AND m.on_path = 1'}`
    )
    .all(big(gen), ...ids.map(big)) as Row[]
  const best = new Map<number, number>()
  for (const r of rows) {
    const v = r.v as Uint8Array
    const iv = new Int8Array(v.buffer, v.byteOffset, v.byteLength)
    if (iv.length !== q.length) continue
    let dot = 0
    let vn = 0
    for (let i = 0; i < iv.length; i++) {
      dot += q[i] * iv[i]
      vn += iv[i] * iv[i]
    }
    const cos = dot / (norm * (Math.sqrt(vn) || 1))
    const id = num(r.id)
    const prev = best.get(id)
    if (prev === undefined || cos > prev) best.set(id, cos)
  }
  return [...best.entries()]
    .map(([id, cos]) => ({ id, cos }))
    .sort((a, b) => b.cos - a.cos || b.id - a.id)
    .slice(0, k)
}

/** Reciprocal Rank Fusion of ranked id lists (research 02 §5.3 step 5). */
export function rrf(lists: number[][], k = RRF_K): { id: number; score: number }[] {
  const score = new Map<number, number>()
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || b.id - a.id)
}

/** The UI search box (newest-first pages, or bm25 over the newest capped matches), with «…» snippets. */
export function ftsPage(
  st: Stmts,
  a: { query: string; f: ScopeFilter; beforeId: number | null; order: 'recent' | 'relevance'; limit: number }
): { items: { id: number; snippet: string; score: number }[]; next: number | null } {
  // Relevance is a deliberate search (no prefix expansion, which is costly for bm25 over many rows).
  const match = ftsAndQuery(a.query, a.order === 'recent')
  if (!match) return { items: [], next: null }
  const b = idBounds(st, a.f.sessionIds, a.f.includeOffPath)
  if (b && b.hi !== null && b.hi < b.lo) return { items: [], next: null }
  const items: { id: number; snippet: string; score: number }[] = []
  if (a.order === 'relevance') {
    const ranked = mergeRanked(rankedMatches(st, match, a.f, a.limit), attachmentMatches(st, match, a.f, a.limit), a.limit)
    if (!ranked.length) return { items, next: null }
    // One MATCH evaluation for all snippets of the page.
    const snips = new Map<number, string>()
    const own = ranked.filter((x) => !x.att)
    if (own.length)
      for (const r of st
        .get(`SELECT rowid AS id, snippet(messages_fts, 0, '«', '»', '…', 12) AS s FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (${marks(own.length)})`)
        .all(match, ...own.map((x) => big(x.id))) as Row[])
        snips.set(num(r.id), String(r.s))
    for (const r of ranked) items.push({ id: r.id, snippet: r.att ? attachmentSnippet(r.att) : (snips.get(r.id) ?? ''), score: -r.rank })
    return { items, next: null }
  }
  // Newest first, paged by id; scan in slices so a narrow scope never walks the whole posting list at once.
  let upper: bigint = a.beforeId !== null ? big(a.beforeId) : BigInt(Number.MAX_SAFE_INTEGER)
  const lower = b ? b.lo : 0n
  const upperCap = b && b.hi !== null ? b.hi + 1n : null
  if (upperCap !== null && upperCap < upper) upper = upperCap
  const slice = st.get(
    `SELECT f.rowid AS id, snippet(messages_fts, 0, '«', '»', '…', 12) AS s, m.session_id, m.ts_utc, m.on_path, m.hidden, m.role
     FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? AND f.rowid < ? AND f.rowid >= ? ORDER BY f.rowid DESC LIMIT ?`
  )
  let scanned = 0
  const start = upper
  // The lowest id the scan has looked at; `lower` once the posting list is exhausted.
  let floor: bigint = upper
  let exhausted = false
  while (items.length < a.limit + 1 && scanned < 20_000) {
    const rows = slice.all(match, upper, lower, BigInt(500)) as Row[]
    if (!rows.length) {
      exhausted = true
      break
    }
    scanned += rows.length
    for (const r of rows) {
      floor = big(num(r.id))
      if (!passes(r, a.f)) continue
      items.push({ id: num(r.id), snippet: String(r.s), score: 0 })
      if (items.length >= a.limit + 1) break
    }
    upper = big(num(rows[rows.length - 1].id))
    if (rows.length < 500) {
      exhausted = items.length < a.limit + 1
      break
    }
  }
  if (exhausted) floor = lower
  // Messages whose attachment text matches (F72), merged in id order within the part of the id range scanned.
  const have = new Set(items.map((x) => x.id))
  for (const r of attachmentMatches(st, match, a.f, ATTACHMENT_CANDIDATES)) {
    const id = big(r.id)
    if (have.has(r.id) || id >= start || id < floor) continue
    items.push({ id: r.id, snippet: attachmentSnippet(r.att!), score: 0 })
  }
  items.sort((x, y) => y.id - x.id)
  const more = items.length > a.limit
  const page = items.slice(0, a.limit)
  // When the scan budget ran out, continue after the last scanned row next time.
  const next = more ? page[page.length - 1].id : scanned >= 20_000 ? num(upper) : null
  return { items: page, next }
}
