/**
 * Effective Star appearance on this device (pure): synced settings (`appearance.star`, `appearance.reduceMotion`) +
 * DevicePrefs overrides (07 D8) + device facts (phone, OS reduced motion). Phones never draw an avatar in WebGL by
 * default: Armilla (the v1.1 default) stays Armilla in its 2D twin there (PresenceHost), the other styles fall back to
 * `minimal2d` as in 1.0; like the desktop they show it behind the chat. A preference set on the phone wins over both.
 */
import type { PresencePrefs, StarQuality, StarStyle } from '../../lib/store/presence.logic'

export interface StarSettings {
  style: StarStyle
  quality: StarQuality
  showInChat: boolean
  pauseWhenUnfocused: boolean
  maxFps: number
  /** v1.1.3: how strongly the avatar shows behind the chat (0.5–2, 1 = the 1.1 look; backdrop.logic clamps the cap). */
  visibility: number
  /** v1.1.3: its size there (0.8–1.2). */
  size: number
}

export interface EffectiveStar extends StarSettings {
  reducedMotion: boolean
  phone: boolean
  /** Device pixel ratio cap for the canvas (research 07 §2.6: 2 desktop, 1.5 phones; low quality 1). */
  dprCap: number
}

export const DEFAULT_STAR: StarSettings = { style: 'armilla', quality: 'high', showInChat: true, pauseWhenUnfocused: true, maxFps: 60, visibility: 1, size: 1 }

export interface DeviceFacts {
  phone: boolean
  osReducedMotion: boolean
  /** Settings → Appearance → Reduce motion (synced). */
  appReducedMotion: boolean
}

export function resolveStar(settings: Partial<StarSettings> | null | undefined, prefs: PresencePrefs, device: DeviceFacts): EffectiveStar {
  const s: StarSettings = { ...DEFAULT_STAR, ...(settings ?? {}) }
  const style = prefs.style ?? (device.phone ? (s.style === 'armilla' ? 'armilla' : 'minimal2d') : s.style)
  const quality = prefs.quality ?? (device.phone && s.quality === 'high' ? 'medium' : s.quality)
  // v11: behind the messages the avatar costs a phone no room (the old band did), so phones follow the setting too.
  const showInChat = prefs.showInChat ?? s.showInChat
  const pauseWhenUnfocused = prefs.pauseWhenUnfocused ?? s.pauseWhenUnfocused
  const motion = prefs.motion ?? 'system'
  const reducedMotion = motion === 'reduced' ? true : motion === 'full' ? false : device.appReducedMotion || device.osReducedMotion
  const maxFps = clampFps(s.maxFps)
  const dprCap = quality === 'low' ? 1 : device.phone ? 1.5 : 2
  const visibility = clampNum(s.visibility, 0.5, 2, 1)
  const size = clampNum(s.size, 0.8, 1.2, 1)
  return { style, quality, showInChat, pauseWhenUnfocused, maxFps, visibility, size, reducedMotion, phone: device.phone, dprCap }
}

function clampNum(n: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

function clampFps(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STAR.maxFps
  return Math.min(120, Math.max(15, Math.round(n)))
}

/** Whether a style draws with WebGL (the one canvas, 07 D5) where WebGL is used (not on phones for Armilla). */
export function isGlStyle(style: StarStyle): boolean {
  return style === 'armilla' || style === 'orb' || style === 'nebula'
}

/** Armilla draws in 2D (SVG) on phones and without WebGL (07 D8); the other WebGL styles fall back to `minimal2d`. */
export function drawsIn2d(style: StarStyle, phone: boolean, webgl: boolean): boolean {
  if (style === 'minimal2d') return true
  if (!isGlStyle(style)) return false
  return !webgl || (style === 'armilla' && phone)
}
