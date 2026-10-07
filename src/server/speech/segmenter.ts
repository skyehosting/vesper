/**
 * The speech document (07 C14): turns the streamed, tag-filtered markdown of a reply into speech chunks.
 *
 * The text is parsed with mdast (GFM + math, like the client's renderer) from the start of the top-level block that
 * holds the next unchunked character, so context such as list nesting is never lost and re-parsing stays O(block).
 * Every top-level block becomes a spoken stream (spoken chars with their source offsets) or an instant block (code,
 * table, math, html, rule, image-only paragraph: shown, never spoken). Chunks tile the source exactly — chunk k covers
 * [src[0], src[1]) and the next chunk starts where it ends — so every visible character belongs to one chunk.
 *
 * Boundaries are only between top-level blocks, list items / quoted paragraphs / headings, or sentences. The FIRST
 * spoken chunk is short for latency: it closes at the first sentence or clause mark after ≥ 40 spoken chars, or at a
 * word boundary by 150. Later chunks close at a sentence boundary once they hold ≥ 150 chars or 3 sentences, and never
 * exceed 400 chars (clause, then word boundaries inside very long sentences). A boundary inside a block still being
 * streamed is used only once the next word has arrived, so a chunk never ends on a guess.
 */
import type { Nodes, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { ABBREVIATIONS, spokenOf } from './spoken'

export interface PlannedChunk {
  index: number
  /** [start, end) into the concatenated pushed text. */
  src: [number, number]
  /** What the voice says; '' for a silent instant chunk. */
  spoken: string
  instant: boolean
}

export interface SegmenterOptions {
  /** 'announce' says a short line for code blocks instead of skipping them silently (settings voice.tts.speakCode). */
  speakCode?: 'skip' | 'announce'
  firstMin?: number
  firstMax?: number
  target?: number
  max?: number
}

export const CHUNK_RULES = { firstMin: 40, firstMax: 150, target: 150, maxSentences: 3, max: 400 } as const

type CutKind = 'sentence' | 'item' | 'block' | 'clause' | 'word' | 'instant' | 'end'

interface Cut {
  /** Source offset where the next chunk would start. */
  at: number
  kind: CutKind
  /** For 'instant': index of that block. */
  block?: number
}

interface Block {
  start: number
  end: number
  complete: boolean
  instant: boolean
  announce: string
  chars: string[]
  pos: number[]
  cuts: Cut[]
  /** mdast type of the top-level node. */
  kind: string
  /** Starts of a top-level list's items (re-parse points). */
  items: number[]
}

/** Text that would open a block if a slice started with it (then a mid-paragraph re-parse would change meaning). */
const BLOCK_OPENER = /^(?:[-+*>#|]|\d{1,9}[.)]|`{3}|~{3}|\$\$)/

const MD_OPTIONS = {
  extensions: [gfm(), math({ singleDollarTextMath: false })],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]
}

const INSTANT_TYPES = new Set(['code', 'math', 'table', 'html', 'thematicBreak', 'definition', 'footnoteDefinition', 'yaml'])
const TERMINAL = /[.!?…:;,]/
const SENT_END = /[.!?…]/
const CLAUSE_END = /[,;:—–]/
const CLOSERS = /["'”’)\]»]/
const WS = /\s/
const ALNUM = /[\p{L}\p{N}]/u

/** Value chars of a text node → source offsets (escapes, entities and line prefixes are skipped in the source). */
function mapToSource(value: string, src: string, start: number, end: number): number[] {
  const out = new Array<number>(value.length)
  let j = start
  for (let i = 0; i < value.length; i++) {
    while (j < end && src[j] !== value[i]) {
      if (src[j] === '&') {
        const semi = src.indexOf(';', j)
        if (semi > j && semi - j <= 32 && semi < end) {
          out[i] = j
          j = semi + 1
          break
        }
      }
      j++
    }
    if (out[i] !== undefined) continue
    if (j < end) out[i] = j++
    else out[i] = Math.max(start, end - 1)
  }
  return out
}

class StreamBuilder {
  chars: string[] = []
  pos: number[] = []
  nobreak: boolean[] = []
  forced: Array<{ at: number; k: number }> = []

  constructor(
    private readonly src: string,
    private readonly base: number
  ) {}

  private push(c: string, at: number, nb: boolean): void {
    const prev = this.pos.length ? this.pos[this.pos.length - 1] : -Infinity
    this.chars.push(c)
    this.pos.push(Math.max(prev, at))
    this.nobreak.push(nb)
  }

  text(value: string, start: number, end: number, nobreak = false): void {
    const map = mapToSource(value, this.src, this.base + start, this.base + end)
    const s = spokenOf(value)
    for (let k = 0; k < s.text.length; k++) this.push(s.text[k], map[s.map[k]] ?? this.base + start, nobreak)
  }

  synth(s: string, at: number): void {
    for (const c of s) this.push(c, at, true)
  }

  /** Before a structural sibling (list item, quoted paragraph): close the sentence and allow a cut at `at`. */
  force(at: number): void {
    if (!this.hasWords()) return
    this.stop()
    this.forced.push({ at, k: this.chars.length })
  }

  /** End a spoken sentence: add '.' when the text does not already end in punctuation. */
  stop(): void {
    let i = this.chars.length - 1
    while (i >= 0 && WS.test(this.chars[i])) i--
    if (i < 0) return
    if (!TERMINAL.test(this.chars[i]) && !CLOSERS.test(this.chars[i])) this.synth('.', this.pos[i])
    this.synth(' ', this.pos[this.pos.length - 1])
  }

  hasWords(): boolean {
    return this.chars.some((c) => ALNUM.test(c))
  }
}

function isBareUrl(node: Extract<Nodes, { type: 'link' }>): boolean {
  const text = node.children.map((c) => ('value' in c ? c.value : '')).join('')
  if (!text) return false
  const url = node.url.replace(/^mailto:/, '')
  return text === node.url || text === url || /^(https?:\/\/|www\.)/i.test(text)
}

function walkInline(node: Nodes, b: StreamBuilder, base: number, nb: boolean): void {
  const p = node.position
  const s = p?.start.offset ?? 0
  switch (node.type) {
    case 'text':
      b.text(node.value, s, p?.end.offset ?? s, nb)
      return
    case 'inlineCode':
      b.text(node.value, s, p?.end.offset ?? s, true)
      return
    case 'link':
      if (isBareUrl(node)) b.synth('link', base + s)
      else for (const c of node.children) walkInline(c, b, base, true)
      return
    case 'linkReference':
      for (const c of node.children) walkInline(c, b, base, true)
      return
    case 'break':
      b.synth(' ', base + s)
      return
    case 'emphasis':
    case 'strong':
    case 'delete':
      for (const c of node.children) walkInline(c, b, base, nb)
      return
    default:
      // image, imageReference, html, inlineMath, footnoteReference: shown, never spoken.
      return
  }
}

function walkBlock(node: RootContent, b: StreamBuilder, base: number): void {
  const at = (n: { position?: { start: { offset?: number } } }) => base + (n.position?.start.offset ?? 0)
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      for (const c of node.children) walkInline(c, b, base, false)
      b.stop()
      return
    case 'blockquote':
    case 'list':
    case 'listItem':
    case 'footnoteDefinition':
      node.children.forEach((c, i) => {
        if (i > 0) b.force(at(c))
        walkBlock(c, b, base)
      })
      return
    default:
      // Nested code/table/math/html/rule inside a list or quote: part of the block's range, not spoken.
      return
  }
}

/** First index whose value is ≥ x (pos arrays are non-decreasing). */
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class SpeechDocument {
  private text = ''
  private committed = 0
  private parseFrom = 0
  private index = 0
  private spokenChunks = 0
  private ended = false
  private analyzedLen = 0
  private readonly rules: { firstMin: number; firstMax: number; target: number; max: number }

  constructor(private readonly o: SegmenterOptions = {}) {
    this.rules = { firstMin: o.firstMin ?? CHUNK_RULES.firstMin, firstMax: o.firstMax ?? CHUNK_RULES.firstMax, target: o.target ?? CHUNK_RULES.target, max: o.max ?? CHUNK_RULES.max }
  }

  /** The visible text so far (chunk offsets index this string). */
  get source(): string {
    return this.text
  }

  /** Characters already covered by emitted chunks. */
  get covered(): number {
    return this.committed
  }

  get finished(): boolean {
    return this.ended && this.committed >= this.text.length
  }

  push(t: string): PlannedChunk[] {
    if (this.ended || !t) return []
    // Only a boundary character, the first word after one, or enough new text (the 150-char rule) completes a chunk.
    const afterMark = /[.!?…,;:\n][\s"'”’)\]*_]*$/.test(this.text.slice(-12))
    this.text += t
    if (!/[.!?…,;:\n]/.test(t) && !afterMark && this.text.length - this.analyzedLen < 40) return []
    return this.drain()
  }

  /** The reply is complete; `finalBody` replaces the text when it extends what was pushed (else it is ignored). */
  end(finalBody?: string): PlannedChunk[] {
    if (this.ended) return []
    if (typeof finalBody === 'string' && finalBody.length > this.text.length && finalBody.startsWith(this.text)) this.text = finalBody
    this.ended = true
    return this.drain()
  }

  private drain(): PlannedChunk[] {
    this.analyzedLen = this.text.length
    const out: PlannedChunk[] = []
    if (this.committed >= this.text.length) return out
    const blocks = this.analyze()
    for (;;) {
      const c = this.next(blocks)
      if (!c) break
      out.push(c)
      this.committed = c.src[1]
      this.index++
      if (!c.instant) this.spokenChunks++
      if (this.committed >= this.text.length) break
    }
    // Next parse point: as late as is safe, so a long paragraph or list is not re-parsed from its start every push.
    const C = this.committed
    const holder = blocks.find((b) => b.start <= C && C < b.end)
    if (!holder) this.parseFrom = C
    else if (holder.kind === 'paragraph' && !BLOCK_OPENER.test(this.text.slice(C, C + 12))) this.parseFrom = C
    else if (holder.kind === 'list') this.parseFrom = holder.items.filter((x) => x <= C).pop() ?? holder.start
    else this.parseFrom = holder.start
    return out
  }

  private analyze(): Block[] {
    const base = this.parseFrom
    const slice = this.text.slice(base)
    const tree = fromMarkdown(slice, MD_OPTIONS)
    const kids = tree.children.filter((k) => k.position)
    return kids.map((node, i) => {
      const start = base + (node.position?.start.offset ?? 0)
      const end = base + (node.position?.end.offset ?? slice.length)
      const complete = this.ended || i < kids.length - 1
      const items = node.type === 'list' ? node.children.map((c) => base + (c.position?.start.offset ?? 0)) : []
      const b: Block = { start, end, complete, instant: false, announce: '', chars: [], pos: [], cuts: [], kind: node.type, items }
      if (INSTANT_TYPES.has(node.type)) {
        b.instant = true
        if (node.type === 'code' && this.o.speakCode === 'announce') b.announce = 'Here is some code.'
        return b
      }
      const sb = new StreamBuilder(this.text, base)
      walkBlock(node, sb, base)
      if (!sb.hasWords()) {
        // Nothing to say (emoji only, an image…) — but a block still arriving may get words yet ("1." → "1. Wake").
        b.instant = complete
        return b
      }
      b.chars = sb.chars
      b.pos = sb.pos
      // A pipe table still arriving parses as a paragraph until its delimiter row: never cut inside it.
      const tableInProgress = !complete && /^\s*\|/.test(this.text.slice(start, end))
      if (!tableInProgress) b.cuts = this.cutsOf(sb, end)
      return b
    })
  }

  /** Candidate boundaries inside one block (each needs the next spoken word to exist already). */
  private cutsOf(sb: StreamBuilder, blockEnd: number): Cut[] {
    const { chars, pos, nobreak } = sb
    const cuts: Cut[] = []
    const forcedAt = new Map<number, number>()
    for (const f of sb.forced) forcedAt.set(f.k, f.at)
    const nextWord = (k: number): number => {
      while (k < chars.length && !ALNUM.test(chars[k])) k++
      return k < chars.length ? k : -1
    }
    for (let k = 0; k < chars.length; k++) {
      const f = forcedAt.get(k)
      if (f !== undefined && f < blockEnd) {
        if (nextWord(k) >= 0) cuts.push({ at: f, kind: 'item' })
        continue
      }
      if (!WS.test(chars[k]) || k === 0 || nobreak[k] || forcedAt.has(k + 1)) continue
      if (WS.test(chars[k - 1])) continue
      const nw = nextWord(k + 1)
      if (nw < 0 || pos[nw] >= blockEnd) continue
      // The cut lands after the last whitespace between the two words in the SOURCE (markdown openers go forward).
      const at = this.cutOffset(pos[k - 1] + 1, pos[nw])
      let j = k - 1
      while (j > 0 && CLOSERS.test(chars[j])) j--
      const mark = chars[j]
      let kind: CutKind = 'word'
      if (SENT_END.test(mark) && !nobreak[j] && !this.isAbbreviation(chars, j)) kind = 'sentence'
      else if (CLAUSE_END.test(mark) && !nobreak[j]) kind = 'clause'
      cuts.push({ at, kind })
    }
    return cuts
  }

  private cutOffset(from: number, to: number): number {
    let at = to
    for (let i = from; i < to; i++) if (WS.test(this.text[i])) at = i + 1
    return Math.min(at, to)
  }

  private isAbbreviation(chars: string[], dot: number): boolean {
    if (chars[dot] !== '.') return false
    let i = dot - 1
    let word = ''
    while (i >= 0 && ALNUM.test(chars[i])) word = chars[i--] + word
    if (!word) return false
    if (word.length === 1 && /\p{Lu}/u.test(word)) return true // an initial: "J. Smith"
    return ABBREVIATIONS.has(word.toLowerCase())
  }

  private spokenIn(blocks: Block[], a: number, b: number): string {
    const parts: string[] = []
    for (const blk of blocks) {
      if (blk.end <= a && blk.start < a && blk.chars.length && blk.pos[blk.pos.length - 1] < a) continue
      if (blk.start >= b) break
      if (blk.instant) {
        if (blk.announce && blk.start >= a) parts.push(blk.announce)
        continue
      }
      let s = ''
      for (let k = 0; k < blk.chars.length; k++) if (blk.pos[k] >= a && blk.pos[k] < b) s += blk.chars[k]
      if (s) parts.push(s)
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  /** Spoken chars with a source offset in [a, b) — O(blocks · log n), so scanning many candidate cuts stays cheap. */
  private countIn(blocks: Block[], a: number, b: number): number {
    let n = 0
    for (const blk of blocks) {
      if (blk.start >= b) break
      if (blk.instant || !blk.pos.length || blk.end < a) continue
      n += lowerBound(blk.pos, b) - lowerBound(blk.pos, a)
    }
    return n
  }

  private chunk(blocks: Block[], a: number, b: number, forceInstant = false): PlannedChunk {
    const spoken = forceInstant ? '' : this.spokenIn(blocks, a, b)
    const instant = forceInstant || !/[\p{L}\p{N}]/u.test(spoken)
    return { index: this.index, src: [a, b], spoken: instant ? '' : spoken, instant }
  }

  private next(blocks: Block[]): PlannedChunk | null {
    const C = this.committed
    const len = this.text.length
    if (C >= len) return null
    let bi = blocks.findIndex((b) => b.end > C)
    if (bi < 0) {
      // Only whitespace after the last block.
      return this.ended ? this.chunk(blocks, C, len, true) : null
    }
    const first = this.spokenChunks === 0
    const r = this.rules
    const blk = blocks[bi]
    if (blk.instant && blk.start <= C + this.leadingWs(C, blk.start)) {
      if (!blk.complete) return null
      const end = blocks[bi + 1]?.start ?? (this.ended ? len : blk.end)
      const c = this.chunk(blocks, C, end, !blk.announce)
      if (blk.announce) return { ...c, spoken: blk.announce, instant: false }
      return c
    }
    // Candidate cuts after C, in order, up to the next instant block or the end of what has arrived.
    const cands: Cut[] = []
    for (; bi < blocks.length; bi++) {
      const b = blocks[bi]
      if (b.instant) {
        cands.push({ at: Math.max(C, b.start), kind: 'instant', block: bi })
        break
      }
      for (const c of b.cuts) if (c.at > C) cands.push(c)
      const nb = blocks[bi + 1]
      if (nb) {
        if (!nb.instant) cands.push({ at: nb.start, kind: 'block' })
      } else if (this.ended) cands.push({ at: len, kind: 'end' })
      if (!b.complete) break
    }
    let sentences = 0
    let lastStrong: Cut | null = null
    let lastClause: Cut | null = null
    let lastWord: Cut | null = null
    for (const cut of cands) {
      const n = this.countIn(blocks, C, cut.at)
      if (cut.kind === 'instant' || cut.kind === 'end') {
        if (n === 0 && cut.kind === 'instant') {
          // Nothing spoken before the instant block: it absorbs the gap.
          const idx = cut.block ?? -1
          const ib = blocks[idx]
          if (!ib || !ib.complete) return null
          const end = blocks[idx + 1]?.start ?? (this.ended ? len : ib.end)
          if (ib.announce) return { index: this.index, src: [C, end], spoken: ib.announce, instant: false }
          return this.chunk(blocks, C, end, true)
        }
        if (n > r.max && (lastStrong || lastClause || lastWord)) return this.chunk(blocks, C, (lastStrong ?? lastClause ?? lastWord)!.at)
        return this.chunk(blocks, C, cut.at)
      }
      const strong = cut.kind === 'sentence' || cut.kind === 'item' || cut.kind === 'block'
      if (first) {
        if ((strong || cut.kind === 'clause') && n >= r.firstMin && n <= r.firstMax) return this.chunk(blocks, C, cut.at)
        if (n > r.firstMax) return this.chunk(blocks, C, (lastStrong ?? lastClause ?? lastWord ?? cut).at)
      } else {
        if (n > r.max) return this.chunk(blocks, C, (lastStrong ?? lastClause ?? lastWord ?? cut).at)
        if (strong) {
          sentences++
          if (n >= r.target || sentences >= CHUNK_RULES.maxSentences) return this.chunk(blocks, C, cut.at)
        }
      }
      if (n > 0) {
        if (strong) lastStrong = cut
        else if (cut.kind === 'clause') lastClause = cut
        else lastWord = cut
      }
    }
    return null
  }

  private leadingWs(from: number, to: number): number {
    let i = from
    while (i < to && WS.test(this.text[i])) i++
    return i - from
  }
}
