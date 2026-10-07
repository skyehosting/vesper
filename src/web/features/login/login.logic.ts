/**
 * Pure helpers for sign-in and pairing (07 B15/B16): a readable default device name, the pairing code from the URL
 * fragment, and the plain-words reading of a failed sign-in (wrong password, lockout countdown, suspended remote
 * sign-in, unreachable PC). No DOM (unit-tested, typechecked by the node project too).
 */
import type { ApiError } from '@shared/errors'

/** "Chrome on Android" from a user agent; the user can edit it. */
export function guessDeviceName(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /CriOS\/|Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPod/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'this device'
  return `${browser} on ${os}`
}

/**
 * The one-time pairing code from a `#c=<code>` fragment (research 06 §5.7: a fragment is never sent to the server
 * nor put in Referer). Codes are URL-safe base64/base32 text; anything else is rejected rather than sent.
 */
export function pairCodeFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  for (const part of h.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq) !== 'c') continue
    let v: string
    try {
      v = decodeURIComponent(part.slice(eq + 1)).trim()
    } catch {
      return null
    }
    return /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : null
  }
  return null
}

/** Hosts where a pairing link was minted by "Open in browser" on this PC: those codes need no approval. */
export function isThisPcHost(hostname: string): boolean {
  return hostname === 'vesper.localhost' || hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

export type SignInProblem =
  | { kind: 'wrong'; message: string; retryAfterSec: number | null }
  | { kind: 'locked'; message: string; retryAfterSec: number }
  | { kind: 'suspended'; message: string }
  | { kind: 'no-password'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'other'; message: string; retryAfterSec: number | null }

/** How the login form should react to a failed `POST /api/auth/login` (or pairing redeem). */
export function readSignInError(e: ApiError, passwordSet: boolean): SignInProblem {
  const retry = typeof e.retryAfter === 'number' && e.retryAfter > 0 ? Math.ceil(e.retryAfter) : null
  switch (e.code) {
    case 'unauthorized':
      if (!passwordSet) return { kind: 'no-password', message: e.message }
      return { kind: 'wrong', message: 'That password is not right.', retryAfterSec: retry }
    case 'rate_limited':
      return { kind: 'locked', message: 'Too many attempts.', retryAfterSec: retry ?? 60 }
    case 'forbidden':
      // 07 B15: after 50 wrong passwords in an hour, password sign-in from other devices is suspended until resumed.
      return { kind: 'suspended', message: e.message }
    case 'network':
      return { kind: 'network', message: "Can't reach Vesper. Check that the PC is on and Vesper is running." }
    default:
      return { kind: 'other', message: e.message, retryAfterSec: retry }
  }
}

/** Whole seconds left until `untilMs` (0 when past). */
export function secondsLeft(untilMs: number | null, nowMs: number): number {
  return untilMs ? Math.max(0, Math.ceil((untilMs - nowMs) / 1000)) : 0
}

/** Pending approval expires on the server after 10 minutes (src/server/auth/service.ts PENDING_TTL_MS). */
export const PENDING_TTL_MS = 10 * 60_000
