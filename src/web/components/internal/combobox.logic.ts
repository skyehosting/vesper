/**
 * Filtering for the searchable Combobox (voices, models — 04). Matches every query word against the label and the
 * description (case- and accent-insensitive) and ranks: label starts with the query > a label word starts with it >
 * label contains it > only the description matches. Stable within a rank, so provider order is kept.
 */
import { foldLabel } from './typeahead.logic'

export interface Searchable {
  label: string
  description?: string
  /** Extra words that should match (ids, aliases) but are not shown. */
  keywords?: string[]
}

export function matchRank(item: Searchable, query: string): number {
  const q = foldLabel(query).trim()
  if (!q) return 1
  const label = foldLabel(item.label)
  const rest = foldLabel([item.description ?? '', ...(item.keywords ?? [])].join(' '))
  const words = q.split(/\s+/)
  // Every word must appear somewhere.
  if (!words.every((w) => label.includes(w) || rest.includes(w))) return 0
  if (label.startsWith(q)) return 4
  if (label.split(/[\s\-_/.:()]+/).some((w) => w.startsWith(words[0]))) return 3
  if (label.includes(words[0])) return 2
  return 1
}

/** Items matching `query`, best first. Empty query → all items in their order. */
export function filterItems<T extends Searchable>(items: readonly T[], query: string): T[] {
  if (!query.trim()) return [...items]
  return items
    .map((item, i) => ({ item, i, rank: matchRank(item, query) }))
    .filter((r) => r.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map((r) => r.item)
}

/** Split a label into [before, match, after] for highlighting the first occurrence of the query. */
export function highlightParts(label: string, query: string): [string, string, string] {
  const q = foldLabel(query).trim()
  if (!q) return [label, '', '']
  // Fold per character so indexes line up with the original string (folding can only drop combining marks).
  const folded: string[] = []
  const map: number[] = []
  for (let i = 0; i < label.length; i++) {
    const f = foldLabel(label[i])
    for (const ch of f) {
      folded.push(ch)
      map.push(i)
    }
  }
  const at = folded.join('').indexOf(q)
  if (at < 0) return [label, '', '']
  const start = map[at]
  const end = (map[at + q.length - 1] ?? label.length - 1) + 1
  return [label.slice(0, start), label.slice(start, end), label.slice(end)]
}
