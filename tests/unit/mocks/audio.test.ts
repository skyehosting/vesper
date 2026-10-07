import { describe, expect, it } from 'vitest'
import { encodeWav, parseWav, synthSpeech } from '../../mocks/audio'

describe('mock speech audio', () => {
  it('alignment matches the samples: voiced characters are sound, whitespace is silence, ends together', () => {
    const text = 'Hello there, quiet world.'
    const s = synthSpeech(text, { sampleRate: 22050 })
    const a = s.alignment
    expect(a.characters.join('')).toBe(text)
    expect(a.character_start_times_seconds).toHaveLength(text.length)
    // Sample-exact: the last character ends exactly where the audio ends.
    expect(a.character_end_times_seconds[text.length - 1]).toBe(s.pcm.length / 22050)
    expect(s.durationMs).toBeCloseTo((s.pcm.length / 22050) * 1000, 6)
    for (let i = 0; i < text.length; i++) {
      const start = Math.round(a.character_start_times_seconds[i] * 22050)
      const end = Math.round(a.character_end_times_seconds[i] * 22050)
      expect(end).toBeGreaterThan(start)
      if (i > 0) expect(a.character_start_times_seconds[i]).toBe(a.character_end_times_seconds[i - 1])
      const span = s.pcm.subarray(start, end)
      if (/\s/.test(text[i])) expect(span.every((v) => v === 0), `char ${i} should be silent`).toBe(true)
      else expect(span.every((v) => v !== 0), `char ${i} should be voiced`).toBe(true)
    }
  })

  it('round-trips through a real RIFF/WAVE container', () => {
    const s = synthSpeech('one two', { sampleRate: 24000 })
    const wav = encodeWav(s.pcm, 24000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.length).toBe(44 + s.pcm.length * 2)
    const back = parseWav(wav)
    expect(back.sampleRate).toBe(24000)
    expect(back.channels).toBe(1)
    expect(Array.from(back.pcm)).toEqual(Array.from(s.pcm))
  })

  it('treats [audio tags] as zero-duration only when asked', () => {
    const tagged = synthSpeech('[warm] Hi', { audioTags: true })
    const spoken = synthSpeech('[warm] Hi', { audioTags: false })
    const a = tagged.alignment
    for (let i = 0; i < '[warm]'.length; i++) expect(a.character_end_times_seconds[i]).toBe(a.character_start_times_seconds[i])
    expect(spoken.pcm.length).toBeGreaterThan(tagged.pcm.length)
  })

  it('speed shortens the audio', () => {
    expect(synthSpeech('speed test', { speed: 1.2 }).durationMs).toBeLessThan(synthSpeech('speed test').durationMs)
  })
})
