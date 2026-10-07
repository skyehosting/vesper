/**
 * Provider HTTP for TTS (07 B1): `redirect: 'manual'`, a timeout, a response size cap, the caller's AbortSignal, and
 * errors mapped to Vesper's codes. Upstream bodies are parsed only to pick a code; they never reach a client or a log.
 * Every timer and listener created here is released before the call returns.
 */
import { VesperError, type ErrorCode } from '@shared/errors'
import { testEnv } from '../../testMode'

export const ELEVEN_BASE = 'https://api.elevenlabs.io'
export const OPENAI_BASE = 'https://api.openai.com/v1'
const PRODUCTION_HOSTS = new Set(['api.elevenlabs.io', 'api.openai.com'])

/**
 * The URL actually fetched. In test mode with VESPER_MOCK_BASE (05 §2) the origin of the fixed production hosts is
 * replaced by the mock's and the path kept. Keys stay bound to the production origin: they are looked up with the
 * logical URL, so the same secret works against the mock and the real service.
 */
export function transportUrl(url: string): string {
  const mock = testEnv('VESPER_MOCK_BASE')
  if (!mock) return url
  const u = new URL(url)
  if (!PRODUCTION_HOSTS.has(u.host)) return url
  return new URL(mock).origin + u.pathname + u.search
}

export interface FetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

export interface FetchResult {
  status: number
  headers: Headers
  bytes: Uint8Array
}

export function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

export function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/** fetch → bytes. Throws AbortError when `signal` aborts, VesperError('network') on timeouts and transport errors. */
export async function fetchBytes(url: string, o: FetchOptions = {}): Promise<FetchResult> {
  if (o.signal?.aborted) throw abortError()
  const ac = new AbortController()
  let timedOut = false
  const onAbort = () => ac.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, o.timeoutMs ?? 30_000)
  try {
    const res = await fetch(transportUrl(url), { method: o.method ?? 'GET', headers: o.headers, body: o.body, redirect: 'manual', signal: ac.signal })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      throw new VesperError('provider_bad_request', { upstreamStatus: res.status })
    }
    const max = o.maxBytes ?? 32 * 1024 * 1024
    const parts: Uint8Array[] = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > max) {
            await reader.cancel().catch(() => undefined)
            throw new VesperError('provider_bad_request', { upstreamStatus: res.status, message: 'The voice service sent an unexpectedly large response.' })
          }
          parts.push(value)
        }
      } finally {
        reader.releaseLock()
      }
    }
    const bytes = new Uint8Array(size)
    let off = 0
    for (const p of parts) {
      bytes.set(p, off)
      off += p.length
    }
    return { status: res.status, headers: res.headers, bytes }
  } catch (e) {
    if (e instanceof VesperError) throw e
    if (o.signal?.aborted && !timedOut) throw abortError()
    throw new VesperError('network')
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

export function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Generic status → code mapping shared by the providers (each refines it with the upstream error code). */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'provider_auth'
  if (status === 402) return 'tts_quota'
  if (status === 404) return 'provider_not_found'
  if (status === 429) return 'provider_rate'
  if (status >= 500) return 'provider_overloaded'
  return 'provider_bad_request'
}

export function retryAfterOf(h: Headers): number | undefined {
  const v = Number(h.get('retry-after'))
  return Number.isFinite(v) && v > 0 ? Math.min(3600, Math.ceil(v)) : undefined
}
