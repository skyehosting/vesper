/**
 * Palette matching and ranking, pure (unit-tested). A match is scored: whole-text prefix > word prefix > substring >
 * in-order letters (fuzzy), with shorter texts first on ties; `matchRanges` gives the parts to highlight.
 */

export interface Scored<T> {
  item: T
  score: number
}

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Higher is better; -1 = no match. Every query word must match (in any order). */
export function scoreMatch(query: string, ...texts: readonly (string | null | undefined)[]): number {
  const words = norm(query).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 0
  const hay = texts.filter((t): t is string => !!t).map(norm)
  if (!hay.length) return -1
  let total = 0
  for (const w of words) {
    let best = -1
    for (let i = 0; i < hay.length; i++) {
      const h = hay[i]
      // Earlier fields (the title) weigh more than later ones (descriptions, keywords).
      const weight = i === 0 ? 1 : 0.6
      let s = -1
      if (h.startsWith(w)) s = 100
      else if (new RegExp(`(^|[\\s/#·:_-])${escapeRe(w)}`).test(h)) s = 80
      else if (h.includes(w)) s = 55
      else if (w.length >= 2 && isSubsequence(w, h)) s = 20
      if (s >= 0) best = Math.max(best, s * weight - Math.min(20, h.length / 10))
    }
    if (best < 0) return -1
    total += best
  }
  return total
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

export function rank<T>(query: string, items: readonly T[], texts: (item: T) => readonly (string | null | undefined)[], limit = Infinity): T[] {
  const scored: Scored<T>[] = []
  for (const item of items) {
    const score = scoreMatch(query, ...texts(item))
    if (score >= 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}

/** [start, end) ranges of `text` matching the query words (case-insensitive), merged, for highlighting. */
export function matchRanges(query: string, text: string): [number, number][] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const t = text.toLowerCase()
  const out: [number, number][] = []
  for (const w of words) {
    let from = 0
    for (;;) {
      const i = t.indexOf(w, from)
      if (i < 0) break
      out.push([i, i + w.length])
      from = i + w.length
    }
  }
  out.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/** Split a text into plain / highlighted runs from `ranges` (for <mark>). */
export function splitRuns(text: string, ranges: readonly [number, number][]): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [a, b] of ranges) {
    if (a > at) runs.push({ text: text.slice(at, a), hit: false })
    runs.push({ text: text.slice(a, b), hit: true })
    at = b
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false })
  return runs
}
