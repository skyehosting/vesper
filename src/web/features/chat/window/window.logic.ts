/**
 * History-window math (research 03 §4.4, 07 D1): how many rows may be unloaded, scrubber position ↔ seq, dates for
 * scrubber previews, day separators and time-gap markers. DOM-free and unit-tested.
 */
import type { Message, TimelineSample } from '@shared/types/domain'
import { calendarDaysBetween, elapsedWords, GAP_NOTE_MS, type Zone } from '@shared/time'

/** Cap = 3 pages of N (07 D1). */
export function windowCap(pageSize: number): number {
  return pageSize * 3
}

/**
 * How many rows to unload from `side` so the window gets back to `cap`, never touching `protectedSeq` rows (rows on
 * screen, focus, selection) or anything between them and the kept side. Returns 0 when nothing can go now.
 */
export function trimCount(seqs: readonly number[], cap: number, side: 'top' | 'bottom', protectedLo: number | null, protectedHi: number | null): number {
  const excess = seqs.length - cap
  if (excess <= 0) return 0
  if (protectedLo === null || protectedHi === null) return excess
  let n = 0
  if (side === 'bottom') {
    for (let i = seqs.length - 1; i >= 0 && n < excess; i--) {
      if (seqs[i] <= protectedHi) break
      n++
    }
  } else {
    for (let i = 0; i < seqs.length && n < excess; i++) {
      if (seqs[i] >= protectedLo) break
      n++
    }
  }
  return n
}

/** Scrubber fraction (0 top … 1 bottom) for a seq. */
export function fractionOf(seq: number, lastSeq: number): number {
  if (lastSeq <= 1) return 1
  return Math.min(1, Math.max(0, (seq - 1) / (lastSeq - 1)))
}

/** Seq at a scrubber fraction. */
export function seqAt(fraction: number, lastSeq: number): number {
  if (lastSeq <= 1) return 1
  const f = Math.min(1, Math.max(0, fraction))
  return Math.max(1, Math.min(lastSeq, Math.round(1 + f * (lastSeq - 1))))
}

/** Estimated time of `seq` by linear interpolation between timeline samples (sorted by seq). */
export function timeAtSeq(samples: readonly TimelineSample[], seq: number): number | null {
  if (samples.length === 0) return null
  if (seq <= samples[0].seq) return samples[0].tsUtc
  const last = samples[samples.length - 1]
  if (seq >= last.seq) return last.tsUtc
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].seq <= seq) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  if (b.seq === a.seq) return a.tsUtc
  return Math.round(a.tsUtc + ((seq - a.seq) / (b.seq - a.seq)) * (b.tsUtc - a.tsUtc))
}

/** "Today" · "Yesterday" · "Friday 12 September" · "Friday 12 September 2025" (other years). */
export function dayLabel(utc: number, nowUtc: number, zone: Zone): string {
  const days = calendarDaysBetween(utc, nowUtc, zone)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const p = zone.partsAt(utc)
  const now = zone.partsAt(nowUtc)
  const base = `${WEEKDAY_LONG[p.weekday]} ${p.day} ${MONTH_LONG[p.month - 1]}`
  return p.year === now.year ? base : `${base} ${p.year}`
}

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface Separator {
  /** Day label when the local day changed. */
  day: string | null
  /** "23 days later" when the conversation resumed after > 6 h (04 "time-gap marker"). */
  gap: string | null
}

/** What to show above `m` given the previous visible message (`prev` null = the first loaded row). */
export function separatorFor(m: Pick<Message, 'tsUtc'>, prev: Pick<Message, 'tsUtc'> | null, nowUtc: number, zone: Zone, knownStart: boolean): Separator | null {
  if (!prev) return knownStart ? { day: dayLabel(m.tsUtc, nowUtc, zone), gap: null } : null
  const newDay = calendarDaysBetween(prev.tsUtc, m.tsUtc, zone) !== 0
  const gapMs = m.tsUtc - prev.tsUtc
  const gap = gapMs >= GAP_NOTE_MS ? `${elapsedWords(prev.tsUtc, m.tsUtc, zone)} later` : null
  if (!newDay && !gap) return null
  return { day: newDay ? dayLabel(m.tsUtc, nowUtc, zone) : null, gap }
}

/** Short date for the scrubber bubble: "12 Sep 2025". */
export function shortDate(utc: number, zone: Zone): string {
  const p = zone.partsAt(utc)
  return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`
}

/** "1,234" */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
