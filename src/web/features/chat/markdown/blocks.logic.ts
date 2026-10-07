/**
 * Top-level markdown blocks with exact source offsets (07 D7: streaming is split into blocks, each memoized, only the
 * open one re-renders). Parsing uses the same mdast stack as the speech segmenter (GFM + math with
 * `singleDollarTextMath: false`), so block offsets line up with `SpeechChunkHeader.src` for the synced reveal (R14).
 *
 * While a reply streams, only the tail from the start of the last block is re-parsed: every block before it is final
 * (a later line can only change the block it belongs to, and that is the last one).
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { hasMathSyntax } from './math.logic'

export interface MdBlock {
  /** [start, end) into the whole text. */
  start: number
  end: number
  /** mdast node type ('paragraph', 'code', 'list', 'table', 'math', …). */
  kind: string
  /** Fenced code whose closing fence has arrived (or any non-code block). */
  closed: boolean
}

export interface BlockCache {
  text: string
  blocks: MdBlock[]
}

const MICROMARK = { extensions: [gfm(), math({ singleDollarTextMath: false })], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] }

/** Is a fenced code block's closing fence present? (Indented code is always closed.) */
export function fenceClosed(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
  if (!open) return true
  const fence = open[1]
  const lines = raw.split('\n')
  if (lines.length < 2) return false
  const last = lines[lines.length - 1].trim()
  return last.length >= fence.length && last === fence[0].repeat(last.length)
}

function parseBlocks(text: string, offset: number): MdBlock[] {
  if (!text.trim()) return []
  const tree = fromMarkdown(text, MICROMARK)
  const out: MdBlock[] = []
  for (const node of tree.children) {
    const s = node.position?.start.offset
    const e = node.position?.end.offset
    if (s === undefined || e === undefined) continue
    // Definitions render nothing; keep them out of the block list.
    if (node.type === 'definition') continue
    const raw = text.slice(s, e)
    out.push({ start: offset + s, end: offset + e, kind: node.type, closed: node.type === 'code' ? fenceClosed(raw) : true })
  }
  return out
}

/**
 * Blocks of `text`. Pass the previous result while streaming (`text` grows by appends) to re-parse only the tail.
 */
export function splitBlocks(text: string, prev?: BlockCache | null): MdBlock[] {
  if (prev && prev.blocks.length > 0 && text.startsWith(prev.text)) {
    const last = prev.blocks[prev.blocks.length - 1]
    const keep = prev.blocks.slice(0, -1)
    return keep.concat(parseBlocks(text.slice(last.start), last.start))
  }
  return parseBlocks(text, 0)
}

/** Markdown → plain text for "Copy as plain text" (07 C8): drop markup, keep words, code and line structure. */
export function markdownToPlain(text: string): string {
  if (!text.trim()) return ''
  const tree = fromMarkdown(text, MICROMARK)
  const parts: string[] = []
  type Node = { type: string; value?: string; children?: Node[]; ordered?: boolean | null; start?: number | null }
  const inline = (n: Node): string => {
    if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') return n.value ?? ''
    if (n.type === 'break') return '\n'
    if (n.type === 'image') return ''
    return (n.children ?? []).map(inline).join('')
  }
  const block = (n: Node, prefix = ''): void => {
    switch (n.type) {
      case 'list': {
        let i = n.start ?? 1
        for (const item of n.children ?? []) {
          const mark = n.ordered ? `${i++}. ` : '• '
          const sub: string[] = []
          for (const c of item.children ?? []) {
            if (c.type === 'list') {
              const before = parts.length
              block(c, prefix + '  ')
              sub.push(...parts.splice(before))
            } else sub.push(inline(c))
          }
          parts.push(prefix + mark + sub.join('\n'))
        }
        return
      }
      case 'code':
      case 'math':
      case 'html':
        parts.push(n.value ?? '')
        return
      case 'table':
        for (const row of n.children ?? []) parts.push((row.children ?? []).map(inline).join('\t'))
        return
      case 'thematicBreak':
      case 'definition':
        return
      case 'blockquote':
        for (const c of n.children ?? []) block(c, prefix)
        return
      default:
        parts.push(prefix + inline(n))
    }
  }
  for (const n of tree.children as Node[]) block(n)
  return parts.filter((p, i) => p !== '' || i === 0).join('\n\n').trim()
}

/**
 * The text needs KaTeX: `$$…$$`, a TeX-delimited formula or a `$…$` that reads as one (prices don't; P08,
 * math.logic.ts). Block splitting is unaffected: the renderer's rewrite is inline-only and keeps every offset.
 */
export function hasMath(text: string): boolean {
  return hasMathSyntax(text)
}
