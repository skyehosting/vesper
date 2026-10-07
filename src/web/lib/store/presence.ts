/**
 * The Star's state (02 §7 state machine) and the presence-only device preferences; presence drives its visuals from
 * here. `star` is derived by features/presence/driver.ts from the reply, voice and connection state; other features
 * read it (avatars mirroring the state, Talk mode captions) and never need to set it.
 */
import { parsePresencePrefs, type PresencePrefs, type StarState, type WebglStatus } from './presence.logic'
import type { SliceCreator } from './types'

export * from './presence.logic'

export interface PresenceSlice {
  presence: {
    star: StarState
    /** The visible "pause animation" control (07 D9, WCAG 2.2.2). Remembered on this device. */
    paused: boolean
    prefs: PresencePrefs
    webgl: WebglStatus
  }
  setStarState(star: StarState): void
  setStarPaused(paused: boolean): void
  setPresencePrefs(patch: PresencePrefs): void
  setWebglStatus(webgl: WebglStatus): void
}

const PREFS_KEY = 'vesper.devicePrefs.presence'
const PAUSED_KEY = 'vesper.starPaused'

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
}

export const createPresenceSlice: SliceCreator<PresenceSlice> = (set) => ({
  presence: {
    star: 'idle',
    paused: readJson(PAUSED_KEY) === true,
    prefs: parsePresencePrefs(readJson(PREFS_KEY)),
    webgl: 'unknown'
  },
  setStarState: (star) => set((s) => (s.presence.star === star ? {} : { presence: { ...s.presence, star } })),
  setStarPaused: (paused) => {
    write(PAUSED_KEY, paused ? 'true' : null)
    set((s) => ({ presence: { ...s.presence, paused } }))
  },
  setPresencePrefs: (patch) =>
    set((s) => {
      const merged: PresencePrefs = { ...s.presence.prefs, ...patch }
      // `undefined` in a patch means "follow Settings again".
      for (const k of Object.keys(merged) as (keyof PresencePrefs)[]) if (merged[k] === undefined) delete merged[k]
      const prefs = parsePresencePrefs(merged)
      write(PREFS_KEY, Object.keys(prefs).length ? JSON.stringify(prefs) : null)
      return { presence: { ...s.presence, prefs } }
    }),
  setWebglStatus: (webgl) => set((s) => (s.presence.webgl === webgl ? {} : { presence: { ...s.presence, webgl } }))
})
