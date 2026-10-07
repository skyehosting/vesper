/**
 * Session short ids: 6 characters of Crockford base32 (no I, L, O, U), shown as `#K7Q2MX` and typed in commands.
 * 32^6 ≈ 1.07 billion values; the server retries on the (vanishingly rare) collision.
 */
export const SHORT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const SHORT_ID_LENGTH = 6

/** A random short id from `random(n)` → n random bytes (crypto.getRandomValues / randomBytes). */
export function makeShortId(random: (n: number) => Uint8Array): string {
  const bytes = random(SHORT_ID_LENGTH)
  let out = ''
  for (let i = 0; i < SHORT_ID_LENGTH; i++) out += SHORT_ID_ALPHABET[bytes[i] & 31]
  return out
}

/**
 * Normalize what a user typed ("#k7q2mx", "k7q-2mx", "K7Q2MX ") to a canonical short id, or null when it cannot be one.
 * Crockford decoding: I/L → 1, O → 0; separators and a leading # are ignored.
 */
export function normalizeShortId(input: string): string | null {
  const s = input
    .trim()
    .replace(/^#/, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (s.length !== SHORT_ID_LENGTH) return null
  for (const c of s) if (!SHORT_ID_ALPHABET.includes(c)) return null
  return s
}

/** Display form: `#K7Q2MX`. */
export function formatShortId(id: string): string {
  return `#${id}`
}
