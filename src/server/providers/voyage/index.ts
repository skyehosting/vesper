/**
 * Voyage provider glue in the main process: where requests go (07 B1 origin binding + the test-mode mock origin),
 * the key, error mapping to the shared catalogue (07 C19), the wizard's "Test" (ProviderTester 'voyage') and the
 * key-save validation hook (07 C22 style). The embedding/rerank traffic itself runs in db.worker (07 C11).
 */
import { VesperError } from '@shared/errors'
import type { ProviderTestResult } from '@shared/types/domain'
import type { ServerContext } from '../../services'
import { onSecret } from '../../settings/secretHooks'
import { testEnv } from '../../testMode'
import { baseUrlForKey } from './catalogue'
import { createVoyageClient, VoyageError } from './client'

export const VOYAGE_SECRET = 'voyage'
/** A Test call must answer within 10 s (07 D11). */
const TEST_TIMEOUT_MS = 10_000

/**
 * The URL requests are actually sent to. In test mode `VESPER_MOCK_BASE` replaces the origin and keeps the path
 * (05 §2), so `https://api.voyageai.com/v1` → `<mock>/v1`. The key stays bound to the configured URL's origin.
 */
export function effectiveVoyageUrl(configured: string): string {
  const mock = testEnv('VESPER_MOCK_BASE')
  if (!mock) return configured
  try {
    const u = new URL(configured)
    const m = new URL(mock)
    return `${m.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return configured
  }
}

/** The saved Voyage key for the configured base URL, or null (unset, unreadable or bound elsewhere). */
export async function voyageKey(ctx: ServerContext): Promise<string | null> {
  try {
    return await ctx.secrets.getFor(VOYAGE_SECRET, ctx.settings.get().memory.voyage.baseUrl)
  } catch {
    return null
  }
}

/** Voyage failure → a Vesper error (never the upstream body). */
export function voyageError(e: unknown): VesperError {
  if (e instanceof VesperError) return e
  if (!(e instanceof VoyageError)) return new VesperError('internal')
  const upstreamStatus = e.status
  switch (e.kind) {
    case 'auth':
      return new VesperError('provider_auth', { upstreamStatus, message: 'Voyage AI did not accept this API key.' })
    case 'forbidden':
      return new VesperError('provider_auth', { upstreamStatus, message: 'Voyage AI refused requests from this network (403). A VPN or region block may be the cause.' })
    case 'rate':
      return new VesperError('provider_rate', { upstreamStatus, ...(e.retryAfterMs ? { retryAfter: Math.ceil(e.retryAfterMs / 1000) } : {}) })
    case 'server':
      return new VesperError('provider_overloaded', { upstreamStatus })
    case 'not_found':
    case 'gone':
      return new VesperError('provider_not_found', { upstreamStatus, message: e.kind === 'gone' ? 'This Voyage model was retired. Pick another model in Settings → Memory.' : undefined })
    case 'bad_request':
      return new VesperError('provider_bad_request', { upstreamStatus })
    case 'network':
    case 'timeout':
      return new VesperError('network')
    default:
      return new VesperError('internal')
  }
}

/**
 * Research 02 §5.8: a real 1-input query embed at 256 dims (there is no models endpoint). 429 means the key IS valid
 * but rate-limited — typical of the free trial.
 */
export async function testVoyage(o: { key: string; baseUrl: string; model: string }, signal?: AbortSignal): Promise<ProviderTestResult> {
  const client = createVoyageClient({ baseUrl: effectiveVoyageUrl(o.baseUrl), key: o.key, timeoutMs: TEST_TIMEOUT_MS })
  try {
    const r = await client.embed({ input: ['Vesper connection test'], model: o.model, inputType: 'query', dim: 256, dtype: 'float' }, signal)
    return { ok: true, message: `Connected. ${o.model} answered (${r.tokens} tokens).`, models: [{ id: o.model }] }
  } catch (e) {
    if (!(e instanceof VoyageError)) return { ok: false, kind: 'unknown', message: 'The test failed unexpectedly.' }
    const upstreamStatus = e.status
    switch (e.kind) {
      case 'auth': {
        const other = new URL(baseUrlForKey(o.key))
        const hint = other.origin !== safeOrigin(o.baseUrl) ? ` This key looks like it belongs to ${other.host}.` : ''
        return { ok: false, kind: 'auth', upstreamStatus, message: `Voyage AI did not accept this key.${hint}` }
      }
      case 'forbidden':
        return { ok: false, kind: 'permission', upstreamStatus, message: 'Voyage AI refused requests from this network (403). A VPN or region block may be the cause.' }
      case 'rate':
        return { ok: true, kind: 'rate', upstreamStatus, message: 'The key works but is rate-limited — this is typical of the free trial (3 requests per minute).' }
      case 'not_found':
      case 'gone':
        return { ok: false, kind: 'model', upstreamStatus, message: `The model "${o.model}" or the address was not found.` }
      case 'bad_request':
        return { ok: false, kind: 'model', upstreamStatus, message: `Voyage AI rejected the request; check the model "${o.model}".` }
      case 'server':
        return { ok: false, kind: 'unknown', upstreamStatus, message: 'Voyage AI had a server problem. Try again in a minute.' }
      case 'timeout':
      case 'network':
        return { ok: false, kind: 'network', message: "Can't reach Voyage AI. Check your connection and the address." }
      default:
        return { ok: false, kind: 'unknown', message: 'The test was cancelled.' }
    }
  }
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin
  } catch {
    return ''
  }
}

/** ProviderTester 'voyage' + key validation on save. `onKeyChange` lets the memory service reconfigure its worker. */
export function registerVoyageProvider(ctx: ServerContext, onKeyChange: () => void): () => void {
  ctx.services.testers.voyage = {
    async test(input, signal) {
      const s = ctx.settings.get().memory.voyage
      const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl ? input.baseUrl : s.baseUrl
      const model = typeof input.model === 'string' && input.model ? input.model : s.embedModel
      let key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : null
      if (!key) {
        try {
          key = await ctx.secrets.getFor(VOYAGE_SECRET, baseUrl)
        } catch (e) {
          if (e instanceof VesperError) return { ok: false, kind: 'auth', message: e.info.message }
          throw e
        }
      }
      if (!key) return { ok: false, kind: 'auth', message: 'No Voyage AI key is saved yet.' }
      return testVoyage({ key, baseUrl, model }, signal)
    }
  }
  return onSecret(ctx, {
    match: (n) => n === VOYAGE_SECRET,
    async validate(_name, value, url) {
      const r = await testVoyage({ key: value, baseUrl: url, model: ctx.settings.get().memory.voyage.embedModel })
      // Refuse only what proves the key wrong; when Voyage can't be reached the key is kept (it can be tested later).
      if (!r.ok && (r.kind === 'auth' || r.kind === 'permission')) throw new VesperError('provider_auth', { message: r.message, upstreamStatus: r.upstreamStatus })
    },
    saved: () => onKeyChange(),
    deleted: () => onKeyChange()
  })
}
