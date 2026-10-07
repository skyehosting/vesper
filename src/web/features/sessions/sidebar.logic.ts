/**
 * Sidebar list layout, pure (unit-tested): groups → flat rows (group headings + session rows) with fixed heights, and
 * the window of rows to render when the list is long (R6 "virtualised when long"). Fixed heights make the window exact
 * without measuring, so a few thousand chats scroll as smoothly as ten.
 */
import type { SessionSummary } from '@shared/types/domain'
import type { SessionGroup, SessionGroupId } from './group.logic'

export type SidebarRow =
  | { kind: 'header'; key: string; id: SessionGroupId; label: string; first: boolean }
  | { kind: 'session'; key: string; session: SessionSummary; group: SessionGroupId }

/** Above this many rows the list renders only a window around the viewport. */
export const VIRTUALIZE_AT = 60

export interface RowMetrics {
  /** Session row height (34 desktop, 46 on touch: a 44 px link plus 1 px above and below). */
  row: number
  /** Group heading height. */
  header: number
  /** Extra space above every heading but the first. */
  gap: number
}

export function flattenGroups(groups: readonly SessionGroup[]): SidebarRow[] {
  const out: SidebarRow[] = []
  groups.forEach((g, gi) => {
    out.push({ kind: 'header', key: `h:${g.id}`, id: g.id, label: g.label, first: gi === 0 })
    for (const s of g.items) out.push({ kind: 'session', key: s.uid, session: s, group: g.id })
  })
  return out
}

export function rowHeight(r: SidebarRow, m: RowMetrics): number {
  return r.kind === 'header' ? m.header + (r.first ? 0 : m.gap) : m.row
}

/** Prefix sums: offsets[i] = top of row i; offsets[n] = total height. */
export function rowOffsets(rows: readonly SidebarRow[], m: RowMetrics): number[] {
  const out = new Array<number>(rows.length + 1)
  out[0] = 0
  for (let i = 0; i < rows.length; i++) out[i + 1] = out[i] + rowHeight(rows[i], m)
  return out
}

/** First index whose row ends after `y` (binary search over the prefix sums). */
function indexAt(offsets: readonly number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Inclusive range of rows intersecting [scrollTop − overscan, scrollTop + viewport + overscan], or null when empty. */
export function windowRange(offsets: readonly number[], scrollTop: number, viewport: number, overscan: number): [number, number] | null {
  const n = offsets.length - 1
  if (n <= 0) return null
  const top = Math.max(0, scrollTop - overscan)
  const bottom = scrollTop + Math.max(0, viewport) + overscan
  const start = indexAt(offsets, top)
  const end = Math.min(n - 1, indexAt(offsets, Math.max(top, bottom - 0.5)))
  return [start, Math.max(start, end)]
}

/** The session uids in display order (keyboard navigation, "next chat" after a delete). */
export function sessionOrder(rows: readonly SidebarRow[]): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const r of rows) if (r.kind === 'session') out.push(r.session)
  return out
}

/** Roving focus: the uid to move to from `current` for a navigation key, or null when the key doesn't move. */
export function moveFocus(order: readonly string[], current: string | null, key: string, page = 10): string | null {
  if (!order.length) return null
  const i = current ? order.indexOf(current) : -1
  switch (key) {
    case 'ArrowDown':
      return order[Math.min(order.length - 1, i + 1)] ?? null
    case 'ArrowUp':
      return order[i < 0 ? 0 : Math.max(0, i - 1)] ?? null
    case 'Home':
      return order[0]
    case 'End':
      return order[order.length - 1]
    case 'PageDown':
      return order[Math.min(order.length - 1, Math.max(0, i) + page)]
    case 'PageUp':
      return order[Math.max(0, i - page)]
    default:
      return null
  }
}
