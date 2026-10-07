/**
 * Speech timing for the synced reveal (07 C14, R14). Pure functions shared by the server (it builds each chunk's
 * timeline) and the web client (RevealController maps a chunk's timeline onto the rendered text). No Node or DOM APIs.
 *
 *   estimateTimeline  — per-character times when the provider gives none (research 04 §7.2, with the verifier's fixes:
 *                       `/[\p{L}\p{N}]/u`, and a `total === 0` guard so nothing becomes NaN).
 *   buildRevealMap    — rendered char → reveal time, aligned on letters/digits, monotonic, the last visible character
 *                       pinned to the end of the audio ("the last letter appears as the audio ends").
 */

export interface Timeline {
  startsMs: number[]
  endsMs: number[]
}

/** Estimator weights (research 04 §7.2 table). Exported so tests and tuning tools use the same numbers. */
export const ESTIMATOR_WEIGHTS = { alnum: 1, space: 0.35, clause: 4, sentence: 8, newline: 9, other: 0.4 } as const

const ALNUM = /[\p{L}\p{N}]/u
const CLAUSE = /[,;:—–]/
const SENTENCE = /[.!?…]/
const WS = /\s/

/**
 * Weight per UTF-16 unit of `text`. Sentence marks count only when followed by whitespace or the end; everything after
 * the last letter/digit weighs 0 (no audio corresponds to trailing punctuation inside the speech span).
 */
export function charWeights(text: string): Float64Array {
  const w = new Float64Array(text.length)
  let lastAlnum = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const pair = c >= '\uD800' && c <= '\uDBFF' && i + 1 < text.length ? text.slice(i, i + 2) : null
    if (ALNUM.test(pair ?? c)) {
      w[i] = ESTIMATOR_WEIGHTS.alnum
      lastAlnum = i
      if (pair) lastAlnum = ++i // the low surrogate weighs 0 (one letter, two code units)
    } else if (c === '\n') w[i] = ESTIMATOR_WEIGHTS.newline
    else if (WS.test(c)) w[i] = ESTIMATOR_WEIGHTS.space
    else if (CLAUSE.test(c)) w[i] = ESTIMATOR_WEIGHTS.clause
    else if (SENTENCE.test(c) && (i + 1 >= text.length || WS.test(text[i + 1]))) w[i] = ESTIMATOR_WEIGHTS.sentence
    else if (pair) {
      w[i] = ESTIMATOR_WEIGHTS.other
      i++
    } else w[i] = ESTIMATOR_WEIGHTS.other
  }
  for (let i = lastAlnum + 1; i < text.length; i++) w[i] = 0
  return w
}

export interface PcmView {
  pcm: Int16Array
  sampleRate: number
}

const FRAME_MS = 10
const SPAN_DB = -35
const MIN_GAP_MS = 120

function frameRms(a: PcmView): Float64Array {
  const per = Math.max(1, Math.round((a.sampleRate * FRAME_MS) / 1000))
  const n = Math.ceil(a.pcm.length / per)
  const out = new Float64Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    const end = Math.min(a.pcm.length, (f + 1) * per)
    for (let s = f * per; s < end; s++) sum += a.pcm[s] * a.pcm[s]
    out[f] = Math.sqrt(sum / Math.max(1, end - f * per))
  }
  return out
}

/**
 * Speech span (first and last 10 ms frame above peak −35 dB) and internal silent gaps ≥ 120 ms, in ms.
 * A silent buffer yields the whole duration and no gaps.
 */
export function analyzeSilence(a: PcmView): { span: [number, number]; gaps: Array<{ startMs: number; endMs: number }> } {
  const durationMs = (a.pcm.length / a.sampleRate) * 1000
  const rms = frameRms(a)
  let peak = 0
  for (const v of rms) if (v > peak) peak = v
  if (peak === 0) return { span: [0, durationMs], gaps: [] }
  const thr = peak * Math.pow(10, SPAN_DB / 20)
  let first = -1
  let last = -1
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > thr) {
      if (first < 0) first = f
      last = f
    }
  }
  const span: [number, number] = [first * FRAME_MS, Math.min(durationMs, (last + 1) * FRAME_MS)]
  const gaps: Array<{ startMs: number; endMs: number }> = []
  let runStart = -1
  for (let f = first; f <= last; f++) {
    const quiet = rms[f] <= thr
    if (quiet && runStart < 0) runStart = f
    if (!quiet && runStart >= 0) {
      if ((f - runStart) * FRAME_MS >= MIN_GAP_MS) gaps.push({ startMs: runStart * FRAME_MS, endMs: f * FRAME_MS })
      runStart = -1
    }
  }
  return { span, gaps }
}

/** Monotonic piecewise-linear map from cumulative weight to time. */
function interpolator(anchors: Array<[number, number]>): (w: number) => number {
  return (w) => {
    if (w <= anchors[0][0]) return anchors[0][1]
    for (let i = 1; i < anchors.length; i++) {
      const [w1, t1] = anchors[i]
      if (w <= w1) {
        const [w0, t0] = anchors[i - 1]
        return w1 === w0 ? t1 : t0 + ((t1 - t0) * (w - w0)) / (w1 - w0)
      }
    }
    return anchors[anchors.length - 1][1]
  }
}

const SKIP_COST = 400

/**
 * Character-weighted timing estimate over `spoken` (research 04 §7.2). With the chunk's PCM, the weights are spread
 * over the speech span and pause-bearing punctuation snaps to detected silent gaps (a small monotonic DP: |predicted −
 * gap mid| per match, 400 ms per skipped item). Without PCM, the weights are spread over [0, durationMs].
 */
export function estimateTimeline(spoken: string, durationMs: number, audio?: PcmView): Timeline {
  const n = spoken.length
  const dur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  const sil = audio && audio.pcm.length ? analyzeSilence(audio) : null
  const span: [number, number] = sil ? [Math.min(sil.span[0], dur), Math.min(sil.span[1], dur)] : [0, dur]
  const w = charWeights(spoken)
  const before = new Float64Array(n)
  const through = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    before[i] = total
    total += w[i]
    through[i] = total
  }
  const startsMs: number[] = new Array<number>(n)
  const endsMs: number[] = new Array<number>(n)
  if (total === 0 || span[1] <= span[0]) {
    for (let i = 0; i < n; i++) startsMs[i] = endsMs[i] = span[0]
    return { startsMs, endsMs }
  }
  const linear = interpolator([
    [0, span[0]],
    [total, span[1]]
  ])
  const anchors: Array<[number, number]> = [[0, span[0]]]
  const gaps = sil ? sil.gaps.filter((g) => g.startMs > span[0] && g.endMs < span[1]) : []
  const pauses: number[] = []
  for (let i = 0; i < n; i++) if (w[i] >= ESTIMATOR_WEIGHTS.clause) pauses.push(i)
  if (gaps.length && pauses.length) {
    const P = pauses.length
    const G = gaps.length
    const cost = new Float64Array((P + 1) * (G + 1))
    const move = new Uint8Array((P + 1) * (G + 1)) // 1 = match, 2 = skip pause, 3 = skip gap
    const at = (p: number, g: number) => p * (G + 1) + g
    for (let p = 1; p <= P; p++) (cost[at(p, 0)] = p * SKIP_COST), (move[at(p, 0)] = 2)
    for (let g = 1; g <= G; g++) (cost[at(0, g)] = g * SKIP_COST), (move[at(0, g)] = 3)
    for (let p = 1; p <= P; p++) {
      const pred = linear(through[pauses[p - 1]])
      for (let g = 1; g <= G; g++) {
        const gap = gaps[g - 1]
        const m = cost[at(p - 1, g - 1)] + Math.abs(pred - (gap.startMs + gap.endMs) / 2)
        const sp = cost[at(p - 1, g)] + SKIP_COST
        const sg = cost[at(p, g - 1)] + SKIP_COST
        const best = Math.min(m, sp, sg)
        cost[at(p, g)] = best
        move[at(p, g)] = best === m ? 1 : best === sp ? 2 : 3
      }
    }
    const pairs: Array<[number, number]> = []
    for (let p = P, g = G; p > 0 && g > 0; ) {
      const mv = move[at(p, g)]
      if (mv === 1) {
        pairs.push([pauses[p - 1], g - 1])
        p--
        g--
      } else if (mv === 2) p--
      else g--
    }
    pairs.reverse()
    for (const [pi, gi] of pairs) {
      const gap = gaps[gi]
      const last = anchors[anchors.length - 1]
      if (through[pi] <= last[0] || gap.startMs < last[1]) continue
      anchors.push([through[pi], gap.startMs])
      let next = pi + 1
      while (next < n && !ALNUM.test(spoken[next])) next++
      if (next < n && before[next] > through[pi]) anchors.push([before[next], gap.endMs])
    }
  }
  if (anchors[anchors.length - 1][0] < total) anchors.push([total, span[1]])
  const f = interpolator(anchors)
  for (let i = 0; i < n; i++) {
    startsMs[i] = round1(f(before[i]))
    endsMs[i] = round1(Math.max(f(through[i]), startsMs[i]))
  }
  return { startsMs, endsMs }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/** Case- and accent-insensitive key of an alignable char, or null (not a letter/digit). */
function keyOf(c: string): string | null {
  if (!ALNUM.test(c)) return null
  const base = c.normalize('NFKD')[0] ?? c
  return base.toLowerCase()
}

/** Indices of alignable chars and their keys; spoken `[audio tags]` absent from `exclude` are skipped. */
function alignables(text: string, skipTagsUnlessIn?: string): { idx: number[]; key: string[] } {
  const idx: number[] = []
  const key: string[] = []
  const hidden = new Uint8Array(text.length)
  if (skipTagsUnlessIn !== undefined) {
    for (const m of text.matchAll(/\[[^\]\n]{1,80}\]/g)) {
      if (!skipTagsUnlessIn.includes(m[0])) hidden.fill(1, m.index, m.index + m[0].length)
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (hidden[i]) continue
    const k = keyOf(text[i])
    if (k !== null) {
      idx.push(i)
      key.push(k)
    }
  }
  return { idx, key }
}

const DP_MAX_CELLS = 1_500_000

/** For each element of `a`, the matched index in `b` or −1: longest common subsequence (greedy windowed when huge). */
function align(a: string[], b: string[]): Int32Array {
  const out = new Int32Array(a.length).fill(-1)
  const n = a.length
  const m = b.length
  if (!n || !m) return out
  if ((n + 1) * (m + 1) <= DP_MAX_CELLS) {
    const L = new Uint16Array((n + 1) * (m + 1))
    const W = m + 1
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[i] === b[j]) {
        out[i] = j
        i++
        j++
      } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++
      else j++
    }
    return out
  }
  const WINDOW = 48
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out[i] = j
      i++
      j++
      continue
    }
    let da = -1
    let db = -1
    for (let d = 1; d <= WINDOW; d++) {
      if (db < 0 && j + d < m && b[j + d] === a[i]) db = d
      if (da < 0 && i + d < n && a[i + d] === b[j]) da = d
      if (da >= 0 || db >= 0) break
    }
    if (db >= 0 && (da < 0 || db <= da)) j += db
    else if (da >= 0) i += da
    else {
      i++
      j++
    }
  }
  return out
}

function validTimeline(t: { startsMs: readonly number[]; endsMs: readonly number[] } | null, n: number): t is Timeline {
  if (!t || t.startsMs.length !== n || t.endsMs.length !== n) return false
  for (let i = 0; i < n; i++) if (!Number.isFinite(t.startsMs[i]) || !Number.isFinite(t.endsMs[i])) return false
  return true
}

/**
 * Map a speech timeline (over the SPOKEN text) onto the RENDERED text of a message chunk (07 C14). Signature frozen in
 * Phase 1.
 *
 * Rendered and spoken text are aligned on letters and digits (case-insensitive, NFKD base char; LCS, so tone/audio-tag
 * text in `spoken` that is not on screen can never claim a visible character). Matched rendered chars take the start
 * time of their spoken counterpart; unmatched chars between two matches interpolate; chars before the first match
 * interpolate from 0; chars after the last match take the chunk's end. The last visible (non-whitespace) char is
 * pinned to `durationMs`. Without a timeline the estimator runs over `spoken` (over `rendered` when nothing is spoken).
 * The result is non-decreasing, finite, and within [0, durationMs].
 */
export function buildRevealMap(
  rendered: string,
  spoken: string,
  timeline: { startsMs: readonly number[]; endsMs: readonly number[] } | null,
  durationMs: number
): Float64Array {
  const n = rendered.length
  const out = new Float64Array(n)
  const dur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  if (!n || dur === 0) return out

  let source = spoken
  let tl: { startsMs: readonly number[]; endsMs: readonly number[] } | null = validTimeline(timeline, spoken.length) ? timeline : null
  if (!alignables(spoken).idx.length) {
    source = rendered
    tl = null
  }
  tl ??= estimateTimeline(source, dur)

  const r = alignables(rendered)
  const s = alignables(source, rendered)
  const match = align(r.key, s.key)

  // Anchors (rendered index → time), times kept non-decreasing.
  const anchorIdx: number[] = []
  const anchorT: number[] = []
  let floor = 0
  for (let k = 0; k < r.idx.length; k++) {
    const j = match[k]
    if (j < 0) continue
    const t = Math.min(dur, Math.max(floor, tl.startsMs[s.idx[j]]))
    floor = t
    anchorIdx.push(r.idx[k])
    anchorT.push(t)
  }
  if (!anchorIdx.length) {
    // Nothing aligns (e.g. a bare URL spoken as "link"): pace the rendered text itself.
    const est = estimateTimeline(rendered, dur)
    for (let i = 0; i < n; i++) out[i] = est.startsMs[i]
  } else {
    let a = 0
    for (let i = 0; i < n; i++) {
      while (a < anchorIdx.length && anchorIdx[a] < i) a++
      if (a < anchorIdx.length && anchorIdx[a] === i) out[i] = anchorT[a]
      else if (a >= anchorIdx.length) out[i] = dur
      else {
        const i0 = a > 0 ? anchorIdx[a - 1] : -1
        const t0 = a > 0 ? anchorT[a - 1] : 0
        out[i] = t0 + ((anchorT[a] - t0) * (i - i0)) / (anchorIdx[a] - i0)
      }
    }
  }
  let lastVisible = n - 1
  while (lastVisible > 0 && WS.test(rendered[lastVisible])) lastVisible--
  for (let i = lastVisible; i < n; i++) out[i] = dur
  let prev = 0
  for (let i = 0; i < n; i++) {
    const v = Math.min(dur, Math.max(prev, Number.isFinite(out[i]) ? out[i] : prev))
    out[i] = v
    prev = v
  }
  return out
}
