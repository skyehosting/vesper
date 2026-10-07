/** PCM helpers shared by the STT process, the service (cloud uploads) and tests. Mono, 16-bit little-endian. */

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * 32767)
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
  }
  return out
}

/** Root mean square of float samples (0..1); the "near-silence" measure of the hallucination guard. */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * Int16 samples from a mic frame payload. The payload is a view into the WebSocket buffer at an arbitrary (possibly
 * odd) offset, so it is copied into a fresh, aligned buffer; null when the byte count is odd or zero.
 */
export function pcmFromBytes(bytes: Uint8Array): Int16Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return null
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Int16Array(copy.buffer)
}

/** A RIFF/WAVE file (PCM16 mono) — what the cloud STT APIs accept for an utterance. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const data = pcm.length * 2
  const out = new Uint8Array(44 + data)
  const v = new DataView(out.buffer)
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, data, true)
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true)
  return out
}

/** Parse a PCM16 WAV (mono or the first channel) — fixtures and tests. */
export function decodeWav(buf: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let off = 12
  let rate = 0
  let channels = 1
  let bits = 16
  while (off + 8 <= buf.length) {
    const id = tag(off)
    const size = v.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      channels = v.getUint16(body + 2, true)
      rate = v.getUint32(body + 4, true)
      bits = v.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('only PCM16 WAV is supported')
      const frames = Math.floor(Math.min(size, buf.length - body) / (2 * channels))
      const pcm = new Int16Array(frames)
      for (let i = 0; i < frames; i++) pcm[i] = v.getInt16(body + i * 2 * channels, true)
      return { pcm, sampleRate: rate }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}
