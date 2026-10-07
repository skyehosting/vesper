/**
 * RevealController (07 C14, C15; research 04 §7.1): a reply's text is laid out at once but painted transparent until
 * its audio plays, then fades in char by char on the audio clock, the last letter landing as the audio ends.
 *
 * Painting uses the CSS Custom Highlight API only (one `vesper-unrevealed` highlight + FADE_STEPS stepped-alpha
 * highlights, shared by every bound reply; four live Ranges per reply, mutated in place each frame). Reduced motion →
 * whole words, no fade. No Highlight API → sentence steps through a clip-path mask on the root (no DOM changes).
 *
 * Chunk timing comes from the AudioEngine's `chunkStart` events (`at` on `now()`), so chunks that arrive after
 * `bind` are picked up without the caller's help. Barge-in (`replyEnd {interrupted}`) freezes the reveal where it is
 * and collapses the root to the last revealed line (P18: the unspoken rest stays laid out but must not keep its height
 * — a blank block as tall as the rest of the reply sat above "— interrupted · show rest"); `finish` shows everything.
 *
 * Highlights paint glyphs only, not list markers, borders, backgrounds or images (F33). So every element in the root
 * whose first char is still hidden carries `data-unrevealed` (`visibility: hidden`, reveal.css): bullets and numbers,
 * code boxes and their header, quote bars, rules, tables and images appear with their first char's audio. An element
 * without text (a rule, an image) appears with the next char. Plain inline elements (span, strong, em... with no
 * class) and everything inside a code block are not marked (no box of their own / they appear with the block).
 */
import { buildRevealMap } from '@shared/revealMap'
import type { SpeechChunkHeader } from '@shared/ws/binary'
import { count } from './counters'
import {
  countAtOrBefore,
  createFrameState,
  FADE_MS,
  FADE_STEPS,
  frameState,
  replyVisibleTimes,
  segmentChunks,
  visibleTimes,
  wordEnd,
  wordsOf,
  collectBlocks,
  type TextPiece,
  type ChunkInfo,
  type FrameState,
  type RevealMode
} from './reveal.logic'
import type { AudioEngine, RevealController } from './types'
import './reveal.css'

/** Replies remembered without a binding (chunk timing that arrived before chat-ui bound the root). */
const MAX_RECORDS = 32
const LOG_SIZE = 20
/** Below the last revealed glyph box of a collapsed (interrupted) reply: the rest of that line's leading. */
const COLLAPSE_SLACK_PX = 4
/** Attribute on elements whose first char is not revealed yet (reveal.css hides their boxes and markers). */
export const UNREVEALED_ATTR = 'data-unrevealed'
/** Inline elements that draw nothing but glyphs when they carry no class: never marked (fewer DOM writes). */
const PLAIN_INLINE = new Set(['SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'BR', 'WBR', 'SMALL', 'ABBR', 'Q', 'CITE', 'TIME'])

export const HIGHLIGHT_HIDDEN = 'vesper-unrevealed'
export const HIGHLIGHT_FADE = Array.from({ length: FADE_STEPS }, (_, i) => `vesper-reveal-${i + 1}`)

interface ReplyRecord {
  chunks: Map<number, SpeechChunkHeader>
  /** Chunk index → audio start on the engine clock (ms). */
  starts: Map<number, number>
  ended: boolean
  interrupted: boolean
  stoppedAt: number | null
  audioEndAt: number | null
  /** End of the latest chunk that finished playing (the audio end of a reply finalized after its last chunk started). */
  lastEndAt: number | null
  finished: boolean
}

type Status = 'revealing' | 'frozen' | 'done'

interface Binding {
  replyId: string
  el: HTMLElement
  rec: ReplyRecord
  status: Status
  dirty: boolean
  text: string
  nodes: Text[]
  nodeStarts: number[]
  v: Float64Array
  /** The final chunk is known (segmentation covers the whole text). */
  complete: boolean
  frame: FrameState
  ranges: Range[] | null
  frozenAt: number
  clipAt: number
  prevClip: string
  /** The root's own max-height / overflow before a frozen reply was collapsed (restored on finish/unbind). */
  prevMaxHeight: string
  prevOverflow: string
  /** Re-collapses a frozen reply when its width (so its line breaks) changes. */
  resize: ResizeObserver | null
  collapsedPx: number | null
  prevBusy: string | null
  observer: MutationObserver | null
  /** Elements that stay hidden until their first char shows (document order), and that char's index (non-decreasing). */
  decor: Element[]
  decorAt: number[]
  /** decor[0, decorShown) are revealed (no mark), the rest carry UNREVEALED_ATTR; −1 = not applied since a rebuild. */
  decorShown: number
  progress: number
  /** Nothing can change until an engine event or a DOM mutation (no frames needed meanwhile). */
  idle: boolean
}

export interface RevealLogEntry {
  replyId: string
  status: 'done' | 'frozen' | 'finished'
  /** Engine clock (ms) of the frame where the reveal completed or froze. */
  at: number
  /** Scheduled end of the final chunk's audio (engine clock), when known. */
  audioEndAt: number | null
  chars: number
}

export interface RevealDeps {
  engine: Pick<AudioEngine, 'now' | 'on'>
  raf?: (cb: () => void) => number
  caf?: (h: number) => void
  /** Highlight API available (feature-detected by default). */
  highlights?: boolean
  reducedMotion?: () => boolean
}

function highlightApi(): boolean {
  return typeof Highlight === 'function' && typeof CSS !== 'undefined' && 'highlights' in CSS
}

function defaultReducedMotion(): () => boolean {
  const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  return () => mql?.matches === true || document.documentElement.dataset.reduceMotion === 'true'
}

let shared: { hidden: Highlight; fades: Highlight[] } | null = null

function sharedHighlights(): { hidden: Highlight; fades: Highlight[] } {
  if (shared) return shared
  const hidden = new Highlight()
  const fades = HIGHLIGHT_FADE.map(() => new Highlight())
  CSS.highlights.set(HIGHLIGHT_HIDDEN, hidden)
  HIGHLIGHT_FADE.forEach((name, i) => CSS.highlights.set(name, fades[i]))
  shared = { hidden, fades }
  return shared
}

export class HighlightRevealController implements RevealController {
  private readonly engine: Pick<AudioEngine, 'now' | 'on'>
  private readonly raf: (cb: () => void) => number
  private readonly caf: (h: number) => void
  private readonly useHighlights: boolean
  private readonly reduced: () => boolean
  private readonly records = new Map<string, ReplyRecord>()
  private readonly bindings = new Map<string, Binding>()
  private readonly log: RevealLogEntry[] = []
  private rafHandle: number | null = null
  private readonly offEngine: Array<() => void>

  constructor(d: RevealDeps) {
    this.engine = d.engine
    this.raf = d.raf ?? ((cb) => requestAnimationFrame(cb))
    this.caf = d.caf ?? ((h) => cancelAnimationFrame(h))
    this.useHighlights = d.highlights ?? highlightApi()
    this.reduced = d.reducedMotion ?? defaultReducedMotion()
    this.offEngine = [
      d.engine.on('chunkStart', (e) => {
        const rec = this.record(e.replyId)
        rec.chunks.set(e.index, e.header)
        rec.starts.set(e.index, e.at)
        this.touch(e.replyId)
      }),
      d.engine.on('chunkEnd', (e) => {
        const rec = this.records.get(e.replyId)
        if (!rec) return
        rec.lastEndAt = e.at
        if (rec.chunks.get(e.index)?.final) rec.audioEndAt = e.at
      }),
      d.engine.on('replyEnd', (e) => {
        const rec = this.record(e.replyId)
        rec.ended = true
        rec.interrupted = e.interrupted
        if (!e.interrupted) rec.audioEndAt ??= rec.lastEndAt
        if (e.interrupted) {
          rec.stoppedAt = this.engine.now()
          const b = this.bindings.get(e.replyId)
          if (b && b.status === 'revealing') this.freeze(b)
        } else this.touch(e.replyId)
      })
    ]
  }

  bind(replyId: string, el: HTMLElement, chunks: readonly SpeechChunkHeader[]): () => void {
    if (this.bindings.has(replyId)) this.unbindReply(replyId)
    const rec = this.record(replyId)
    // Headers from the engine carry the decoded duration; never overwrite them with the caller's copy.
    for (const c of chunks) if (!rec.starts.has(c.index)) rec.chunks.set(c.index, c)
    const b: Binding = {
      replyId,
      el,
      rec,
      status: 'revealing',
      dirty: true,
      text: '',
      nodes: [],
      nodeStarts: [],
      v: new Float64Array(0),
      complete: false,
      frame: createFrameState(),
      ranges: null,
      frozenAt: 0,
      clipAt: -1,
      prevClip: el.style.clipPath,
      prevMaxHeight: el.style.maxHeight,
      prevOverflow: el.style.overflow,
      resize: null,
      collapsedPx: null,
      prevBusy: el.getAttribute('aria-busy'),
      observer: null,
      decor: [],
      decorAt: [],
      decorShown: 0,
      progress: 0,
      idle: false
    }
    this.bindings.set(replyId, b)
    count('reveals', 1)
    if (rec.finished || (rec.ended && !rec.interrupted && this.allPlayed(rec))) {
      b.status = 'done'
      b.progress = 1
    } else {
      el.setAttribute('aria-busy', 'true')
      el.dataset.revealing = ''
      if (this.useHighlights) {
        const h = sharedHighlights()
        b.ranges = Array.from({ length: FADE_STEPS + 1 }, () => new Range())
        h.hidden.add(b.ranges[0])
        for (let i = 0; i < FADE_STEPS; i++) h.fades[i].add(b.ranges[i + 1])
      }
      b.observer = new MutationObserver(() => {
        b.dirty = true
        b.idle = false
        if (b.status === 'frozen') this.applyFrozen(b)
        else this.ensureLoop()
      })
      b.observer.observe(el, { childList: true, subtree: true, characterData: true })
      if (rec.ended && rec.interrupted) this.freeze(b)
      else this.paintNow(b)
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.bindings.get(replyId) === b) this.unbindReply(replyId)
    }
  }

  finish(replyId: string): void {
    // Remembered even before a bind: a root mounted after a text-first fallback must not hide its text.
    this.record(replyId).finished = true
    const b = this.bindings.get(replyId)
    if (!b || b.status === 'done') return
    this.complete(b, 'finished', this.engine.now())
  }

  progress(replyId: string): number {
    const b = this.bindings.get(replyId)
    if (!b) return 1
    return b.status === 'done' ? 1 : b.progress
  }

  // ── extras (not part of the frozen interface) ─────────────────────────────────────────────────────────────────

  /** 'revealing' | 'frozen' (barge-in: chat-ui shows "— interrupted · show rest") | 'done' | null when unbound. */
  state(replyId: string): Status | null {
    return this.bindings.get(replyId)?.status ?? null
  }

  /** Recent completions (test hooks, dev overlay). */
  recent(): RevealLogEntry[] {
    return [...this.log]
  }

  /** Unbind everything and stop listening to the engine (page teardown, tests). */
  dispose(): void {
    for (const id of [...this.bindings.keys()]) this.unbindReply(id)
    for (const off of this.offEngine) off()
    this.records.clear()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private record(replyId: string): ReplyRecord {
    let rec = this.records.get(replyId)
    if (rec) {
      // LRU: most recently used last.
      this.records.delete(replyId)
      this.records.set(replyId, rec)
      return rec
    }
    rec = { chunks: new Map(), starts: new Map(), ended: false, interrupted: false, stoppedAt: null, audioEndAt: null, lastEndAt: null, finished: false }
    this.records.set(replyId, rec)
    if (this.records.size > MAX_RECORDS) {
      for (const id of this.records.keys()) {
        if (this.records.size <= MAX_RECORDS) break
        if (!this.bindings.has(id)) this.records.delete(id)
      }
    }
    return rec
  }

  private allPlayed(rec: ReplyRecord): boolean {
    for (const h of rec.chunks.values()) if (h.final) return rec.starts.has(h.index)
    return rec.ended
  }

  private touch(replyId: string): void {
    const b = this.bindings.get(replyId)
    if (!b || b.status !== 'revealing') return
    b.dirty = true
    b.idle = false
    this.ensureLoop()
  }

  private ensureLoop(): void {
    if (this.rafHandle !== null) return
    for (const b of this.bindings.values()) {
      if (b.status === 'revealing' && !b.idle) {
        this.rafHandle = this.raf(this.tick)
        return
      }
    }
  }

  private readonly tick = (): void => {
    this.rafHandle = null
    const t = this.engine.now()
    for (const b of [...this.bindings.values()]) {
      if (b.status !== 'revealing') continue
      if (!b.el.isConnected) {
        // Evicted without an unbind: drop it rather than keep ranges on detached nodes.
        this.unbindReply(b.replyId)
        continue
      }
      this.paint(b, t)
    }
    this.ensureLoop()
  }

  private paintNow(b: Binding): void {
    this.paint(b, this.engine.now())
    this.ensureLoop()
  }

  private mode(): RevealMode {
    if (!this.useHighlights) return 'sentences'
    return this.reduced() ? 'words' : 'fade'
  }

  private paint(b: Binding, t: number): void {
    if (b.dirty) this.rebuild(b)
    const f = frameState(b.v, b.text, t, this.mode(), b.frame)
    const n = b.text.length
    b.progress = n ? f.full / n : 0
    if (b.complete && f.full >= n && (n > 0 || b.rec.ended)) {
      this.complete(b, 'done', t)
      return
    }
    if (b.ranges) {
      this.setRange(b, b.ranges[0], f.hidden, -1)
      for (let i = 0; i < FADE_STEPS; i++) this.setRange(b, b.ranges[i + 1], f.bands[i], f.bands[i + 1])
    } else this.clipAt(b, f.hidden)
    this.showDecor(b, f.hidden)
    // Everything due is shown and the next char has no audio yet: sleep until an engine event or DOM change.
    b.idle = f.hidden === f.full && !(b.v[f.full] < Number.POSITIVE_INFINITY)
  }

  /** Index the text nodes, segment the known chunks and compute each char's visible time. */
  private rebuild(b: Binding): void {
    b.dirty = false
    const nodes: Text[] = []
    const starts: number[] = []
    const pieces: TextPiece<Element>[] = []
    const decor: Element[] = []
    const decorAt: number[] = []
    let text = ''
    // Elements and text in document order. UI inside the root ([data-reveal-skip]) is not text to reveal: it shows and
    // hides with its nearest marked ancestor.
    const walker = document.createTreeWalker(b.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).hasAttribute('data-reveal-skip') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    })
    let code: Element | null = null
    for (let x = walker.nextNode(); x; x = walker.nextNode()) {
      if (x.nodeType === Node.ELEMENT_NODE) {
        const el = x as Element
        if (code && !code.contains(el)) code = null
        if (!code && !(PLAIN_INLINE.has(el.tagName) && !el.getAttribute('class'))) {
          decor.push(el)
          decorAt.push(text.length)
        }
        if (!code && el.tagName === 'PRE') code = el
        continue
      }
      const n = x as Text
      nodes.push(n)
      starts.push(text.length)
      const owner = n.parentElement?.closest('[data-src-start]') ?? null
      const tagged = owner && b.el.contains(owner) ? owner : null
      pieces.push({
        owner: tagged,
        srcStart: tagged ? Number(tagged.getAttribute('data-src-start')) : NaN,
        srcEnd: tagged ? Number(tagged.getAttribute('data-src-end')) : NaN,
        run: !!tagged?.hasAttribute('data-src-text'),
        length: n.data.length
      })
      text += n.data
    }
    const blocks = collectBlocks(pieces)
    b.nodes = nodes
    b.nodeStarts = starts
    b.text = text
    // An element appears with its first visible char, not with a newline or space before it (those can belong to
    // the previous chunk's audio).
    if (decorAt.length) {
      let next = text.length
      let k = decorAt.length - 1
      for (let i = text.length; i >= 0 && k >= 0; i--) {
        if (i < text.length && !/\s/u.test(text[i])) next = i
        while (k >= 0 && decorAt[k] === i) decorAt[k--] = next
      }
    }
    // Marks follow the new DOM; showDecor() applies them in the same frame (before anything is painted).
    const fresh = new Set(decor)
    for (const el of b.decor) if (!fresh.has(el)) el.removeAttribute(UNREVEALED_ATTR)
    b.decor = decor
    b.decorAt = decorAt
    b.decorShown = -1

    const rec = b.rec
    const infos: ChunkInfo[] = []
    for (let i = 0; rec.chunks.has(i); i++) infos.push(rec.chunks.get(i) as SpeechChunkHeader)
    // A naturally ended reply has played everything it will: its last known chunk is final.
    if (infos.length && rec.ended && !rec.interrupted && !infos[infos.length - 1].final) infos[infos.length - 1] = { ...infos[infos.length - 1], final: true }
    b.complete = infos.length > 0 && infos[infos.length - 1].final
    const ranges = segmentChunks(text, wordsOf(text), blocks, infos)
    const timed = infos.map((c, k) => {
      const h = rec.chunks.get(c.index) as SpeechChunkHeader
      const [s, e] = ranges[k]
      const map = buildRevealMap(text.slice(s, e), h.spoken, h.timeline, h.durationMs)
      return { startAt: rec.starts.get(c.index) ?? null, times: visibleTimes(map, h.durationMs, h.instant) }
    })
    b.v = replyVisibleTimes(text.length, ranges, timed)
  }

  /** Reveal the marked elements whose first char is below `upTo` (shown or fading); re-hide any at or above it. */
  private showDecor(b: Binding, upTo: number): void {
    const k = countBelow(b.decorAt, upTo)
    if (b.decorShown < 0) {
      // After a rebuild: touch only the elements whose mark is wrong (no needless style invalidation).
      for (let i = 0; i < b.decor.length; i++) {
        const el = b.decor[i]
        const hide = i >= k
        if (el.hasAttribute(UNREVEALED_ATTR) !== hide) {
          if (hide) el.setAttribute(UNREVEALED_ATTR, '')
          else el.removeAttribute(UNREVEALED_ATTR)
        }
      }
    } else {
      for (let i = b.decorShown; i < k; i++) b.decor[i].removeAttribute(UNREVEALED_ATTR)
      for (let i = k; i < b.decorShown; i++) b.decor[i].setAttribute(UNREVEALED_ATTR, '')
    }
    b.decorShown = k
  }

  private clearDecor(b: Binding): void {
    for (let i = Math.max(0, b.decorShown); i < b.decor.length; i++) b.decor[i].removeAttribute(UNREVEALED_ATTR)
    b.decor = []
    b.decorAt = []
    b.decorShown = 0
  }

  /** Point `r` at chars [from, to) of the binding's text; `to` = −1 means "to the end of the root". */
  private setRange(b: Binding, r: Range, from: number, to: number): void {
    const n = b.text.length
    if (from >= n || (to >= 0 && to <= from) || b.nodes.length === 0) {
      r.setStart(b.el, 0)
      r.collapse(true)
      return
    }
    const a = this.locate(b, from)
    r.setStart(a.node, a.offset)
    if (to < 0 || to >= n) r.setEnd(b.el, b.el.childNodes.length)
    else {
      const z = this.locate(b, to)
      r.setEnd(z.node, z.offset)
    }
  }

  private locate(b: Binding, idx: number): { node: Text; offset: number } {
    const s = b.nodeStarts
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    const node = b.nodes[lo]
    return { node, offset: Math.min(node.data.length, idx - s[lo]) }
  }

  /** Fallback mask: everything above the frontier's line, plus that line up to the frontier (LTR). */
  private clipAt(b: Binding, idx: number): void {
    if (idx === b.clipAt) return
    b.clipAt = idx
    const n = b.text.length
    if (idx >= n && n > 0) {
      b.el.style.clipPath = b.prevClip
      return
    }
    if (idx <= 0 || b.nodes.length === 0) {
      b.el.style.clipPath = 'inset(0 0 100% 0)'
      return
    }
    const r = document.createRange()
    const a = this.locate(b, idx - 1)
    const z = this.locate(b, idx)
    r.setStart(a.node, a.offset)
    r.setEnd(z.node, z.offset)
    const rects = r.getClientRects()
    const last = rects[rects.length - 1]
    if (!last) return
    const box = b.el.getBoundingClientRect()
    const x = last.right - box.left
    const top = last.top - box.top
    const bottom = last.bottom - box.top
    b.el.style.clipPath = `polygon(0 0, 100% 0, 100% ${top}px, ${x}px ${top}px, ${x}px ${bottom}px, 0 ${bottom}px)`
  }

  /** Barge-in: keep what has started to appear (to the end of its word), hide the rest until `finish`. */
  private freeze(b: Binding): void {
    if (b.dirty) this.rebuild(b)
    const t = b.rec.stoppedAt ?? this.engine.now()
    const shown = countAtOrBefore(b.v, t + FADE_MS)
    b.frozenAt = shown === 0 ? 0 : wordEnd(b.text, shown - 1)
    b.status = 'frozen'
    b.el.removeAttribute('aria-busy')
    if (b.prevBusy !== null) b.el.setAttribute('aria-busy', b.prevBusy)
    delete b.el.dataset.revealing
    this.applyFrozen(b)
    this.pushLog({ replyId: b.replyId, status: 'frozen', at: t, audioEndAt: b.rec.audioEndAt, chars: b.frozenAt })
  }

  private applyFrozen(b: Binding): void {
    if (b.dirty) this.rebuild(b)
    const idx = Math.min(b.frozenAt, b.text.length)
    b.progress = b.text.length ? idx / b.text.length : 0
    if (b.ranges) {
      this.setRange(b, b.ranges[0], idx, -1)
      for (let i = 1; i < b.ranges.length; i++) this.setRange(b, b.ranges[i], 0, 0)
    } else {
      b.clipAt = -1
      this.clipAt(b, idx)
    }
    this.showDecor(b, idx)
    this.collapseAt(b, idx)
  }

  /** P18: a frozen reply keeps only the height of what was revealed (to the bottom of the line of its last char). */
  private collapseAt(b: Binding, idx: number): void {
    if (idx >= b.text.length || b.nodes.length === 0) return this.uncollapse(b)
    let px = 0
    if (idx > 0) {
      const last = this.lastGlyphRect(b, idx)
      if (!last) return
      // The line's own leading below the glyphs, so descenders are never cut.
      px = Math.ceil(last.bottom - b.el.getBoundingClientRect().top + COLLAPSE_SLACK_PX)
    }
    if (b.collapsedPx === px) return
    b.collapsedPx = px
    b.el.style.maxHeight = `${px}px`
    b.el.style.overflow = 'hidden'
    if (!b.resize && typeof ResizeObserver === 'function') {
      let width = b.el.getBoundingClientRect().width
      b.resize = new ResizeObserver(() => {
        const w = b.el.getBoundingClientRect().width
        if (w === width || b.status !== 'frozen') return
        width = w
        b.collapsedPx = null
        b.el.style.maxHeight = b.prevMaxHeight
        this.applyFrozen(b)
      })
      b.resize.observe(b.el)
    }
  }

  /**
   * The box of the last revealed glyph below `idx`. Each char is measured inside its own text node: a range that ends at
   * offset 0 of the next node (a frozen cut at a paragraph's end) also yields an empty rect at the start of the next,
   * hidden paragraph, which would size the collapse a line and a paragraph gap too tall. Chars without a box of their
   * own (collapsed whitespace) are skipped, a bounded way back.
   */
  private lastGlyphRect(b: Binding, idx: number): DOMRect | null {
    const r = document.createRange()
    for (let i = idx - 1; i >= 0 && i >= idx - 64; i--) {
      const a = this.locate(b, i)
      if (a.offset >= a.node.data.length) continue
      r.setStart(a.node, a.offset)
      r.setEnd(a.node, a.offset + 1)
      const rects = r.getClientRects()
      for (let k = rects.length - 1; k >= 0; k--) if (rects[k].width > 0 && rects[k].height > 0) return rects[k]
    }
    return null
  }

  private uncollapse(b: Binding): void {
    b.resize?.disconnect()
    b.resize = null
    if (b.collapsedPx === null) return
    b.collapsedPx = null
    b.el.style.maxHeight = b.prevMaxHeight
    b.el.style.overflow = b.prevOverflow
  }

  private complete(b: Binding, how: 'done' | 'finished', t: number): void {
    b.status = 'done'
    b.progress = 1
    this.clearVisuals(b)
    this.pushLog({ replyId: b.replyId, status: how, at: t, audioEndAt: b.rec.audioEndAt, chars: b.text.length })
  }

  private clearVisuals(b: Binding): void {
    b.observer?.disconnect()
    b.observer = null
    this.clearDecor(b)
    if (b.ranges && shared) {
      shared.hidden.delete(b.ranges[0])
      for (let i = 0; i < FADE_STEPS; i++) shared.fades[i].delete(b.ranges[i + 1])
    }
    b.ranges = null
    if (!this.useHighlights) b.el.style.clipPath = b.prevClip
    this.uncollapse(b)
    if (b.el.hasAttribute('data-revealing')) {
      delete b.el.dataset.revealing
      b.el.removeAttribute('aria-busy')
      if (b.prevBusy !== null) b.el.setAttribute('aria-busy', b.prevBusy)
    }
  }

  private unbindReply(replyId: string): void {
    const b = this.bindings.get(replyId)
    if (!b) return
    this.clearVisuals(b)
    this.bindings.delete(replyId)
    count('reveals', -1)
    if (this.rafHandle !== null && ![...this.bindings.values()].some((x) => x.status === 'revealing')) {
      this.caf(this.rafHandle)
      this.rafHandle = null
    }
  }

  private pushLog(e: RevealLogEntry): void {
    this.log.push(e)
    if (this.log.length > LOG_SIZE) this.log.shift()
  }
}

/** Number of entries < x in a non-decreasing array. */
function countBelow(v: readonly number[], x: number): number {
  let lo = 0
  let hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}
