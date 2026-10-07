/**
 * Permission policy for the `persist:vesper` partition (07 B11): only our own loopback origin, and only the microphone
 * (audio, never video), sanitized clipboard writes and fullscreen. Everything else — notifications (main shows them),
 * geolocation, HID/USB/serial, clipboard reads, display capture, openExternal (main validates links itself) — is
 * denied. Pure — unit-tested in tests/unit/main/permissions.test.ts.
 */
import { originOf } from './urls'

const ALWAYS_FOR_OWN_ORIGIN = new Set(['clipboard-sanitized-write', 'fullscreen'])

export interface PermissionQuery {
  permission: string
  /** URL or origin of the requesting frame (security origin for media). */
  requester: string | null | undefined
  /** Our loopback origin (`http://127.0.0.1:<port>`), null before the server runs. */
  allowedOrigin: string | null
  /** Media requests: the kinds asked for ('audio' | 'video' | 'unknown'). */
  mediaTypes?: readonly string[]
}

export function decidePermission(q: PermissionQuery): boolean {
  if (!q.allowedOrigin || originOf(q.requester) !== q.allowedOrigin) return false
  if (q.permission === 'media') return !!q.mediaTypes && q.mediaTypes.length > 0 && q.mediaTypes.every((t) => t === 'audio')
  return ALWAYS_FOR_OWN_ORIGIN.has(q.permission)
}
