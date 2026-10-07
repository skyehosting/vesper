import { describe, expect, it } from 'vitest'
import {
  ATTACK_S,
  bandBins,
  copyLevels,
  createEnvelopeState,
  follow,
  ONSET_MIN_GAP_S,
  RELEASE_S,
  rmsToLevel,
  stepLevels,
  timeDomainRms,
  type LevelValues
} from '../../../../src/web/lib/audio/levels.logic'

const bins = bandBins(48000, 1024)

function sine(amp: number, n = 1024, freq = 440, rate = 48000): Float32Array {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return a
}

function spectrum(level: number): Uint8Array {
  return new Uint8Array(512).fill(level)
}

describe('level envelopes (research 07 §2.3) @R15', () => {
  it('maps RMS to a perceptual 0–1 level: −60 dB → 0, −10 dB → 1', () => {
    expect(rmsToLevel(0)).toBe(0)
    expect(rmsToLevel(0.001)).toBeCloseTo(0, 3)
    expect(rmsToLevel(10 ** (-35 / 20))).toBeCloseTo(0.5, 4)
    expect(rmsToLevel(10 ** (-10 / 20))).toBeCloseTo(1, 4)
    expect(rmsToLevel(1)).toBe(1)
    expect(timeDomainRms(sine(0.5, 4800))).toBeCloseTo(0.5 / Math.SQRT2, 3)
  })

  it('attacks with τ = 30 ms and releases with τ = 250 ms', () => {
    expect(follow(0, 1, ATTACK_S)).toBeCloseTo(1 - Math.exp(-1), 6)
    expect(follow(1, 0, RELEASE_S)).toBeCloseTo(Math.exp(-1), 6)
    expect(follow(0.4, 0.9, 0)).toBe(0.4)
  })

  it('is frame-rate independent (60 fps and 20 fps reach the same envelope)', () => {
    const run = (fps: number): number => {
      let env = 0
      const dt = 1 / fps
      for (let t = 0; t < 0.3 - 1e-9; t += dt) env = follow(env, 1, dt)
      for (let t = 0; t < 0.6 - 1e-9; t += dt) env = follow(env, 0, dt)
      return env
    }
    expect(run(60)).toBeCloseTo(run(20), 6)
    expect(run(60)).toBeCloseTo(Math.exp(-0.6 / RELEASE_S) * (1 - Math.exp(-0.3 / ATTACK_S)), 6)
  })

  it('puts the speech bands on the right FFT bins at 48 kHz / 1024', () => {
    // 46.875 Hz per bin.
    expect(bins.low).toEqual([2, 6])
    expect(bins.mid).toEqual([6, 43])
    expect(bins.high).toEqual([43, 171])
    const b44 = bandBins(44100, 1024)
    expect(b44.low[0]).toBeGreaterThanOrEqual(1)
    expect(b44.high[1]).toBeLessThanOrEqual(512)
  })

  it('rises while a signal plays, decays to zero in silence, and never allocates per frame', () => {
    const s = createEnvelopeState(512)
    const loud = sine(0.3)
    const spec = spectrum(200)
    for (let i = 0; i < 30; i++) stepLevels(s, loud, spec, bins, 1 / 60)
    const out: LevelValues = { rms: 0, low: 0, mid: 0, high: 0, onset: 0 }
    copyLevels(s, out)
    expect(out.rms).toBeGreaterThan(0.6)
    expect(out.low).toBeCloseTo(200 / 255, 2)
    expect(out.mid).toBeCloseTo(200 / 255, 2)
    for (let i = 0; i < 120; i++) stepLevels(s, null, null, bins, 1 / 60)
    copyLevels(s, out)
    expect(out.rms).toBeLessThan(0.01)
    expect(out.low).toBeLessThan(0.01)
    expect(out.onset).toBeLessThan(0.01)
    // The state keeps one spectrum buffer for flux; stepping never replaces it.
    const prev = s.prev
    stepLevels(s, loud, spec, bins, 1 / 60)
    expect(s.prev).toBe(prev)
  })

  it('fires an onset on a spectral jump, at most every 90 ms, decaying with τ = 120 ms', () => {
    const s = createEnvelopeState(512)
    const td = sine(0.2)
    const quiet = spectrum(10)
    const loud = spectrum(220)
    for (let i = 0; i < 30; i++) stepLevels(s, td, quiet, bins, 1 / 60)
    expect(s.onset).toBe(0)
    stepLevels(s, td, loud, bins, 1 / 60)
    expect(s.onset).toBe(1)
    // Another jump 1 frame later (16 ms < 90 ms) must not re-trigger.
    stepLevels(s, td, quiet, bins, 1 / 60)
    const decayed = s.onset
    stepLevels(s, td, loud, bins, 1 / 60)
    expect(s.onset).toBeLessThan(decayed)
    expect(decayed).toBeCloseTo(Math.exp(-(1 / 60) / 0.12), 5)
    // After the minimum gap a new jump fires again.
    for (let t = 0; t < ONSET_MIN_GAP_S + 0.05; t += 1 / 60) stepLevels(s, td, quiet, bins, 1 / 60)
    stepLevels(s, td, loud, bins, 1 / 60)
    expect(s.onset).toBe(1)
  })

  it('does not fire onsets on steady sound or silence', () => {
    const s = createEnvelopeState(512)
    const steady = spectrum(180)
    let fired = 0
    for (let i = 0; i < 120; i++) {
      stepLevels(s, sine(0.2), steady, bins, 1 / 60)
      if (s.onset === 1) fired++
    }
    // The very first loud frame after priming is not an onset either (no previous frame to compare).
    expect(fired).toBe(0)
  })
})
