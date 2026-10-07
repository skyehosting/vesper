/**
 * Container sniffing and durations for provider audio. The chunk header's `durationMs` must be the real decoded length
 * (research 04 §7.1: the reveal ends with the audio, trailing silence included), so it is read from the bytes:
 * WAV from its header (streamed WAVs with an unknown data size are clamped to the bytes present), MP3 by walking the
 * frame headers. Raw PCM is wrapped into a WAV so every client decodes it with decodeAudioData.
 */
import type { SpeechMime } from '@shared/ws'

export function sniffMime(b: Uint8Array): 'audio/wav' | 'audio/mpeg' | null {
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'audio/wav'
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') return 'audio/mpeg'
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return null
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Mono PCM16 (the first channel when the file has several). */
  pcm: Int16Array
  durationMs: number
}

/** PCM16 WAV reader; null when the bytes are not a WAV it can read. */
export function readWav(b: Uint8Array): WavInfo | null {
  if (sniffMime(b) !== 'audio/wav') return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let off = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  while (off + 8 <= b.length) {
    const id = ascii(b, off, off + 4)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ' && body + 16 <= b.length) {
      fmt = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt || fmt.bits !== 16 || !fmt.sampleRate || !fmt.channels) return null
      // Streamed WAVs (OpenAI) carry 0xFFFFFFFF or 0 here: use what is actually present.
      const end = size === 0 || size === 0xffffffff || body + size > b.length ? b.length : body + size
      const frames = Math.floor((end - body) / (2 * fmt.channels))
      const pcm = new Int16Array(frames)
      for (let i = 0; i < frames; i++) pcm[i] = view.getInt16(body + i * 2 * fmt.channels, true)
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: 16, pcm, durationMs: (frames / fmt.sampleRate) * 1000 }
    }
    off = body + size + (size % 2)
  }
  return null
}

/** RIFF/WAVE PCM16 mono around raw little-endian samples. */
export function wavFromPcm(pcmLe: Uint8Array, sampleRate: number): Uint8Array {
  const data = pcmLe.length - (pcmLe.length % 2)
  const out = new Uint8Array(44 + data)
  const v = new DataView(out.buffer)
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, data, true)
  out.set(pcmLe.subarray(0, data), 44)
  return out
}

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

/** Duration of an MPEG layer III stream by walking its frames; null when no frame is found. */
export function mp3DurationMs(b: Uint8Array): number | null {
  let off = 0
  if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
    off = 10 + size + (b[5] & 0x10 ? 10 : 0)
  }
  let seconds = 0
  let frames = 0
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) {
      off++
      continue
    }
    const version = (b[off + 1] >> 3) & 3
    const layer = (b[off + 1] >> 1) & 3
    const brIdx = b[off + 2] >> 4
    const srIdx = (b[off + 2] >> 2) & 3
    const pad = (b[off + 2] >> 1) & 1
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      off++
      continue
    }
    const rate = MP3_RATES[version][srIdx]
    const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx]
    const spf = version === 3 ? 1152 : 576
    const len = Math.floor(((spf / 8) * kbps * 1000) / rate) + pad
    if (len < 4) {
      off++
      continue
    }
    seconds += spf / rate
    frames++
    off += len
  }
  return frames ? seconds * 1000 : null
}

/** Duration of encoded audio, or null when it cannot be read. */
export function durationOf(b: Uint8Array, mime: SpeechMime): number | null {
  if (mime === 'audio/wav') return readWav(b)?.durationMs ?? null
  if (mime === 'audio/mpeg') return mp3DurationMs(b)
  const m = /rate=(\d+)/.exec(mime)
  return m ? (Math.floor(b.length / 2) / Number(m[1])) * 1000 : null
}
