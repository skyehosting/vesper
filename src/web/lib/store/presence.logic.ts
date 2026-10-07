/**
 * Presence types and pure helpers (no store import, so unit tests and *.logic.ts files can use them). The slice in
 * ./presence.ts re-exports everything here.
 */
export type StarState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'preparing-voice'
  | 'speaking'
  | 'muted'
  /** The speech model is loading (Talk mode opened, mic armed): 07 D6 `warming-up`. */
  | 'warming-up'
  | 'error'
  | 'offline'

export type StarStyle = 'armilla' | 'orb' | 'nebula' | 'minimal2d' | 'off'
export type StarQuality = 'low' | 'medium' | 'high'
export type StarMotion = 'system' | 'full' | 'reduced'

/**
 * DevicePrefs for the presence (07 D8): per origin, client-side, overriding the synced appearance settings on this
 * device only (a phone keeps a 2D style while the desktop draws in WebGL). Unset = follow Settings.
 */
export interface PresencePrefs {
  style?: StarStyle
  quality?: StarQuality
  showInChat?: boolean
  pauseWhenUnfocused?: boolean
  motion?: StarMotion
}

/** WebGL availability for the one canvas (07 D5): `lost` while a context loss is being restored. */
export type WebglStatus = 'unknown' | 'ok' | 'unavailable' | 'lost'

const STYLES: readonly StarStyle[] = ['armilla', 'orb', 'nebula', 'minimal2d', 'off']
const QUALITIES: readonly StarQuality[] = ['low', 'medium', 'high']
const MOTIONS: readonly StarMotion[] = ['system', 'full', 'reduced']

/** Parse stored prefs defensively (another version or a hand edit may have left anything there). */
export function parsePresencePrefs(raw: unknown): PresencePrefs {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: PresencePrefs = {}
  if (STYLES.includes(r.style as StarStyle)) out.style = r.style as StarStyle
  if (QUALITIES.includes(r.quality as StarQuality)) out.quality = r.quality as StarQuality
  if (typeof r.showInChat === 'boolean') out.showInChat = r.showInChat
  if (typeof r.pauseWhenUnfocused === 'boolean') out.pauseWhenUnfocused = r.pauseWhenUnfocused
  if (MOTIONS.includes(r.motion as StarMotion)) out.motion = r.motion as StarMotion
  return out
}
