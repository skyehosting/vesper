/**
 * Map microphone failures to the shared catalogue (07 C19, D8): the UI shows `ERRORS[code].message` and its action.
 *
 *   no secure context / no mediaDevices        → insecure_context  (LAN over plain HTTP; research 07 §5.4)
 *   NotAllowedError "… by system" / NotReadable → mic_os_blocked    (Windows privacy switch, device held elsewhere)
 *   NotFoundError / OverconstrainedError        → mic_os_blocked    (no usable input device)
 *   NotAllowedError / SecurityError             → mic_denied        (the user or the permission handler said no)
 *   no AudioWorklet                              → insecure_context  (it is secure-context-only, like getUserMedia)
 */
import type { ErrorCode } from '@shared/errors'

export interface MicEnvironment {
  isSecureContext: boolean
  hasGetUserMedia: boolean
  hasAudioWorklet: boolean
}

/** Pre-flight: the code that makes capture impossible on this page, or null. */
export function micEnvironmentError(env: MicEnvironment): ErrorCode | null {
  if (!env.isSecureContext || !env.hasGetUserMedia || !env.hasAudioWorklet) return 'insecure_context'
  return null
}

/** A getUserMedia / addModule rejection → error code. */
export function micErrorCode(e: unknown): ErrorCode {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : ''
  const message = typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Chromium says "Permission denied by system" when the OS (Windows privacy settings) blocks capture.
      return /system/i.test(message) ? 'mic_os_blocked' : 'mic_denied'
    case 'SecurityError':
      return 'mic_denied'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'mic_os_blocked'
    case 'AbortError':
      return 'mic_os_blocked'
    default:
      return 'internal'
  }
}
