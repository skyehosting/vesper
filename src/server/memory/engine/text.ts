/**
 * Text rules of the memory index (research 02 §5.2/§5.3):
 * - the embedded unit is one message: `<tag>: <text>` with a little context (an AI reply carries the user message it
 *   answers; a short user message carries the AI message before it), never the control tags (07 A3) or a turn header;
 * - trivial messages (< 3 word tokens, emoji only) are not embedded (FTS still has them, 07 A1);
 * - messages over ~1,500 tokens are split by paragraph into ~400-token chunks;
 * - FTS queries drop stop words, quote every term and OR them (memory) or AND them with a prefix on the last one (UI).
 * The tag, the sender's timestamp and the session id are stored WITH every vector (vector_bits.session_id/ts_utc and
 * the message row) rather than inside the embedded text: research 02 §5.2 is explicit that timestamps and ids add
 * noise to embeddings, and time is applied as a filter and in the presentation (absolute + relative age).
 */
import { stripControlTags } from '@shared/tags'
import type { RoleTag } from '@shared/types/domain'
import { estimateTokens } from '../../providers/voyage/catalogue'

const WORD_RE = /[\p{L}\p{N}]+/gu
const CONTEXT_CHARS = 300
const CHUNK_TRIGGER_TOKENS = 1500
const CHUNK_TARGET_CHARS = 2000
/** Voyage context is 32K tokens; keep each input well under it. */
const MAX_INPUT_CHARS = 60_000
/** A leading `[Now: …]` header (07 C2) or an imitated stamp never reaches the index. */
const HEADER_RE = /^\s*\[(?:Now: )?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}[^\]\n]{0,160}\]\s*/

export function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? []
}

/** Fewer than 3 word tokens (emoji-only and "ok thanks" style replies). */
export function isTrivial(body: string): boolean {
  return words(body).length < 3
}

/** The text the index may see: control tags and a leading time header removed. */
export function cleanForIndex(body: string): string {
  return stripControlTags(body).text.replace(HEADER_RE, '').trim()
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

export interface EmbedSource {
  tag: RoleTag
  body: string
  /** The on-path message before this one (seq − 1), if any. */
  prev: { tag: RoleTag; body: string } | null
}

/** Inputs to embed for one message: [] when trivial; several when long (chunk = index in the array). */
export function embedInputs(m: EmbedSource): string[] {
  const body = cleanForIndex(m.body)
  if (isTrivial(body)) return []
  let context = ''
  if (m.prev) {
    const prev = cleanForIndex(m.prev.body)
    if (m.tag === 'ai response' && m.prev.tag === 'user response' && prev) context = `In reply to: ${clip(prev, CONTEXT_CHARS)}\n`
    else if (m.tag === 'user response' && m.prev.tag === 'ai response' && prev && words(body).length < 12) context = `Replying to: ${clip(prev, CONTEXT_CHARS)}\n`
  }
  const parts = estimateTokens(body) > CHUNK_TRIGGER_TOKENS ? chunkByParagraph(body, CHUNK_TARGET_CHARS) : [body]
  return parts.map((p) => `${context}${m.tag}: ${p}`.slice(0, MAX_INPUT_CHARS))
}

/** Split at blank lines, packing paragraphs up to ~target chars; a single huge paragraph is cut at sentence ends. */
export function chunkByParagraph(text: string, target: number): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const p of paras) {
    if (p.length > target) {
      push()
      let rest = p
      while (rest.length > target) {
        const window = rest.slice(0, target)
        const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
        const at = cut > target / 2 ? cut + 1 : target
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      cur = rest
      continue
    }
    if (cur && cur.length + p.length + 2 > target) push()
    cur = cur ? `${cur}\n\n${p}` : p
  }
  push()
  return out.length ? out : [text]
}

/** The rerank document for a candidate (research 02 §5.3 step 6): `[<tag>, <date>] <text>` ≤ ~1,200 chars. */
/**
 * How the matching words of a message's file read next to the message (rerank documents, the model's records; F72):
 * `[Attached file "contract.pdf": …the notice period is ninety days…]` (the snippet's «» marks dropped).
 */
export function attachmentLine(a: { name: string; snippet: string }): string {
  return `[Attached file "${a.name.replace(/["\r\n]+/g, ' ')}": ${a.snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim()}]`
}

export function rerankDocument(tag: RoleTag, date: string, body: string): string {
  return `[${tag}, ${date}] ${clip(cleanForIndex(body), 1200)}`
}

const STOP = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing ' +
    'down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most ' +
    'my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would ' +
    'you your yours yourself yourselves im ive id dont didnt doesnt isnt wasnt cant wont thats whats lets also really like get got one us'
  ).split(' ')
)

/** Search terms of a free-text query: words minus stop words, de-duplicated, at most `max`. */
export function queryTerms(query: string, max = 8): string[] {
  const seen = new Set<string>()
  const all = words(query)
  for (const w of all) if (!STOP.has(w) && !seen.has(w)) seen.add(w)
  // A query made only of stop words still searches for them (better than nothing).
  if (!seen.size) for (const w of all) seen.add(w)
  return [...seen].slice(0, max)
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`

/** FTS5 MATCH expression for memory (recall-oriented OR), or null when nothing is searchable. */
export function ftsOrQuery(query: string): string | null {
  const t = queryTerms(query)
  return t.length ? t.map(quote).join(' OR ') : null
}

/** FTS5 MATCH expression for the UI search box: all terms, optionally the last one as a prefix (search as you type). */
export function ftsAndQuery(query: string, prefix = true): string | null {
  const t = queryTerms(query, 12)
  if (!t.length) return null
  return t.map((w, i) => (prefix && i === t.length - 1 ? `${quote(w)}*` : quote(w))).join(' AND ')
}

/** Share of the query's terms present in the text (0..1): the local relevance proxy when nothing is reranked. */
export function overlapScore(query: string, text: string): number {
  const q = queryTerms(query)
  if (!q.length) return 0
  const have = new Set(words(text))
  let hit = 0
  for (const w of q) if (have.has(w)) hit++
  return hit / q.length
}
