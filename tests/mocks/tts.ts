/**
 * Mock text-to-speech providers (owner: voice-out-server; foundation version by test-infra).
 *
 *   ElevenLabs  GET /v1/voices · GET /v2/voices (paged) · GET /v1/models · GET /v1/user/subscription
 *               POST /v1/text-to-speech/:voice/with-timestamps → {audio_base64, alignment, normalized_alignment}
 *               POST /v1/text-to-speech/:voice[/stream] → audio bytes · GET /preview/:voice (preview_url target)
 *   OpenAI      POST /v1/audio/speech → audio bytes
 *
 * Audio is a real WAV from ./audio.ts whose alignment matches the samples exactly. MP3 cannot be produced without an
 * encoder, so `mp3_*` / `mp3` requests receive WAV (header `x-mock-audio-format: wav`; decodeAudioData sniffs the
 * container). `pcm_<rate>` / `pcm` return raw PCM16 LE — the raw-PCM scenario of 07 E10.
 * ElevenLabs requests are recognised by `xi-api-key` (or the `/elevenlabs` prefix).
 */
import type { ServerResponse } from 'node:http'
import { bearer, header, isRecord, sendBytes, sendJson, sleep, type MockRequest } from './http'
import { encodeWav, pcmBytes, synthSpeech, type SynthResult } from './audio'
import type { MockModule } from './module'

export type ElevenMode = 'ok' | 'unauthorized' | 'no-voice-permission' | 'quota' | 'rate-limited' | 'server-error' | 'no-audio' | 'bad-alignment'

export interface TtsMock {
  /** ElevenLabs behaviour (OpenAI TTS is unaffected). */
  mode(m: ElevenMode): void
  /** Fail the next `count` synthesis requests of a provider with `status`. */
  failNext(status: number, count?: number, provider?: 'elevenlabs' | 'openai'): void
  /** Delay before each synthesis response (the "chunk not ready within 6 s" rule, 07 C14). */
  setDelay(ms: number): void
  setQuota(used: number, limit: number): void
  /** OpenAI-compatible local servers take no key: false lets `/audio/speech` answer without a bearer. */
  openaiRequiresKey(required: boolean): void
  /**
   * Every text sent for synthesis, in order (assert no `[tone=` ever reaches a provider as text). `tone` is the tone the
   * provider was given, where it can be read back: an ElevenLabs v3/v4 audio-tag prefix (`[warm] Hello` → 'warm') or
   * OpenAI's `instructions`; null when none was sent (other ElevenLabs models carry it in voice_settings: also null).
   */
  synthTexts(): Array<{ provider: 'elevenlabs' | 'openai'; voice: string; model: string; text: string; tone: string | null }>
}

export interface MockVoice {
  voice_id: string
  name: string
  category: 'premade' | 'cloned' | 'generated' | 'professional'
  labels: Record<string, string>
  description: string
}

export const MOCK_VOICES: readonly MockVoice[] = [
  { voice_id: 'mock-aria', name: 'Aria (mock)', category: 'premade', labels: { accent: 'american', gender: 'female', age: 'young', descriptive: 'warm', use_case: 'conversational' }, description: 'Warm and conversational.' },
  { voice_id: 'mock-rowan', name: 'Rowan (mock)', category: 'premade', labels: { accent: 'british', gender: 'male', age: 'middle_aged', descriptive: 'calm', use_case: 'narration' }, description: 'Calm narrator.' },
  { voice_id: 'mock-clone', name: 'My cloned voice (mock)', category: 'cloned', labels: { accent: 'american', gender: 'neutral' }, description: 'A personal clone.' }
]

/** ElevenLabs `/v1/models` (a bare array, as the real API). The STS model must be filtered out by the app. */
export const ELEVEN_MODELS = [
  { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, maximum_text_length_per_request: 5000, languages: [{ language_id: 'en', name: 'English' }], model_rates: { character_cost_multiplier: 1 }, requires_alpha_access: false },
  { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: true, maximum_text_length_per_request: 40000, languages: [{ language_id: 'en', name: 'English' }], model_rates: { character_cost_multiplier: 0.5 }, requires_alpha_access: false },
  { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, maximum_text_length_per_request: 10000, languages: [{ language_id: 'en', name: 'English' }], model_rates: { character_cost_multiplier: 1 }, requires_alpha_access: false },
  { model_id: 'eleven_english_sts_v2', name: 'Eleven English v2 (speech to speech)', can_do_text_to_speech: false, can_use_style: true, can_use_speaker_boost: true, maximum_text_length_per_request: 5000, languages: [{ language_id: 'en', name: 'English' }], model_rates: { character_cost_multiplier: 1 }, requires_alpha_access: false }
] as const

/** Models that read `[audio tags]` instead of speaking them. */
const TAG_MODELS = /^eleven_v[34]/

function elevenError(res: ServerResponse, status: number, s: string, message: string): void {
  sendJson(res, status, { detail: { status: s, message } })
}

function audioFor(format: string | null, defaultRate: number, mp3Rate: number): { kind: 'wav' | 'pcm'; rate: number } {
  const m = /^(pcm|wav|mp3)_(\d+)/.exec(format ?? '')
  if (m) return { kind: m[1] === 'pcm' ? 'pcm' : 'wav', rate: m[1] === 'mp3' ? mp3Rate : Number(m[2]) }
  if (format === 'pcm') return { kind: 'pcm', rate: defaultRate }
  return { kind: 'wav', rate: defaultRate }
}

function bytesOf(s: SynthResult, kind: 'wav' | 'pcm'): Buffer {
  return kind === 'pcm' ? pcmBytes(s.pcm) : encodeWav(s.pcm, s.sampleRate)
}

export function createTtsMock(): TtsMock & MockModule {
  let mode: ElevenMode = 'ok'
  let failures: Array<{ status: number; provider: 'elevenlabs' | 'openai' | null }> = []
  let delayMs = 0
  let quota = { used: 1234, limit: 100_000 }
  let texts: Array<{ provider: 'elevenlabs' | 'openai'; voice: string; model: string; text: string; tone: string | null }> = []
  let openaiKey = true

  const isEleven = (req: MockRequest): boolean => req.forced === 'elevenlabs' || (req.forced === null && header(req, 'xi-api-key') !== undefined)

  function nextFailure(provider: 'elevenlabs' | 'openai'): number | null {
    const i = failures.findIndex((f) => f.provider === null || f.provider === provider)
    return i < 0 ? null : failures.splice(i, 1)[0].status
  }

  /** Auth + mode checks shared by every ElevenLabs route; returns true when an error was sent. */
  function elevenGate(req: MockRequest, res: ServerResponse, needs: 'voices' | 'user' | 'tts' | 'models'): boolean {
    if (!header(req, 'xi-api-key') || mode === 'unauthorized') {
      elevenError(res, 401, 'invalid_api_key', 'Invalid API key')
      return true
    }
    if (mode === 'no-voice-permission' && needs === 'voices') {
      elevenError(res, 401, 'missing_permissions', 'The API key you used is missing the permission voices_read to execute this operation.')
      return true
    }
    return false
  }

  function voiceJson(v: MockVoice, base: string): Record<string, unknown> {
    return {
      ...v,
      preview_url: `${base}/elevenlabs/preview/${v.voice_id}`,
      settings: null,
      verified_languages: [{ language: 'en', model_id: 'eleven_v4', accent: v.labels.accent ?? 'american' }],
      high_quality_base_model_ids: ['eleven_v4', 'eleven_multilingual_v2'],
      is_legacy: false
    }
  }

  async function elevenSynth(req: MockRequest, res: ServerResponse, voiceId: string, timestamps: boolean): Promise<void> {
    if (elevenGate(req, res, 'tts')) return
    const b = isRecord(req.json) ? req.json : {}
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text) return elevenError(res, 422, 'invalid_text', 'text must not be empty')
    if (!MOCK_VOICES.some((v) => v.voice_id === voiceId)) return elevenError(res, 404, 'voice_not_found', `A voice with the voice_id ${voiceId} was not found.`)
    const model = typeof b.model_id === 'string' ? b.model_id : 'eleven_multilingual_v2'
    const fail = nextFailure('elevenlabs')
    if (fail) return elevenError(res, fail, fail === 429 ? 'too_many_concurrent_requests' : 'mock_failure', `Mock failure ${fail}.`)
    if (mode === 'rate-limited') return elevenError(res, 429, 'too_many_concurrent_requests', 'Too many concurrent requests.')
    if (mode === 'server-error') return elevenError(res, 500, 'internal_error', 'Internal server error.')
    if (mode === 'quota' || quota.used + text.length > quota.limit) return elevenError(res, 401, 'quota_exceeded', `This request exceeds your quota of ${quota.limit}.`)
    if (delayMs) await sleep(delayMs)
    texts.push({ provider: 'elevenlabs', voice: voiceId, model, text, tone: TAG_MODELS.test(model) ? (/^\[([^\]]+)\] /.exec(text)?.[1] ?? null) : null })
    quota.used += text.length
    const vs = isRecord(b.voice_settings) ? b.voice_settings : {}
    const fmt = audioFor(req.query.get('output_format'), 22050, 22050)
    const s = synthSpeech(text, { sampleRate: fmt.rate, speed: typeof vs.speed === 'number' ? vs.speed : 1, audioTags: TAG_MODELS.test(model) })
    const audio = bytesOf(s, fmt.kind)
    const headers = { 'x-mock-audio-format': fmt.kind, 'x-mock-sample-rate': String(fmt.rate), 'request-id': `el_mock_${texts.length}` }
    if (!timestamps) return sendBytes(res, 200, audio, fmt.kind === 'pcm' ? 'audio/pcm' : 'audio/wav', headers)
    let alignment = s.alignment
    if (mode === 'bad-alignment') {
      const half = Math.floor(alignment.characters.length / 2)
      alignment = { characters: alignment.characters.slice(0, half), character_start_times_seconds: alignment.character_start_times_seconds.slice(0, half), character_end_times_seconds: alignment.character_end_times_seconds.slice(0, half) }
    }
    sendJson(res, 200, { audio_base64: mode === 'no-audio' ? '' : audio.toString('base64'), alignment, normalized_alignment: alignment }, headers)
  }

  async function openaiSpeech(req: MockRequest, res: ServerResponse): Promise<void> {
    if (openaiKey && !bearer(req)) return sendJson(res, 401, { error: { message: 'Missing bearer authentication in header', type: 'invalid_request_error', param: null, code: null } })
    const b = isRecord(req.json) ? req.json : {}
    const input = typeof b.input === 'string' ? b.input : ''
    if (!input) return sendJson(res, 400, { error: { message: "Missing required parameter: 'input'.", type: 'invalid_request_error', param: 'input', code: 'missing_required_parameter' } })
    if (input.length > 4096) return sendJson(res, 400, { error: { message: 'input is longer than 4096 characters.', type: 'invalid_request_error', param: 'input', code: null } })
    const fail = nextFailure('openai')
    if (fail) return sendJson(res, fail, { error: { message: `Mock failure ${fail}.`, type: fail === 429 ? 'requests' : 'server_error', param: null, code: null } })
    if (delayMs) await sleep(delayMs)
    texts.push({ provider: 'openai', voice: String(b.voice ?? ''), model: String(b.model ?? ''), text: input, tone: typeof b.instructions === 'string' ? b.instructions : null })
    // OpenAI's raw `pcm` is 24 kHz 16-bit LE; every other format is served as a 24 kHz WAV.
    const fmt = audioFor(typeof b.response_format === 'string' ? b.response_format : 'mp3', 24000, 24000)
    const s = synthSpeech(input, { sampleRate: 24000, speed: typeof b.speed === 'number' ? b.speed : 1, audioTags: false })
    sendBytes(res, 200, bytesOf(s, fmt.kind), fmt.kind === 'pcm' ? 'audio/pcm' : 'audio/wav', { 'x-mock-audio-format': fmt.kind, 'x-mock-sample-rate': '24000' })
  }

  return {
    name: 'tts',
    prefixes: ['elevenlabs', 'openai'],
    mode(m) {
      mode = m
    },
    failNext(status, count = 1, provider) {
      for (let i = 0; i < count; i++) failures.push({ status, provider: provider ?? null })
    },
    setDelay(ms) {
      delayMs = ms
    },
    setQuota(used, limit) {
      quota = { used, limit }
    },
    openaiRequiresKey(required) {
      openaiKey = required
    },
    synthTexts() {
      return [...texts]
    },
    reset() {
      mode = 'ok'
      failures = []
      delayMs = 0
      quota = { used: 1234, limit: 100_000 }
      texts = []
      openaiKey = true
    },
    async handle(req, res) {
      if (req.method === 'POST' && req.path.endsWith('/audio/speech') && (req.forced === null || req.forced === 'openai')) {
        await openaiSpeech(req, res)
        return true
      }
      if (!isEleven(req)) return false
      const p = req.path
      if (req.method === 'GET' && p.startsWith('/preview/')) {
        const v = MOCK_VOICES.find((x) => x.voice_id === decodeURIComponent(p.slice('/preview/'.length)))
        if (v) sendBytes(res, 200, encodeWav(synthSpeech(`Hello, I am ${v.name}.`).pcm, 22050), 'audio/wav')
        else elevenError(res, 404, 'voice_not_found', 'voice not found')
        return true
      }
      if (req.method === 'GET' && p === '/v1/voices') {
        if (!elevenGate(req, res, 'voices')) sendJson(res, 200, { voices: MOCK_VOICES.map((v) => voiceJson(v, req.base)) })
        return true
      }
      if (req.method === 'GET' && p === '/v2/voices') {
        if (elevenGate(req, res, 'voices')) return true
        const size = Math.min(100, Math.max(1, Number(req.query.get('page_size') ?? 10)))
        const from = Number(req.query.get('next_page_token') ?? 0) || 0
        const search = (req.query.get('search') ?? '').toLowerCase()
        const category = req.query.get('category')
        const all = MOCK_VOICES.filter((v) => (!search || v.name.toLowerCase().includes(search)) && (!category || v.category === category))
        const page = all.slice(from, from + size)
        const more = from + size < all.length
        sendJson(res, 200, { voices: page.map((v) => voiceJson(v, req.base)), has_more: more, total_count: all.length, next_page_token: more ? String(from + size) : null })
        return true
      }
      if (req.method === 'GET' && p === '/v1/models') {
        if (!elevenGate(req, res, 'models')) sendJson(res, 200, ELEVEN_MODELS)
        return true
      }
      if (req.method === 'GET' && p === '/v1/user/subscription') {
        if (!elevenGate(req, res, 'user'))
          sendJson(res, 200, { tier: 'creator', character_count: quota.used, character_limit: quota.limit, can_extend_character_limit: true, allowed_to_extend_character_limit: false, next_character_count_reset_unix: 1_798_761_600, voice_limit: 30, status: 'active', currency: 'usd' })
        return true
      }
      const m = /^\/v1\/text-to-speech\/([^/]+)(\/stream)?(\/with-timestamps)?$/.exec(p)
      if (req.method === 'POST' && m) {
        await elevenSynth(req, res, decodeURIComponent(m[1]), m[3] !== undefined)
        return true
      }
      return false
    }
  }
}
