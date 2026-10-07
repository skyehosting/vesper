/**
 * Dates as the sidebar, panel and search show them, in this device's zone (or the Settings → General override), with
 * the one display format of 07 C2. Formatting comes from shared/time (numeric parts, no locale month names).
 */
import { formatDate, formatStamp, relativeAge, zoneOf, type Clock, type LocalParts, type Zone } from '@shared/time'
import { useStore } from '../../lib/store'

export { formatDate }

/** The device's zone, or the profile's override. */
export function deviceZone(override?: string | null): Zone {
  let name: string | null = override || null
  if (!name) {
    try {
      name = Intl.DateTimeFormat().resolvedOptions().timeZone || null
    } catch {
      name = null
    }
  }
  return zoneOf(name, -new Date().getTimezoneOffset())
}

function currentZone(): Zone {
  return deviceZone(useStore.getState().settings?.profile.timeZone)
}

function currentClock(): Clock {
  return useStore.getState().settings?.profile.clock ?? '24h'
}

export function partsOf(utcMs: number, zone: Zone = currentZone()): LocalParts {
  return zone.partsAt(utcMs)
}

/** "Mon 5 Oct 2026 14:03 (UTC−04:00)" */
export function stampOf(utcMs: number, zone: Zone = currentZone(), clock: Clock = currentClock()): string {
  return formatStamp(utcMs, zone, clock)
}

/** "3 days ago" */
export function ageOf(utcMs: number, nowUtc = Date.now(), zone: Zone = currentZone()): string {
  return relativeAge(utcMs, nowUtc, zone)
}
