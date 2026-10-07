/**
 * Global search, pure parts (unit-tested): the URL state (/search?q=…&mode=…&session=…&role=…&when=…&order=…), the
 * snippet's «match» markers → highlight runs, date presets in the user's zone, and the client-side filters (role,
 * date) applied to each page of hits.
 */
import type { Zone } from '@shared/time'
import type { Role, SearchHit } from '@shared/types/domain'

export type SearchMode = 'keyword' | 'semantic'
export type RoleFilter = 'any' | Role
export type WhenFilter = 'any' | 'today' | 'week' | 'month' | 'year'
export type SearchOrder = 'recent' | 'relevance'

export interface SearchState {
  q: string
  mode: SearchMode
  /** Session uid, or '' for all chats. */
  session: string
  role: RoleFilter
  when: WhenFilter
  order: SearchOrder
}

export const DEFAULT_SEARCH: SearchState = { q: '', mode: 'keyword', session: '', role: 'any', when: 'any', order: 'recent' }

const pickFrom = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => (v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback)

export function parseSearchParams(search: string): SearchState {
  const p = new URLSearchParams(search)
  return {
    q: (p.get('q') ?? '').slice(0, 500),
    mode: pickFrom(p.get('mode'), ['keyword', 'semantic'] as const, 'keyword'),
    session: (p.get('session') ?? '').slice(0, 64),
    role: pickFrom(p.get('role'), ['any', 'user', 'assistant'] as const, 'any'),
    when: pickFrom(p.get('when'), ['any', 'today', 'week', 'month', 'year'] as const, 'any'),
    order: pickFrom(p.get('order'), ['recent', 'relevance'] as const, 'recent')
  }
}

/** The path for a state; defaults are left out so links stay short. */
export function searchPath(s: SearchState): string {
  const p = new URLSearchParams()
  if (s.q) p.set('q', s.q)
  if (s.mode !== 'keyword') p.set('mode', s.mode)
  if (s.session) p.set('session', s.session)
  if (s.role !== 'any') p.set('role', s.role)
  if (s.when !== 'any') p.set('when', s.when)
  if (s.order !== 'recent') p.set('order', s.order)
  const qs = p.toString()
  return qs ? `/search?${qs}` : '/search'
}

/** Snippet "…we flew to «Lisbon» in…" → runs; unbalanced markers are treated as text. */
export function snippetRuns(snippet: string): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = []
  let rest = snippet
  for (;;) {
    const a = rest.indexOf('«')
    if (a < 0) break
    const b = rest.indexOf('»', a + 1)
    if (b < 0) break
    if (a > 0) runs.push({ text: rest.slice(0, a), hit: false })
    if (b > a + 1) runs.push({ text: rest.slice(a + 1, b), hit: true })
    rest = rest.slice(b + 1)
  }
  if (rest) runs.push({ text: rest, hit: false })
  return runs
}

/** Lower bound (UTC ms, inclusive) of a "when" preset: the start of the local day N days back. */
export function whenFrom(when: WhenFilter, nowUtc: number, zone: Zone): number | null {
  if (when === 'any') return null
  const days = when === 'today' ? 0 : when === 'week' ? 6 : when === 'month' ? 29 : 364
  const p = zone.partsAt(nowUtc)
  // Local midnight today, then back `days` calendar days (offset taken at that instant; DST shifts ≤ 1 h are fine).
  const midnightLocal = Date.UTC(p.year, p.month - 1, p.day) - days * 86_400_000
  const off = zone.partsAt(midnightLocal - p.offsetMin * 60_000).offsetMin
  return midnightLocal - off * 60_000
}

export function filterHits(hits: readonly SearchHit[], role: RoleFilter, fromUtc: number | null): SearchHit[] {
  return hits.filter((h) => (role === 'any' || h.message.role === role) && (fromUtc === null || h.message.tsUtc >= fromUtc))
}

/**
 * With newest-first order, once a page ends before the date bound no later page can match: stop paging.
 */
export function pastBound(hits: readonly SearchHit[], order: SearchOrder, fromUtc: number | null): boolean {
  if (fromUtc === null || order !== 'recent' || !hits.length) return false
  return hits[hits.length - 1].message.tsUtc < fromUtc
}
