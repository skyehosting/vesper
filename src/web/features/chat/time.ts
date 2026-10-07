/**
 * Time display for the conversation (07 C2): one absolute format everywhere ("Mon 5 Oct 2026 14:03 (UTC−04:00)",
 * in the owner's zone — Settings → profile.timeZone, else this device's) and relative ages computed in code. One
 * shared minute ticker drives every "5 minutes ago"; it runs only while something is subscribed.
 */
import { useSyncExternalStore } from 'react'
import { fixedZone, ianaZone, isValidZoneName, type Zone } from '@shared/time'
import { useStore } from '../../lib/store'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: number | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (timer === null) {
    now = Date.now()
    timer = window.setInterval(() => {
      now = Date.now()
      for (const l of [...listeners]) l()
    }, 30_000)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}
const getNow = (): number => now

/** "Now", refreshed every 30 s while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow)
}

/** Ticker listeners (leak checks). */
export function nowTickerStats(): { listeners: number; running: boolean } {
  return { listeners: listeners.size, running: timer !== null }
}

const zones = new Map<string, Zone>()

export function deviceZoneName(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

export function zoneFor(name: string | null): Zone {
  if (name && isValidZoneName(name)) {
    let z = zones.get(name)
    if (!z) {
      z = ianaZone(name)
      zones.set(name, z)
    }
    return z
  }
  return fixedZone(-new Date().getTimezoneOffset())
}

/** The owner's zone for display. */
export function useViewerZone(): Zone {
  const override = useStore((s) => s.settings?.profile.timeZone || '')
  return zoneFor(override || deviceZoneName())
}

export function useClock(): '24h' | '12h' {
  return useStore((s) => s.settings?.profile.clock ?? '24h')
}
