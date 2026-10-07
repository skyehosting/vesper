/** The viewer's zone and clock (Settings → profile.timeZone, else this device's zone; 12/24 h). */
import { useMemo } from 'react'
import { ianaZone, isValidZoneName, fixedZone, type Clock, type Zone } from '@shared/time'
import { useSettings } from './settings'

export function deviceZoneName(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

export function viewerZone(override: string | undefined): Zone {
  const name = override && isValidZoneName(override) ? override : deviceZoneName()
  return isValidZoneName(name) ? ianaZone(name) : fixedZone(-new Date().getTimezoneOffset())
}

export function useViewerZone(): { zone: Zone; clock: Clock } {
  const settings = useSettings()
  const tz = settings?.profile.timeZone
  const clock = settings?.profile.clock ?? '24h'
  const zone = useMemo(() => viewerZone(tz), [tz])
  return { zone, clock }
}
