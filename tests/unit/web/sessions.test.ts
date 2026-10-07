import { describe, expect, it } from 'vitest'
import { fixedZone, ianaZone } from '@shared/time'
import type { SessionSummary } from '@shared/types/domain'
import { activityOf, groupSessions, recencyGroup } from '../../../src/web/features/sessions/group.logic'

const H = 3_600_000
const D = 24 * H

function s(uid: string, lastMessageUtc: number | null, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    uid,
    shortId: uid.toUpperCase().padEnd(6, 'X').slice(0, 6),
    title: uid,
    createdUtc: (lastMessageUtc ?? 0) - H,
    updatedUtc: lastMessageUtc ?? 0,
    lastMessageUtc,
    lastSeq: 0,
    messageCount: 0,
    pinned: false,
    archived: false,
    private: false,
    temporary: false,
    hasPrompt: false,
    linkCount: 0,
    memory: 'inherit',
    ...extra
  }
}

describe('session grouping', () => {
  // Mon 5 Oct 2026 14:00 UTC
  const now = Date.UTC(2026, 9, 5, 14, 0)
  const utc = fixedZone(0)

  it('uses calendar days in the zone, not 24 h windows', () => {
    expect(recencyGroup(Date.UTC(2026, 9, 5, 0, 1), now, utc)).toBe('today')
    expect(recencyGroup(Date.UTC(2026, 9, 4, 23, 59), now, utc)).toBe('yesterday')
    expect(recencyGroup(Date.UTC(2026, 9, 3, 12), now, utc)).toBe('week')
    expect(recencyGroup(Date.UTC(2026, 8, 29, 12), now, utc)).toBe('week')
    expect(recencyGroup(Date.UTC(2026, 8, 28, 12), now, utc)).toBe('older')
    // 01:00 UTC on the 5th is still the 4th in New York → yesterday there
    expect(recencyGroup(Date.UTC(2026, 9, 5, 1), now, ianaZone('America/New_York'))).toBe('yesterday')
  })

  it('treats future timestamps (clock skew) as today', () => {
    expect(recencyGroup(now + 5 * 60_000, now, utc)).toBe('today')
  })

  it('groups in a fixed order, pinned first, newest first, empty groups omitted', () => {
    const items = [
      s('old', now - 40 * D),
      s('today-early', now - 10 * H),
      s('pin-old', now - 100 * D, { pinned: true }),
      s('today-late', now - H),
      s('yesterday', now - 20 * H),
      s('never', null, { updatedUtc: now - 2 * H })
    ]
    const groups = groupSessions(items, now, utc)
    expect(groups.map((g) => [g.id, g.label, g.items.map((x) => x.uid)])).toEqual([
      ['pinned', 'Pinned', ['pin-old']],
      ['today', 'Today', ['today-late', 'never', 'today-early']],
      ['yesterday', 'Yesterday', ['yesterday']],
      ['older', 'Older', ['old']]
    ])
  })

  it('falls back to updated time when there is no message yet', () => {
    expect(activityOf({ lastMessageUtc: null, updatedUtc: 5, createdUtc: 1 })).toBe(5)
    expect(activityOf({ lastMessageUtc: 9, updatedUtc: 5, createdUtc: 1 })).toBe(9)
  })
})
