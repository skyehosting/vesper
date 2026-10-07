/**
 * Time formatting for time awareness (R7, R10). Everything is formatted from numeric date parts, never with locale
 * month/weekday names (ICU 78 in Electron prints "Sept"), and relative ages are computed in code as calendar-day
 * differences in the user's zone (DST-safe) — models are unreliable at date arithmetic (research 02 §6).
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MINUTE = 60_000
const HOUR = 60 * MINUTE

export type Clock = '24h' | '12h'

export interface LocalParts {
  year: number
  month: number // 1–12
  day: number
  hour: number // 0–23
  minute: number
  weekday: number // 0 = Sunday
  /** UTC offset at that instant, minutes east of UTC (e.g. −240 for New York in summer). */
  offsetMin: number
}

/** A time zone: an IANA name when known (DST-aware), otherwise a fixed offset. */
export interface Zone {
  name: string | null
  partsAt(utcMs: number): LocalParts
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function dtfFor(name: string): Intl.DateTimeFormat {
  let f = dtfCache.get(name)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    })
    dtfCache.set(name, f)
  }
  return f
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** Is `name` an IANA zone this runtime knows? */
export function isValidZoneName(name: string | null | undefined): name is string {
  if (!name || name.length > 64) return false
  try {
    dtfFor(name)
    return true
  } catch {
    return false
  }
}

export function fixedZone(offsetMin: number): Zone {
  return {
    name: null,
    partsAt(utcMs: number): LocalParts {
      const d = new Date(utcMs + offsetMin * MINUTE)
      const year = d.getUTCFullYear()
      const month = d.getUTCMonth() + 1
      const day = d.getUTCDate()
      return { year, month, day, hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay(), offsetMin }
    }
  }
}

export function ianaZone(name: string): Zone {
  const f = dtfFor(name)
  return {
    name,
    partsAt(utcMs: number): LocalParts {
      const p: Record<string, number> = {}
      for (const part of f.formatToParts(new Date(utcMs))) {
        if (part.type !== 'literal') p[part.type] = Number(part.value)
      }
      const year = p.year
      const month = p.month
      const day = p.day
      const hour = p.hour === 24 ? 0 : p.hour
      const minute = p.minute
      const second = p.second ?? 0
      const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
      const offsetMin = Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / MINUTE)
      return { year, month, day, hour, minute, weekday: weekdayOf(year, month, day), offsetMin }
    }
  }
}

/** The zone a message was written in: its IANA name when valid, else its recorded offset. */
export function zoneOf(tzName: string | null | undefined, offsetMin: number): Zone {
  return isValidZoneName(tzName) ? ianaZone(tzName) : fixedZone(offsetMin)
}

/** "UTC−04:00" (true minus sign), "UTC+05:30", "UTC+00:00". */
export function formatOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? '−' : '+'
  const a = Math.abs(offsetMin)
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

function formatClock(hour: number, minute: number, clock: Clock): string {
  const mm = String(minute).padStart(2, '0')
  if (clock === '24h') return `${String(hour).padStart(2, '0')}:${mm}`
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`
}

/** "Mon 5 Oct 2026 14:03" (or "… 2:03 PM"). */
export function formatAbsolute(p: LocalParts, clock: Clock = '24h'): string {
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year} ${formatClock(p.hour, p.minute, clock)}`
}

/** "Mon 5 Oct 2026" */
export function formatDate(p: LocalParts): string {
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}`
}

/** The clock line given to the model every turn: "Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)". */
export function formatNow(utcMs: number, zone: Zone, clock: Clock = '24h'): string {
  const p = zone.partsAt(utcMs)
  const where = zone.name ? `${formatOffset(p.offsetMin)}, ${zone.name}` : formatOffset(p.offsetMin)
  return `${formatAbsolute(p, clock)} (${where})`
}

/** Days since 1970-01-01 of the local calendar date (for calendar-day differences). */
function dayNumber(p: LocalParts): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / (24 * HOUR))
}

/** Whole calendar days between two instants, both seen in `zone` (0 = same local day). */
export function calendarDaysBetween(thenUtc: number, nowUtc: number, zone: Zone): number {
  return dayNumber(zone.partsAt(nowUtc)) - dayNumber(zone.partsAt(thenUtc))
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/**
 * Relative age in words, computed in code: just now · N minutes ago · N hours ago (same day) · yesterday ·
 * N days ago (< 14) · N weeks ago (< 60 days) · about N months ago (< 2 years) · about N years ago.
 * Future instants (clock skew between devices) read as "just now".
 */
export function relativeAge(thenUtc: number, nowUtc: number, zone: Zone): string {
  const ms = nowUtc - thenUtc
  if (ms < MINUTE) return 'just now'
  const days = calendarDaysBetween(thenUtc, nowUtc, zone)
  if (days <= 0) {
    if (ms < HOUR) return `${plural(Math.floor(ms / MINUTE), 'minute')} ago`
    return `${plural(Math.floor(ms / HOUR), 'hour')} ago`
  }
  if (days === 1) return ms < 6 * HOUR ? `${plural(Math.max(1, Math.floor(ms / HOUR)), 'hour')} ago` : 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${plural(Math.floor(days / 7), 'week')} ago`
  if (days < 730) return `about ${plural(Math.round(days / 30.44), 'month')} ago`
  return `about ${plural(Math.round(days / 365.25), 'year')} ago`
}

/** Elapsed time between two messages in words, for gap notes: "7 hours", "yesterday" → "1 day", "23 days", "3 weeks". */
export function elapsedWords(fromUtc: number, toUtc: number, zone: Zone): string {
  const ms = toUtc - fromUtc
  const days = calendarDaysBetween(fromUtc, toUtc, zone)
  if (ms < 24 * HOUR && days <= 1) return plural(Math.max(1, Math.round(ms / HOUR)), 'hour')
  if (days < 14) return plural(Math.max(1, days), 'day')
  if (days < 60) return plural(Math.floor(days / 7), 'week')
  if (days < 730) return `about ${plural(Math.round(days / 30.44), 'month')}`
  return `about ${plural(Math.round(days / 365.25), 'year')}`
}

/** Minimum gap that earns an explicit note in the model's context and a "— N days later —" marker in the UI. */
export const GAP_NOTE_MS = 6 * HOUR

/** One display format everywhere (07 C2): "Mon 5 Oct 2026 14:03 (UTC−04:00)". */
export function formatStamp(utcMs: number, zone: Zone, clock: Clock = '24h'): string {
  const p = zone.partsAt(utcMs)
  return `${formatAbsolute(p, clock)} (${formatOffset(p.offsetMin)})`
}

/**
 * The header written ONCE, at send time, at the start of a user turn's first text block in the wire transcript, and
 * never re-rendered (07 C2): "[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)]" or, after a gap of more than
 * 6 hours, "[Now: … · 23 days since the previous message]".
 */
export function turnHeader(utcMs: number, zone: Zone, prevUtcMs: number | null, clock: Clock = '24h'): string {
  const now = formatNow(utcMs, zone, clock)
  if (prevUtcMs !== null && utcMs - prevUtcMs >= GAP_NOTE_MS) {
    return `[Now: ${now} · ${elapsedWords(prevUtcMs, utcMs, zone)} since the previous message]`
  }
  return `[Now: ${now}]`
}

/** Strip a leading "[Mon 5 Oct 2026 14:03 …]" the model may have imitated at the start of its reply. */
export function stripImitatedStamp(text: string): string {
  return text.replace(/^\s*\[(?:Now: )?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4} \d{1,2}:\d{2}(?: [AP]M)?[^\]\n]{0,120}\]\s*/, '')
}
