/**
 * The Star's visual language as numbers (pure; research 07 §2.4, 04 accents, 07 D9). Each state is a target vector of
 * look parameters; the renderer eases toward it (300–600 ms crossfades, never a shader switch). Audio adds on top,
 * through two safety valves for WCAG 2.3.1: audio-driven brightness never moves more than 15 % and onset pulses fire
 * at most 3 times a second.
 */
import type { StarState } from '../../lib/store/presence.logic'

export type Rgb = readonly [number, number, number]

/** Per-accent colours (04 "Accents"): core, body (the accent), corona, rim, and the listening hue (the user's voice). */
export interface StarPalette {
  core: Rgb
  body: Rgb
  corona: Rgb
  rim: Rgb
  mic: Rgb
}

export type AccentId = 'gold' | 'violet' | 'rose' | 'aurora' | 'ice'

export const PALETTES: Record<AccentId, StarPalette> = {
  // warm white-gold core, violet-rose corona
  gold: { core: [1.0, 0.95, 0.84], body: [0.96, 0.7, 0.3], corona: [0.74, 0.38, 0.72], rim: [1.0, 0.8, 0.52], mic: [0.42, 0.86, 0.92] },
  // lilac core, indigo corona
  violet: { core: [0.95, 0.91, 1.0], body: [0.65, 0.54, 0.98], corona: [0.32, 0.28, 0.86], rim: [0.82, 0.74, 1.0], mic: [0.44, 0.9, 0.82] },
  // pink core, plum corona
  rose: { core: [1.0, 0.88, 0.91], body: [0.98, 0.44, 0.52], corona: [0.56, 0.2, 0.52], rim: [1.0, 0.66, 0.72], mic: [0.48, 0.84, 0.96] },
  // mint core, teal corona
  aurora: { core: [0.88, 1.0, 0.94], body: [0.2, 0.83, 0.6], corona: [0.08, 0.5, 0.6], rim: [0.6, 1.0, 0.84], mic: [0.68, 0.7, 1.0] },
  // blue-white core, cyan corona
  ice: { core: [0.92, 0.97, 1.0], body: [0.49, 0.83, 0.99], corona: [0.12, 0.58, 0.8], rim: [0.76, 0.94, 1.0], mic: [1.0, 0.8, 0.5] }
}

export function paletteFor(accent: string | null | undefined): StarPalette {
  return PALETTES[(accent ?? 'gold') as AccentId] ?? PALETTES.gold
}

/** Look parameters (one float each). */
export const LOOK_KEYS = ['energy', 'swirl', 'noise', 'gather', 'saturation', 'error', 'ring', 'voice', 'throb'] as const
export type LookKey = (typeof LOOK_KEYS)[number]
export type Look = Record<LookKey, number>

/**
 * energy: base brightness · swirl: surface/flow speed · noise: displacement amount · gather: motes' orbit radius
 * (thinking pulls them in) · saturation: 1 normal, low = desaturated (muted, offline) · error: red-tinted rim ·
 * ring: the listening halo · voice: how much the output audio drives the shape · throb: the slow thinking glow.
 */
export const STATE_LOOK: Record<StarState, Look> = {
  idle: { energy: 0.82, swirl: 0.25, noise: 0.5, gather: 1.0, saturation: 1, error: 0, ring: 0, voice: 0, throb: 0 },
  listening: { energy: 0.88, swirl: 0.32, noise: 0.5, gather: 1.06, saturation: 1, error: 0, ring: 1, voice: 0, throb: 0 },
  transcribing: { energy: 0.9, swirl: 0.75, noise: 0.38, gather: 0.82, saturation: 1, error: 0, ring: 0.45, voice: 0, throb: 0.35 },
  thinking: { energy: 0.94, swirl: 1.25, noise: 0.6, gather: 0.58, saturation: 1, error: 0, ring: 0, voice: 0, throb: 1 },
  'preparing-voice': { energy: 1.02, swirl: 0.95, noise: 0.45, gather: 0.42, saturation: 1, error: 0, ring: 0, voice: 0, throb: 0.6 },
  speaking: { energy: 1.0, swirl: 0.55, noise: 0.55, gather: 1.1, saturation: 1, error: 0, ring: 0, voice: 1, throb: 0 },
  muted: { energy: 0.62, swirl: 0.15, noise: 0.25, gather: 1.0, saturation: 0.35, error: 0, ring: 0, voice: 0, throb: 0 },
  'warming-up': { energy: 0.74, swirl: 0.6, noise: 0.35, gather: 0.78, saturation: 0.8, error: 0, ring: 0.3, voice: 0, throb: 0.5 },
  error: { energy: 0.7, swirl: 0.2, noise: 0.3, gather: 1.0, saturation: 0.7, error: 1, ring: 0, voice: 0, throb: 0 },
  offline: { energy: 0.45, swirl: 0.1, noise: 0.2, gather: 1.0, saturation: 0.2, error: 0, ring: 0, voice: 0, throb: 0 }
}

export function createLook(state: StarState = 'idle'): Look {
  return { ...STATE_LOOK[state] }
}

/** Crossfade time constant: ~95 % of the way in 3τ ≈ 450 ms (research 07: 300–600 ms). */
export const LOOK_TAU_S = 0.15

/** Ease `look` toward the state's target in place (frame-rate independent). Returns true while still moving. */
export function stepLook(look: Look, state: StarState, dt: number, tau = LOOK_TAU_S): boolean {
  const target = STATE_LOOK[state]
  const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau)
  let moving = false
  for (const key of LOOK_KEYS) {
    const d = target[key] - look[key]
    if (Math.abs(d) > 0.002) moving = true
    look[key] = Math.abs(d) < 1e-4 ? target[key] : look[key] + d * k
  }
  return moving
}

/** The most audio may change the Star's brightness (WCAG 2.3.1 / 07 D9). */
export const MAX_AUDIO_BRIGHTNESS = 0.15
/** Minimum spacing between visual pulses: ≤ 3 per second (07 D9). */
export const MIN_PULSE_GAP_MS = 334
const PULSE_DECAY_S = 0.14

/**
 * Turns the analyser's onset signal into visual pulses that respect the flash limits. `onset` from audio-core is
 * already a decaying impulse; we fire on its rising edge only, at most every MIN_PULSE_GAP_MS.
 */
export class PulseLimiter {
  pulse = 0
  private lastFire = -Infinity
  private prevOnset = 0
  fired = 0

  step(onset: number, nowMs: number, dt: number): number {
    this.pulse *= dt > 0 ? Math.exp(-dt / PULSE_DECAY_S) : 1
    const rising = onset > 0.55 && onset > this.prevOnset + 0.05
    this.prevOnset = onset
    if (rising && nowMs - this.lastFire >= MIN_PULSE_GAP_MS) {
      this.lastFire = nowMs
      this.pulse = 1
      this.fired++
    }
    return this.pulse
  }

  reset(): void {
    this.pulse = 0
    this.prevOnset = 0
    this.lastFire = -Infinity
  }
}

/** Brightness multiplier from audio: 1 … 1 + MAX_AUDIO_BRIGHTNESS. */
export function audioBrightness(env: number, pulse: number): number {
  const t = Math.min(1, Math.max(0, env * 1.4 + pulse * 0.35))
  return 1 + MAX_AUDIO_BRIGHTNESS * t
}

/** The thinking glow: a 1.2 Hz swell (research 07 §2.4) of at most ±6 % brightness — well under the flash limit. */
export function throbBrightness(timeS: number, throb: number): number {
  return 1 + 0.06 * throb * Math.sin(timeS * Math.PI * 2 * 1.2)
}

/**
 * Critically damped spring (research 07 §2.3) for the orb's scale: organic swell with no overshoot. Mutates `s`.
 */
export interface Spring {
  x: number
  v: number
}

export function stepSpring(s: Spring, target: number, dt: number, stiffness = 90): void {
  if (dt <= 0) return
  const c = 2 * Math.sqrt(stiffness)
  // Sub-step long frames so a 1 s gap (tab came back) cannot explode.
  let left = Math.min(dt, 0.25)
  while (left > 0) {
    const h = Math.min(left, 1 / 120)
    const a = stiffness * (target - s.x) - c * s.v
    s.v += a * h
    s.x += s.v * h
    left -= h
  }
}

/** Mix an RGB colour toward its luminance (saturation 0 = grey). */
export function desaturate(c: Rgb, saturation: number, out: [number, number, number]): [number, number, number] {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  out[0] = l + (c[0] - l) * saturation
  out[1] = l + (c[1] - l) * saturation
  out[2] = l + (c[2] - l) * saturation
  return out
}
