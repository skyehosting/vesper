/**
 * Level envelopes for the Star and level meters (research 07 §2.3, 07 E4). Pure and allocation-free per frame: the
 * caller owns every buffer, `stepLevels` only reads analyser data and writes numbers.
 *
 *   level = clamp01((20·log10(rms) + 60) / 50)          −60 dB → 0, −10 dB → 1
 *   env  += (target − env)·(1 − e^(−dt/τ)),  τ = 30 ms rising, 250 ms falling
 *   bands: mean of byte bins / 255 in 80–300 / 300–2000 / 2000–8000 Hz, each with its own follower
 *   onset: half-wave-rectified spectral flux over the log spectrum; pulse = 1 when flux > 1.5·mean + δ (≥ 90 ms
 *          apart), then decays with τ = 120 ms
 */

/** Structurally the frozen `Levels` of ./types (kept DOM-free: *.logic.ts files are also checked without the DOM lib). */
export interface LevelValues {
  rms: number
  low: number
  mid: number
  high: number
  onset: number
}

export const ATTACK_S = 0.03
export const RELEASE_S = 0.25
export const ONSET_DECAY_S = 0.12
/** Mean flux follows over about half a second (the "last ~0.5 s" of research 07). */
export const FLUX_MEAN_S = 0.5
export const ONSET_MIN_GAP_S = 0.09
/** Flux threshold: mean × 1.5 + δ (δ in dB-sum units over the analysed bins, keeps silence from triggering). */
export const ONSET_RATIO = 1.5
export const ONSET_DELTA = 40
/** Analyser settings for speech (research 07 §2.3). */
export const FFT_SIZE = 1024
export const MIN_DB = -90
export const MAX_DB = -25
export const SMOOTHING = 0.6
/**
 * The waveform analyser beside it (Armilla's horizon oscilloscope, v1.1.5): at least this much of the newest audio —
 * a 25–45 ms window plus room to search back for a trigger — so its fftSize follows the context's sample rate.
 */
export const SCOPE_SECONDS = 0.06

/** fftSize of the waveform analyser: the smallest power of two holding SCOPE_SECONDS at `sampleRate` (2048–32768). */
export function scopeFftSize(sampleRate: number): number {
  let n = 2048
  while (n < sampleRate * SCOPE_SECONDS && n < 32768) n *= 2
  return n
}
/** A frame gap longer than this (paused Star, hidden tab) is treated as this long. */
export const MAX_DT_S = 1

export const BANDS = { low: [80, 300], mid: [300, 2000], high: [2000, 8000] } as const

export interface BandBins {
  low: [number, number]
  mid: [number, number]
  high: [number, number]
  /** Highest bin used by any band + 1 (flux is computed over [1, fluxEnd)). */
  fluxEnd: number
}

/** Inclusive-exclusive bin ranges for the bands at this sample rate and FFT size (each range holds ≥ 1 bin). */
export function bandBins(sampleRate: number, fftSize: number): BandBins {
  const binHz = sampleRate / fftSize
  const nBins = fftSize / 2
  const range = ([lo, hi]: readonly [number, number]): [number, number] => {
    const a = Math.min(nBins - 1, Math.max(1, Math.round(lo / binHz)))
    const b = Math.min(nBins, Math.max(a + 1, Math.round(hi / binHz)))
    return [a, b]
  }
  const low = range(BANDS.low)
  const mid = range(BANDS.mid)
  const high = range(BANDS.high)
  return { low, mid, high, fluxEnd: high[1] }
}

export interface EnvelopeState {
  rms: number
  low: number
  mid: number
  high: number
  onset: number
  fluxMean: number
  /** Seconds since the last onset (starts large so the first onset can fire). */
  sinceOnset: number
  /** Previous frame's spectrum (byte bins), for spectral flux. */
  prev: Uint8Array
  hasPrev: boolean
}

export function createEnvelopeState(bins: number): EnvelopeState {
  return { rms: 0, low: 0, mid: 0, high: 0, onset: 0, fluxMean: 0, sinceOnset: 10, prev: new Uint8Array(bins), hasPrev: false }
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Perceptual level of a raw RMS (linear amplitude): −60 dBFS → 0, −10 dBFS → 1. */
export function rmsToLevel(rms: number): number {
  return clamp01((20 * Math.log10(rms + 1e-6) + 60) / 50)
}

/** One attack/release follower step (frame-rate independent). */
export function follow(env: number, target: number, dt: number): number {
  if (dt <= 0) return env
  const tau = target > env ? ATTACK_S : RELEASE_S
  return env + (target - env) * (1 - Math.exp(-dt / tau))
}

export function timeDomainRms(td: Float32Array): number {
  let sum = 0
  for (let i = 0; i < td.length; i++) sum += td[i] * td[i]
  return td.length ? Math.sqrt(sum / td.length) : 0
}

function bandMean(freq: Uint8Array, [a, b]: readonly [number, number]): number {
  let s = 0
  for (let i = a; i < b; i++) s += freq[i]
  return b > a ? s / ((b - a) * 255) : 0
}

/**
 * Advance the envelopes by `dt` seconds with one analyser frame. `td` = float time-domain samples, `freq` = byte
 * frequency data (log scale between MIN_DB and MAX_DB); either may be null for a silent frame (everything decays).
 */
export function stepLevels(s: EnvelopeState, td: Float32Array | null, freq: Uint8Array | null, bins: BandBins, dt: number): void {
  const d = dt > MAX_DT_S ? MAX_DT_S : dt < 0 ? 0 : dt
  const level = td ? rmsToLevel(timeDomainRms(td)) : 0
  s.rms = follow(s.rms, level, d)
  s.low = follow(s.low, freq ? bandMean(freq, bins.low) : 0, d)
  s.mid = follow(s.mid, freq ? bandMean(freq, bins.mid) : 0, d)
  s.high = follow(s.high, freq ? bandMean(freq, bins.high) : 0, d)

  s.onset *= Math.exp(-d / ONSET_DECAY_S)
  s.sinceOnset += d
  if (!freq || d === 0) {
    if (!freq) s.hasPrev = false
    return
  }
  // Byte bins are linear in dB, so differences are log-magnitude differences (scaled to dB).
  const dbPerStep = (MAX_DB - MIN_DB) / 255
  let flux = 0
  const end = Math.min(bins.fluxEnd, freq.length, s.prev.length)
  if (s.hasPrev) for (let i = 1; i < end; i++) {
    const diff = freq[i] - s.prev[i]
    if (diff > 0) flux += diff * dbPerStep
  }
  for (let i = 0; i < end; i++) s.prev[i] = freq[i]
  const wasPrimed = s.hasPrev
  s.hasPrev = true
  if (!wasPrimed) return
  const threshold = s.fluxMean * ONSET_RATIO + ONSET_DELTA
  if (flux > threshold && s.sinceOnset >= ONSET_MIN_GAP_S) {
    s.onset = 1
    s.sinceOnset = 0
  }
  s.fluxMean += (flux - s.fluxMean) * (1 - Math.exp(-d / FLUX_MEAN_S))
}

export function copyLevels(s: EnvelopeState, out: LevelValues): void {
  out.rms = clamp01(s.rms)
  out.low = clamp01(s.low)
  out.mid = clamp01(s.mid)
  out.high = clamp01(s.high)
  out.onset = clamp01(s.onset)
}

export function zeroLevels(out: LevelValues): void {
  out.rms = 0
  out.low = 0
  out.mid = 0
  out.high = 0
  out.onset = 0
}
