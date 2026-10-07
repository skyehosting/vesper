/**
 * OpenAI `/v1/audio/speech` and OpenAI-compatible servers (custom base URL, e.g. a local Kokoro-FastAPI) — research 04
 * §3. Audio is requested as WAV ("fastest response times"; exact duration; PCM for the estimator). OpenAI returns no
 * timing, so the timeline is the estimator with silence snapping over the decoded PCM. Tone goes into `instructions`
 * on gpt-4o-mini-tts models and is ignored by tts-1/tts-1-hd. Voices: OpenAI has no list endpoint, so the documented
 * list ships here (filtered by model); compatible servers are asked for `/audio/voices` first.
 */
import { estimateTimeline } from '@shared/revealMap'
import { VesperError } from '@shared/errors'
import { baseUrlProblem } from '@shared/settings'
import type { ModelInfo, Voice } from '@shared/types/domain'
import type { SecretsService, SettingsStore } from '../../services'
import { durationOf, readWav, sniffMime, wavFromPcm } from '../../speech/audio'
import { toneInstructions } from '../../speech/tone'
import { codeForStatus, fetchBytes, isRecord, jsonOf, OPENAI_BASE, retryAfterOf } from './http'
import type { SynthResult, TtsProvider } from './types'

/** research 04 §3 (verified 2026-10-05): 13 voices; tts-1/tts-1-hd support 9. */
export const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const
const TTS1_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
export const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS (tone instructions)', maxChars: 4096 },
  { id: 'tts-1', label: 'TTS-1 (fast)', maxChars: 4096, fast: true },
  { id: 'tts-1-hd', label: 'TTS-1 HD', maxChars: 4096 }
]
const SYNTH_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 10_000

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function openaiError(status: number, body: unknown, headers?: Headers): VesperError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {}
  const code = typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : ''
  if (code === 'insufficient_quota' || status === 402) return new VesperError('tts_quota', { upstreamStatus: status })
  if (status === 401 || status === 403) return new VesperError('provider_auth', { upstreamStatus: status, message: 'The voice service rejected the API key.' })
  if (status === 429) return new VesperError('provider_rate', { upstreamStatus: status, retryAfter: headers ? retryAfterOf(headers) : undefined })
  return new VesperError(codeForStatus(status), { upstreamStatus: status })
}

export function createOpenAiTts(kind: 'openai' | 'openai-compatible', env: { secrets: SecretsService; settings: SettingsStore }): TtsProvider {
  const secret = `tts:${kind}`

  function base(override?: string): string {
    if (kind === 'openai') return OPENAI_BASE
    const b = (override ?? env.settings.get().voice.tts.baseUrl).trim().replace(/\/+$/, '')
    if (!b) throw new VesperError('validation', { message: 'Enter the address of your OpenAI-compatible voice server.', fields: { baseUrl: 'Required' } })
    const problem = baseUrlProblem(b)
    if (problem) throw new VesperError('validation', { fields: { baseUrl: problem } })
    return b
  }

  async function headers(b: string, override?: string): Promise<Record<string, string>> {
    const k = override ?? (await env.secrets.getFor(secret, b))
    if (!k && kind === 'openai') throw new VesperError('key_missing')
    return k ? { authorization: `Bearer ${k}` } : {}
  }

  function voicesFor(model: string | null): Voice[] {
    const tts1 = !!model && /^tts-1/.test(model)
    return OPENAI_VOICES.filter((v) => !tts1 || TTS1_VOICES.has(v)).map((v) => ({ id: v, name: cap(v), provider: kind, previewable: false }))
  }

  const provider: TtsProvider = {
    id: kind,
    available: () => kind === 'openai' || env.settings.get().voice.tts.baseUrl.trim().length > 0,

    async synthesize(req, signal) {
      const b = base()
      const model = req.model ?? (kind === 'openai' ? 'gpt-4o-mini-tts' : 'tts-1')
      const body: Record<string, unknown> = {
        model,
        input: req.text,
        voice: req.voiceId ?? provider.defaultVoice({ voices: voicesFor(model), models: [] }, model),
        response_format: 'wav',
        speed: Math.min(4, Math.max(0.25, req.speed))
      }
      const instructions = /^gpt-4o/.test(model) ? toneInstructions(req.tone) : null
      if (instructions) body.instructions = instructions
      const r = await fetchBytes(`${b}/audio/speech`, {
        method: 'POST',
        headers: { ...(await headers(b)), 'content-type': 'application/json', accept: 'audio/*' },
        body: JSON.stringify(body),
        signal,
        timeoutMs: SYNTH_TIMEOUT_MS
      })
      if (r.status !== 200) throw openaiError(r.status, jsonOf(r.bytes), r.headers)
      if (!r.bytes.length) throw new VesperError('tts_failed', { upstreamStatus: r.status })
      let audio = r.bytes
      let mime = sniffMime(audio)
      // A server that ignores response_format and streams raw PCM: OpenAI's raw format is 24 kHz 16-bit LE.
      if (!mime && /pcm|L16|octet/i.test(r.headers.get('content-type') ?? '')) {
        audio = wavFromPcm(audio, 24000)
        mime = 'audio/wav'
      }
      if (!mime) throw new VesperError('tts_failed', { upstreamStatus: r.status })
      const wav = mime === 'audio/wav' ? readWav(audio) : null
      if (wav) return { audio, mime, durationMs: wav.durationMs, timeline: estimateTimeline(req.text, wav.durationMs, wav), timing: 'estimate' } satisfies SynthResult
      const durationMs = durationOf(audio, mime)
      if (durationMs === null) throw new VesperError('tts_failed', { upstreamStatus: r.status })
      // MP3 from a compatible server: the client estimates from the duration (timeline null).
      return { audio, mime, durationMs, timeline: null, timing: 'none' }
    },

    async list(signal, o) {
      const model = env.settings.get().voice.tts.provider === kind ? env.settings.get().voice.tts.model : null
      if (kind === 'openai') {
        if (o?.key) await provider.validateKey?.(o.key, OPENAI_BASE, signal)
        return { voices: voicesFor(model), models: OPENAI_MODELS }
      }
      const b = base(o?.baseUrl)
      const h = await headers(b, o?.key)
      let voices = voicesFor(model)
      const r = await fetchBytes(`${b}/audio/voices`, { headers: { ...h, accept: 'application/json' }, signal, timeoutMs: LIST_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 }).catch((e: unknown) => {
        if (e instanceof VesperError && e.info.code === 'network') throw e
        return null
      })
      if (r && (r.status === 401 || r.status === 403)) throw openaiError(r.status, null)
      const body = r && r.status === 200 ? jsonOf(r.bytes) : null
      const list: unknown[] = isRecord(body) && Array.isArray(body.voices) ? body.voices : []
      const own = list
        .map((v): Voice | null => {
          if (typeof v === 'string') return { id: v, name: v, provider: kind, previewable: false }
          if (isRecord(v) && typeof (v.id ?? v.voice_id ?? v.name) === 'string') {
            const id = String(v.id ?? v.voice_id ?? v.name)
            return { id, name: typeof v.name === 'string' ? v.name : id, provider: kind, previewable: false }
          }
          return null
        })
        .filter((v): v is Voice => v !== null)
      if (own.length) voices = own
      const models: ModelInfo[] = [{ id: 'tts-1', label: 'tts-1' }]
      if (model && model !== 'tts-1') models.push({ id: model, label: model })
      return { voices, models }
    },

    async validateKey(k, url, signal) {
      // A cheap authenticated call: list models (free).
      const b = kind === 'openai' ? OPENAI_BASE : url.replace(/\/+$/, '')
      const r = await fetchBytes(`${b}/models`, { headers: { authorization: `Bearer ${k}`, accept: 'application/json' }, signal, timeoutMs: LIST_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 }).catch((e: unknown) => {
        if (e instanceof VesperError) return null // unreachable now: keep the key, the voices fetch reports it
        throw e
      })
      if (r && (r.status === 401 || r.status === 403)) throw openaiError(r.status, jsonOf(r.bytes))
    },

    defaultVoice(list, model) {
      const ids = list.voices.map((v) => v.id)
      if (kind === 'openai') return model && /^tts-1/.test(model) ? 'alloy' : 'marin'
      return ids[0] ?? 'alloy'
    },

    defaultModel() {
      // gpt-4o-mini-tts is the only OpenAI model that takes tone instructions; compatible servers accept "tts-1".
      return kind === 'openai' ? 'gpt-4o-mini-tts' : 'tts-1'
    }
  }
  return provider
}
