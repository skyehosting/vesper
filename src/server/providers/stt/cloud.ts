/**
 * Cloud speech-to-text with the user's own key (research 05 §2.7): the server already holds the utterance, so every
 * provider is one upload of a WAV → text. OpenAI and Groq share the OpenAI shape; Deepgram always sends
 * `mip_opt_out=true` (07 B18); ElevenLabs Scribe. Keys come from the secrets service bound to the provider's origin
 * (07 B1). Requests: no redirects, a timeout, a response size cap; failures map to Vesper's own error codes with the
 * upstream status only — never the upstream body (07 C19).
 */
import { VesperError, type ErrorCode } from '@shared/errors'
import type { SttProviderId } from '@shared/settings'
import { STT_MODELS } from '@shared/models'
import type { SecretsService } from '../../services'
import { isTestMode, testEnv } from '../../testMode'

export type CloudProviderId = Exclude<SttProviderId, 'local'>

export interface CloudProvider {
  id: CloudProviderId
  label: string
  secret: `stt:${CloudProviderId}`
  /** The real endpoint (test mode swaps its origin for VESPER_MOCK_BASE). */
  endpoint: string
  defaultModel: string
  models: readonly string[]
}

export const CLOUD_PROVIDERS: Readonly<Record<CloudProviderId, CloudProvider>> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    secret: 'stt:openai',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    defaultModel: 'gpt-4o-mini-transcribe',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-transcribe', 'whisper-1']
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    secret: 'stt:groq',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    defaultModel: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3']
  },
  deepgram: {
    id: 'deepgram',
    label: 'Deepgram',
    secret: 'stt:deepgram',
    endpoint: 'https://api.deepgram.com/v1/listen',
    defaultModel: 'nova-3',
    models: ['nova-3', 'nova-2']
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    secret: 'stt:elevenlabs',
    endpoint: 'https://api.elevenlabs.io/v1/speech-to-text',
    defaultModel: 'scribe_v2',
    models: ['scribe_v2', 'scribe_v1']
  }
}

export function isCloud(p: SttProviderId): p is CloudProviderId {
  return p !== 'local'
}

/**
 * `voice.stt.model` holds the local catalogue id for the local provider and the provider's model name otherwise; a
 * local id (or nothing) left over after switching providers means "the provider's default".
 */
export function cloudModel(p: CloudProvider, configured: string): string {
  const m = configured.trim()
  if (!m || STT_MODELS.some((e) => e.id === m)) return p.defaultModel
  return m
}

/** Test mode with VESPER_MOCK_BASE: same path on the mock's origin (05 §2 "Pointing the app at the mock"). */
export function providerUrl(real: string): string {
  const mock = testEnv('VESPER_MOCK_BASE')
  if (!mock) return real
  const u = new URL(real)
  return `${mock.replace(/\/+$/, '')}${u.pathname}`
}

/** The saved key for `p`, bound to the URL the request goes to (07 B1). */
export async function keyFor(secrets: SecretsService, p: CloudProvider, url: string, explicit?: string): Promise<string> {
  if (explicit) return explicit
  let key: string | null
  try {
    key = await secrets.getFor(p.secret, url)
  } catch (e) {
    // Test builds: a key saved through the UI is bound to the real origin while requests go to the mock.
    if (!(__VESPER_TEST__ && isTestMode() && e instanceof VesperError && e.info.code === 'key_origin_mismatch' && url !== p.endpoint)) throw e
    key = await secrets.getFor(p.secret, p.endpoint)
  }
  if (!key) throw new VesperError('key_missing', { status: 400 })
  return key
}

export interface TranscribeInput {
  wav: Uint8Array
  model: string
  /** ISO-639-1 code or 'auto'. */
  language: string
  key: string
  signal?: AbortSignal
  timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 1024 * 1024

function statusCode(status: number, body: string): ErrorCode {
  if (status === 401 || status === 403) return 'provider_auth'
  if (status === 402) return 'provider_quota'
  if (status === 429) return /insufficient_quota|quota_exceeded|billing/i.test(body) ? 'provider_quota' : 'provider_rate'
  if (status === 404) return 'provider_not_found'
  if (status >= 500) return 'provider_overloaded'
  return 'provider_bad_request'
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new VesperError('provider_bad_request', { status: 502, message: 'The speech service sent an oversized answer.' })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function wavBlob(wav: Uint8Array): Blob {
  return new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
}

function requestFor(p: CloudProvider, i: TranscribeInput, url: string): { url: string; init: RequestInit } {
  const lang = i.language && i.language !== 'auto' ? i.language : null
  switch (p.id) {
    case 'openai':
    case 'groq': {
      const form = new FormData()
      form.append('file', wavBlob(i.wav), 'speech.wav')
      form.append('model', i.model)
      form.append('response_format', 'json')
      if (lang) form.append('language', lang)
      return { url, init: { method: 'POST', headers: { authorization: `Bearer ${i.key}` }, body: form } }
    }
    case 'deepgram': {
      const q = new URLSearchParams({ model: i.model, smart_format: 'true', punctuate: 'true', mip_opt_out: 'true' })
      if (lang) q.set('language', lang)
      else q.set('detect_language', 'true')
      return { url: `${url}?${q}`, init: { method: 'POST', headers: { authorization: `Token ${i.key}`, 'content-type': 'audio/wav' }, body: wavBlob(i.wav) } }
    }
    case 'elevenlabs': {
      const form = new FormData()
      form.append('model_id', i.model)
      form.append('file', wavBlob(i.wav), 'speech.wav')
      form.append('tag_audio_events', 'false')
      if (lang) form.append('language_code', lang)
      return { url, init: { method: 'POST', headers: { 'xi-api-key': i.key }, body: form } }
    }
  }
}

function textOf(p: CloudProvider, json: unknown): string {
  const o = (json ?? {}) as Record<string, unknown>
  if (p.id === 'deepgram') {
    const alt = (o.results as { channels?: { alternatives?: { transcript?: unknown }[] }[] } | undefined)?.channels?.[0]?.alternatives?.[0]
    return typeof alt?.transcript === 'string' ? alt.transcript : ''
  }
  return typeof o.text === 'string' ? o.text : ''
}

/** Upload one utterance; resolves to the trimmed transcript. */
export async function transcribe(p: CloudProvider, i: TranscribeInput): Promise<string> {
  const url = providerUrl(p.endpoint)
  const { url: full, init } = requestFor(p, i, url)
  const timeout = AbortSignal.timeout(i.timeoutMs ?? 30_000)
  const signal = i.signal ? AbortSignal.any([i.signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(full, { ...init, redirect: 'manual', signal })
  } catch (e) {
    if (i.signal?.aborted) throw e
    throw new VesperError('network', { status: 502 })
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined)
    throw new VesperError('provider_bad_request', { status: 502, upstreamStatus: res.status })
  }
  const body = await readCapped(res)
  if (!res.ok) throw new VesperError(statusCode(res.status, body), { status: 502, upstreamStatus: res.status })
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new VesperError('provider_bad_request', { status: 502, upstreamStatus: res.status })
  }
  return textOf(p, json).trim()
}
