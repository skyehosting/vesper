/**
 * Thrown value → client error (07 B1/C19): always Vesper's own code and message from the shared catalogue; never an
 * upstream body, a stack trace or an internal message.
 */
import { apiError, VesperError, type ApiError } from '@shared/errors'
import { isBusy } from '../db/sqlite'
import { zodFields } from '../settings/store'

interface FastifyLikeError {
  statusCode?: number
  code?: string
  validation?: unknown
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof VesperError) return e.info
  if (isZod(e)) return apiError('validation', { fields: zodFields(e.issues) })
  const f = (e ?? {}) as FastifyLikeError
  if (f.validation) return apiError('validation')
  switch (f.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return apiError('payload_too_large')
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return apiError('unsupported_type')
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return apiError('validation', { message: 'The request body is not valid JSON.' })
  }
  if (e instanceof SyntaxError) return apiError('validation', { message: 'The request body is not valid JSON.' })
  if (e instanceof Error && /SQLITE_FULL|database or disk is full/i.test(e.message)) return apiError('disk_full')
  // 07 C9: the main connection waits ≤ 250 ms for db.worker's lock; past that the request can simply be repeated.
  if (isBusy(e)) return apiError('db_error', { retryable: true, message: 'Vesper is busy saving. Try again in a moment.' })
  if (typeof f.statusCode === 'number' && f.statusCode >= 400 && f.statusCode < 500) {
    if (f.statusCode === 404) return apiError('not_found')
    if (f.statusCode === 413) return apiError('payload_too_large')
    if (f.statusCode === 415) return apiError('unsupported_type')
    if (f.statusCode === 429) return apiError('rate_limited')
    return apiError('validation')
  }
  return apiError('internal')
}

/** HTTP status for a thrown value (VesperError knows its own). */
export function statusOf(e: unknown, err: ApiError): number {
  if (e instanceof VesperError) return e.status
  switch (err.code) {
    case 'validation':
      return 400
    case 'not_found':
      return 404
    case 'payload_too_large':
      return 413
    case 'unsupported_type':
      return 415
    case 'rate_limited':
      return 429
    case 'disk_full':
      return 507
    case 'db_error':
      // A busy database (07 C9) is temporary: 503 with retryable; anything else stays a 500.
      return err.retryable ? 503 : 500
    default:
      return 500
  }
}

function isZod(e: unknown): e is { issues: { path: PropertyKey[]; message: string }[] } {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues)
}
