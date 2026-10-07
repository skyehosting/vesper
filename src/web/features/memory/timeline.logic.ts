/**
 * Memory viewer timeline logic (pure, unit-tested): filters → request query, rows with day separators, search
 * snippets (`«match»` markers → parts), and local filtering of search hits (the search API has no role/date filter).
 */
import type { MemoryTimelineQuery } from '@shared/api'
import type { Message, SearchHit, TimelineEntry } from '@shared/types/domain'
import type { Zone } from '@shared/time'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { dayKey, dayLabel } from './format.logic'

export interface TimelineFilters {
  /** Search text ('' = browse the timeline). */
  q: string
  mode: 'keyword' | 'semantic'
  session: string | null
  role: 'all' | 'user' | 'assistant'
  /** yyyy-mm-dd in the viewer's zone ('' = open). */
  from: string
  to: string
}

export const EMPTY_FILTERS: TimelineFilters = { q: '', mode: 'keyword', session: null, role: 'all', from: '', to: '' }

/** Midnight (start) or the last millisecond (end) of a yyyy-mm-dd day in `zone`, as UTC ms; null when invalid. */
export function dayBoundUtc(ymd: string, zone: Zone, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Guess with UTC, then correct by the zone's offset at that instant (twice, for DST edges).
  let t = Date.UTC(y, mo - 1, d + (end ? 1 : 0), 0, 0, 0)
  for (let i = 0; i < 2; i++) t = Date.UTC(y, mo - 1, d + (end ? 1 : 0)) - zone.partsAt(t).offsetMin * 60_000
  return end ? t - 1 : t
}

export function timelineQuery(f: TimelineFilters, zone: Zone, cursor?: string | null, limit = 50): MemoryTimelineQuery {
  const q: MemoryTimelineQuery = { limit }
  if (f.session) q.session = f.session
  if (f.role !== 'all') q.role = f.role
  const from = f.from ? dayBoundUtc(f.from, zone, false) : null
  const to = f.to ? dayBoundUtc(f.to, zone, true) : null
  if (from !== null) q.fromUtc = from
  if (to !== null) q.toUtc = to
  if (cursor) q.cursor = cursor
  return q
}

export function activeFilterCount(f: TimelineFilters): number {
  return (f.session ? 1 : 0) + (f.role !== 'all' ? 1 : 0) + (f.from ? 1 : 0) + (f.to ? 1 : 0)
}

/** Search hits pass the role/date filters locally (the server filters only by session). */
export function hitPasses(m: Message, f: TimelineFilters, zone: Zone): boolean {
  if (f.role !== 'all' && m.role !== f.role) return false
  const from = f.from ? dayBoundUtc(f.from, zone, false) : null
  const to = f.to ? dayBoundUtc(f.to, zone, true) : null
  if (from !== null && m.tsUtc < from) return false
  if (to !== null && m.tsUtc > to) return false
  return true
}

/** One entry in the viewer: a timeline row or a search hit (with its snippet). */
export interface ViewerItem {
  message: Message
  session: { uid: string; shortId: string; title: string; private?: boolean }
  snippet?: string
  onPath?: boolean
}

export function fromTimeline(e: TimelineEntry): ViewerItem {
  return { message: e.message, session: e.session }
}

export function fromHit(h: SearchHit): ViewerItem {
  return { message: h.message, session: h.session, snippet: h.snippet, onPath: h.onPath }
}

export type Row = { kind: 'day'; key: string; label: string } | { kind: 'item'; key: string; item: ViewerItem }

/** Rows with a day separator before each new local day (search results ranked by relevance get none). */
export function buildRows(items: readonly ViewerItem[], zone: Zone, nowUtc: number, separators = true): Row[] {
  const rows: Row[] = []
  let last: string | null = null
  const seen = new Set<string>()
  for (const it of items) {
    if (seen.has(it.message.uid)) continue
    seen.add(it.message.uid)
    if (separators) {
      const k = dayKey(it.message.tsUtc, zone)
      if (k !== last) {
        rows.push({ kind: 'day', key: `d:${k}:${rows.length}`, label: dayLabel(it.message.tsUtc, nowUtc, zone) })
        last = k
      }
    }
    rows.push({ kind: 'item', key: it.message.uid, item: it })
  }
  return rows
}

/** "…the «castle» and the «tram»…" → text parts with `mark` flags. Unbalanced markers are shown as plain text. */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = []
  const re = /«([^«»]*)»/g
  let at = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet))) {
    if (m.index > at) out.push({ text: snippet.slice(at, m.index), mark: false })
    if (m[1]) out.push({ text: m[1], mark: true })
    at = m.index + m[0].length
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), mark: false })
  return out.filter((p) => p.text !== '')
}

/** The chat's markdown dialect (GFM + `$$` math, single-dollar math off), so a preview parses a reply the way chat does. */
const MICROMARK = { extensions: [gfm(), math({ singleDollarTextMath: false })], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] }

type MdNode = {
  type: string
  value?: string
  alt?: string | null
  children?: MdNode[]
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
}

function mdInline(n: MdNode): string {
  switch (n.type) {
    case 'text':
    case 'inlineCode':
    case 'inlineMath':
    // Raw HTML shows as text in chat (react-markdown without rehype-raw, 07 B8), so `List<String>` keeps its `<String>`.
    case 'html':
      return n.value ?? ''
    case 'break':
      return '\n'
    case 'image':
    case 'imageReference':
      return n.alt ? `[image: ${n.alt}]` : '[image]'
    case 'footnoteReference':
      return ''
    default:
      return (n.children ?? []).map(mdInline).join('')
  }
}

function mdBlock(n: MdNode, indent = ''): string {
  switch (n.type) {
    case 'list': {
      const first = n.start ?? 1
      return (n.children ?? [])
        .map((item, i) => {
          const mark = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : n.ordered ? `${first + i}. ` : '• '
          const body = (item.children ?? []).map((c, j) => (c.type === 'list' ? mdBlock(c, indent + '  ') : (j === 0 ? indent + mark : indent + '  ') + mdBlock(c)))
          return body.length ? body.join('\n') : indent + mark.trimEnd()
        })
        .join('\n')
    }
    case 'code':
    case 'math':
    case 'html':
      return n.value ?? ''
    case 'table':
      return (n.children ?? []).map((row) => (row.children ?? []).map(mdInline).join('\t')).join('\n')
    case 'blockquote':
      return (n.children ?? []).map((c) => mdBlock(c)).filter(Boolean).join('\n\n')
    case 'thematicBreak':
    case 'definition':
    case 'footnoteDefinition':
      return ''
    default:
      return mdInline(n)
  }
}

/**
 * An AI reply as the words the chat shows (F53): markup (**, ##, backticks, fences, link syntax) goes, but nothing the
 * chat displays is lost — raw HTML stays literal text, an image becomes `[image: alt]`, task items keep their box and a
 * list keeps one item per line. Its own walk rather than "Copy as plain text" so the timeline never hides words.
 */
export function replyPlainText(body: string): string {
  if (!body.trim()) return ''
  const tree = fromMarkdown(body, MICROMARK) as unknown as MdNode
  return (tree.children ?? [])
    .map((n) => mdBlock(n))
    .filter((p) => p !== '')
    .join('\n\n')
    .trim()
}

/**
 * A message body as plain text for previews, never HTML. AI replies are markdown, so their markup is dropped with
 * `replyPlainText` (F53); the owner's own messages are shown in chat as typed, so they stay as written. Copy still
 * copies the stored text.
 */
export function previewText(body: string, max = 4000, role: 'user' | 'assistant' = 'user'): { text: string; cut: boolean } {
  const t = (role === 'assistant' ? replyPlainText(body) : body)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length > max ? { text: `${t.slice(0, max).trimEnd()}…`, cut: true } : { text: t, cut: false }
}
