/**
 * Chunk payload formats (07 C14): `audio/mpeg`, `audio/wav` (and any container decodeAudioData understands, e.g.
 * OGG) are decoded by the browser; `audio/L16;rate=<n>` is raw 16-bit mono PCM handled here, because decodeAudioData
 * cannot decode headerless PCM. Vesper's L16 is **little-endian** (what the providers' `pcm_<rate>` formats and the
 * mocks emit), not RFC 2586 network order; `;endianness=big` is honoured if a producer ever sends it.
 */

export interface PcmFormat {
  rate: number
  channels: number
  bigEndian: boolean
}

/** Parse `audio/L16;rate=24000[;channels=1]`; null for any other mime. */
export function parseL16(mime: string): PcmFormat | null {
  const parts = mime.split(';').map((p) => p.trim().toLowerCase())
  if (parts[0] !== 'audio/l16') return null
  let rate = 16000
  let channels = 1
  let bigEndian = false
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=').map((x) => x.trim())
    if (k === 'rate' && Number(v) > 0) rate = Math.round(Number(v))
    else if (k === 'channels' && Number(v) >= 1) channels = Math.round(Number(v))
    else if (k === 'endianness' && v === 'big-endian') bigEndian = true
    else if (k === 'endianness' && v === 'big') bigEndian = true
  }
  return { rate, channels, bigEndian }
}

/** Deinterleave 16-bit PCM bytes into one Float32Array per channel (−1..1). A trailing odd byte is ignored. */
export function pcm16ToFloat(bytes: ArrayBuffer | Uint8Array, fmt: PcmFormat): Float32Array[] {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const frames = Math.floor(u8.byteLength / (2 * fmt.channels))
  const out: Float32Array[] = []
  for (let c = 0; c < fmt.channels; c++) out.push(new Float32Array(frames))
  const le = !fmt.bigEndian
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const s = view.getInt16((i * fmt.channels + c) * 2, le)
      out[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff
    }
  }
  return out
}

/** True for a chunk that carries no audio: instant chunks (07 C14) and empty payloads play as zero-length. */
export function isSilentChunk(instant: boolean, byteLength: number): boolean {
  return instant || byteLength === 0
}
