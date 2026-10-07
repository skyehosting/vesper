import { describe, expect, it } from 'vitest'
import { fixedZone } from '@shared/time'
import { dayLabel, fractionOf, seqAt, separatorFor, shortDate, timeAtSeq, trimCount, windowCap } from '../../../src/web/features/chat/window/window.logic'

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const UTC = fixedZone(0)
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 5, 14, 3)

describe('history window math (07 D1) @R5', () => {
  it('caps the window at 3 pages', () => {
    expect(windowCap(100)).toBe(300)
  })

  it('unloads the excess from the far side, never rows on screen, focused or selected', () => {
    const seqs = range(1, 400)
    expect(trimCount(seqs, 300, 'bottom', null, null)).toBe(100)
    // Rows 50..120 are protected: dropping from the bottom is free.
    expect(trimCount(seqs, 300, 'bottom', 50, 120)).toBe(100)
    // Protected rows near the bottom: only those below them may go.
    expect(trimCount(seqs, 300, 'bottom', 300, 380)).toBe(20)
    expect(trimCount(seqs, 300, 'top', 30, 380)).toBe(29)
    expect(trimCount(seqs, 300, 'top', 1, 380)).toBe(0)
    expect(trimCount(range(1, 250), 300, 'top', null, null)).toBe(0)
  })

  it('maps scrubber fractions to seqs and back', () => {
    expect(seqAt(0, 1_000_000)).toBe(1)
    expect(seqAt(1, 1_000_000)).toBe(1_000_000)
    expect(seqAt(0.1, 1_000_001)).toBe(100_001)
    expect(fractionOf(500_000, 999_999)).toBeCloseTo(0.5, 5)
    expect(fractionOf(1, 1)).toBe(1)
    for (const f of [0, 0.123, 0.5, 0.99, 1]) expect(fractionOf(seqAt(f, 10_000), 10_000)).toBeCloseTo(f, 3)
  })

  it('interpolates dates between timeline samples', () => {
    const samples = [
      { seq: 1, tsUtc: 0 },
      { seq: 101, tsUtc: 1000 },
      { seq: 201, tsUtc: 5000 }
    ]
    expect(timeAtSeq(samples, 51)).toBe(500)
    expect(timeAtSeq(samples, 151)).toBe(3000)
    expect(timeAtSeq(samples, 999)).toBe(5000)
    expect(timeAtSeq([], 5)).toBeNull()
  })

  it('labels days and time gaps (04 day separators and "— 23 days later —")', () => {
    expect(dayLabel(NOW - 60_000, NOW, UTC)).toBe('Today')
    expect(dayLabel(NOW - DAY, NOW, UTC)).toBe('Yesterday')
    expect(dayLabel(Date.UTC(2026, 8, 12, 9), NOW, UTC)).toBe('Saturday 12 September')
    expect(dayLabel(Date.UTC(2025, 8, 12, 9), NOW, UTC)).toBe('Friday 12 September 2025')
    expect(shortDate(Date.UTC(2025, 8, 12, 9), UTC)).toBe('12 Sep 2025')
    const a = { tsUtc: NOW - 10 * DAY }
    const b = { tsUtc: NOW }
    expect(separatorFor(b, a, NOW, UTC, true)).toEqual({ day: 'Today', gap: '10 days later' })
    expect(separatorFor(b, { tsUtc: NOW - 60_000 }, NOW, UTC, true)).toBeNull()
    expect(separatorFor(b, { tsUtc: NOW - 7 * 3_600_000 }, NOW, UTC, true)).toEqual({ day: null, gap: '7 hours later' })
    expect(separatorFor(b, null, NOW, UTC, false)).toBeNull()
    expect(separatorFor(b, null, NOW, UTC, true)).toEqual({ day: 'Today', gap: null })
  })
})
