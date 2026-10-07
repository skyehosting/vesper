import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../mocks/server'
import { parseWav } from '../../mocks/audio'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => mock.reset())

const XI = { 'xi-api-key': 'xi-test', 'content-type': 'application/json' }

interface WithTimestamps {
  audio_base64: string
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
}

describe('mock ElevenLabs', () => {
  it('returns a real WAV whose length matches the alignment exactly', async () => {
    const text = 'Hello, it is good to hear you.'
    const res = await fetch(`${mock.url}/v1/text-to-speech/mock-aria/with-timestamps`, { method: 'POST', headers: XI, body: JSON.stringify({ text, model_id: 'eleven_v4' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as WithTimestamps
    const wav = parseWav(Buffer.from(body.audio_base64, 'base64'))
    expect(wav.sampleRate).toBe(22050)
    expect(body.alignment.characters.join('')).toBe(text)
    const end = body.alignment.character_end_times_seconds[text.length - 1]
    expect(end).toBe(wav.pcm.length / wav.sampleRate)
    // The first word is voiced, the following space is silent.
    const space = text.indexOf(' ')
    const s0 = Math.round(body.alignment.character_start_times_seconds[space] * 22050)
    const s1 = Math.round(body.alignment.character_end_times_seconds[space] * 22050)
    expect(wav.pcm.subarray(s0, s1).every((v) => v === 0)).toBe(true)
    expect(wav.pcm.subarray(0, s0).every((v) => v !== 0)).toBe(true)
    expect(mock.tts.synthTexts()).toEqual([{ provider: 'elevenlabs', voice: 'mock-aria', model: 'eleven_v4', text, tone: null }])
  })

  it('serves raw PCM for pcm_ formats (the raw-PCM scenario)', async () => {
    const res = await fetch(`${mock.url}/v1/text-to-speech/mock-aria?output_format=pcm_24000`, { method: 'POST', headers: XI, body: JSON.stringify({ text: 'hi there' }) })
    expect(res.headers.get('content-type')).toBe('audio/pcm')
    expect(res.headers.get('x-mock-sample-rate')).toBe('24000')
    expect((await res.arrayBuffer()).byteLength % 2).toBe(0)
  })

  it('lists voices (paged v2), models and the subscription; enforces the key', async () => {
    const p1 = (await (await fetch(`${mock.url}/v2/voices?page_size=2`, { headers: XI })).json()) as { voices: Array<{ voice_id: string; preview_url: string }>; has_more: boolean; next_page_token: string }
    expect(p1.voices).toHaveLength(2)
    expect(p1.has_more).toBe(true)
    const p2 = (await (await fetch(`${mock.url}/v2/voices?page_size=2&next_page_token=${p1.next_page_token}`, { headers: XI })).json()) as { voices: unknown[]; has_more: boolean }
    expect(p2.voices).toHaveLength(1)
    expect(p2.has_more).toBe(false)
    const preview = await fetch(p1.voices[0].preview_url)
    expect(preview.headers.get('content-type')).toBe('audio/wav')
    const models = (await (await fetch(`${mock.url}/v1/models`, { headers: XI })).json()) as Array<{ model_id: string; can_do_text_to_speech: boolean }>
    expect(models.filter((m) => m.can_do_text_to_speech).map((m) => m.model_id)).toContain('eleven_v4')
    const sub = (await (await fetch(`${mock.url}/elevenlabs/v1/user/subscription`, { headers: { 'xi-api-key': 'k' } })).json()) as { character_limit: number }
    expect(sub.character_limit).toBe(100_000)
    expect((await fetch(`${mock.url}/elevenlabs/v1/voices`)).status).toBe(401)
    mock.tts.mode('no-voice-permission')
    expect(JSON.stringify(await (await fetch(`${mock.url}/v1/voices`, { headers: XI })).json())).toMatch(/voices_read/)
  })

  it('reproduces the "alignment without audio" bug and quota errors', async () => {
    mock.tts.mode('no-audio')
    const body = (await (await fetch(`${mock.url}/v1/text-to-speech/mock-aria/with-timestamps`, { method: 'POST', headers: XI, body: JSON.stringify({ text: 'x' }) })).json()) as WithTimestamps
    expect(body.audio_base64).toBe('')
    expect(body.alignment.characters).toEqual(['x'])
    mock.tts.mode('ok')
    mock.tts.setQuota(99_999, 100_000)
    const q = await fetch(`${mock.url}/v1/text-to-speech/mock-aria/with-timestamps`, { method: 'POST', headers: XI, body: JSON.stringify({ text: 'too long' }) })
    expect(q.status).toBe(401)
    expect(JSON.stringify(await q.json())).toMatch(/quota_exceeded/)
  })
})

describe('mock OpenAI TTS', () => {
  it('returns a 24 kHz WAV for /v1/audio/speech', async () => {
    const res = await fetch(`${mock.url}/v1/audio/speech`, { method: 'POST', headers: { authorization: 'Bearer sk', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hello there', response_format: 'wav' }) })
    expect(res.status).toBe(200)
    const wav = parseWav(new Uint8Array(await res.arrayBuffer()))
    expect(wav.sampleRate).toBe(24000)
    expect(wav.pcm.length).toBeGreaterThan(0)
    expect((await fetch(`${mock.url}/v1/audio/speech`, { method: 'POST', body: '{}' })).status).toBe(401)
  })
})
