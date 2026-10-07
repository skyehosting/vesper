/** Provider audio: container sniffing and real durations (the reveal ends with the audio, 07 C14). @R14 */
import { describe, expect, it } from 'vitest'
import { durationOf, mp3DurationMs, readWav, sniffMime, wavFromPcm } from '@server/speech/audio'
import { sanitizeTone, toneInstructions, tonePreset, toneTag } from '@server/speech/tone'
import { encodeWav, synthSpeech } from '../../mocks/audio'

/** N frames of MPEG-1 Layer III, 128 kbit/s, 44.1 kHz (417 bytes each), optionally behind an ID3v2 tag. */
function mp3(frames: number, id3 = 0): Uint8Array {
  const tag = id3 ? [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (id3 >> 7) & 0x7f, id3 & 0x7f, ...new Array<number>(id3).fill(0)] : []
  const out = new Uint8Array(tag.length + frames * 417)
  out.set(tag, 0)
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0x00], tag.length + f * 417)
  return out
}

describe('audio containers', () => {
  it('sniffs WAV and MP3 (with or without ID3)', () => {
    const wav = encodeWav(synthSpeech('hi').pcm, 16000)
    expect(sniffMime(wav)).toBe('audio/wav')
    expect(sniffMime(mp3(2))).toBe('audio/mpeg')
    expect(sniffMime(mp3(2, 20))).toBe('audio/mpeg')
    expect(sniffMime(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  it('reads WAV duration, including streamed WAVs whose header has no real size', () => {
    const s = synthSpeech('hello world', { sampleRate: 24000 })
    const wav = new Uint8Array(encodeWav(s.pcm, 24000))
    expect(readWav(wav)!.durationMs).toBeCloseTo(s.durationMs, 6)
    const streamed = wav.slice()
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true)
    new DataView(streamed.buffer).setUint32(4, 0xffffffff, true)
    expect(readWav(streamed)!.pcm.length).toBe(s.pcm.length)
    expect(readWav(mp3(1))).toBeNull()
  })

  it('wraps raw PCM into a WAV', () => {
    const s = synthSpeech('pcm', { sampleRate: 22050 })
    const raw = new Uint8Array(s.pcm.buffer)
    const wav = wavFromPcm(raw, 22050)
    const back = readWav(wav)!
    expect(back.sampleRate).toBe(22050)
    expect(Array.from(back.pcm)).toEqual(Array.from(s.pcm))
    expect(durationOf(raw, 'audio/L16;rate=22050')).toBeCloseTo(s.durationMs, 6)
  })

  it('walks MP3 frames for the duration', () => {
    expect(mp3DurationMs(mp3(100))).toBeCloseTo((100 * 1152 * 1000) / 44100, 6)
    expect(mp3DurationMs(mp3(10, 300))).toBeCloseTo((10 * 1152 * 1000) / 44100, 6)
    expect(mp3DurationMs(new Uint8Array(50))).toBeNull()
    expect(durationOf(mp3(5), 'audio/mpeg')).toBeCloseTo((5 * 1152 * 1000) / 44100, 6)
  })
})

describe('tone adapters (research 04 §7.4) @R13', () => {
  it('sanitizes the model-written tone: no brackets or newlines, ≤ 6 words, ≤ 60 chars', () => {
    expect(sanitizeTone('  warm,\n gently [teasing] ')).toBe('warm, gently teasing')
    expect(sanitizeTone('one two three four five six seven eight')).toBe('one two three four five six')
    expect(sanitizeTone('[]')).toBeNull()
    expect(sanitizeTone(null)).toBeNull()
    expect(sanitizeTone('a'.repeat(100))!.length).toBeLessThanOrEqual(60)
    expect(toneTag('warm')).toBe('[warm] ')
    expect(toneTag('')).toBe('')
    expect(toneInstructions('playful')).toBe('Speak in a playful tone.')
  })

  it('maps tones to presets with a tiny keyword classifier; unknown tones are neutral', () => {
    expect(tonePreset('Excited!').speed).toBeGreaterThan(1)
    expect(tonePreset('sad and tired').speed).toBeLessThan(1)
    expect(tonePreset('warm, gently teasing').style).toBe(0.2)
    expect(tonePreset('zxqv')).toEqual(tonePreset(null))
  })
})
