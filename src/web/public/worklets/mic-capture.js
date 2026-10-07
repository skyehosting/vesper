/**
 * Vesper microphone capture worklet (07 E4, spike S6, research 05 §2.6). Served same-origin from /worklets/ so the
 * production CSP (`script-src 'self'`) allows `audioWorklet.addModule` without blob: URLs.
 *
 * Input: one channel at the context's native rate (the node downmixes with channelCount 1 / 'explicit').
 * Output: 16 kHz mono Int16 frames of 512 samples (32 ms), posted to the main thread with the buffer transferred.
 *
 * Resampling is a windowed-sinc (Blackman) low-pass evaluated at fractional input positions from a tabulated kernel,
 * so any native rate works (48 kHz → exact 3:1, 44.1 kHz → fractional). Cut-off at 90 % of the output Nyquist
 * (7.2 kHz); the stop band starts near 8.6 kHz. No allocation in `process` except the posted frames.
 *
 * Plain JS on purpose (public/ files are served as-is); tests/unit/web/audio/mic-worklet.test.ts loads this file and
 * checks it against a reference resampler.
 */

const TARGET_RATE = 16000
const FRAME_SAMPLES = 512
/** Kernel table resolution (positions per input sample); linear interpolation between them. */
const PHASES = 128
/** Kernel half-width in output samples (taps = 2 · HALF_OUT · inRate/outRate). */
const HALF_OUT = 16
const CUTOFF = 0.9

class Resampler {
  /**
   * @param {number} inRate
   * @param {number} outRate
   */
  constructor(inRate, outRate) {
    /** Input samples per output sample. */
    this.step = inRate / outRate
    const ratio = Math.min(1, outRate / inRate)
    /** Cut-off in cycles per input sample. */
    const fc = 0.5 * ratio * CUTOFF
    /** Kernel half-width in input samples. */
    this.hw = Math.ceil(HALF_OUT / ratio)
    const n = 2 * this.hw * PHASES + 2
    this.table = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = i / PHASES - this.hw
      const u = (x + this.hw) / (2 * this.hw)
      const w = u < 0 || u > 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
      const a = 2 * fc * x
      const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a)
      this.table[i] = 2 * fc * sinc * w
    }
    // Normalise the DC gain (sum of taps at phase 0) to exactly 1.
    let dc = 0
    for (let k = -this.hw; k <= this.hw; k++) dc += this.table[(k + this.hw) * PHASES]
    for (let i = 0; i < n; i++) this.table[i] /= dc
    this.cap = Math.max(8192, 8 * this.hw + 4096)
    this.buf = new Float32Array(this.cap)
    // Pre-pad with silence so the first output (centred on input sample 0) has its left half.
    this.len = this.hw + 1
    /** Next output position, in samples relative to buf[0]. */
    this.t = this.hw + 1
  }

  /**
   * Push input samples; calls `emit(sample)` for each output sample that is now computable.
   * @param {Float32Array} input
   * @param {(s: number) => void} emit
   */
  push(input, emit) {
    let off = 0
    while (off < input.length) {
      if (this.len === this.cap) this.compact()
      const n = Math.min(input.length - off, this.cap - this.len)
      this.buf.set(input.subarray(off, off + n), this.len)
      this.len += n
      off += n
      this.run(emit)
    }
  }

  /** @param {(s: number) => void} emit */
  run(emit) {
    const hw = this.hw
    const tab = this.table
    const buf = this.buf
    while (Math.floor(this.t + hw) < this.len) {
      const t = this.t
      const n0 = Math.ceil(t - hw)
      const n1 = Math.floor(t + hw)
      let y = 0
      for (let n = n0; n <= n1; n++) {
        const pos = (t - n + hw) * PHASES
        const i = pos | 0
        const h = tab[i] + (tab[i + 1] - tab[i]) * (pos - i)
        y += buf[n] * h
      }
      emit(y)
      this.t += this.step
    }
  }

  compact() {
    // Keep everything the next output still needs.
    const keep = Math.max(0, Math.ceil(this.t - this.hw) - 1)
    if (keep === 0) throw new Error('resampler buffer too small')
    this.buf.copyWithin(0, keep, this.len)
    this.len -= keep
    this.t -= keep
  }
}

class MicCaptureProcessor extends AudioWorkletProcessor {
  /** @param {{processorOptions?: {targetRate?: number, frameSamples?: number}}} options */
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    this.frameSamples = o.frameSamples || FRAME_SAMPLES
    this.resampler = new Resampler(sampleRate, o.targetRate || TARGET_RATE)
    this.frame = new Int16Array(this.frameSamples)
    this.n = 0
    this.alive = true
    this.emit = (/** @type {number} */ s) => {
      const v = s > 1 ? 1 : s < -1 ? -1 : s
      this.frame[this.n++] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
      if (this.n === this.frameSamples) {
        const out = this.frame
        this.frame = new Int16Array(this.frameSamples)
        this.n = 0
        this.port.postMessage(out, [out.buffer])
      }
    }
    this.port.onmessage = (/** @type {MessageEvent} */ e) => {
      if (e.data && e.data.type === 'stop') {
        // Returning false from process() lets the node be collected once the main thread drops it.
        this.alive = false
        this.port.onmessage = null
      }
    }
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    if (!this.alive) return false
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.resampler.push(ch, this.emit)
    return true
  }
}

registerProcessor('vesper-mic-capture', MicCaptureProcessor)
