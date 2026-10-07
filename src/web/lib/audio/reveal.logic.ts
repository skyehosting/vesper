/**
 * Synced reveal math (07 C14, research 04 §7.1) — pure, DOM-free, unit-tested.
 *
 * 1. Segmentation: which part of the rendered text each speech chunk covers. Chunk headers carry `src` offsets into
 *    the reply's clean markdown, which the DOM does not know; renderers may tag elements with `data-src-start` /
 *    `data-src-end` (mdast node offsets — react-markdown hands them to components as `node.position`). Boundaries
 *    that coincide with a tagged block are exact. A held reply also tags each run of text (`exact` blocks: rendered
 *    1:1 from its source range), so a boundary inside a sentence-split paragraph is exact too (F34). Elsewhere (an
 *    escape or entity in the run, untagged roots) the boundary is found by aligning the chunk's own SOURCE words
 *    (`header.text`, markdown that renders no words stripped) with the rendered words — never its spoken words, which
 *    the server rewrites ("~5" → "about 5", "e.g." → "for example") and which then match the next sentence.
 * 2. Timing: `buildRevealMap` (shared/revealMap.ts) gives each rendered char a start time inside its chunk; the tail
 *    is then warped so the chunk's last char is fully visible exactly at the chunk's audio end — so the reply's last
 *    letter appears as the audio ends (the owner's signature requirement).
 * 3. Per frame: a char is invisible until `v − FADE`, fades in over FADE, fully visible at `v`. Visible times are
 *    non-decreasing across the reply, so each frame needs only a few binary searches.
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'

/** Fade-in length of one char (research 04 §7.1: "the last about 120 ms"). */
export const FADE_MS = 120
/** Number of stepped-alpha fade highlights (07 C14: 3–4). */
export const FADE_STEPS = 3
/** Only the last stretch of a chunk is warped to land on its audio end. */
export const TAIL_WARP_MS = 300
/** Rendered words searched ahead for each spoken word before the spoken word is skipped. */
export const ALIGN_LOOKAHEAD = 12

const WORD_CHAR = /[\p{L}\p{N}]/u
const SENTENCE_END = /[.!?…]/u

export function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch)
}

/** Case- and accent-insensitive form used for matching spoken and rendered words. */
export function normalizeWord(w: string): string {
  return w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

export interface Words {
  starts: number[]
  ends: number[]
  norm: string[]
}

/** Runs of letters/digits (UTF-16 offsets). */
export function wordsOf(text: string): Words {
  const starts: number[] = []
  const ends: number[] = []
  const norm: string[] = []
  const re = /[\p{L}\p{N}\p{M}]+/gu
  for (let m = re.exec(text); m; m = re.exec(text)) {
    starts.push(m.index)
    ends.push(m.index + m[0].length)
    norm.push(normalizeWord(m[0]))
  }
  return { starts, ends, norm }
}

export function spokenWords(spoken: string): string[] {
  return wordsOf(spoken).norm
}

/** Index of the first word starting at or after `pos` (binary search). */
export function firstWordAtOrAfter(w: Words, pos: number): number {
  let lo = 0
  let hi = w.starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (w.starts[mid] < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Greedy word alignment of `spoken` against the rendered words from `start`, never past `limit`. Returns the rendered
 * position just after the chunk: after its last matched word, extended over closing punctuation (`.`, `!`, `”`, `)`)
 * and the following whitespace, stopping before anything that opens the next sentence (`“`, `(`) or `limit`. With
 * nothing matched, returns `start`.
 */
export function alignChunkEnd(text: string, w: Words, start: number, limit: number, spoken: readonly string[]): number {
  let wi = firstWordAtOrAfter(w, start)
  let lastEnd = -1
  for (const sw of spoken) {
    for (let j = wi; j < w.starts.length && j < wi + ALIGN_LOOKAHEAD && w.ends[j] <= limit; j++) {
      if (w.norm[j] === sw) {
        lastEnd = w.ends[j]
        wi = j + 1
        break
      }
    }
  }
  if (lastEnd < 0) return start
  return trailingEnd(text, lastEnd, limit)
}

/** Past closing punctuation glued to the word, then past whitespace. */
function trailingEnd(text: string, from: number, limit: number): number {
  let p = from
  while (p < limit && !/\s/u.test(text[p]) && !isWordChar(text[p])) p++
  while (p < limit && /\s/u.test(text[p])) p++
  return p
}

/** A run of rendered text owned by one tagged element. */
export interface Block {
  srcStart: number
  srcEnd: number
  start: number
  end: number
  /** The run renders its source range char for char (a tagged text run without escapes): offsets map 1:1. */
  exact?: boolean
  /** A text-run span (`data-src-text`): its edges map exactly even when its inside does not (escapes, entities). */
  run?: boolean
}

/** One rendered text node, in document order: its length and its nearest `data-src-start` element (or none). */
export interface TextPiece<K> {
  owner: K | null
  srcStart: number
  srcEnd: number
  /** The owner is a text-run span (`data-src-text`). */
  run: boolean
  length: number
}

/**
 * The Blocks of a rendered root, built from its text nodes in document order (HighlightRevealController.rebuild).
 * One Block per tagged element: text an element owns directly on both sides of a child run (`**A** *B*`, a #K7Q2MX
 * chip, a positionless piece) extends that element's one Block across the runs between — a paragraph split into
 * fragments with the whole paragraph's source range would put a boundary on the wrong fragment (NEW-1).
 */
export function collectBlocks<K>(pieces: Iterable<TextPiece<K>>): Block[] {
  const blocks: Block[] = []
  const byOwner = new Map<K, Block>()
  let at = 0
  for (const p of pieces) {
    if (p.owner !== null && Number.isFinite(p.srcStart) && Number.isFinite(p.srcEnd)) {
      const prev = byOwner.get(p.owner)
      if (prev) {
        prev.end = at + p.length
        prev.exact = false
      } else {
        // A tagged text run (`data-src-text`) whose source length equals its rendered length maps 1:1 (F34).
        const b: Block = { srcStart: p.srcStart, srcEnd: p.srcEnd, start: at, end: at + p.length, exact: p.run && p.srcEnd - p.srcStart === p.length, run: p.run }
        blocks.push(b)
        byOwner.set(p.owner, b)
      }
    }
    at += p.length
  }
  return blocks
}

/** `text` = the chunk's exact markdown (SpeechChunkHeader.text); without it alignment falls back to `spoken`. */
export type ChunkInfo = Pick<SpeechChunkHeader, 'index' | 'src' | 'spoken' | 'instant' | 'final'> & { text?: string }

/**
 * The words a chunk's markdown renders: link/image destinations, list markers, task boxes, footnote references and
 * character references render no words of their own, so they must not be matched against the rendered text.
 */
export function sourceWords(md: string): string[] {
  const visible = md
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']')
    .replace(/^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, ' ')
  return wordsOf(visible).norm
}

function chunkWords(c: ChunkInfo): string[] {
  return typeof c.text === 'string' ? sourceWords(c.text) : spokenWords(c.spoken)
}

/**
 * Rendered [start, end) per chunk, contiguous from 0, for the known prefix of chunks (sorted by index, no gaps).
 * When the last chunk is final it extends to the end of the text.
 */
export function segmentChunks(text: string, words: Words, blocks: readonly Block[], chunks: readonly ChunkInfo[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let cursor = 0
  for (const c of chunks) {
    const start = cursor
    let end: number
    if (c.final) end = text.length
    else if (blocks.length) end = endWithBlocks(text, words, blocks, c, start)
    else if (c.instant) end = instantEndUntagged(text, start, c)
    else end = alignChunkEnd(text, words, start, text.length, chunkWords(c))
    end = Math.max(start, Math.min(text.length, end))
    out.push([start, end])
    cursor = end
  }
  return out
}

function endWithBlocks(text: string, words: Words, blocks: readonly Block[], c: ChunkInfo, start: number): number {
  const e = c.src[1]
  // A boundary on a text run's edge (a sentence ending right before **bold**, `code` or a link) maps exactly (NEW-1):
  // the run that starts at the boundary opens the next chunk, else the run that ends there closes this one.
  let opens = -1
  let closes = -1
  for (const b of blocks) {
    if (!b.run) continue
    if (b.srcStart === e && (opens < 0 || b.start < opens)) opens = b.start
    if (b.srcEnd === e && b.end > closes) closes = b.end
  }
  if (opens >= 0) return Math.max(start, opens)
  if (closes >= 0) return Math.max(start, closes)
  let inside: Block | null = null
  let before = -1
  for (const b of blocks) {
    if (b.srcStart < e && e < b.srcEnd) {
      // Innermost tagged element containing the boundary.
      if (!inside || b.srcEnd - b.srcStart < inside.srcEnd - inside.srcStart) inside = b
    } else if (b.srcEnd <= e && b.end > before) before = b.end
  }
  if (!inside) return before >= 0 ? before : start
  const lo = Math.max(start, inside.start)
  if (c.instant) return lo
  // A text run rendered char for char: the boundary maps exactly (F34).
  if (inside.exact) return Math.max(lo, Math.min(inside.end, inside.start + (e - inside.srcStart)))
  const end = alignChunkEnd(text, words, start, inside.end, chunkWords(c))
  return Math.max(lo, end)
}

/**
 * An unspoken chunk (code fence, table, math, image) in an untagged root: its rendered size is estimated from its
 * markdown length (fence lines dropped), then snapped to the end of a line.
 */
function instantEndUntagged(text: string, start: number, c: ChunkInfo): number {
  const est = Math.max(0, c.src[1] - c.src[0] - 8)
  let end = Math.min(text.length, start + est)
  const nl = text.indexOf('\n', end)
  if (nl >= 0 && nl - end < 80) end = nl + 1
  return end
}

/**
 * Chunk-relative "fully visible at" times from a reveal map: non-decreasing, within [0, duration], and the last char
 * exactly at `durationMs` (the tail over TAIL_WARP_MS is stretched linearly to land there). Instant or zero-length
 * chunks reveal at 0.
 */
export function visibleTimes(map: Float64Array, durationMs: number, instant: boolean): Float64Array {
  const n = map.length
  const v = new Float64Array(n)
  if (n === 0 || instant || durationMs <= 0) return v
  let prev = 0
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(map[i]) ? Math.min(durationMs, Math.max(0, map[i])) : prev
    prev = Math.max(prev, x)
    v[i] = prev
  }
  const last = v[n - 1]
  if (last < durationMs) {
    const t0 = Math.max(0, last - TAIL_WARP_MS)
    if (last > t0) {
      const k = (durationMs - t0) / (last - t0)
      for (let i = 0; i < n; i++) if (v[i] > t0) v[i] = t0 + (v[i] - t0) * k
    }
    v[n - 1] = durationMs
  }
  return v
}

/** Number of entries ≤ t in a non-decreasing array (binary search). */
export function countAtOrBefore(v: ArrayLike<number>, t: number): number {
  let lo = 0
  let hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export type RevealMode = 'fade' | 'words' | 'sentences'

/**
 * The frame's boundaries, as char indexes into the rendered text:
 *   [0, full)            fully visible
 *   [full, hidden)       fading (split into FADE_STEPS bands in `bands`, nearest-to-visible first)
 *   [hidden, length)     not yet revealed
 */
export interface FrameState {
  full: number
  hidden: number
  /** FADE_STEPS + 1 boundaries: bands[i]..bands[i+1] is fade step i (alpha (FADE_STEPS − i) / (FADE_STEPS + 1)). */
  bands: number[]
}

export function frameState(v: ArrayLike<number>, text: string, t: number, mode: RevealMode, out: FrameState): FrameState {
  const full = countAtOrBefore(v, t)
  if (mode === 'fade') {
    out.full = full
    for (let i = 0; i <= FADE_STEPS; i++) out.bands[i] = countAtOrBefore(v, t + (FADE_MS * i) / FADE_STEPS)
    out.hidden = out.bands[FADE_STEPS]
    return out
  }
  // Reduced motion → whole words, no fade; no Highlight API → sentence steps (07 C14). A unit appears when its first
  // char is due, so the steps never run behind the audio.
  const first = countAtOrBefore(v, t + 1e-9)
  const shown = first === 0 ? 0 : mode === 'words' ? wordEnd(text, first - 1) : sentenceEnd(text, first - 1)
  const stop = Math.max(full, Math.min(text.length, shown))
  out.full = stop
  out.hidden = stop
  for (let i = 0; i <= FADE_STEPS; i++) out.bands[i] = stop
  return out
}

export function createFrameState(): FrameState {
  return { full: 0, hidden: 0, bands: new Array<number>(FADE_STEPS + 1).fill(0) }
}

/** End (exclusive) of the word containing index i, or i + 1 for a non-word char. */
export function wordEnd(text: string, i: number): number {
  if (i < 0) return 0
  if (!isWordChar(text[i] ?? '')) return i + 1
  let j = i + 1
  while (j < text.length && isWordChar(text[j])) j++
  return j
}

/** End (exclusive) of the sentence containing index i: after the next .!?… (and closing quotes/brackets) or newline. */
export function sentenceEnd(text: string, i: number): number {
  if (i < 0) return 0
  let j = i
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\n') return j + 1
    if (SENTENCE_END.test(ch)) {
      j++
      while (j < text.length && /["'”’)\]]/u.test(text[j])) j++
      return j
    }
    j++
  }
  return text.length
}

/**
 * Global visible times for the reply: chunk k's chars get `startAt_k + visibleTimes(...)`; chars of chunks that have
 * not started (or are not known) stay at +∞, so text never runs ahead of its audio.
 */
export function replyVisibleTimes(
  textLength: number,
  ranges: ReadonlyArray<[number, number]>,
  chunks: ReadonlyArray<{ startAt: number | null; times: Float64Array }>
): Float64Array {
  const v = new Float64Array(textLength).fill(Number.POSITIVE_INFINITY)
  let floor = Number.NEGATIVE_INFINITY
  for (let k = 0; k < ranges.length && k < chunks.length; k++) {
    const c = chunks[k]
    if (c.startAt === null) break
    const [s, e] = ranges[k]
    for (let i = s; i < e; i++) {
      const x = c.startAt + (c.times[i - s] ?? 0)
      // Keep the global order even if a late chunk was scheduled before an earlier one finished (clock jitter).
      floor = Math.max(floor, x)
      v[i] = floor
    }
  }
  return v
}
