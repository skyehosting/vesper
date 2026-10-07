/**
 * AI provider profiles for Settings → AI providers and the wizard's step 1 (07 D11): new-profile defaults (from the
 * shared schema, never literals — 07 E12), unique ids, and the Test result → the specific message the owner sees
 * (401 = key, 404 = address or model, timeout = network/firewall, …). Pure: unit-tested.
 */
import { presetById, type Preset } from '@shared/presets'
import { settingsSchema, type LlmProfile, type PresetId } from '@shared/settings'
import type { ModelInfo, ProviderTestResult } from '@shared/types/domain'

/** A profile id from the preset id, unique among `taken` ('openai', 'openai-2', …). */
export function uniqueProfileId(base: string, taken: readonly string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'ai'
  if (!taken.includes(clean)) return clean
  for (let i = 2; ; i++) if (!taken.includes(`${clean}-${i}`)) return `${clean}-${i}`
}

/** A complete new profile for `preset`, with every default filled by the shared schema. */
export function newProfile(presetId: PresetId, taken: readonly string[]): LlmProfile {
  const p = presetById(presetId)
  const raw = { id: uniqueProfileId(p.id, taken), label: p.label.replace(/\s*\(.*\)$/, ''), preset: p.id, adapter: p.adapter, baseUrl: p.baseUrl }
  return settingsSchema.parse({ llm: { profiles: [raw] } }).llm.profiles[0]
}

/** Switch an existing profile to another preset (keeps id, label if renamed, and options). */
export function withPreset(profile: LlmProfile, presetId: PresetId): LlmProfile {
  const p = presetById(presetId)
  const old = presetById(profile.preset)
  const renamed = profile.label !== old.label.replace(/\s*\(.*\)$/, '')
  return {
    ...profile,
    preset: p.id,
    adapter: p.adapter,
    baseUrl: p.baseUrl,
    model: '',
    label: renamed ? profile.label : p.label.replace(/\s*\(.*\)$/, ''),
    capabilities: {}
  }
}

export function secretName(profileId: string): string {
  return `llm:${profileId}`
}
export function headerSecretName(profileId: string): string {
  return `llm-header:${profileId}`
}

/** Host of a URL for messages ("api.openai.com"); the raw text when it isn't a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url || 'the service'
  }
}

/** "1 model is available." / "12 models are available." (fix5-ui P04) */
export function modelsAvailable(n: number): string {
  return n === 1 ? '1 model is available.' : `${n} models are available.`
}

/** The model list's hint: "1 model from OpenAI." / "12 models from OpenAI." */
export function modelsFrom(n: number, service: string): string {
  return `${n} ${n === 1 ? 'model' : 'models'} from ${service}.`
}

/**
 * A service that lists exactly one model (a local LM Studio/Ollama server, a custom endpoint) while none is chosen:
 * that one is the choice, so the editor picks it (and tests it) instead of leaving Continue blocked.
 */
export function soleModel(models: readonly { id: string }[] | null | undefined, chosen: string): string | null {
  return !chosen && models?.length === 1 ? models[0].id : null
}

export interface TestView {
  tone: 'success' | 'danger' | 'warning'
  title: string
  body: string
}

/**
 * The owner-facing text for a Test result. The server's message is already Vesper's own (never an upstream body);
 * this adds the "what to do" for each kind.
 */
export function testView(r: ProviderTestResult, o: { service: string; baseUrl: string; model: string; timedOut?: boolean }): TestView {
  const host = hostOf(o.baseUrl)
  const code = r.upstreamStatus ? ` (${r.upstreamStatus})` : ''
  if (o.timedOut) return { tone: 'danger', title: 'No answer within 10 seconds', body: `${host} didn't answer in time. Check the address, your internet connection, or whether a firewall or VPN blocks it.` }
  if (r.ok) {
    const n = r.models?.length ?? 0
    return {
      tone: 'success',
      title: o.model ? 'Connected — the model answered' : 'Connected',
      body: o.model ? `${o.service} answered with ${o.model}.${n ? ` ${modelsAvailable(n)}` : ''}` : n ? `${modelsAvailable(n)} Choose ${n === 1 ? 'it' : 'one'} below.` : 'Choose a model below.'
    }
  }
  switch (r.kind) {
    case 'auth':
      if (/no api key/i.test(r.message)) return { tone: 'danger', title: 'No key saved yet', body: `Paste your ${o.service} API key above and save it, then test again.` }
      if (/address changed/i.test(r.message)) return { tone: 'danger', title: 'Enter the key again', body: r.message }
      if (/can't be unlocked/i.test(r.message)) return { tone: 'danger', title: 'The saved key is unreadable', body: r.message }
      return {
        tone: 'danger',
        title: `The key was rejected${code}`,
        body: `${o.service} didn't accept this API key. Check that you copied all of it and that it belongs to ${o.service}.`
      }
    case 'model':
      return o.model
        ? { tone: 'danger', title: `Model not found${code}`, body: `${o.service} doesn't offer “${o.model}” to this key. Pick another model from the list.` }
        : { tone: 'danger', title: `Nothing found at this address${code}`, body: `${host} answered, but not as an AI service. Check the URL — most services end in /v1.` }
    case 'url':
      return { tone: 'danger', title: 'Check the address', body: r.message }
    case 'network':
      return /in time|timed? ?out/i.test(r.message)
        ? { tone: 'danger', title: 'No answer within 10 seconds', body: `${host} didn't answer in time. Check the address, your internet connection, or whether a firewall or VPN blocks it.` }
        : { tone: 'danger', title: `Can't reach ${host}`, body: 'Check the address and your internet connection. If the service runs on this PC, make sure it is started.' }
    case 'quota':
      return { tone: 'warning', title: `No credit left${code}`, body: `${o.service} says the credit or spending limit for this key is used up. Add credit in your ${o.service} account, then test again.` }
    case 'rate':
      return { tone: 'warning', title: `Too many requests${code}`, body: `${o.service} is rate-limiting this key. Wait a moment and test again.` }
    case 'permission':
      return { tone: 'danger', title: `Not allowed${code}`, body: `This key can't use that part of ${o.service}. Check the key's permissions.` }
    default:
      return { tone: 'danger', title: `The test failed${code}`, body: r.message || `${o.service} rejected the test request.` }
  }
}

/**
 * The key field's message when the server refuses a key on save (engine-int's key check: `PUT /api/secrets/llm:*`
 * answers 400 `provider_auth` with the provider's `upstreamStatus`), worded like the Test's "The key was rejected".
 */
export function keyRefusal(service: string, upstreamStatus?: number): string {
  const code = upstreamStatus ? ` (${upstreamStatus})` : ''
  return `${service} rejected this key${code}. Check that you copied all of it and that it belongs to ${service}.`
}

/** Short capability summary for a model row: tools · vision · PDF · reasoning · context size. */
export function capabilityTags(m: Pick<ModelInfo, 'caps' | 'contextWindow'>): string[] {
  const out: string[] = []
  if (m.caps?.tools) out.push('Tools')
  if (m.caps?.vision) out.push('Vision')
  if (m.caps?.pdf) out.push('PDF')
  if (m.caps?.reasoning) out.push('Reasoning')
  if (m.contextWindow) out.push(contextLabel(m.contextWindow))
  return out
}

export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

/** Capabilities to store on the profile when a model is chosen (only what the list knows; unknown stays unset). */
export function capabilitiesFor(m: ModelInfo | undefined): LlmProfile['capabilities'] {
  if (!m) return {}
  const c: LlmProfile['capabilities'] = {}
  if (m.caps?.tools !== undefined) c.tools = m.caps.tools
  if (m.caps?.vision !== undefined) c.vision = m.caps.vision
  if (m.caps?.pdf !== undefined) c.pdf = m.caps.pdf
  if (m.contextWindow) c.contextWindow = m.contextWindow
  return c
}

/** Is the profile ready to chat? (model chosen; key saved when the service needs one) */
export function profileReady(p: LlmProfile, preset: Preset, keySaved: boolean): boolean {
  return !!p.baseUrl && !!p.model && (!preset.keyRequired || keySaved)
}
