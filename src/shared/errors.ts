/**
 * The one error-code catalogue for REST, WS and the UI (07 C19). Every error that reaches a client is
 * `{code, message, retryable, upstreamStatus?}` with `message` from this table (never an upstream body).
 */

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'sudo_required',
  'desktop_only',
  'not_found',
  'validation',
  'conflict',
  'session_busy',
  'rate_limited',
  'not_implemented',
  'key_origin_mismatch',
  'key_missing',
  'provider_auth',
  'provider_quota',
  'provider_rate',
  'provider_overloaded',
  'provider_error',
  'provider_empty',
  'provider_context',
  'provider_history',
  'provider_refusal',
  'provider_bad_request',
  'provider_not_found',
  'network',
  'disk_full',
  'db_error',
  'stt_unavailable',
  'stt_model_missing',
  'stt_crashed',
  'model_checksum',
  'model_unsafe',
  'mic_denied',
  'mic_os_blocked',
  'insecure_context',
  'tts_failed',
  'tts_quota',
  'memory_unavailable',
  'voyage_backlog',
  'secret_unreadable',
  'port_unavailable',
  'payload_too_large',
  'unsupported_type',
  'internal'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ErrorAction =
  | { kind: 'retry' }
  | { kind: 'settings'; section: string }
  | { kind: 'download-model' }
  | { kind: 'open-uri'; uri: string }
  | { kind: 'login' }
  | { kind: 'none' }

export interface ErrorInfo {
  retryable: boolean
  message: string
  action: ErrorAction
}

export const ERRORS: Record<ErrorCode, ErrorInfo> = {
  unauthorized: { retryable: false, message: 'Please sign in to Vesper.', action: { kind: 'login' } },
  forbidden: { retryable: false, message: "This device isn't allowed to do that.", action: { kind: 'none' } },
  sudo_required: { retryable: false, message: 'Enter your password again to continue.', action: { kind: 'login' } },
  desktop_only: { retryable: false, message: 'This can only be changed in the Vesper app on your PC.', action: { kind: 'none' } },
  not_found: { retryable: false, message: "That couldn't be found. It may have been deleted.", action: { kind: 'none' } },
  validation: { retryable: false, message: "Some values aren't valid.", action: { kind: 'none' } },
  conflict: { retryable: true, message: 'Something changed in the meantime. Try again.', action: { kind: 'retry' } },
  session_busy: { retryable: true, message: 'Vesper is still answering in this conversation.', action: { kind: 'none' } },
  rate_limited: { retryable: true, message: 'Too many attempts. Wait a moment and try again.', action: { kind: 'none' } },
  not_implemented: { retryable: false, message: "This part of Vesper isn't available yet.", action: { kind: 'none' } },
  key_origin_mismatch: {
    retryable: false,
    message: 'The address changed since this key was saved. Enter the key again for the new address.',
    action: { kind: 'settings', section: 'providers' }
  },
  key_missing: { retryable: false, message: 'No API key is saved for this service.', action: { kind: 'settings', section: 'providers' } },
  provider_auth: { retryable: false, message: 'The AI service rejected the API key.', action: { kind: 'settings', section: 'providers' } },
  provider_quota: {
    retryable: false,
    message: 'The AI service says your credit or spending limit is used up.',
    action: { kind: 'settings', section: 'providers' }
  },
  // F68: final-state texts. The engine retries busy/network once and condenses once on a context error before an
  // error is shown, so a shown error never promises more automatic work; Try again counts down `retryAfter`.
  provider_rate: { retryable: true, message: 'The AI service is rate-limiting requests. Try again in a moment.', action: { kind: 'retry' } },
  provider_overloaded: { retryable: true, message: 'The AI service is busy right now.', action: { kind: 'retry' } },
  // F54: a 500 from the service (often a model problem on a local server) is not "busy": retry, or check the model.
  provider_error: {
    retryable: true,
    message: 'The AI service had an internal error. If it keeps happening, check the model in Settings.',
    action: { kind: 'settings', section: 'providers' }
  },
  // F63: the service answered, but with nothing (a web page at the address, an empty stream, a used-up output limit).
  provider_empty: {
    retryable: true,
    message: "The AI service sent an empty reply. Check the address and model in Settings, or try again.",
    action: { kind: 'settings', section: 'providers' }
  },
  provider_context: {
    retryable: true,
    message: "This is too long for the model's context window. Shorten the message or attachment, or choose a model with a larger window.",
    action: { kind: 'settings', section: 'providers' }
  },
  provider_history: { retryable: true, message: 'The AI service rejected part of the conversation history. Try again.', action: { kind: 'retry' } },
  provider_refusal: { retryable: false, message: 'The model declined to answer this.', action: { kind: 'none' } },
  provider_bad_request: { retryable: false, message: 'The AI service rejected the request.', action: { kind: 'settings', section: 'providers' } },
  provider_not_found: { retryable: false, message: "The model or address wasn't found at the AI service.", action: { kind: 'settings', section: 'providers' } },
  network: { retryable: true, message: "Can't reach the service. Check your connection.", action: { kind: 'retry' } },
  disk_full: { retryable: true, message: 'Your disk is almost full; Vesper paused saving.', action: { kind: 'none' } },
  db_error: { retryable: false, message: 'Vesper had trouble with its database.', action: { kind: 'settings', section: 'data' } },
  stt_unavailable: { retryable: true, message: 'Speech recognition is not available right now.', action: { kind: 'retry' } },
  stt_model_missing: { retryable: false, message: 'Download a speech model to use voice input.', action: { kind: 'download-model' } },
  stt_crashed: { retryable: true, message: 'Speech recognition stopped unexpectedly and is restarting.', action: { kind: 'retry' } },
  model_checksum: { retryable: true, message: 'The model download was damaged and has been deleted. Try again.', action: { kind: 'download-model' } },
  model_unsafe: { retryable: false, message: "The downloaded model didn't pass Vesper's safety check and was removed.", action: { kind: 'none' } },
  mic_denied: { retryable: false, message: 'Microphone access was denied.', action: { kind: 'none' } },
  mic_os_blocked: {
    retryable: false,
    message: 'Windows is blocking microphone access for apps.',
    action: { kind: 'open-uri', uri: 'ms-settings:privacy-microphone' }
  },
  insecure_context: {
    retryable: false,
    message: 'The microphone needs a secure (HTTPS) connection. Use Local network (HTTPS) or Tailscale.',
    action: { kind: 'settings', section: 'access' }
  },
  tts_failed: { retryable: true, message: "The voice couldn't be generated; showing text instead.", action: { kind: 'none' } },
  tts_quota: { retryable: false, message: 'The voice service quota is used up.', action: { kind: 'settings', section: 'voice-out' } },
  memory_unavailable: { retryable: true, message: 'Memory search is unavailable; using keyword search.', action: { kind: 'none' } },
  voyage_backlog: { retryable: true, message: 'Memory is still indexing earlier messages.', action: { kind: 'none' } },
  secret_unreadable: {
    retryable: false,
    message: "A saved key can't be unlocked on this Windows account. Please enter it again.",
    action: { kind: 'settings', section: 'providers' }
  },
  port_unavailable: { retryable: false, message: 'The network port Vesper uses is busy.', action: { kind: 'settings', section: 'access' } },
  payload_too_large: { retryable: false, message: 'That file is too large.', action: { kind: 'none' } },
  unsupported_type: { retryable: false, message: "That file type isn't supported.", action: { kind: 'none' } },
  internal: { retryable: true, message: 'Something went wrong inside Vesper.', action: { kind: 'retry' } }
}

export interface ApiError {
  code: ErrorCode
  message: string
  retryable: boolean
  upstreamStatus?: number
  /** Field errors for `validation`. */
  fields?: Record<string, string>
  /** Seconds to wait (rate limits / lockout). */
  retryAfter?: number
}

export function apiError(code: ErrorCode, extra: Partial<Omit<ApiError, 'code'>> = {}): ApiError {
  const info = ERRORS[code]
  return { code, message: extra.message ?? info.message, retryable: info.retryable, ...extra }
}

/** Error class used on the server; serialized as `{error: ApiError}` with an HTTP status. */
export class VesperError extends Error {
  readonly status: number
  readonly info: ApiError
  constructor(code: ErrorCode, extra: Partial<Omit<ApiError, 'code'>> & { status?: number } = {}) {
    const { status, ...rest } = extra
    const info = apiError(code, rest)
    super(info.message)
    this.name = 'VesperError'
    this.info = info
    this.status = status ?? defaultStatus(code)
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401
    case 'forbidden':
    case 'sudo_required':
    case 'desktop_only':
      return 403
    case 'not_found':
      return 404
    case 'validation':
      return 400
    case 'conflict':
    case 'session_busy':
      return 409
    case 'payload_too_large':
      return 413
    case 'unsupported_type':
      return 415
    case 'rate_limited':
      return 429
    case 'not_implemented':
      return 501
    default:
      return 500
  }
}
