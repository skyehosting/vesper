/**
 * ElevenLabs (primary, research 04 §2 + §9.2). Synthesis uses `/v1/text-to-speech/:voice/with-timestamps`; every
 * response is validated (non-empty audio, alignment ≥ 0.9 × the sent characters, finite non-decreasing times). An
 * invalid response is retried once, then the plain endpoint is used with raw PCM and the estimator (the v3/v4
 * "alignment without audio" field report). Tone: an audio-tag prefix for v3/v4 models (its alignment entries are
 * dropped), a voice_settings preset for the others. Voices from paged `/v2/voices` (fallback `/v1/voices`), models
 * from `/v1/models`, key check and quota from `/v1/user/subscription`.
 */
import { estimateTimeline, type Timeline } from '@shared/revealMap'
import { VesperError } from '@shared/errors'
import type { ModelInfo, Voice } from '@shared/types/domain'
import type { SecretsService, SettingsStore } from '../../services'
import { durationOf, readWav, sniffMime, wavFromPcm } from '../../speech/audio'
import { toneTag, tonePreset } from '../../speech/tone'
import { codeForStatus, ELEVEN_BASE, fetchBytes, isRecord, jsonOf, retryAfterOf } from './http'
import type { SynthRequest, SynthResult, TtsProvider, VoiceList } from './types'

const SECRET = 'tts:elevenlabs'
const TAG_MODEL = /^eleven_v\d/
const FAST_MODEL = /turbo|flash/
const SYNTH_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 10_000
const MAX_VOICE_PAGES = 20

interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/** Upstream error → Vesper error (the body only selects the code; it is never forwarded). */
export function elevenError(status: number, body: unknown, headers?: Headers, ctx: 'tts' | 'voices' = 'tts'): VesperError {
  const detail = isRecord(body) && isRecord(body.detail) ? body.detail : {}
  const s = typeof detail.status === 'string' ? detail.status : ''
  if (s === 'quota_exceeded' || status === 402) return new VesperError('tts_quota', { upstreamStatus: status })
  if (s === 'missing_permissions')
    return new VesperError('provider_auth', {
      upstreamStatus: status,
      message: ctx === 'voices' ? "This key can't list voices; enable 'Voices: read' for it in ElevenLabs." : "This ElevenLabs key is missing a permission Vesper needs (Text to Speech)."
    })
  if (status === 401 || status === 403) return new VesperError('provider_auth', { upstreamStatus: status, message: 'ElevenLabs rejected the API key.' })
  if (status === 404) return new VesperError('provider_not_found', { upstreamStatus: status, message: "ElevenLabs doesn't know this voice or model." })
  if (status === 429) return new VesperError('provider_rate', { upstreamStatus: status, retryAfter: headers ? retryAfterOf(headers) : undefined })
  return new VesperError(codeForStatus(status), { upstreamStatus: status })
}

/** Drop the alignment of an injected `[tone] ` prefix and map the rest onto `text`'s UTF-16 indices. */
export function alignmentToTimeline(a: Alignment, prefix: string, text: string): Timeline {
  let chars = a.characters
  let starts = a.character_start_times_seconds
  let ends = a.character_end_times_seconds
  const p = Array.from(prefix)
  if (p.length && chars.slice(0, p.length).join('') === prefix) {
    chars = chars.slice(p.length)
    starts = starts.slice(p.length)
    ends = ends.slice(p.length)
  }
  const startsMs = new Array<number>(text.length)
  const endsMs = new Array<number>(text.length)
  let a0 = 0
  let lastEnd = 0
  let i = 0
  const norm = (s: string) => s.toLowerCase()
  for (const cp of text) {
    let found = -1
    for (let d = 0; d < 8 && a0 + d < chars.length; d++) {
      if (norm(chars[a0 + d]) === norm(cp)) {
        found = a0 + d
        break
      }
    }
    let s: number
    let e: number
    if (found >= 0) {
      s = starts[found] * 1000
      e = Math.max(s, ends[found] * 1000)
      a0 = found + 1
    } else {
      s = lastEnd
      e = lastEnd
    }
    lastEnd = Math.max(lastEnd, e)
    for (let u = 0; u < cp.length; u++) {
      startsMs[i] = Math.round(s * 10) / 10
      endsMs[i] = Math.round(e * 10) / 10
      i++
    }
  }
  // Non-decreasing starts (the reveal never runs backwards).
  for (let k = 1; k < startsMs.length; k++) if (startsMs[k] < startsMs[k - 1]) startsMs[k] = startsMs[k - 1]
  for (let k = 0; k < endsMs.length; k++) if (endsMs[k] < startsMs[k]) endsMs[k] = startsMs[k]
  return { startsMs, endsMs }
}

/** research 04 §9.2: audio present, alignment covers ≥ 90 % of what was sent, times finite and non-decreasing. */
export function validAlignment(body: unknown, sent: string): { audio: Uint8Array; alignment: Alignment } | null {
  if (!isRecord(body) || typeof body.audio_base64 !== 'string' || !body.audio_base64) return null
  const a = body.alignment
  if (!isRecord(a) || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) return null
  const n = a.characters.length
  if (a.character_start_times_seconds.length !== n || a.character_end_times_seconds.length !== n) return null
  if (n < 0.9 * Array.from(sent).length) return null
  let prev = -Infinity
  for (let i = 0; i < n; i++) {
    const s = a.character_start_times_seconds[i]
    const e = a.character_end_times_seconds[i]
    if (typeof a.characters[i] !== 'string' || typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e) || s < prev - 1e-6 || e < s - 1e-6) return null
    prev = s
  }
  const audio = Buffer.from(body.audio_base64, 'base64')
  if (!audio.length) return null
  return { audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength), alignment: a as unknown as Alignment }
}

export function createElevenLabs(env: { secrets: SecretsService; settings: SettingsStore }): TtsProvider {
  async function key(override?: string): Promise<string> {
    if (override) return override
    const k = await env.secrets.getFor(SECRET, ELEVEN_BASE)
    if (!k) throw new VesperError('key_missing')
    return k
  }

  async function getJson(path: string, k: string, signal: AbortSignal, ctx: 'tts' | 'voices' = 'tts'): Promise<unknown> {
    const r = await fetchBytes(`${ELEVEN_BASE}${path}`, { headers: { 'xi-api-key': k, accept: 'application/json' }, signal, timeoutMs: LIST_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 })
    const body = jsonOf(r.bytes)
    if (r.status !== 200) throw elevenError(r.status, body, r.headers, ctx)
    return body
  }

  function bodyFor(req: SynthRequest, prefix: string): string {
    const model = req.model ?? 'eleven_multilingual_v2'
    const tags = TAG_MODEL.test(model)
    const preset = tonePreset(req.tone)
    const voiceSettings: Record<string, unknown> = { stability: req.stability, similarity_boost: req.similarity }
    if (!tags) {
      // v2/flash: tone through voice_settings; v4 has only stability + similarity (research 04 §2.2).
      if (req.tone) voiceSettings.stability = preset.stability
      voiceSettings.style = preset.style
      voiceSettings.use_speaker_boost = true
      voiceSettings.speed = Math.min(1.2, Math.max(0.7, req.speed * preset.speed))
    }
    const b: Record<string, unknown> = { text: prefix + req.text, model_id: model, voice_settings: voiceSettings }
    if (!tags && req.prevText) b.previous_text = req.prevText
    if (!tags && req.nextText) b.next_text = req.nextText
    return JSON.stringify(b)
  }

  async function withTimestamps(req: SynthRequest, voice: string, k: string, prefix: string, signal: AbortSignal): Promise<SynthResult | 'invalid'> {
    const r = await fetchBytes(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': k, 'content-type': 'application/json', accept: 'application/json' },
      body: bodyFor(req, prefix),
      signal,
      timeoutMs: SYNTH_TIMEOUT_MS
    })
    const body = jsonOf(r.bytes)
    if (r.status !== 200) throw elevenError(r.status, body, r.headers)
    const ok = validAlignment(body, prefix + req.text)
    if (!ok) return 'invalid'
    const mime = sniffMime(ok.audio) ?? 'audio/mpeg'
    const timeline = alignmentToTimeline(ok.alignment, prefix, req.text)
    const lastEnd = ok.alignment.character_end_times_seconds.at(-1) ?? 0
    const durationMs = durationOf(ok.audio, mime) ?? lastEnd * 1000
    return { audio: ok.audio, mime, durationMs, timeline, timing: 'provider' }
  }

  /** Fallback: plain endpoint, raw 22.05 kHz PCM (any tier) wrapped as WAV, estimator timeline. */
  async function plain(req: SynthRequest, voice: string, k: string, prefix: string, signal: AbortSignal): Promise<SynthResult> {
    const r = await fetchBytes(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_22050`, {
      method: 'POST',
      headers: { 'xi-api-key': k, 'content-type': 'application/json', accept: 'audio/*' },
      body: bodyFor(req, prefix),
      signal,
      timeoutMs: SYNTH_TIMEOUT_MS
    })
    if (r.status !== 200) throw elevenError(r.status, jsonOf(r.bytes), r.headers)
    if (!r.bytes.length) throw new VesperError('tts_failed', { upstreamStatus: r.status })
    const wav = sniffMime(r.bytes) === 'audio/wav' ? r.bytes : wavFromPcm(r.bytes, 22050)
    const info = readWav(wav)
    if (!info) throw new VesperError('tts_failed', { upstreamStatus: r.status })
    return { audio: wav, mime: 'audio/wav', durationMs: info.durationMs, timeline: estimateTimeline(req.text, info.durationMs, info), timing: 'estimate' }
  }

  function toVoice(v: Record<string, unknown>): Voice | null {
    if (typeof v.voice_id !== 'string' || typeof v.name !== 'string') return null
    const labels = isRecord(v.labels) ? v.labels : {}
    const langs = Array.isArray(v.verified_languages) ? v.verified_languages : []
    const lang = isRecord(langs[0]) && typeof langs[0].language === 'string' ? langs[0].language : typeof labels.language === 'string' ? labels.language : undefined
    return {
      id: v.voice_id,
      name: v.name,
      provider: 'elevenlabs',
      category: typeof v.category === 'string' ? v.category : undefined,
      language: lang,
      gender: typeof labels.gender === 'string' ? labels.gender : undefined,
      description: typeof v.description === 'string' && v.description ? v.description : typeof labels.descriptive === 'string' ? labels.descriptive : undefined,
      previewable: typeof v.preview_url === 'string' && v.preview_url.length > 0
    }
  }

  const provider: TtsProvider = {
    id: 'elevenlabs',
    available: () => true,

    async synthesize(req, signal) {
      const k = await key()
      const voice = req.voiceId
      if (!voice) throw new VesperError('validation', { message: 'Choose an ElevenLabs voice first.' })
      const prefix = TAG_MODEL.test(req.model ?? '') ? toneTag(req.tone) : ''
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await withTimestamps(req, voice, k, prefix, signal)
        if (r !== 'invalid') return r
      }
      return plain(req, voice, k, prefix, signal)
    },

    async list(signal, o) {
      const k = await key(o?.key)
      const voices: Voice[] = []
      const previews: Record<string, string> = {}
      const take = (raw: unknown) => {
        if (!isRecord(raw)) return
        const v = toVoice(raw)
        if (!v || previews[v.id] !== undefined || voices.some((x) => x.id === v.id)) return
        voices.push(v)
        if (typeof raw.preview_url === 'string' && raw.preview_url) previews[v.id] = raw.preview_url
      }
      try {
        let token: string | null = null
        for (let page = 0; page < MAX_VOICE_PAGES; page++) {
          const q = new URLSearchParams({ page_size: '100' })
          if (token) q.set('next_page_token', token)
          const body = await getJson(`/v2/voices?${q}`, k, signal, 'voices')
          const list: unknown[] = isRecord(body) && Array.isArray(body.voices) ? body.voices : []
          list.forEach(take)
          token = isRecord(body) && body.has_more === true && typeof body.next_page_token === 'string' ? body.next_page_token : null
          if (!token) break
        }
      } catch (e) {
        if (!(e instanceof VesperError && e.info.code === 'provider_not_found')) throw e
        const body = await getJson('/v1/voices', k, signal, 'voices')
        ;(isRecord(body) && Array.isArray(body.voices) ? body.voices : []).forEach(take)
      }
      // Premade voices first: the dropdown auto-selects the first one (07 C22).
      voices.sort((a, b) => Number(b.category === 'premade') - Number(a.category === 'premade'))

      const rawModels = await getJson('/v1/models', k, signal)
      const models: ModelInfo[] = []
      for (const m of Array.isArray(rawModels) ? rawModels : []) {
        if (!isRecord(m) || typeof m.model_id !== 'string' || m.can_do_text_to_speech !== true || m.requires_alpha_access === true) continue
        const rates = isRecord(m.model_rates) ? m.model_rates : {}
        models.push({
          id: m.model_id,
          label: typeof m.name === 'string' ? m.name : undefined,
          costMultiplier: typeof rates.character_cost_multiplier === 'number' ? rates.character_cost_multiplier : undefined,
          audioTags: TAG_MODEL.test(m.model_id),
          fast: FAST_MODEL.test(m.model_id),
          maxChars: typeof m.maximum_text_length_per_request === 'number' ? m.maximum_text_length_per_request : undefined
        })
      }
      let quota: VoiceList['quota']
      try {
        const sub = await getJson('/v1/user/subscription', k, signal)
        if (isRecord(sub) && typeof sub.character_count === 'number' && typeof sub.character_limit === 'number') quota = { used: sub.character_count, limit: sub.character_limit }
      } catch (e) {
        // A key scoped without user access still works for speech; it just shows no quota.
        if (!(e instanceof VesperError && e.info.code === 'provider_auth')) throw e
      }
      return { voices, models, quota, previews }
    },

    async validateKey(k, _url, signal) {
      try {
        await getJson('/v1/user/subscription', k, signal)
      } catch (e) {
        if (!(e instanceof VesperError)) throw e
        // Refuse only a key ElevenLabs calls invalid. A key scoped without user access, one whose quota is used up, or
        // an outage does not prove the key bad, so it is kept (the voices fetch after saving reports what is wrong).
        if (e.info.code === 'provider_auth' && !/permission/i.test(e.info.message)) throw e
      }
    },

    defaultVoice(list) {
      return (list.voices.find((v) => v.category === 'premade') ?? list.voices[0])?.id ?? null
    },

    defaultModel(list, fast) {
      const models = list.models
      if (!models.length) return null
      if (fast) {
        // Talk mode (07 D6): the fastest listed model, preferring audio tags (v4 turbo) over flash.
        const f = models.filter((m) => m.fast).sort((a, b) => Number(!!b.audioTags) - Number(!!a.audioTags) || (a.costMultiplier ?? 1) - (b.costMultiplier ?? 1))
        if (f.length) return f[0].id
      }
      // 07 C22: the cheapest model with audio tags, from /v1/models (never hard-coded); else the cheapest.
      const byCost = (a: ModelInfo, b: ModelInfo) => (a.costMultiplier ?? 1) - (b.costMultiplier ?? 1) || Number(!!a.fast) - Number(!!b.fast)
      const tagged = models.filter((m) => m.audioTags).sort(byCost)
      return (tagged[0] ?? [...models].sort(byCost)[0]).id
    }
  }
  return provider
}
