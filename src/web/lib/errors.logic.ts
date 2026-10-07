/**
 * The client-side error type. REST and WebSocket failures both surface as an `ApiErrorException` carrying the shared
 * `ApiError` (07 C19), so UI code handles one shape: `err.error.code` picks the action, `err.error.message` is safe to
 * show (it comes from the shared catalogue, never from an upstream body).
 */
import { apiError, ERROR_CODES, type ApiError, type ErrorCode } from '@shared/errors'

export class ApiErrorException extends Error {
  readonly error: ApiError
  /** HTTP status; 0 for network failures and WebSocket errors. */
  readonly status: number

  constructor(error: ApiError, status = 0) {
    super(error.message)
    this.name = 'ApiErrorException'
    this.error = error
    this.status = status
  }

  get code(): ErrorCode {
    return this.error.code
  }
}

export function isApiError(e: unknown, code?: ErrorCode): e is ApiErrorException {
  return e instanceof ApiErrorException && (code === undefined || e.error.code === code)
}

const KNOWN = new Set<string>(ERROR_CODES)

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && KNOWN.has(code)
}

/** Fallback code for a response that has no (recognisable) error body. */
export function statusToCode(status: number): ErrorCode {
  if (status === 0) return 'network'
  if (status === 400 || status === 422) return 'validation'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 413) return 'payload_too_large'
  if (status === 415) return 'unsupported_type'
  if (status === 429) return 'rate_limited'
  if (status === 501) return 'not_implemented'
  if (status === 502 || status === 503 || status === 504) return 'network'
  return 'internal'
}

/**
 * Turn a non-2xx response body into an ApiError. Accepts the server's `{error: ApiError}` envelope; anything else
 * (proxy HTML, empty body, unknown code) falls back to the status. `retryAfterHeader` fills `retryAfter` when the body
 * lacks it.
 */
export function parseErrorBody(status: number, body: unknown, retryAfterHeader?: string | null): ApiError {
  const raw = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  const headerRetry = retryAfterHeader != null && retryAfterHeader !== '' ? Number(retryAfterHeader) : NaN
  if (raw && typeof raw === 'object') {
    const e = raw as Partial<ApiError> & { code?: unknown }
    if (isErrorCode(e.code)) {
      const out = apiError(e.code)
      if (typeof e.message === 'string' && e.message) out.message = e.message
      if (typeof e.retryable === 'boolean') out.retryable = e.retryable
      if (typeof e.upstreamStatus === 'number') out.upstreamStatus = e.upstreamStatus
      if (e.fields && typeof e.fields === 'object') out.fields = e.fields
      if (typeof e.retryAfter === 'number') out.retryAfter = e.retryAfter
      else if (Number.isFinite(headerRetry)) out.retryAfter = headerRetry
      return out
    }
  }
  const out = apiError(statusToCode(status))
  if (Number.isFinite(headerRetry)) out.retryAfter = headerRetry
  return out
}

export function networkError(message?: string): ApiErrorException {
  return new ApiErrorException(apiError('network', message ? { message } : {}), 0)
}

/** Best-effort conversion of anything thrown into an ApiError (for toasts and error states). */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiErrorException) return e.error
  return apiError('internal')
}
