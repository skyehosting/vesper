/**
 * The shipped worklet file (src/web/public/worklets/mic-capture.js) loaded with stand-ins for the AudioWorklet
 * globals, checked against a reference: an analytic band-limited signal sampled directly at 16 kHz.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { micEnvironmentError, micErrorCode } from '../../../../src/web/lib/mic/errors.logic'

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../src/web/public/worklets/mic-capture.js'), 'utf8')

interface FakePort {
  posted: Int16Array[]
  transfers: number
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(data: Int16Array, transfer?: unknown[]): void
}

interface Processor {
  port: FakePort
  process(inputs: Float32Array[][]): boolean
}

function load(rate: number): { create: (opts?: unknown) => Processor; name: string } {
  class FakeAudioWorkletProcessor {
    port: FakePort = {
      posted: [],
      transfers: 0,
      onmessage: null,
      postMessage(data: Int16Array, transfer?: unknown[]) {
        this.posted.push(data)
        if (transfer?.length) this.transfers++
      }
    }
  }
  let ctor: (new (o?: unknown) => Processor) | null = null
  let name = ''
  const register = (n: string, c: new (o?: unknown) => Processor): void => {
    name = n
    ctor = c
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', SRC)(FakeAudioWorkletProcessor, register, rate)
  if (!ctor) throw new Error('registerProcessor was not called')
  const C = ctor as new (o?: unknown) => Processor
  return { create: (o) => new C(o ?? { processorOptions: { targetRate: 16000, frameSamples: 512 } }), name }
}

type Signal = (t: number) => number

/** Feed `seconds` of `signal` at `rate` in 128-frame render quanta; return all 16 kHz output samples (−1..1). */
function run(rate: number, signal: Signal, seconds: number): { out: Float32Array; frames: Int16Array[]; proc: Processor } {
  const proc = load(rate).create()
  const total = Math.round(rate * seconds)
  const block = new Float32Array(128)
  for (let i = 0; i < total; i += 128) {
    for (let k = 0; k < 128; k++) block[k] = signal((i + k) / rate)
    expect(proc.process([[block]])).toBe(true)
  }
  const frames = proc.port.posted
  const out = new Float32Array(frames.length * 512)
  frames.forEach((f, i) => out.set(Float32Array.from(f, (s) => (s < 0 ? s / 0x8000 : s / 0x7fff)), i * 512))
  return { out, frames, proc }
}

const tones = (parts: Array<[number, number]>): Signal => (t) => parts.reduce((s, [f, a]) => s + a * Math.sin(2 * Math.PI * f * t), 0)

/** RMS error against the signal sampled at 16 kHz, skipping the start-up transient. */
function rmsError(out: Float32Array, signal: Signal, skip = 64): number {
  let e = 0
  let n = 0
  for (let m = skip; m < out.length; m++) {
    const d = out[m] - signal(m / 16000)
    e += d * d
    n++
  }
  return Math.sqrt(e / n)
}

function rms(a: Float32Array, skip = 64): number {
  let s = 0
  for (let i = skip; i < a.length; i++) s += a[i] * a[i]
  return Math.sqrt(s / (a.length - skip))
}

describe('mic capture worklet: 48k/44.1k → 16 kHz Int16 frames of 512 (07 E4, S6) @R19', () => {
  it('registers the processor the client instantiates', () => {
    expect(load(48000).name).toBe('vesper-mic-capture')
  })

  it('posts 512-sample frames at real-time rate with the buffer transferred', () => {
    const { frames, proc } = run(48000, tones([[440, 0.3]]), 2)
    // 2 s × 16000 / 512 = 62.5 → 62 full frames (the filter's look-ahead holds back < 1 frame).
    expect(frames.length).toBe(62)
    expect(frames.every((f) => f instanceof Int16Array && f.length === 512)).toBe(true)
    expect(proc.port.transfers).toBe(frames.length)
  })

  it('matches the reference within 0.5 % RMS for speech-band tones at 48 kHz', () => {
    const sig = tones([
      [180, 0.25],
      [700, 0.2],
      [2500, 0.15],
      [5000, 0.1]
    ])
    const { out } = run(48000, sig, 1)
    expect(rmsError(out, sig)).toBeLessThan(0.005)
  })

  it('matches the reference at 44.1 kHz (fractional ratio)', () => {
    const sig = tones([
      [220, 0.3],
      [1300, 0.2],
      [3700, 0.1]
    ])
    const { out, frames } = run(44100, sig, 1)
    expect(frames.length).toBe(31)
    expect(rmsError(out, sig)).toBeLessThan(0.005)
  })

  it('rejects content above 8 kHz instead of aliasing it into the speech band', () => {
    // A 12 kHz tone would alias to 4 kHz with naive decimation; the low-pass leaves less than −50 dB of it.
    const { out } = run(48000, tones([[12000, 0.5]]), 1)
    expect(20 * Math.log10(rms(out) / (0.5 / Math.SQRT2))).toBeLessThan(-50)
    // The spike's sample-dropping decimator for comparison: no protection at all.
    const naive = Float32Array.from({ length: 16000 }, (_, m) => 0.5 * Math.sin(2 * Math.PI * 12000 * (m * 3) / 48000))
    expect(20 * Math.log10(rms(naive) / (0.5 / Math.SQRT2))).toBeGreaterThan(-1)
  })

  it('clips to the Int16 range and keeps DC', () => {
    const { frames } = run(48000, () => 1.5, 0.2)
    expect(Math.max(...frames[frames.length - 1])).toBe(32767)
    const dc = run(48000, () => 0.25, 0.2).out
    expect(dc[dc.length - 1]).toBeCloseTo(0.25, 3)
  })

  it('finishes on a stop message (process returns false) and ignores empty inputs', () => {
    const proc = load(48000).create()
    expect(proc.process([[]])).toBe(true)
    expect(proc.process([])).toBe(true)
    proc.port.onmessage?.({ data: { type: 'stop' } })
    expect(proc.process([[new Float32Array(128)]])).toBe(false)
    expect(proc.port.onmessage).toBeNull()
  })
})

describe('microphone error mapping (07 C19, D8) @R19', () => {
  it('requires a secure context, getUserMedia and AudioWorklet', () => {
    expect(micEnvironmentError({ isSecureContext: false, hasGetUserMedia: false, hasAudioWorklet: false })).toBe('insecure_context')
    expect(micEnvironmentError({ isSecureContext: true, hasGetUserMedia: false, hasAudioWorklet: true })).toBe('insecure_context')
    expect(micEnvironmentError({ isSecureContext: true, hasGetUserMedia: true, hasAudioWorklet: false })).toBe('insecure_context')
    expect(micEnvironmentError({ isSecureContext: true, hasGetUserMedia: true, hasAudioWorklet: true })).toBeNull()
  })

  it('maps getUserMedia rejections', () => {
    const err = (name: string, message = ''): Error => Object.assign(new Error(message), { name })
    expect(micErrorCode(err('NotAllowedError', 'Permission denied'))).toBe('mic_denied')
    expect(micErrorCode(err('NotAllowedError', 'Permission denied by system'))).toBe('mic_os_blocked')
    expect(micErrorCode(err('SecurityError'))).toBe('mic_denied')
    expect(micErrorCode(err('NotReadableError', 'Could not start audio source'))).toBe('mic_os_blocked')
    expect(micErrorCode(err('NotFoundError'))).toBe('mic_os_blocked')
    expect(micErrorCode(err('OverconstrainedError'))).toBe('mic_os_blocked')
    expect(micErrorCode(err('TypeError'))).toBe('internal')
    expect(micErrorCode('weird')).toBe('internal')
  })
})
