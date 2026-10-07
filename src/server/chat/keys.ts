/**
 * Key checks on save (07 C22 pattern, Phase 3 engine-int): `PUT /api/secrets/llm:<profile>` and `stt:<provider>` make
 * one cheap, free request with the new key before it is stored — the provider's models list (LLM, OpenAI, Groq), or
 * the account/projects endpoint (Deepgram, ElevenLabs). Only a DEFINITE refusal (401/403 that is not a missing
 * permission of a scoped key) refuses the save with 400 `provider_auth`; outages, timeouts, rate limits, unknown
 * profiles and local servers keep the key (the Test button and the first real request report those).
 * Test builds never leave the machine: a check whose transport URL is not loopback is skipped.
 */
import { VesperError } from '@shared/errors'
import { presetById } from '@shared/presets'
import { adapterFor, resolveProfile } from '../providers/llm/client'
import { mapProviderError } from '../providers/llm/errors'
import { testProfile } from '../providers/llm/tester'
import { CLOUD_PROVIDERS, providerUrl, type CloudProviderId } from '../providers/stt/cloud'
import type { ServerContext } from '../services'
import { onSecret } from '../settings/secretHooks'
import { isTestMode } from '../testMode'

const CHECK_TIMEOUT_MS = 10_000
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i
/** A scoped key that may not read the checked endpoint is not a wrong key (ElevenLabs `missing_permissions`). */
const PERMISSION_HINT = /permission|scope/i

/** Test builds: only loopback (mock) URLs are contacted (no network, 05 §2). */
function mayContact(url: string): boolean {
  return LOOPBACK.test(url) || !(__VESPER_TEST__ && isTestMode())
}

function refuse(status: number): never {
  throw new VesperError('provider_auth', { status: 400, upstreamStatus: status, message: 'The provider refused this key. Check it and try again.' })
}

/** llm:<profileId>: the profile's models list with the new key. */
async function checkLlmKey(ctx: ServerContext, name: string, value: string, url: string): Promise<void> {
  const id = name.slice('llm:'.length)
  const saved = ctx.settings.get().llm.profiles.find((p) => p.id === id)
  if (!saved) return // no profile yet (the wizard may save the key first): nothing to check against
  const preset = presetById(saved.preset)
  if (!preset.keyRequired) return // local servers (Ollama, LM Studio) ignore keys
  let p
  try {
    const profile = testProfile(ctx, { profileId: saved.id, preset: saved.preset, baseUrl: url, model: saved.model })
    p = await resolveProfile(ctx, profile, { keyOverride: value, modelOptional: true })
  } catch {
    return // an incomplete profile is not the key's fault
  }
  if (!mayContact(p.requestBaseUrl)) return
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)
  try {
    await adapterFor(p).listModels(signal)
  } catch (e) {
    const ve = mapProviderError(e)
    const status = ve.info.upstreamStatus
    if (ve.info.code === 'provider_auth' && (status === 401 || status === 403)) refuse(status)
    ctx.log.child('chat').info('key check inconclusive; key kept', { name, code: ve.info.code, upstreamStatus: status })
  }
}

/** A free, authenticated request per cloud STT provider. */
function sttCheck(id: CloudProviderId, key: string): { url: string; headers: Record<string, string> } {
  const p = CLOUD_PROVIDERS[id]
  const origin = new URL(p.endpoint).origin
  switch (id) {
    case 'openai':
      return { url: providerUrl(`${origin}/v1/models`), headers: { authorization: `Bearer ${key}` } }
    case 'groq':
      return { url: providerUrl(`${origin}/openai/v1/models`), headers: { authorization: `Bearer ${key}` } }
    case 'deepgram':
      return { url: providerUrl(`${origin}/v1/projects`), headers: { authorization: `Token ${key}` } }
    case 'elevenlabs':
      return { url: providerUrl(`${origin}/v1/user`), headers: { 'xi-api-key': key } }
  }
}

async function checkSttKey(ctx: ServerContext, name: string, value: string): Promise<void> {
  const id = name.slice('stt:'.length)
  if (!(id in CLOUD_PROVIDERS)) return
  const { url, headers } = sttCheck(id as CloudProviderId, value)
  if (!mayContact(url)) return
  let res: Response
  try {
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch {
    return // offline / timeout: keep the key
  }
  // Read at most a little of the body (permission hints only); never forwarded.
  let body = ''
  try {
    body = (await res.text()).slice(0, 2000)
  } catch {
    body = ''
  }
  if ((res.status === 401 || res.status === 403) && !PERMISSION_HINT.test(body)) refuse(res.status)
  if (!res.ok) ctx.log.child('stt').info('key check inconclusive; key kept', { name, upstreamStatus: res.status })
}

/** Register the checks (from the chat WS handler module). */
export function registerKeyChecks(ctx: ServerContext): void {
  onSecret(ctx, {
    match: (name) => name.startsWith('llm:') || name.startsWith('stt:'),
    validate: (name, value, url) => (name.startsWith('llm:') ? checkLlmKey(ctx, name, value, url) : checkSttKey(ctx, name, value))
  })
}
