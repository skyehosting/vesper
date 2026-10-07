/**
 * Armilla — a resonant armillary (pure; no three, no DOM). The numbers behind the avatar:
 *
 *   - three nested gimbal rings (outer → inner) with a liquid-light bead at the centre, and a wide horizon ring that is
 *     seen almost edge-on: the horizontal line. The horizon is the audio visualizer — its front is a live oscilloscope
 *     of the REAL voice (v1.1.5): every frame the current window of the audio, standing still (triggered), the AI's in
 *     its colour and one output latency late (as heard), the owner's (mic) in theirs.
 *   - each state is a target vector of look weights (crossfaded, never switched) plus a gimbal drive: idle precesses,
 *     listening turns every ring to face the viewer (an ear), thinking spins the gimbals at commensurate rates,
 *     speaking settles into an open "presenting" pose.
 *   - only the horizon shows the voice (owner, v1.1: "only the main ring should display the audio wave"): the gimbals
 *     keep spinning and turning in every state (a slow counter-turn while the AI speaks), but no audio level ever
 *     displaces, brightens or flickers them: `gimbalRadius` and `ringFrame`'s gimbal outputs have no audio input, and
 *     the GL ring shader has no audio term for them. The bead may still answer the voice (its liquid, its halo).
 *   - the oscilloscope (`Scope`): the analyser's time-domain samples, triggered, resampled, normalised, delayed by a
 *     ring of recent frames, written as a small RGBA8 texture the shader reads across the horizon's front.
 *
 * Flash safety (07 D9) reuses visual.logic: audio brightness ≤ 15 %, ≤ 3 onset pulses per second.
 */
import type { StarState } from '../../../../../lib/store/presence.logic'
import { audioBrightness, type Rgb, type StarPalette } from '../../../visual.logic'

/** Look weights (one float each), eased toward the state's target. */
export const ARM_KEYS = ['energy', 'saturation', 'error', 'face', 'spin', 'voice', 'ring', 'throb', 'sweep', 'gather', 'calm'] as const
export type ArmKey = (typeof ARM_KEYS)[number]
export type ArmLook = Record<ArmKey, number>

/**
 * energy: base brightness · saturation: 1 normal, low = muted/offline · error: red-tinted bead rim ·
 * face: gimbals turn to face the viewer (listening) · spin: purposeful gimbal rotation (thinking) ·
 * voice: the AI's audio drives the horizon and the bead · ring: the mic drives the horizon and the bead's ripples ·
 * throb: the slow 1.2 Hz thinking glow · sweep: a scanning light runs the horizon and rings ·
 * gather: rings draw in toward the bead (preparing a voice) · calm: 1 = everything slows (muted/offline).
 */
export const ARM_LOOK: Record<StarState, ArmLook> = {
  idle: { energy: 0.86, saturation: 1, error: 0, face: 0, spin: 0, voice: 0, ring: 0, throb: 0, sweep: 0, gather: 0, calm: 0 },
  listening: { energy: 0.92, saturation: 1, error: 0, face: 1, spin: 0, voice: 0, ring: 1, throb: 0, sweep: 0, gather: 0, calm: 0 },
  transcribing: { energy: 0.92, saturation: 1, error: 0, face: 0.75, spin: 0.25, voice: 0, ring: 0.35, throb: 0.35, sweep: 0.6, gather: 0.15, calm: 0 },
  thinking: { energy: 0.95, saturation: 1, error: 0, face: 0, spin: 1, voice: 0, ring: 0, throb: 1, sweep: 1, gather: 0.1, calm: 0 },
  'preparing-voice': { energy: 1.0, saturation: 1, error: 0, face: 0, spin: 0.45, voice: 0, ring: 0, throb: 0.6, sweep: 0.5, gather: 0.6, calm: 0 },
  speaking: { energy: 1.0, saturation: 1, error: 0, face: 0, spin: 0, voice: 1, ring: 0, throb: 0, sweep: 0, gather: 0, calm: 0 },
  muted: { energy: 0.6, saturation: 0.3, error: 0, face: 0.8, spin: 0, voice: 0, ring: 0, throb: 0, sweep: 0, gather: 0, calm: 1 },
  'warming-up': { energy: 0.78, saturation: 0.8, error: 0, face: 0.5, spin: 0.2, voice: 0, ring: 0.3, throb: 0.5, sweep: 0.4, gather: 0.2, calm: 0 },
  error: { energy: 0.7, saturation: 0.6, error: 1, face: 0, spin: 0, voice: 0, ring: 0, throb: 0, sweep: 0, gather: 0, calm: 0.6 },
  offline: { energy: 0.45, saturation: 0.15, error: 0, face: 0, spin: 0, voice: 0, ring: 0, throb: 0, sweep: 0, gather: 0, calm: 1 }
}

const REST_LOOK: ArmLook = { ...ARM_LOOK.idle }

export function createArmLook(state: StarState = 'idle'): ArmLook {
  return { ...ARM_LOOK[state] }
}

/** Crossfade time constants (s): most weights ~450 ms (research 07: 300–600 ms); the gimbals' pose a little slower. */
export const ARM_TAU_S = 0.15
const SLOW_KEYS: ReadonlySet<ArmKey> = new Set<ArmKey>(['face', 'gather', 'spin'])
const SLOW_TAU_S = 0.28

/** Ease `look` toward the state's target in place (frame-rate independent). Returns true while still moving. */
export function stepArmLook(look: ArmLook, state: StarState, dt: number): boolean {
  const target = ARM_LOOK[state]
  let moving = false
  for (const key of ARM_KEYS) {
    const tau = SLOW_KEYS.has(key) ? SLOW_TAU_S : ARM_TAU_S
    const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau)
    const d = target[key] - look[key]
    if (Math.abs(d) > 0.002) moving = true
    look[key] = Math.abs(d) < 1e-4 ? target[key] : look[key] + d * k
  }
  return moving
}

// ── Gimbals ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Gimbal pose: a0 turns the outer ring about the vertical axis, a1 tilts the middle ring about the outer ring's
 * horizontal diameter, a2 turns the inner ring about the middle ring's vertical diameter (CSS / three both compose
 * Ry(a0)·Rx(a1)·Ry(a2) for the inner ring). All zero = every ring faces the viewer.
 */
export interface Gimbals {
  /** Free-running phases (rad), integrated from the drive velocities. */
  p0: number
  p1: number
  p2: number
  /** Shown angles (rad) and their velocities (critically damped springs toward the targets). */
  a0: number
  a1: number
  a2: number
  v0: number
  v1: number
  v2: number
}

/** The resting pose (rad offsets added to the phases) and the speaking pose. */
export const IDLE_POSE = { a0: 0.62, a1: 0.4, a2: 1.12 } as const
export const SPEAK_POSE = { a0: 0.38, a1: 0.22, a2: 1.34 } as const
/** Drive velocities (rad/s): idle precession, and thinking's commensurate 2 : 3 : 4 spin (re-aligns every ~10 s). */
export const IDLE_RATE = { r0: 0.07, r1: 0.0, r2: 0.0 } as const
export const THINK_RATE = { r0: 0.21, r1: 0.42, r2: 0.63 } as const
/**
 * Speaking: the middle and inner gimbals keep turning against each other (rad/s), weighted by the speaking LOOK
 * (the state, crossfaded) — never by the signal level (owner, v1.1: "still have them spin and rotate").
 */
export const SPEAK_RATE = { r1: 0.1, r2: -0.16 } as const
/** Spring stiffness for the pose: ω = √k ≈ 4.5 rad/s, settles in ~1 s — gimbals with a little inertia. */
export const GIMBAL_K = 20

export function createGimbals(): Gimbals {
  return { p0: 0, p1: 0, p2: 0, a0: IDLE_POSE.a0, a1: IDLE_POSE.a1, a2: IDLE_POSE.a2, v0: 0, v1: 0, v2: 0 }
}

/** Nearest multiple of π (a ring turned half a turn about a diameter is the same ring). */
export function nearestHalfTurn(x: number): number {
  return Math.round(x / Math.PI) * Math.PI
}

/** The gimbals' target angles for a look (pure; used by both the GL and the 2D renderers). */
export function gimbalTargets(g: Gimbals, look: ArmLook, nod: number): [number, number, number] {
  const v = look.voice
  const face = look.face
  const off0 = IDLE_POSE.a0 + (SPEAK_POSE.a0 - IDLE_POSE.a0) * v
  const off1 = IDLE_POSE.a1 + (SPEAK_POSE.a1 - IDLE_POSE.a1) * v + nod
  const off2 = IDLE_POSE.a2 + (SPEAK_POSE.a2 - IDLE_POSE.a2) * v
  const t0 = mix(g.p0 + off0, nearestHalfTurn(g.p0 + off0), face)
  const t1 = mix(g.p1 + off1, nearestHalfTurn(g.p1 + off1), face)
  const t2 = mix(g.p2 + off2, nearestHalfTurn(g.p2 + off2), face)
  return [t0, t1, t2]
}

/**
 * Advance the gimbals by dt. `motion` 0 (reduced motion) freezes the phases and snaps to the targets (no rotation);
 * returns true while the springs still move (the scheduler keeps drawing).
 */
export function stepGimbals(g: Gimbals, look: ArmLook, dt: number, motion: number, nod = 0): boolean {
  if (dt <= 0) return false
  const slow = 1 - 0.85 * look.calm
  const free = (1 - look.face) * slow * motion
  g.p0 += dt * free * (IDLE_RATE.r0 + (THINK_RATE.r0 - IDLE_RATE.r0) * look.spin)
  g.p1 += dt * free * (THINK_RATE.r1 * look.spin + SPEAK_RATE.r1 * look.voice)
  g.p2 += dt * free * (THINK_RATE.r2 * look.spin + SPEAK_RATE.r2 * look.voice)
  // Homing: as the spin (or the speaking turn) winds down, the gimbals come back to their pose (a half turn is the
  // same pose), so every state after thinking or speaking looks the same as before it — a mechanical settle.
  const home = 1 - Math.exp(-dt * 1.6 * (1 - Math.max(look.spin, look.voice)))
  g.p1 += (nearestHalfTurn(g.p1) - g.p1) * home
  g.p2 += (nearestHalfTurn(g.p2) - g.p2) * home
  // Keep the phases small (the poses repeat every half turn), without moving what is shown.
  for (const k of ['0', '1', '2'] as const) {
    const pk = `p${k}` as const
    const ak = `a${k}` as const
    if (Math.abs(g[pk]) > Math.PI * 8) {
      const shift = nearestHalfTurn(g[pk])
      g[pk] -= shift
      g[ak] -= shift
    }
  }
  // Reduced motion: the instrument keeps its resting pose in every state (no rotation, no snapping); states show
  // through brightness and colour only (07 D9).
  const [t0, t1, t2] = gimbalTargets(g, motion === 0 ? REST_LOOK : look, nod * motion)
  if (motion === 0) {
    g.a0 = t0
    g.a1 = t1
    g.a2 = t2
    g.v0 = g.v1 = g.v2 = 0
    return false
  }
  const c = 2 * Math.sqrt(GIMBAL_K)
  let left = Math.min(dt, 0.25)
  while (left > 0) {
    const h = Math.min(left, 1 / 120)
    g.v0 += (GIMBAL_K * (t0 - g.a0) - c * g.v0) * h
    g.v1 += (GIMBAL_K * (t1 - g.a1) - c * g.v1) * h
    g.v2 += (GIMBAL_K * (t2 - g.a2) - c * g.v2) * h
    g.a0 += g.v0 * h
    g.a1 += g.v1 * h
    g.a2 += g.v2 * h
    left -= h
  }
  // "Moving" means a pose change still settling — not the ambient precession (a spring following the slow drift lags
  // it by ~0.03 rad forever), so an idle armillary can still come to rest at 0 fps (07 D4).
  const err = Math.abs(t0 - g.a0) + Math.abs(t1 - g.a1) + Math.abs(t2 - g.a2)
  return err > 0.06
}

/** Gimbal radii (world units), outer → inner; the bead's radius (both renderers). */
export const R_GIMBAL = [0.66, 0.585, 0.51] as const
export const R_BEAD = 0.235
/** The bead's resting liquid level (bead radii below the equator): the meniscus sits just under the horizon line. */
export const REST_LEVEL = -0.12

/** Ring gains at full strength (the hero, Talk mode) and behind text: constant per mode, never audio-driven. */
const GAIN_FULL = [1, 0.62, 0.56, 0.5] as const
const GAIN_BEHIND = [1, 0.55, 0.5, 0.45] as const
/** While the AI speaks the horizon (only) leads by +25 %, crossfaded on the speaking look. */
export const HORIZON_SPEAK_LIFT = 0.25
/** The pivot jewels' glow: constant (the pins belong to the gimbals). */
export const JEWEL_GLOW = 0.3

export interface RingFrame {
  /** Horizon brightness: energy × the voice (≤ 15 %, ≤ 3 onsets/s via the caller's PulseLimiter) × the throb. */
  brightHorizon: number
  /** Gimbal (and jewel) brightness: energy × the throb — no audio term. */
  brightGimbal: number
  /** uRingGain: [horizon, outer, middle, inner]. */
  gains: [number, number, number, number]
}

export function createRingFrame(): RingFrame {
  return { brightHorizon: 1, brightGimbal: 1, gains: [1, 1, 1, 1] }
}

/**
 * The rings' brightness and gains this frame (both renderers). `env` / `micEnv` are the voice envelopes, `pulse` the
 * limited onset pulse, `throb` the thinking swell, `behind` 0 (full) … 1 (behind the chat's text). Only the horizon
 * reads the audio; the gimbals' outputs are the same for any level and any onset (owner, v1.1).
 */
export function ringFrame(out: RingFrame, look: ArmLook, env: number, micEnv: number, pulse: number, throb: number, behind: number): RingFrame {
  out.brightHorizon = look.energy * audioBrightness(env * look.voice + micEnv * look.ring * 0.5, pulse * look.voice) * throb
  out.brightGimbal = look.energy * throb
  for (let i = 0; i < 4; i++) out.gains[i] = GAIN_FULL[i] + (GAIN_BEHIND[i] - GAIN_FULL[i]) * behind
  out.gains[0] *= 1 + HORIZON_SPEAK_LIFT * look.voice
  return out
}

/**
 * A gimbal's radius this frame (both renderers): drawn in a little while preparing (gather), a slow 0.2 Hz breath at
 * rest. Deliberately no audio input — the voice moves the horizon only (owner, v1.1); while the AI speaks or the owner
 * is heard the breath is off too, so the gimbals hold a true circle and only turn.
 */
export function gimbalRadius(i: 0 | 1 | 2, look: ArmLook, nowS: number, motion: number): number {
  const gather = 1 - 0.1 * look.gather
  const breath = motion * (1 - look.voice) * (1 - look.ring) * 0.012 * Math.sin(nowS * Math.PI * 2 * 0.2)
  return R_GIMBAL[i] * (gather + breath)
}

// ── The voice oscilloscope (the horizon's front) ──────────────────────────────────────────────────

/*
 * Owner, v1.1.5: "I was hoping instead of them moving left to right, it was more stationary … points within the front
 * of the ring create curves going up and some down depending on the voice / media coming through." The horizon's
 * front (left end → right end) is a live oscilloscope of the audio that is playing: every frame it shows the current
 * SCOPE_WINDOW_S of the real waveform (the analyser's time-domain samples — the decoded TTS chunk, or the microphone;
 * AnalyserLevels.samples()), triggered on a rising zero crossing so a steady sound stands still, resampled to SCOPE_N
 * points, lightly smoothed, normalised by a peak-hold envelope and tapered to zero at both ends. Nothing travels
 * sideways. The AI's frames are drawn late by the output latency (a ring of recent frames): the frame whose window
 * centre is what the speakers play now — the latency less the window's own lag behind the analyser's newest sample —
 * so the curves match what is heard; the owner's (the mic) as they come. Silence draws a calm, flat ring.
 */

/** Points across the front (left end → right end): the shape's resolution and the texture's width. */
export const SCOPE_N = 128
/** The window shown: a few pitch periods (≈ 4 of a 120 Hz voice, 8 of a 220 Hz one). */
export const SCOPE_WINDOW_S = 0.035
/** How far back from the newest full window a trigger may lie (one period of a 50 Hz voice). */
export const SCOPE_SEARCH_S = 0.02
/** The window ends at least this far before the newest sample (clear of the zero-phase filter's edge). */
export const SCOPE_MARGIN_S = 0.002
/** A frame's lag behind the analyser's newest sample (its window centre) when it has no trigger of its own. */
export const SCOPE_NOMINAL_LAG_S = SCOPE_MARGIN_S + SCOPE_WINDOW_S / 2 + SCOPE_SEARCH_S / 2
/** Display smoothing: a zero-phase one-pole (forward, then backward: no lag, no phase shift) at this cut-off (Hz). */
export const SCOPE_LP_HZ = 1000
/** The trigger's own, lower low-pass (Hz): it finds the fundamental's crossings, not the harmonics'. */
export const SCOPE_TRIG_HZ = 300
/** Trigger hysteresis: a rising crossing counts only after the trigger signal dipped below −SCOPE_HYST × its peak. */
export const SCOPE_HYST = 0.12
/** The shape fades to 0 over the outer SCOPE_TAPER of the front at each end (it joins the still ring smoothly). */
export const SCOPE_TAPER = 0.14
/** A faint persistence: the drawn shape eases toward each new frame with this time constant (s). */
export const SCOPE_PERSIST_S = 0.012
/** Recent frames kept for the latency delay (≥ 0.25 s at 120 fps), and the longest delay honoured (s). */
export const SCOPE_RING = 32
export const SCOPE_MAX_DELAY_S = 0.25
/** The delay follows the engine's estimate slowly (that clock steps with the audio callbacks). */
export const SCOPE_DELAY_TAU_S = 0.4
/** Normalisation (per voice): the larger of the floor and the peak, held 0.6 s, then released over 1.2 s. */
export const WAVE_FLOOR = 0.06
export const WAVE_HOLD_S = 0.6
export const WAVE_RELEASE_S = 1.2
/** The drawn level (the line's brightness) is an envelope — attack / release (s) — never a per-frame flicker. */
const LEVEL_ATTACK_S = 0.03
const LEVEL_RELEASE_S = 0.25
/**
 * Swing at full scale: WAVE_AMP_PX CSS px, at most WAVE_AMP world units (the horizon's radius is 1.25; the ring is
 * ~0.28 tall on screen) — the curves keep the same proportions at every size, and small stages keep them inside the ring.
 */
export const WAVE_AMP = 0.07
export const WAVE_AMP_PX = 16

/** The swing (world units) for a stage drawn at `pxPerWorld` CSS px per world unit. */
export function waveAmp(pxPerWorld: number): number {
  return pxPerWorld > 0 ? Math.min(WAVE_AMP, WAVE_AMP_PX / pxPerWorld) : WAVE_AMP
}

/** The taper at u (0 = the left end … 1 = the right end): 0 at both ends, 1 across the middle. */
export function scopeTaper(u: number): number {
  return smoothstep(0, SCOPE_TAPER, u) * smoothstep(0, SCOPE_TAPER, 1 - u)
}

/** Zero-phase one-pole low-pass of x[0, n) into y: forward, then backward (no lag, so the trigger lands on the wave). */
function zeroPhase(x: ArrayLike<number>, y: Float32Array, n: number, k: number): void {
  let v = x[0]
  for (let i = 0; i < n; i++) {
    v += (x[i] - v) * k
    y[i] = v
  }
  v = y[n - 1]
  for (let i = n - 1; i >= 0; i--) {
    v += (y[i] - v) * k
    y[i] = v
  }
}

/**
 * One oscilloscope frame from `td` (time-domain samples, newest last) into `out` (SCOPE_N points, not yet normalised):
 * the latest SCOPE_WINDOW_S that starts on a rising zero crossing of the trigger signal (sub-sample; with hysteresis;
 * searched up to SCOPE_SEARCH_S back; free-running on the newest window when there is none — silence, hiss), read
 * from the zero-phase smoothed signal, [1 2 1] across the points, tapered to 0 at both ends. `lp` and `trig` are
 * scratch (≥ td.length); `at.lag` (optional) gets the window centre's lag behind the newest sample (s). Returns the
 * frame's peak |amplitude| (before the taper). Allocation-free.
 */
export function scopeFrame(td: ArrayLike<number>, rate: number, lp: Float32Array, trig: Float32Array, out: Float32Array, at?: { lag: number }): number {
  const n = Math.min(td.length, lp.length, trig.length)
  const N = out.length
  if (at) at.lag = SCOPE_NOMINAL_LAG_S
  if (n < 64 || N < 3 || !(rate > 0)) {
    out.fill(0)
    return 0
  }
  const W = Math.min(SCOPE_WINDOW_S * rate, n - 2)
  const margin = Math.min(Math.round(SCOPE_MARGIN_S * rate), n - 2 - Math.ceil(W))
  zeroPhase(td, lp, n, 1 - Math.exp((-2 * Math.PI * SCOPE_LP_HZ) / rate))
  zeroPhase(td, trig, n, 1 - Math.exp((-2 * Math.PI * SCOPE_TRIG_HZ) / rate))
  let tp = 0
  for (let i = 0; i < n; i++) {
    const m = trig[i] < 0 ? -trig[i] : trig[i]
    if (m > tp) tp = m
  }
  const h = SCOPE_HYST * tp
  const latest = Math.floor(n - 1 - W - Math.max(0, margin))
  const earliest = Math.max(1, latest - Math.round(SCOPE_SEARCH_S * rate))
  let start = latest
  if (tp > 1e-6)
    for (let i = latest; i >= earliest; i--) {
      if (!(trig[i - 1] < 0 && trig[i] >= 0)) continue
      // Armed: the half-period before this crossing went below −h (a harmonic's wiggle near zero does not count).
      let armed = false
      for (let j = i - 1; j >= 0 && trig[j] < 0; j--)
        if (trig[j] < -h) {
          armed = true
          break
        }
      if (armed) {
        start = i - 1 + trig[i - 1] / (trig[i - 1] - trig[i])
        break
      }
    }
  if (at) at.lag = (n - 1 - (start + W / 2)) / rate
  const step = W / (N - 1)
  for (let j = 0; j < N; j++) {
    const x = start + j * step
    const i0 = Math.floor(x)
    const f = x - i0
    out[j] = i0 + 1 < n ? lp[i0] * (1 - f) + lp[i0 + 1] * f : lp[n - 1]
  }
  let prev = out[0]
  let peak = 0
  for (let j = 1; j < N - 1; j++) {
    const cur = out[j]
    out[j] = (prev + 2 * cur + out[j + 1]) / 4
    prev = cur
    const m = out[j] < 0 ? -out[j] : out[j]
    if (m > peak) peak = m
  }
  for (let j = 0; j < N; j++) out[j] *= scopeTaper(j / (N - 1))
  return peak
}

/**
 * The horizon's oscilloscope: a ring of the most recent frames (shape, time, lag, peak, who; preallocated), the one
 * whose audio is `delayS` old drawn — normalised per voice (peak-hold), weighted by the look, eased a little (persistence) — as
 * SCOPE_N heights (`shape`) and as RGBA8 texture bytes (`data`, r = 128 ± 127; the shader's uScope). The renderers
 * call `step` once per frame; nothing in it allocates once the scratch is sized for the analyser.
 */
export class Scope {
  /** The drawn heights, −1…1 of full swing, left end → right end. */
  readonly shape = new Float32Array(SCOPE_N)
  readonly data = new Uint8Array(SCOPE_N * 4)
  /** Bumped when `data` changed (the GL side re-uploads the texture then). */
  version = 0
  /** Whose voice is drawn: 0 = the AI … 1 = the owner (eased; the colour). */
  who = 0
  /** The drawn voice's level, 0–1 (an envelope: the line's brightness). */
  level = 0
  /** The delay applied now (s): the AI's output latency, smoothed; 0 for the owner or when unknown. */
  delayS = 0
  /** How old the drawn audio is (s, its window centre; −1 = silence from before the history began). */
  drawnAge = -1
  /** True while a voice is drawn or still waiting for its turn (keep the frames coming); false once flat. */
  busy = false
  private readonly frames = new Float32Array(SCOPE_RING * SCOPE_N)
  private readonly views: Float32Array[] = []
  private readonly times = new Float64Array(SCOPE_RING)
  private readonly lags = new Float64Array(SCOPE_RING)
  private readonly at = { lag: 0 }
  private readonly peaks = new Float32Array(SCOPE_RING)
  private readonly whos = new Uint8Array(SCOPE_RING)
  private head = -1
  private count = 0
  private t = 0
  private born = 0
  private delayKnown = false
  private lp = new Float32Array(0)
  private trig = new Float32Array(0)
  private readonly norm = [WAVE_FLOOR, WAVE_FLOOR]
  private readonly hold = [0, 0]

  constructor() {
    for (let i = 0; i < SCOPE_RING; i++) this.views.push(this.frames.subarray(i * SCOPE_N, (i + 1) * SCOPE_N))
    this.clear()
  }

  /**
   * Advance by dt with the source's newest samples (null = nothing playing) at `rate`. `weight` 0–1 scales the voice
   * (the look's voice / ring weight); `who` 0 = the AI, 1 = the owner; `delayS` the output latency (the AI's frames
   * are drawn that late; the owner's never). Long gaps (a rest, a hidden tab) clear it.
   */
  step(dt: number, samples: ArrayLike<number> | null, rate: number, weight: number, who: 0 | 1, delayS: number): void {
    if (!(dt > 0)) return
    if (dt > 0.5) this.clear()
    this.t += dt
    // This frame, into the ring.
    const h = (this.head + 1) % SCOPE_RING
    this.head = h
    if (this.count === 0) this.born = this.t
    if (this.count < SCOPE_RING) this.count++
    let peak = 0
    let lag = SCOPE_NOMINAL_LAG_S
    if (samples && weight > 0) {
      // Sized once per analyser (fftSize), never per frame.
      if (this.lp.length < samples.length) {
        this.lp = new Float32Array(samples.length)
        this.trig = new Float32Array(samples.length)
      }
      peak = scopeFrame(samples, rate, this.lp, this.trig, this.views[h], this.at)
      lag = this.at.lag
    } else this.views[h].fill(0)
    this.times[h] = this.t
    this.lags[h] = lag
    this.peaks[h] = peak
    this.whos[h] = who
    // The delay: what the speakers play now left the analyser delayS ago.
    const want = who ? 0 : Math.min(SCOPE_MAX_DELAY_S, Math.max(0, Number.isFinite(delayS) ? delayS : 0))
    if (!this.delayKnown) {
      this.delayS = want
      this.delayKnown = true
    } else this.delayS += (want - this.delayS) * (1 - Math.exp(-dt / SCOPE_DELAY_TAU_S))
    // The frame whose window centre left the analyser delayS ago — what is heard now (its age: how long ago it was
    // taken plus its own lag behind the newest sample). The nearest; ties: the older. Asking for older audio than the
    // history holds (just after a clear): silence.
    let src = -1
    let best = Infinity
    for (let k = 0; k < this.count; k++) {
      const s = (h - k + SCOPE_RING) % SCOPE_RING
      const back = this.t - this.times[s]
      // Older frames are only further away (a lag is never negative).
      if (back - this.delayS > best) break
      const d = Math.abs(back + this.lags[s] - this.delayS)
      if (d <= best + 1e-9) {
        best = d
        src = s
      }
    }
    const oldest = (h - this.count + 1 + SCOPE_RING) % SCOPE_RING
    if (this.count < SCOPE_RING && this.delayS > this.t - this.born + this.lags[oldest] + Math.min(dt, 1 / 30) / 2) src = -1
    this.drawnAge = src < 0 ? -1 : this.t - this.times[src] + this.lags[src]
    const p = src < 0 ? 0 : this.peaks[src]
    const w = src < 0 ? who : (this.whos[src] as 0 | 1)
    // Normalise per voice: peak-hold, then a slow release down to the floor.
    if (p > this.norm[w]) {
      this.norm[w] = p
      this.hold[w] = WAVE_HOLD_S
    } else {
      let left = dt
      const held = Math.min(this.hold[w], left)
      this.hold[w] -= held
      left -= held
      if (left > 0) this.norm[w] = Math.max(WAVE_FLOOR, this.norm[w] * Math.exp(-left / WAVE_RELEASE_S))
    }
    const g = (weight > 0 ? Math.min(1, weight) : 0) / this.norm[w]
    // Ease the drawn shape toward that frame (a faint persistence; exact once within 1e-4: a steady tone stands still).
    const kp = 1 - Math.exp(-dt / SCOPE_PERSIST_S)
    const base = src * SCOPE_N
    let changed = false
    let drawn = false
    for (let j = 0; j < SCOPE_N; j++) {
      const raw = src < 0 ? 0 : this.frames[base + j] * g
      const v = raw < -1 ? -1 : raw > 1 ? 1 : raw
      const d = v - this.shape[j]
      const y = d > -1e-4 && d < 1e-4 ? v : this.shape[j] + d * kp
      this.shape[j] = y
      if (y !== 0) drawn = true
      const b = enc(y)
      if (this.data[j * 4] !== b) {
        this.data[j * 4] = b
        changed = true
      }
    }
    if (changed) this.version++
    const lv = Math.min(1, p * g)
    this.level += (lv - this.level) * (1 - Math.exp(-dt / (lv > this.level ? LEVEL_ATTACK_S : LEVEL_RELEASE_S)))
    if (lv === 0 && this.level < 0.01) this.level = 0
    this.who += (w - this.who) * (1 - Math.exp(-dt / 0.08))
    // Busy: a voice drawn, or a voiced frame not yet heard (still waiting for its turn).
    let queued = false
    for (let k = 0; k < this.count && !queued; k++) {
      const s = (h - k + SCOPE_RING) % SCOPE_RING
      if (this.t - this.times[s] + this.lags[s] < this.delayS - 1e-9 && this.peaks[s] > 0) queued = true
    }
    this.busy = drawn || queued || this.level > 0
  }

  clear(): void {
    this.frames.fill(0)
    this.shape.fill(0)
    for (let o = 0; o < this.data.length; o += 4) {
      this.data[o] = 128
      this.data[o + 1] = 0
      this.data[o + 2] = 0
      this.data[o + 3] = 0
    }
    this.head = -1
    this.count = 0
    this.delayKnown = false
    this.norm[0] = this.norm[1] = WAVE_FLOOR
    this.hold[0] = this.hold[1] = 0
    this.level = 0
    this.who = 0
    this.drawnAge = -1
    this.busy = false
    this.version++
  }

  /** True when the drawn line is flat (nothing to draw). */
  flat(): boolean {
    for (let o = 0; o < this.data.length; o += 4) if (this.data[o] !== 128) return false
    return true
  }
}

function enc(v: number): number {
  return 128 + Math.round((v < -1 ? -1 : v > 1 ? 1 : v) * 127)
}

/** The drawn bytes read at u (0 … 1 across the front) exactly as the shader's LINEAR, clamped texture read: −1…1. */
export function scopeAt(data: Uint8Array, u: number): number {
  const x = (u < 0 ? 0 : u > 1 ? 1 : u) * (SCOPE_N - 1)
  const i0 = Math.min(SCOPE_N - 2, Math.floor(x))
  const f = x - i0
  const a = data[i0 * 4]
  return (a + (data[(i0 + 1) * 4] - a) * f - 128) / 127
}

/**
 * Height of the horizon at ring angle `th` (world units: × `amp`, waveAmp; before the rest swell) — ONE source of truth
 * for both renderers; the GL shader's horizonY transliterates it (tested). The front half (sin th ≥ 0) carries the
 * oscilloscope: u = 0 at the left end (x = −R) … 1 at the right end, uniform in screen x (time runs evenly across);
 * the back half (behind the bead) stays still. `info` (optional) gets [who 0–1 (colour), live 0–1 (brightness)].
 */
export function horizonWave(scope: Scope, th: number, amp: number, info?: [number, number]): number {
  const front = Math.sin(th) < 0 ? 0 : 1
  const u = 0.5 + 0.5 * Math.cos(th)
  if (info) {
    info[0] = scope.who
    info[1] = Math.min(1, scope.level * 1.4) * scopeTaper(u) * front
  }
  return front ? scopeAt(scope.data, u) * amp : 0
}

// ── Colours ────────────────────────────────────────────────────────────────────────────────────────

/** The avatar's colours: light-emitting ones for the dark theme and "ink" ones for the light theme. */
export interface ArmColors {
  bead: Rgb
  ring: Rgb
  horizon: Rgb
  halo: Rgb
  mic: Rgb
  inkBead: Rgb
  inkRing: Rgb
  inkHorizon: Rgb
  inkMic: Rgb
}

/** A colour's "ink" twin for the light theme: the same hue at a set lightness, a little richer (HSL). */
export function inkOf(c: Rgb, lightness = 0.38, satBoost = 1.15): Rgb {
  const [h, sat] = hsl(c)
  return rgbOfHsl(h, Math.min(1, sat * satBoost), lightness)
}

function hsl(c: Rgb): [number, number, number] {
  const max = Math.max(c[0], c[1], c[2])
  const min = Math.min(c[0], c[1], c[2])
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0) : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4
  h /= 6
  return [h, s, l]
}

function rgbOfHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (u < 1 / 6) return p + (q - p) * 6 * u
    if (u < 1 / 2) return q
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
    return p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

export function armColors(p: StarPalette): ArmColors {
  return {
    bead: p.core,
    ring: p.body,
    horizon: p.rim,
    halo: p.corona,
    mic: p.mic,
    // Light theme: deep, saturated ink (gold → about #6b4a1e) — bronze lines, never a beige haze.
    inkBead: inkOf(p.body, 0.34, 1.3),
    inkRing: inkOf(p.body, 0.28, 1.4),
    inkHorizon: inkOf(p.body, 0.26, 1.4),
    inkMic: inkOf(p.mic, 0.28, 1.4)
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
