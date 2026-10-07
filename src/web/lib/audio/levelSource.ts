/**
 * LevelSource over an AnalyserNode (research 07 §2.3): envelopes are advanced by wall-clock delta time on each
 * `read`, so the result is the same at 20, 30 or 60 fps. Buffers are allocated once per analyser; `read` allocates
 * nothing. When the source is inactive (nothing playing, mic stopped, context suspended) the envelopes decay to zero
 * instead of holding the analyser's last frame. `samples()` hands out the time-domain samples the last `read` took (the
 * audio itself — the decoded TTS chunk or the microphone, before the volume), for Armilla's horizon oscilloscope: from
 * a second, longer analyser on the same signal when one is attached (`configureScope`), so the levels keep their
 * 1024-point analysis and the waveform gets ≥ 60 ms.
 */
import { bandBins, copyLevels, createEnvelopeState, FFT_SIZE, MAX_DB, MIN_DB, scopeFftSize, SMOOTHING, stepLevels, type BandBins, type EnvelopeState } from './levels.logic'
import type { Levels, LevelSource } from './types'

/** Configure an analyser for speech visuals. */
export function configureAnalyser(a: AnalyserNode): AnalyserNode {
  a.fftSize = FFT_SIZE
  a.minDecibels = MIN_DB
  a.maxDecibels = MAX_DB
  a.smoothingTimeConstant = SMOOTHING
  return a
}

/** Configure the waveform analyser (time domain only): ≥ SCOPE_SECONDS of audio at the context's rate. */
export function configureScope(a: AnalyserNode): AnalyserNode {
  a.fftSize = scopeFftSize(a.context.sampleRate)
  return a
}

export class AnalyserLevels implements LevelSource {
  private analyser: AnalyserNode | null = null
  private scope: AnalyserNode | null = null
  private td: Float32Array<ArrayBuffer> = new Float32Array(0)
  private scopeTd: Float32Array<ArrayBuffer> = new Float32Array(0)
  private freq: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private bins: BandBins = bandBins(48000, FFT_SIZE)
  private state: EnvelopeState = createEnvelopeState(0)
  private last = 0
  private live = false

  /**
   * @param active whether the analysed signal is live right now (false → decay). Read once per `read`.
   * @param clock milliseconds (performance.now by default; injectable for tests).
   */
  constructor(
    private readonly active: () => boolean,
    private readonly clock: () => number = () => performance.now()
  ) {}

  /** Attach (or detach with null) the analyser and its waveform twin; buffers are sized here, never in `read`. */
  attach(a: AnalyserNode | null, scope: AnalyserNode | null = null): void {
    this.analyser = a
    this.scope = a ? scope : null
    if (scope && this.scopeTd.length !== scope.fftSize) this.scopeTd = new Float32Array(scope.fftSize)
    if (!a) return
    if (this.td.length !== a.fftSize) this.td = new Float32Array(a.fftSize)
    if (this.freq.length !== a.frequencyBinCount) this.freq = new Uint8Array(a.frequencyBinCount)
    this.bins = bandBins(a.context.sampleRate, a.fftSize)
    if (this.state.prev.length !== a.frequencyBinCount) this.state = createEnvelopeState(a.frequencyBinCount)
  }

  read(out: Levels): void {
    const now = this.clock()
    const dt = this.last ? (now - this.last) / 1000 : 0
    this.last = now
    const a = this.analyser
    if (a && this.active()) {
      a.getFloatTimeDomainData(this.td)
      this.scope?.getFloatTimeDomainData(this.scopeTd)
      a.getByteFrequencyData(this.freq)
      stepLevels(this.state, this.td, this.freq, this.bins, dt)
      this.live = true
    } else {
      stepLevels(this.state, null, null, this.bins, dt)
      this.live = false
    }
    copyLevels(this.state, out)
  }

  /**
   * The newest time-domain samples (−1…1) the last `read` took — the waveform analyser's (≥ 60 ms) when attached, else
   * the level analyser's 1024 — or null when that read found nothing live (nothing playing, mic stopped). Not a copy:
   * valid until the next `read` (no allocation).
   */
  samples(): Float32Array | null {
    if (!this.live) return null
    return this.scope ? this.scopeTd : this.td
  }

  /** Sample rate of `samples()` (the AudioContext's). */
  get sampleRate(): number {
    return this.analyser?.context.sampleRate ?? 48000
  }
}
