/**
 * The device's voice preferences in localStorage (07 D8), as a tiny external store:
 *
 *   const prefs = useVoicePrefs()          // re-renders on change (also from other tabs)
 *   setVoicePrefs({ micDeviceId: id })
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_VOICE_PREFS, parseVoicePrefs, VOICE_PREFS_KEY, type VoiceDevicePrefs } from './prefs.logic'

let current: VoiceDevicePrefs | null = null
const listeners = new Set<() => void>()
let storageWired = false

function read(): VoiceDevicePrefs {
  try {
    return parseVoicePrefs(window.localStorage.getItem(VOICE_PREFS_KEY))
  } catch {
    // Storage blocked (privacy mode): defaults, kept in memory only.
    return { ...DEFAULT_VOICE_PREFS }
  }
}

function wireStorage(): void {
  if (storageWired) return
  storageWired = true
  // Page-lifetime listener (one per page): another tab changed the prefs.
  window.addEventListener('storage', (e) => {
    if (e.key !== VOICE_PREFS_KEY) return
    current = read()
    for (const l of [...listeners]) l()
  })
}

export function getVoicePrefs(): VoiceDevicePrefs {
  current ??= read()
  return current
}

export function setVoicePrefs(patch: Partial<VoiceDevicePrefs>): void {
  const next = { ...getVoicePrefs(), ...patch }
  current = next
  try {
    window.localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next))
  } catch {
    /* in memory only */
  }
  for (const l of [...listeners]) l()
}

export function subscribeVoicePrefs(cb: () => void): () => void {
  wireStorage()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Listener count (leak checks). */
export function voicePrefsListeners(): number {
  return listeners.size
}

export function useVoicePrefs(): VoiceDevicePrefs {
  return useSyncExternalStore(subscribeVoicePrefs, getVoicePrefs, getVoicePrefs)
}

export type { VoiceDevicePrefs } from './prefs.logic'
