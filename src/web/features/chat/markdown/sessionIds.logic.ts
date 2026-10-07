/**
 * Session ids in reply text (07 C18): `#K7Q2MX` — the AI cites another chat by its short id (the manifest lists them)
 * — becomes a link node the renderer turns into a session chip (SessionChip.tsx). Pure: a remark plugin over mdast.
 *
 * Only exact display forms count: `#` + 6 characters of the short-id alphabet in upper case, not glued to a word on
 * either side. Text inside links, inline code, code blocks and math is left alone. Whether such an id names a real
 * chat is decided when it renders (a hex colour like `#FF0000` stays plain text).
 */
import { SHORT_ID_ALPHABET, SHORT_ID_LENGTH } from '@shared/ids'

/** The in-app href a session id becomes (an app path, so the link rules keep it, 07 B8). */
export const SESSION_HREF = '/session-id/'

const CH = `[${SHORT_ID_ALPHABET}]`
/** Not preceded by a word character or `#`/`/`, not followed by a word character. */
export const SESSION_ID_RE = new RegExp(`(?<![\\p{L}\\p{N}_#/&])#(${CH}{${SHORT_ID_LENGTH}})(?![\\p{L}\\p{N}_])`, 'gu')

export interface IdMatch {
  index: number
  /** Length of the matched text ("#" + id). */
  length: number
  shortId: string
}

export function findSessionIds(text: string): IdMatch[] {
  const out: IdMatch[] = []
  SESSION_ID_RE.lastIndex = 0
  for (let m = SESSION_ID_RE.exec(text); m; m = SESSION_ID_RE.exec(text)) out.push({ index: m.index, length: m[0].length, shortId: m[1] })
  return out
}

/** The short id of a SESSION_HREF link, or null. */
export function sessionIdOfHref(href: string): string | null {
  if (!href.startsWith(SESSION_HREF)) return null
  const id = href.slice(SESSION_HREF.length)
  return new RegExp(`^${CH}{${SHORT_ID_LENGTH}}$`).test(id) ? id : null
}

interface Point {
  line: number
  column: number
  offset?: number
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: Point; end: Point }
}

/**
 * Source positions for the pieces of a split text node, when its value is its source char for char (no escapes or
 * entities): the synced reveal maps chunk boundaries through them (F34 / NEW-1). Otherwise none, as before.
 */
function piecePosition(node: MdNode, text: string): ((from: number, to: number) => MdNode['position']) | null {
  const p = node.position
  const s = p?.start.offset
  if (!p || s === undefined || p.end.offset === undefined || p.end.offset - s !== text.length) return null
  const at = (i: number): Point => {
    const nl = text.lastIndexOf('\n', i - 1)
    if (nl < 0) return { line: p.start.line, column: p.start.column + i, offset: s + i }
    let lines = 0
    for (let k = text.indexOf('\n'); k >= 0 && k < i; k = text.indexOf('\n', k + 1)) lines++
    return { line: p.start.line + lines, column: i - nl, offset: s + i }
  }
  return (from, to) => ({ start: at(from), end: at(to) })
}

/** Containers whose text is never scanned. */
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'math', 'inlineMath', 'html', 'definition', 'image', 'imageReference'])

function splitText(node: MdNode): MdNode[] | null {
  const text = node.value ?? ''
  if (!text.includes('#')) return null
  const found = findSessionIds(text)
  if (!found.length) return null
  const pos = piecePosition(node, text)
  const piece = (from: number, to: number): MdNode => {
    const n: MdNode = { type: 'text', value: text.slice(from, to) }
    const position = pos?.(from, to)
    if (position) n.position = position
    return n
  }
  const out: MdNode[] = []
  let at = 0
  for (const f of found) {
    if (f.index > at) out.push(piece(at, f.index))
    const link: MdNode = { type: 'link', url: `${SESSION_HREF}${f.shortId}`, children: [piece(f.index, f.index + f.length)] }
    const position = pos?.(f.index, f.index + f.length)
    if (position) link.position = position
    out.push(link)
    at = f.index + f.length
  }
  if (at < text.length) out.push(piece(at, text.length))
  return out
}

function walk(node: MdNode): void {
  const kids = node.children
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.type === 'text') {
      const parts = splitText(c)
      if (parts) {
        kids.splice(i, 1, ...parts)
        i += parts.length - 1
      }
    } else if (!SKIP.has(c.type)) walk(c)
  }
}

/** remark plugin: `#K7Q2MX` → a link to SESSION_HREF + id. */
export function remarkSessionIds() {
  return (tree: MdNode): void => walk(tree)
}
