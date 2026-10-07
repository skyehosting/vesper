/** Plain-words number, money, duration and day formatting for the memory/data pages (pure; unit-tested). */
import { formatDate, type Zone } from '@shared/time'

const nf = new Intl.NumberFormat('en-US')

export function formatCount(n: number): string {
  return nf.format(Math.round(n))
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** "$0.03", "under $0.01", "$12" — for estimates. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return 'under $0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

/** "about 40 seconds", "about 3 minutes", "about 2 hours", "about 3 days". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'unknown'
  if (sec < 1) return 'a moment'
  if (sec < 60) return `about ${Math.max(1, Math.round(sec / 5) * 5)} seconds`
  const min = sec / 60
  if (min < 60) {
    const m = Math.round(min)
    return `about ${m} minute${m === 1 ? '' : 's'}`
  }
  const h = min / 60
  if (h < 36) {
    const r = h < 10 ? Math.round(h * 2) / 2 : Math.round(h)
    return `about ${r} hour${r === 1 ? '' : 's'}`
  }
  const d = Math.round(h / 24)
  return `about ${d} days`
}

/** Bytes as "1.2 GB" (base 1024, like Explorer). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Calendar key of an instant in a zone ("2026-10-05"). */
export function dayKey(utcMs: number, zone: Zone): string {
  const p = zone.partsAt(utcMs)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Day separator label (04 "Day separators"): "Today", "Yesterday", "Friday 2 October 2026". */
export function dayLabel(utcMs: number, nowUtc: number, zone: Zone): string {
  const k = dayKey(utcMs, zone)
  if (k === dayKey(nowUtc, zone)) return 'Today'
  if (k === dayKey(nowUtc - 86_400_000, zone)) return 'Yesterday'
  const p = zone.partsAt(utcMs)
  // formatDate gives "Fri 2 Oct 2026"; the long weekday reads better as a heading.
  return `${WEEKDAYS_LONG[p.weekday]} ${formatDate(p).split(' ').slice(1).join(' ')}`
}

/** Tokens → "~1,100 words" (about 0.75 English words per token). */
export function tokensAsWords(tokens: number): string {
  return `~${formatCount(Math.round((tokens * 0.75) / 10) * 10)} words`
}

/** Short hash for display ("3fa2c91e"). */
export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

/** The most useful text of an API error: the first field message for validation errors, else the message. */
export function errorText(e: { message: string; fields?: Record<string, string> }): string {
  const f = e.fields ? Object.values(e.fields)[0] : undefined
  return f || e.message
}
