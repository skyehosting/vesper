/**
 * URL rules of the desktop shell (07 B8, B11). Pure — unit-tested in tests/unit/main/urls.test.ts.
 */

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const MAX_EXTERNAL_URL = 4096

/** The origin of `url` (`http://127.0.0.1:41730`), or null for unparsable / opaque URLs. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const o = new URL(url).origin
    return o && o !== 'null' ? o : null
  } catch {
    return null
  }
}

/** True when `url` is on exactly `allowedOrigin` (scheme, host and port). */
export function isSameOrigin(url: string | null | undefined, allowedOrigin: string | null): boolean {
  return !!allowedOrigin && originOf(url) === allowedOrigin
}

/**
 * The URL to hand to `shell.openExternal`, or null. Only http(s) and mailto — never file:, ms-settings:, javascript:,
 * custom protocol handlers or UNC paths, which would let page content launch programs. http(s) URLs must have a host
 * and no user:password part (a classic way to disguise the real host).
 */
export function validateExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EXTERNAL_URL) return null
  // Control characters and whitespace are never part of a link the user meant to open.
  if (/[\u0000- \u007f]/.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!EXTERNAL_SCHEMES.has(u.protocol)) return null
  if (u.protocol === 'mailto:') return u.pathname.length > 0 ? u.href : null
  if (!u.hostname || u.username || u.password) return null
  return u.href
}

/** A CSS hex color (#rgb, #rgba, #rrggbb, #rrggbbaa) — the only form accepted for the caption-button overlay. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
}
