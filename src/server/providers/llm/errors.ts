/**
 * Upstream failures → the error catalogue (07 C19, research 01 §4.2). Only Vesper's own messages reach clients; the
 * upstream status travels as `upstreamStatus` and the provider's body is used only to pick the code, never forwarded.
 */
import { VesperError, type ErrorCode } from '@shared/errors'

interface UpstreamLike {
  name?: string
  message?: string
  status?: number
  headers?: unknown
  error?: unknown
  code?: unknown
  type?: unknown
  cause?: unknown
}

const QUOTA_CODES = /credit_balance_exhausted|insufficient_quota|spend_limit|usage_limit|enforced_spend_limit_reached|billing/i
const CONTEXT_TEXT =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|model_context_window_exceeded|reduce the length|exceeds the maximum|tokens exceed/i
const HISTORY_TEXT = /invalid `?signature`? in `?thinking`? block|bound to a different conversation|thinking block/i
/** "Busy": the service asks to come back later (Anthropic 529 overloaded_error, OpenAI 503 "engine overloaded"). */
const OVERLOADED_TEXT = /overloaded|unavailable|capacity|timeout/i
/** The service failed internally (Anthropic api_error, OpenAI server_error, a local server's 500): not "busy" (F54). */
const SERVER_ERROR_TEXT = /server_error|api_error|internal/i

function headerOf(headers: unknown, name: string): string | null {
  if (!headers) return null
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const v = (headers as Record<string, unknown>)[name]
  return typeof v === 'string' ? v : null
}

/** Text of the upstream error used ONLY for classification (never logged or forwarded). */
function upstreamText(e: UpstreamLike): string {
  const parts: string[] = []
  if (typeof e.message === 'string') parts.push(e.message)
  if (typeof e.code === 'string') parts.push(e.code)
  if (typeof e.type === 'string') parts.push(e.type)
  try {
    if (e.error !== undefined) parts.push(JSON.stringify(e.error))
  } catch {
    /* circular — ignore */
  }
  return parts.join(' ')
}

function retryAfterSec(e: UpstreamLike): number | undefined {
  const raw = headerOf(e.headers, 'retry-after')
  if (!raw) return undefined
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined
}

/** SDK error classes keep `name = 'Error'`; their constructor names identify them. */
function kindOf(e: unknown): string {
  if (!e || typeof e !== 'object') return ''
  const ctor = (e as { constructor?: { name?: unknown } }).constructor?.name
  const name = (e as { name?: unknown }).name
  return typeof ctor === 'string' && ctor !== 'Error' && ctor !== 'Object' ? ctor : typeof name === 'string' ? name : ''
}

export function isAbortError(e: unknown): boolean {
  const k = kindOf(e)
  return k === 'APIUserAbortError' || k === 'AbortError' || (e instanceof Error && e.name === 'AbortError')
}

function isConnectionError(e: UpstreamLike): boolean {
  const k = kindOf(e)
  if (k === 'APIConnectionError' || k === 'APIConnectionTimeoutError') return true
  const c = e.cause as { code?: unknown; cause?: { code?: unknown } } | undefined
  const code = typeof e.code === 'string' ? e.code : typeof c?.code === 'string' ? c.code : typeof c?.cause?.code === 'string' ? c.cause.code : ''
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|EPIPE|EHOSTUNREACH/.test(code) || (k === 'TypeError' && /fetch failed/i.test(e.message ?? ''))
}

/** Classify by status + body. Exported so the error-mapping table test can drive it directly. */
export function classify(status: number | undefined, text: string): ErrorCode {
  if (status === undefined) {
    // In-stream error events carry no status.
    if (/rate_limit/i.test(text)) return 'provider_rate'
    if (QUOTA_CODES.test(text)) return 'provider_quota'
    if (CONTEXT_TEXT.test(text)) return 'provider_context'
    if (HISTORY_TEXT.test(text)) return 'provider_history'
    if (OVERLOADED_TEXT.test(text)) return 'provider_overloaded'
    if (SERVER_ERROR_TEXT.test(text)) return 'provider_error'
    return 'provider_bad_request'
  }
  if (status === 401 || status === 403) return 'provider_auth'
  if (status === 402) return 'provider_quota'
  if (status === 404) return 'provider_not_found'
  if (status === 408 || status === 504) return 'network'
  if (status === 413) return 'provider_context'
  if (status === 429) return QUOTA_CODES.test(text) ? 'provider_quota' : 'provider_rate'
  if (status === 400 || status === 422) {
    if (/specified API usage limits/i.test(text) || QUOTA_CODES.test(text)) return 'provider_quota'
    if (HISTORY_TEXT.test(text)) return 'provider_history'
    if (CONTEXT_TEXT.test(text)) return 'provider_context'
    return 'provider_bad_request'
  }
  if (status >= 500) return status === 502 || status === 503 || status === 529 || OVERLOADED_TEXT.test(text) ? 'provider_overloaded' : 'provider_error'
  if (status >= 300 && status < 400) return 'provider_bad_request'
  return 'provider_bad_request'
}

export const UNREADABLE_REPLY = "The AI service sent a reply Vesper couldn't read. Check the address in Settings, or try again."

/** Any thrown value from an adapter → VesperError (pass-through for our own errors). */
export function mapProviderError(e: unknown): VesperError {
  if (e instanceof VesperError) return e
  // Our own timeouts abort the request; to the user that is "no answer in time".
  if (isAbortError(e)) return new VesperError('network', { message: "The AI service didn't answer in time." })
  // A stream or tool-argument payload that is not valid JSON came from the provider, but it did not "reject" anything
  // (F61): say what happened; a garbled stream may well work on a retry.
  if (e instanceof SyntaxError || kindOf(e) === 'SyntaxError') return new VesperError('provider_bad_request', { message: UNREADABLE_REPLY, retryable: true })
  const u =(e && typeof e === 'object' ? e : { message: String(e) }) as UpstreamLike
  if (isConnectionError(u) && typeof u.status !== 'number') return new VesperError('network')
  const status = typeof u.status === 'number' ? u.status : undefined
  const code = classify(status, upstreamText(u))
  const extra: { upstreamStatus?: number; retryAfter?: number; message?: string } = {}
  if (status !== undefined) extra.upstreamStatus = status
  // The status is a number, never upstream text: it tells a local model's 500 from a cloud hiccup.
  if (code === 'provider_error' && status !== undefined) extra.message = `The AI service had an internal error (HTTP ${status}). If it keeps happening, check the model in Settings.`
  if (code === 'provider_rate') {
    const ra = retryAfterSec(u)
    if (ra !== undefined) extra.retryAfter = ra
  }
  return new VesperError(code, extra)
}

/** A redirect from a provider is refused (07 B1: redirect:'manual'). */
export class RedirectRefused extends Error {
  readonly status: number
  constructor(status: number) {
    super('The AI service answered with a redirect.')
    this.name = 'RedirectRefused'
    this.status = status
  }
}
