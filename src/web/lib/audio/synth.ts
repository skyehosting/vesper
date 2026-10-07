/**
 * Synthetic "speech" chunks for the gallery harness and e2e specs (07 E10 style, client side): every voiced char is a
 * short harmonic buzz, every space is silence, and the per-char timeline matches the samples exactly — so gapless
 * playback, levels and reveal timing can be asserted without a TTS provider. Loaded on demand (code-split): by the
 * gallery and e2e hooks (test builds) and by Settings' "Preview speaking" (presence AvatarPreview, v1.1.3).
 */
import type { SpeechChunkHeader, SpeechMime } from '@shared/ws/binary'

export interface SynthOptions {
  sampleRate?: number
  charMs?: number
  gapMs?: number
  /** 0–1 peak amplitude. */
  amplitude?: number
  /** 'wav' (decodeAudioData path) or 'l16' (raw PCM path). */
  format?: 'wav' | 'l16'
}

export interface SynthChunk {
  header: SpeechChunkHeader
  bytes: ArrayBuffer
}

/** PCM16 samples and a per-char timeline (ms, relative to the chunk start) for `text`. */
export function synthPcm(text: string, o: SynthOptions = {}): { pcm: Int16Array; startsMs: number[]; endsMs: number[]; durationMs: number } {
  const rate = o.sampleRate ?? 24000
  const charN = Math.max(1, Math.round(((o.charMs ?? 55) * rate) / 1000))
  const gapN = Math.max(1, Math.round(((o.gapMs ?? 90) * rate) / 1000))
  const amp = Math.min(1, Math.max(0, o.amplitude ?? 0.3))
  const lens = Array.from(text, (ch) => (/\s/u.test(ch) ? -gapN : charN))
  const total = lens.reduce((a, b) => a + Math.abs(b), 0)
  const pcm = new Int16Array(total)
  const startsMs: number[] = []
  const endsMs: number[] = []
  let pos = 0
  let syllable = 0
  for (const len of lens) {
    const n = Math.abs(len)
    startsMs.push((pos * 1000) / rate)
    if (len > 0) {
      // A 4-ish Hz syllable rhythm over a 150 Hz buzz with a few harmonics: enough for bands and onsets to move.
      const f0 = 150 + 25 * Math.sin(syllable++ * 1.7)
      for (let k = 0; k < n; k++) {
        const t = (pos + k) / rate
        const env = Math.sin((Math.PI * (k + 0.5)) / n)
        let s = 0
        for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h
        pcm[pos + k] = Math.round(amp * env * 0.55 * s * 32767)
      }
    }
    pos += n
    endsMs.push((pos * 1000) / rate)
  }
  return { pcm, startsMs, endsMs, durationMs: (total * 1000) / rate }
}

/** RIFF/WAVE, PCM 16-bit little-endian mono. */
export function encodeWav(pcm: Int16Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.byteLength)
  const v = new DataView(buf)
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.byteLength, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.byteLength, true)
  new Int16Array(buf, 44).set(pcm)
  return buf
}

/**
 * A reply as speech chunks: one chunk per text, `src` ranges contiguous over `texts.join('')` (so the joined string is
 * the "rendered" reply), the last chunk `final`.
 */
export function synthReply(replyId: string, texts: readonly string[], o: SynthOptions = {}): SynthChunk[] {
  const rate = o.sampleRate ?? 24000
  let src = 0
  return texts.map((text, index) => {
    const s = synthPcm(text, o)
    const mime: SpeechMime = o.format === 'l16' ? `audio/L16;rate=${rate}` : 'audio/wav'
    const bytes = o.format === 'l16' ? s.pcm.slice().buffer : encodeWav(s.pcm, rate)
    const header: SpeechChunkHeader = {
      sessionUid: 'gallery',
      evSeq: 0,
      replyId,
      index,
      src: [src, src + text.length],
      text,
      spoken: text,
      timeline: { startsMs: s.startsMs, endsMs: s.endsMs },
      durationMs: s.durationMs,
      mime,
      instant: false,
      final: index === texts.length - 1
    }
    src += text.length
    return { header, bytes }
  })
}

/** A plain tone (WAV) for the "play a tone" button. */
export function toneWav(freq: number, ms: number, rate = 48000, amplitude = 0.25): { bytes: ArrayBuffer; durationMs: number } {
  const n = Math.round((ms * rate) / 1000)
  const pcm = new Int16Array(n)
  const fade = Math.min(n / 2, rate * 0.01)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade)
    pcm[i] = Math.round(amplitude * env * Math.sin((2 * Math.PI * freq * i) / rate) * 32767)
  }
  return { bytes: encodeWav(pcm, rate), durationMs: (n * 1000) / rate }
}
