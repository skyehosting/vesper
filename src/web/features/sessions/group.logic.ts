/** Sidebar grouping by recency (01 "Sessions"): Pinned · Today · Yesterday · This week · Older, newest first. */
import { calendarDaysBetween, type Zone } from '@shared/time'
import type { SessionSummary } from '@shared/types/domain'

export type SessionGroupId = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

export const SESSION_GROUP_LABELS: Record<SessionGroupId, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  older: 'Older'
}

export interface SessionGroup {
  id: SessionGroupId
  label: string
  items: SessionSummary[]
}

/** A chat's display title: its title, else "New chat" ("Temporary chat" for a temporary one). */
export const titleOf = (s: Pick<SessionSummary, 'title' | 'temporary'>): string => s.title || (s.temporary ? 'Temporary chat' : 'New chat')

/** When the session was last active: its last message, else its last change. */
export function activityOf(s: Pick<SessionSummary, 'lastMessageUtc' | 'updatedUtc' | 'createdUtc'>): number {
  return s.lastMessageUtc ?? s.updatedUtc ?? s.createdUtc
}

/** Calendar days in the user's zone, so "Yesterday" flips at local midnight (not 24 h ago). */
export function recencyGroup(activityUtc: number, nowUtc: number, zone: Zone): Exclude<SessionGroupId, 'pinned'> {
  const days = calendarDaysBetween(activityUtc, nowUtc, zone)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  return 'older'
}

export function groupSessions(items: readonly SessionSummary[], nowUtc: number, zone: Zone): SessionGroup[] {
  const order: SessionGroupId[] = ['pinned', 'today', 'yesterday', 'week', 'older']
  const buckets = new Map<SessionGroupId, SessionSummary[]>(order.map((id) => [id, []]))
  for (const s of items) {
    const id: SessionGroupId = s.pinned ? 'pinned' : recencyGroup(activityOf(s), nowUtc, zone)
    buckets.get(id)?.push(s)
  }
  const out: SessionGroup[] = []
  for (const id of order) {
    const list = buckets.get(id) ?? []
    if (!list.length) continue
    list.sort((a, b) => activityOf(b) - activityOf(a))
    out.push({ id, label: SESSION_GROUP_LABELS[id], items: list })
  }
  return out
}
