/**
 * Password rules and hashing (07 B15, research 06 §5.1).
 * - Rules (NIST SP 800-63B-4): 15–1024 characters after NFKC, no composition rules, a bundled blocklist plus the
 *   obvious patterns (one unit repeated, keyboard rows, counting) that a blocklist cannot enumerate.
 * - Hash: scrypt N=2^17, r=8, p=1, 64-byte key, 16-byte salt; maxmem must be strictly above 128·N·r = 128 MiB (the
 *   32 MiB default throws in Electron), so 256 MiB. Argon2 is not available in Electron's BoringSSL.
 * - One scrypt at a time with at most 4 waiting (else 429): a burst of logins can never pin the CPU or the 256 MiB.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { VesperError } from '@shared/errors'
import { COMMON_PASSWORDS } from './commonPasswords'

export const PASSWORD_MIN = 15
export const PASSWORD_MAX = 1024
/** UTF-8 cap on what reaches scrypt (1024 astral characters are 4 KiB). */
const PASSWORD_MAX_BYTES = 4096

export interface ScryptParams {
  N: number
  r: number
  p: number
}

export const SCRYPT_DEFAULT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }
const KEY_LEN = 64
const SALT_LEN = 16
const MAXMEM = 256 * 1024 * 1024

const COMMON = new Set(COMMON_PASSWORDS)
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'qwertzuiopasdfghjklyxcvbnm', 'azertyuiopqsdfghjklmwxcvbn', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p']

export function normalizePassword(pw: string): string {
  return pw.normalize('NFKC')
}

/** True when `s` is a run along one of SEQUENCES (wrapping, either direction), e.g. "123456789012345". */
function isRun(s: string): boolean {
  for (const seq of SEQUENCES) {
    for (const base of [seq, [...seq].reverse().join('')]) {
      const start = base.indexOf(s[0])
      if (start < 0) continue
      let ok = true
      for (let i = 1; i < s.length && ok; i++) ok = base[(start + i) % base.length] === s[i]
      if (ok) return true
    }
  }
  return false
}

/** Why `pw` can't be used as Vesper's password, or null when it is fine. Shown to the owner as-is. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Enter a password.'
  const n = normalizePassword(pw)
  const chars = [...n].length
  if (chars < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters (a few words with spaces work well).`
  if (chars > PASSWORD_MAX || Buffer.byteLength(n, 'utf8') > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX} characters.`
  if (/[\u0000-\u001f\u007f]/.test(n)) return "The password can't contain control characters."
  const lower = n.toLowerCase()
  const compact = lower.replace(/\s+/g, '')
  if (COMMON.has(lower) || COMMON.has(compact)) return 'This password is on the list of commonly used passwords. Choose another one.'
  if (/^(.+?)\1+$/su.test(compact)) return 'This password just repeats a few characters. Choose something less predictable.'
  if (isRun(compact)) return 'This password is a simple keyboard or counting sequence. Choose something less predictable.'
  return null
}

function scrypt(password: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** `scrypt$v=1$N=131072,r=8,p=1$<salt b64>$<hash b64>` (research 06 §5.1). */
export async function hashPassword(pw: string, params: ScryptParams = SCRYPT_DEFAULT): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const key = await scrypt(normalizePassword(pw), salt, params)
  return `scrypt$v=1$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const m = /^scrypt\$v=1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored)
  if (!m) return null
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }
  // Refuse absurd parameters from a tampered file instead of trying to allocate them.
  if (!Number.isInteger(Math.log2(params.N)) || params.N < 2 ** 10 || params.N > 2 ** 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 4) return null
  const salt = Buffer.from(m[4], 'base64')
  const key = Buffer.from(m[5], 'base64')
  if (salt.length < 8 || key.length !== KEY_LEN) return null
  return { params, salt, key }
}

/**
 * Constant-time verify. A missing or unreadable hash still runs one scrypt with the default parameters, so the answer
 * takes the same time whether or not a password exists.
 */
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const parsed = stored ? parseHash(stored) : null
  const params = parsed?.params ?? SCRYPT_DEFAULT
  const salt = parsed?.salt ?? randomBytes(SALT_LEN)
  const key = await scrypt(normalizePassword(typeof pw === 'string' ? pw : ''), salt, params)
  if (!parsed) return false
  return timingSafeEqual(key, parsed.key)
}

/**
 * Runs scrypt jobs one at a time; up to `maxWaiting` wait, more are refused with `rate_limited` (07 B15). The queue
 * holds nothing once idle (tested by the leak test: `size()` returns to 0).
 */
export class ScryptQueue {
  private running = false
  private readonly waiting: (() => void)[] = []
  constructor(private readonly maxWaiting = 4) {}

  size(): number {
    return this.waiting.length + (this.running ? 1 : 0)
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.waiting.length >= this.maxWaiting) throw new VesperError('rate_limited', { retryAfter: 1 })
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.running = true
    try {
      return await job()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.running = false
    }
  }
}
