/**
 * TTS providers against the mock provider server (VESPER_MOCK_BASE, 05 §2): ElevenLabs with-timestamps validation +
 * fallback, tone adapters, voices/models/quota, key validation, error mapping; OpenAI and OpenAI-compatible; the HTTP
 * helper's redirect/size/timeout rules. @R12 @R13
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { VesperError } from '@shared/errors'
import { defaultSettings, type Settings } from '@shared/settings'
import type { SecretsService, SettingsStore } from '@server/services'
import { createElevenLabs } from '@server/providers/tts/elevenlabs'
import { createOpenAiTts } from '@server/providers/tts/openai'
import { fetchBytes } from '@server/providers/tts/http'
import type { SynthRequest } from '@server/providers/tts/types'
import { readWav } from '@server/speech/audio'
import { startMockServer, type MockServer } from '../../mocks/server'
import { synthSpeech } from '../../mocks/audio'
import { timelineOf } from './helpers'

let mock: MockServer
let settings: Settings
const keys = new Map<string, { value: string; origin: string }>()

const secrets: SecretsService = {
  list: async () => [...keys.keys()],
  invalid: async () => [],
  async getFor(name, url) {
    const k = keys.get(name)
    if (!k) return null
    if (new URL(url).origin !== k.origin) throw new VesperError('key_origin_mismatch')
    return k.value
  },
  set: async () => undefined,
  delete: async () => undefined,
  rebind: async () => 'kept'
}
const store = { get: () => settings } as unknown as SettingsStore
const env = { secrets, settings: store }

beforeAll(async () => {
  process.env.VESPER_TEST = '1'
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
})
afterAll(async () => {
  delete process.env.VESPER_MOCK_BASE
  await mock.close()
})
beforeEach(() => {
  mock.reset()
  settings = defaultSettings()
  keys.clear()
  keys.set('tts:elevenlabs', { value: 'xi-test-key', origin: 'https://api.elevenlabs.io' })
  keys.set('tts:openai', { value: 'sk-test-key', origin: 'https://api.openai.com' })
})

const req = (o: Partial<SynthRequest> = {}): SynthRequest => ({ text: 'Hello there, friend. It is good to hear you.', voiceId: 'mock-aria', model: 'eleven_v4', tone: null, speed: 1, stability: 0.5, similarity: 0.75, ...o })
const signal = () => new AbortController().signal
const ttsRequests = () => mock.recorder.all().filter((r) => r.path.includes('/text-to-speech/'))

describe('ElevenLabs', () => {
  const el = () => createElevenLabs(env)

  it('with-timestamps: real audio, exact timeline over the spoken text, real duration', async () => {
    const r = await el().synthesize(req(), signal())
    expect(r.timing).toBe('provider')
    expect(r.mime).toBe('audio/wav') // the mock answers mp3 requests with WAV; the container is sniffed
    const wav = readWav(r.audio)!
    expect(r.durationMs).toBeCloseTo(wav.durationMs, 6)
    const truth = timelineOf(req().text, synthSpeech(req().text, { sampleRate: 22050 }))
    expect(r.timeline!.startsMs).toEqual(truth.startsMs.map((x) => Math.round(x * 10) / 10))
    const sent = ttsRequests()[0]
    expect(sent.query.output_format).toBe('mp3_44100_128')
    expect(sent.headers['xi-api-key']).toBe('xi-test-key')
    expect(sent.json).toMatchObject({ model_id: 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    // v4 has no style/speed settings.
    expect((sent.json as { voice_settings: Record<string, unknown> }).voice_settings).not.toHaveProperty('speed')
  })

  it('tone on v3/v4: an audio-tag prefix the timeline does not include; never the raw [tone=] tag @R13', async () => {
    const r = await el().synthesize(req({ tone: 'warm, gently [teasing]' }), signal())
    expect(mock.tts.synthTexts()[0].text).toBe('[warm, gently teasing] Hello there, friend. It is good to hear you.')
    expect(r.timeline!.startsMs).toHaveLength(req().text.length)
    const truth = synthSpeech('[warm, gently teasing] Hello there, friend. It is good to hear you.', { sampleRate: 22050 })
    expect(r.timeline!.startsMs[0]).toBeCloseTo(truth.alignment.character_start_times_seconds['[warm, gently teasing] '.length] * 1000, 0)
    for (const t of mock.tts.synthTexts()) expect(t.text).not.toMatch(/\[tone=/)
  })

  it('tone on v2/flash models: a voice_settings preset, nothing added to the text @R13', async () => {
    await el().synthesize(req({ model: 'eleven_flash_v2_5', tone: 'excited', speed: 1.1, prevText: 'Before.', nextText: 'After.' }), signal())
    expect(mock.tts.synthTexts()[0].text).toBe(req().text)
    const body = ttsRequests()[0].json as { voice_settings: Record<string, number>; previous_text: string; next_text: string }
    expect(body.voice_settings).toMatchObject({ stability: 0.3, style: 0.5 })
    expect(body.voice_settings.speed).toBeCloseTo(1.188, 3)
    expect(body.previous_text).toBe('Before.')
    expect(body.next_text).toBe('After.')
  })

  it.each(['bad-alignment', 'no-audio'] as const)('%s: retried once, then the plain endpoint with PCM and the estimator', async (mode) => {
    mock.tts.mode(mode)
    const r = await el().synthesize(req(), signal())
    const paths = ttsRequests().map((x) => `${x.path}?${x.query.output_format}`)
    expect(paths).toEqual([
      '/v1/text-to-speech/mock-aria/with-timestamps?mp3_44100_128',
      '/v1/text-to-speech/mock-aria/with-timestamps?mp3_44100_128',
      '/v1/text-to-speech/mock-aria?pcm_22050'
    ])
    expect(r).toMatchObject({ mime: 'audio/wav', timing: 'estimate' })
    expect(readWav(r.audio)!.sampleRate).toBe(22050)
    expect(r.timeline!.startsMs).toHaveLength(req().text.length)
  })

  it.each([
    ['unauthorized', 'provider_auth', 401],
    ['quota', 'tts_quota', 401],
    ['rate-limited', 'provider_rate', 429],
    ['server-error', 'provider_overloaded', 500]
  ] as const)('maps %s to %s (never the upstream body)', async (mode, code, status) => {
    mock.tts.mode(mode)
    const e = await el().synthesize(req(), signal()).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(VesperError)
    expect((e as VesperError).info).toMatchObject({ code, upstreamStatus: status })
    expect((e as VesperError).info.message).not.toMatch(/quota of|Invalid API key|Internal server error|concurrent/)
  })

  it('unknown voice → provider_not_found; no key → key_missing; key bound elsewhere → key_origin_mismatch', async () => {
    expect(await el().synthesize(req({ voiceId: 'nope' }), signal()).catch((e: VesperError) => e.info.code)).toBe('provider_not_found')
    keys.delete('tts:elevenlabs')
    expect(await el().synthesize(req(), signal()).catch((e: VesperError) => e.info.code)).toBe('key_missing')
    keys.set('tts:elevenlabs', { value: 'k', origin: 'https://evil.example' })
    expect(await el().synthesize(req(), signal()).catch((e: VesperError) => e.info.code)).toBe('key_origin_mismatch')
  })

  it('voices (paged /v2/voices, premade first), TTS models from /v1/models, quota, preview URLs kept server-side @R12', async () => {
    // First page scripted with has_more: the second request carries the token.
    mock.script({
      method: 'GET',
      path: '/v2/voices',
      json: { voices: [{ voice_id: 'mock-clone', name: 'Clone', category: 'cloned', labels: {}, description: '', preview_url: `${mock.url}/elevenlabs/preview/mock-clone` }], has_more: true, next_page_token: '0' }
    })
    const l = await el().list(signal())
    expect(mock.recorder.all().filter((r) => r.path === '/v2/voices').map((r) => r.query.next_page_token ?? null)).toEqual([null, '0'])
    expect(l.voices.map((v) => v.id)).toEqual(['mock-aria', 'mock-rowan', 'mock-clone'])
    expect(l.voices[0]).toMatchObject({ provider: 'elevenlabs', category: 'premade', gender: 'female', language: 'en', previewable: true })
    expect(l.models.map((m) => m.id)).toEqual(['eleven_v4', 'eleven_flash_v2_5', 'eleven_multilingual_v2'])
    expect(l.models[0]).toMatchObject({ audioTags: true, fast: false, costMultiplier: 1 })
    expect(l.models[1]).toMatchObject({ audioTags: false, fast: true, costMultiplier: 0.5 })
    expect(l.quota).toEqual({ used: 1234, limit: 100_000 })
    expect(l.previews!['mock-aria']).toBe(`${mock.url}/elevenlabs/preview/mock-aria`)
    const p = el()
    expect(p.defaultVoice(l, null)).toBe('mock-aria')
    expect(p.defaultModel(l, false)).toBe('eleven_v4')
    expect(p.defaultModel(l, true)).toBe('eleven_flash_v2_5')
  })

  it("a key without 'Voices: read' says so", async () => {
    mock.tts.mode('no-voice-permission')
    const e = (await el().list(signal()).catch((x: unknown) => x)) as VesperError
    expect(e.info.code).toBe('provider_auth')
    expect(e.info.message).toMatch(/Voices: read/)
  })

  it('validateKey refuses an invalid key and accepts a valid or merely scoped one', async () => {
    await expect(el().validateKey!('xi-good', 'https://api.elevenlabs.io', signal())).resolves.toBeUndefined()
    mock.tts.mode('no-voice-permission')
    await expect(el().validateKey!('xi-scoped', 'https://api.elevenlabs.io', signal())).resolves.toBeUndefined()
    mock.tts.mode('unauthorized')
    await expect(el().validateKey!('xi-bad', 'https://api.elevenlabs.io', signal())).rejects.toMatchObject({ info: { code: 'provider_auth' } })
    expect(mock.recorder.all().map((r) => r.headers['xi-api-key'])).toEqual(['xi-good', 'xi-scoped', 'xi-bad'])
  })
})

describe('OpenAI and OpenAI-compatible', () => {
  it('speech as WAV with an estimated timeline; tone as instructions on gpt-4o-mini-tts only @R13', async () => {
    const p = createOpenAiTts('openai', env)
    const r = await p.synthesize(req({ voiceId: 'marin', model: 'gpt-4o-mini-tts', tone: 'calm', speed: 1.2 }), signal())
    expect(r).toMatchObject({ mime: 'audio/wav', timing: 'estimate' })
    expect(r.durationMs).toBeCloseTo(readWav(r.audio)!.durationMs, 6)
    expect(r.timeline!.startsMs).toHaveLength(req().text.length)
    const body = mock.recorder.last()!.json as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', response_format: 'wav', speed: 1.2, instructions: 'Speak in a calm tone.', input: req().text })
    expect(mock.recorder.last()!.headers.authorization).toBe('Bearer sk-test-key')
    await p.synthesize(req({ voiceId: 'alloy', model: 'tts-1', tone: 'calm' }), signal())
    expect(mock.recorder.last()!.json).not.toHaveProperty('instructions')
  })

  it('maps errors: 401 → provider_auth, insufficient_quota → tts_quota, 429 → provider_rate, 500 → provider_overloaded', async () => {
    const p = createOpenAiTts('openai', env)
    mock.script({ method: 'POST', path: '/v1/audio/speech', status: 401, json: { error: { message: 'Incorrect API key provided: sk-…', type: 'invalid_request_error' } } })
    expect(((await p.synthesize(req(), signal()).catch((e: unknown) => e)) as VesperError).info).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    mock.script({ method: 'POST', path: '/v1/audio/speech', status: 429, json: { error: { code: 'insufficient_quota' } } })
    expect(((await p.synthesize(req(), signal()).catch((e: unknown) => e)) as VesperError).info.code).toBe('tts_quota')
    mock.tts.failNext(429, 1, 'openai')
    expect(((await p.synthesize(req(), signal()).catch((e: unknown) => e)) as VesperError).info.code).toBe('provider_rate')
    mock.tts.failNext(500, 1, 'openai')
    expect(((await p.synthesize(req(), signal()).catch((e: unknown) => e)) as VesperError).info.code).toBe('provider_overloaded')
  })

  it('voices: the documented list, filtered for tts-1; validateKey uses /models', async () => {
    const p = createOpenAiTts('openai', env)
    const l = await p.list(signal())
    expect(l.voices.map((v) => v.id)).toContain('marin')
    settings.voice.tts.provider = 'openai'
    settings.voice.tts.model = 'tts-1'
    expect((await p.list(signal())).voices.map((v) => v.id)).not.toContain('marin')
    expect(p.defaultVoice(l, 'tts-1')).toBe('alloy')
    mock.script({ method: 'GET', path: '/v1/models', status: 401, json: { error: { message: 'bad key' } } })
    await expect(p.validateKey!('sk-bad', 'https://api.openai.com/v1', signal())).rejects.toMatchObject({ info: { code: 'provider_auth' } })
  })

  it('OpenAI-compatible: custom base URL, no key required, voices from /audio/voices', async () => {
    settings.voice.tts.provider = 'openai-compatible'
    settings.voice.tts.baseUrl = `${mock.url}/openai/v1`
    keys.delete('tts:openai-compatible')
    mock.tts.openaiRequiresKey(false)
    const p = createOpenAiTts('openai-compatible', env)
    expect(p.available()).toBe(true)
    mock.script({ method: 'GET', path: '/v1/audio/voices', json: { voices: ['af_heart', 'am_michael'] } })
    const l = await p.list(signal())
    expect(l.voices.map((v) => v.id)).toEqual(['af_heart', 'am_michael'])
    const r = await p.synthesize(req({ voiceId: 'af_heart', model: null }), signal())
    expect(r.mime).toBe('audio/wav')
    expect(mock.recorder.last()!.headers.authorization).toBeUndefined()
    expect(mock.recorder.last()!.json).toMatchObject({ model: 'tts-1', voice: 'af_heart' })
    settings.voice.tts.baseUrl = 'http://192.168.1.5:8880/v1'
    expect(await p.synthesize(req(), signal()).catch((e: VesperError) => e.info.code)).toBe('validation')
  })
})

describe('provider HTTP rules (07 B1)', () => {
  it('never follows redirects, caps response size, times out, honours abort', async () => {
    mock.script({ path: '/redir', status: 302, headers: { location: 'https://evil.example/' }, body: '' })
    await expect(fetchBytes(`${mock.url}/redir`)).rejects.toMatchObject({ info: { code: 'provider_bad_request', upstreamStatus: 302 } })
    mock.script({ path: '/big', body: new Uint8Array(4096) })
    await expect(fetchBytes(`${mock.url}/big`, { maxBytes: 1000 })).rejects.toMatchObject({ info: { code: 'provider_bad_request' } })
    mock.script({ path: '/hang', hang: true })
    await expect(fetchBytes(`${mock.url}/hang`, { timeoutMs: 50 })).rejects.toMatchObject({ info: { code: 'network' } })
    mock.script({ path: '/hang2', hang: true })
    const ac = new AbortController()
    const p = fetchBytes(`${mock.url}/hang2`, { signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await expect(fetchBytes('http://127.0.0.1:1/x', { timeoutMs: 2000 })).rejects.toMatchObject({ info: { code: 'network' } })
  })
})
