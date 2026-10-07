/**
 * Profile resolution and the HTTP plumbing both adapters use (07 B1): the key is read only for the origin it was bound
 * to, provider fetches never follow redirects and response bodies are size-capped. In test mode VESPER_MOCK_BASE
 * replaces the ORIGIN of a profile's base URL (05 §2); the key binding still uses the configured URL.
 */
import { VesperError } from '@shared/errors'
import { presetById } from '@shared/presets'
import type { LlmProfile, Settings } from '@shared/settings'
import type { ServerContext } from '../../services'
import { testEnv } from '../../testMode'
import { createAnthropicAdapter } from './anthropic'
import { createOpenaiAdapter } from './openai'
import type { LlmAdapter, ResolvedProfile } from './types'

/** Streams may be long, but not unbounded (07 B1). */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 120_000

/** fetch with `redirect:'manual'` and a byte cap on the body. */
export function guardedFetch(maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, { ...init, redirect: 'manual' })
    if (!res.body) return res
    let seen = 0
    const capped = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength
          if (seen > maxBytes) ctl.error(new Error('The AI service sent too much data.'))
          else ctl.enqueue(chunk)
        }
      })
    )
    return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

/**
 * What a "streaming" answer really is (F63): an event stream, a whole JSON reply (a server that ignores
 * `stream: true`), or a web page (a base URL that points at a self-hosted UI, which answers index.html for every path).
 * A missing or other content type is read as a stream (lenient: some local servers omit it).
 */
export function answerKind(res: Response): 'stream' | 'json' | 'html' {
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'application/json' || type.endsWith('+json')) return 'json'
  return 'stream'
}

/** The address answered with a web page: never an AI reply, and never retried blindly (F63). */
export function notAnApi(res: Response): VesperError {
  void res.body?.cancel().catch(() => undefined)
  return new VesperError('provider_bad_request', { message: "The address answered with a web page, not the AI service's API. Check the address in Settings." })
}

/** Test mode only: point a provider URL at the mock server, keeping its path. */
export function effectiveBaseUrl(url: string): string {
  const mock = testEnv('VESPER_MOCK_BASE')
  if (!mock) return url
  try {
    const u = new URL(url)
    const m = new URL(mock)
    return `${m.origin}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return url
  }
}

/** Echo keys (07 C7): reasoning bound to a model for Anthropic and OpenRouter, to the provider elsewhere. */
export function echoKeyFor(profile: Pick<LlmProfile, 'preset'>, model: string): string {
  const p = presetById(profile.preset)
  return profile.preset === 'anthropic' || profile.preset === 'openrouter' ? `${p.echoKey}:${model}` : p.echoKey
}

const DEFAULT_WINDOW: Partial<Record<string, number>> = { anthropic: 200_000, openai: 128_000, gemini: 1_000_000, openrouter: 128_000, ollama: 8192, lmstudio: 8192, custom: 32_000 }

export function contextWindowOf(profile: LlmProfile): number {
  return profile.capabilities.contextWindow ?? DEFAULT_WINDOW[profile.preset] ?? 64_000
}

export function profileById(settings: Settings, id: string | null | undefined): LlmProfile | null {
  const list = settings.llm.profiles
  if (id) {
    const p = list.find((x) => x.id === id)
    if (p) return p
  }
  return list.find((x) => x.id === settings.llm.defaultProfile) ?? list[0] ?? null
}

/** The key and headers for a profile (the key is origin-bound, 07 B1). `keyOverride` = a key typed into the wizard. */
export async function resolveProfile(
  ctx: ServerContext,
  profile: LlmProfile,
  o: { model?: string | null; keyOverride?: string | null; modelOptional?: boolean } = {}
): Promise<ResolvedProfile> {
  const preset = presetById(profile.preset)
  const baseUrl = profile.baseUrl || preset.baseUrl
  if (!baseUrl) throw new VesperError('provider_bad_request', { message: 'This AI provider has no address yet. Add one in Settings.' })
  const model = (o.model || profile.model || '').trim()
  if (!model && !o.modelOptional) throw new VesperError('provider_bad_request', { message: 'Choose a model for this AI provider in Settings.' })
  const key = (o.keyOverride ?? (await ctx.secrets.getFor(`llm:${profile.id}`, baseUrl))) || null
  if (!key && preset.keyRequired) throw new VesperError('key_missing')
  const headers: Record<string, string | null> = {}
  const custom = profile.authHeader.trim()
  if (custom) {
    // A custom header carries the `llm-header:<id>` secret (or the key itself); the preset's own auth header is dropped.
    const value = (await ctx.secrets.getFor(`llm-header:${profile.id}`, baseUrl)) ?? key
    if (value) headers[custom] = value
    if (custom.toLowerCase() !== preset.auth.header.toLowerCase()) headers[preset.auth.header] = null
  } else if (!key) headers[preset.auth.header] = null
  return {
    id: profile.id,
    label: profile.label,
    preset,
    adapter: profile.adapter,
    baseUrl,
    requestBaseUrl: effectiveBaseUrl(baseUrl),
    model,
    key: custom ? null : key,
    headers,
    options: profile.options,
    caps: {
      tools: profile.capabilities.tools ?? preset.defaults.tools,
      vision: profile.capabilities.vision ?? preset.defaults.vision,
      pdf: profile.capabilities.pdf ?? preset.pdfMode !== 'extract-text',
      contextWindow: contextWindowOf(profile)
    },
    echoKey: echoKeyFor(profile, model)
  }
}

export function adapterFor(p: ResolvedProfile): LlmAdapter {
  return p.adapter === 'anthropic' ? createAnthropicAdapter(p) : createOpenaiAdapter(p)
}

/** Raw JSON GET for model lists (tolerant of the shapes in research 01 §3.7), errors mapped by the caller. */
export async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await guardedFetch(8 * 1024 * 1024)(url, { headers, signal })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: 'APIError', status: res.status, headers: res.headers, error: body ?? text.slice(0, 200) })
  return body
}

/** Headers for a raw request, mirroring what the SDKs send. */
export function rawAuthHeaders(p: ResolvedProfile): Record<string, string> {
  const out: Record<string, string> = {}
  if (p.key) out[p.preset.auth.header] = p.preset.auth.scheme ? `${p.preset.auth.scheme} ${p.key}` : p.key
  for (const [k, v] of Object.entries(p.headers)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  if (p.adapter === 'anthropic') out['anthropic-version'] = '2023-06-01'
  return out
}
