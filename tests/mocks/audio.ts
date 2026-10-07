/**
 * Synthetic "speech" for the TTS mocks (07 E10): a REAL PCM16 mono WAV where every word is a sine burst and every
 * whitespace character is silence, with a per-character alignment that matches the samples exactly — so reveal
 * timing (R14) can be asserted against the audio itself without a key or a speech engine.
 *
 * Timing per character: voiced (non-space) = `charMs`, whitespace = `gapMs` of silence, characters inside an
 * ElevenLabs audio tag (`[warm] …`) = zero duration (not spoken). Times are sample-exact: start = offset / rate.
 */

export interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface SynthOptions {
  sampleRate?: number
  /** Duration of each voiced character (default 55 ms). */
  charMs?: number
  /** Silence per whitespace character (default 90 ms). */
  gapMs?: number
  /** 0..1 peak amplitude (default 0.3). */
  amplitude?: number
  /** Speaking rate multiplier (ElevenLabs voice_settings.speed, OpenAI speed): durations are divided by it. */
  speed?: number
  /** Treat `[...]` as zero-duration audio tags (ElevenLabs v3/v4). Default true. */
  audioTags?: boolean
}

export interface SynthResult {
  pcm: Int16Array
  sampleRate: number
  alignment: Alignment
  durationMs: number
  /** Sample offsets [start, end) per character (same order as alignment.characters). */
  spans: Array<[number, number]>
}

const FADE_MS = 5

export function synthSpeech(text: string, o: SynthOptions = {}): SynthResult {
  const rate = o.sampleRate ?? 22050
  const speed = o.speed && o.speed > 0 ? o.speed : 1
  const charSamples = Math.max(1, Math.round((((o.charMs ?? 55) / speed) * rate) / 1000))
  const gapSamples = Math.max(1, Math.round((((o.gapMs ?? 90) / speed) * rate) / 1000))
  const amp = Math.round(32767 * Math.min(1, Math.max(0, o.amplitude ?? 0.3)))
  const chars = Array.from(text)
  const spans: Array<[number, number]> = []
  const voiced: boolean[] = []
  let pos = 0
  let inTag = false
  for (const ch of chars) {
    if (o.audioTags !== false && ch === '[') inTag = true
    let len = 0
    let isVoiced = false
    if (inTag) len = 0
    else if (/\s/u.test(ch)) len = gapSamples
    else {
      len = charSamples
      isVoiced = true
    }
    if (o.audioTags !== false && ch === ']') inTag = false
    spans.push([pos, pos + len])
    voiced.push(isVoiced)
    pos += len
  }
  const pcm = new Int16Array(pos)
  // Render each word (a run of voiced characters, zero-length tag characters do not break it) as one burst with a
  // continuous phase and short fades, so the waveform has no clicks and silence is exactly zero.
  let word = 0
  let i = 0
  while (i < chars.length) {
    if (!voiced[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < chars.length && (voiced[j + 1] || spans[j + 1][0] === spans[j + 1][1])) j++
    while (!voiced[j]) j--
    const start = spans[i][0]
    const end = spans[j][1]
    const freq = 220 + 55 * (word % 6)
    const fade = Math.min(Math.round((FADE_MS * rate) / 1000), Math.floor((end - start) / 2))
    for (let s = start; s < end; s++) {
      const k = s - start
      const env = fade > 0 ? Math.min(1, (k + 1) / fade, (end - s) / fade) : 1
      const v = Math.round(amp * env * Math.sin((2 * Math.PI * freq * k) / rate))
      // Keep voiced samples non-zero (a zero crossing is not silence) so tests can tell voiced from silent spans.
      pcm[s] = v === 0 ? (Math.sin((2 * Math.PI * freq * k) / rate) < 0 ? -1 : 1) : v
    }
    word++
    i = j + 1
  }
  return {
    pcm,
    sampleRate: rate,
    spans,
    durationMs: (pos / rate) * 1000,
    alignment: {
      characters: chars,
      character_start_times_seconds: spans.map(([s]) => s / rate),
      character_end_times_seconds: spans.map(([, e]) => e / rate)
    }
  }
}

/** RIFF/WAVE, PCM 16-bit little-endian, mono. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** Raw little-endian PCM16 bytes (`pcm_<rate>` / `audio/L16`). */
export function pcmBytes(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

export interface ParsedWav {
  sampleRate: number
  channels: number
  bitsPerSample: number
  pcm: Int16Array
}

/** Minimal WAV reader (PCM16) that walks the chunk list; used by tests and the STT mock. */
export function parseWav(buf: Uint8Array): ParsedWav {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let off = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) }
    if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk')
      if (fmt.bits !== 16) throw new Error(`unsupported bits per sample ${fmt.bits}`)
      const bytes = b.subarray(body, Math.min(b.length, body + size))
      const copy = new Int16Array(Math.floor(bytes.length / 2))
      for (let i = 0; i < copy.length; i++) copy[i] = bytes.readInt16LE(i * 2)
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, pcm: copy }
    }
    off = body + size + (size % 2)
  }
  throw new Error('no data chunk')
}
