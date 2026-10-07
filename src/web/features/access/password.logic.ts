/**
 * Live password rules for the set/change form (07 B15): the same checks the server runs (src/server/auth/password.ts),
 * shown while typing so the owner never submits a password that will be refused. The server stays the authority:
 * its message is shown when it disagrees. The blocklist is shared with the server (src/shared/commonPasswords.ts),
 * imported so the two lists can never drift apart; it lands in the lazily loaded Access chunk only.
 */
import { COMMON_PASSWORDS } from '@shared/commonPasswords'

export const PASSWORD_MIN = 15
export const PASSWORD_MAX = 1024

const COMMON = new Set(COMMON_PASSWORDS)
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'qwertzuiopasdfghjklyxcvbnm', 'azertyuiopqsdfghjklmwxcvbn', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p']

function isRun(s: string): boolean {
  if (!s) return false
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

export interface PasswordCheck {
  /** Characters after NFKC (what the server counts). */
  chars: number
  longEnough: boolean
  notTooLong: boolean
  notCommon: boolean
  notPattern: boolean
  noControl: boolean
  /** The first problem in the server's words, or null when the password will be accepted. */
  problem: string | null
}

export function checkPassword(pw: string): PasswordCheck {
  const n = pw.normalize('NFKC')
  const chars = [...n].length
  const lower = n.toLowerCase()
  const compact = lower.replace(/\s+/g, '')
  const longEnough = chars >= PASSWORD_MIN
  const notTooLong = chars <= PASSWORD_MAX && new TextEncoder().encode(n).length <= 4096
  const noControl = !/[\u0000-\u001f\u007f]/.test(n)
  const notCommon = !(COMMON.has(lower) || COMMON.has(compact))
  const notPattern = compact.length === 0 || !(/^(.+?)\1+$/su.test(compact) || isRun(compact))
  let problem: string | null = null
  if (!longEnough) problem = `Use at least ${PASSWORD_MIN} characters (a few words with spaces work well).`
  else if (!notTooLong) problem = `Use at most ${PASSWORD_MAX} characters.`
  else if (!noControl) problem = "The password can't contain control characters."
  else if (!notCommon) problem = 'This password is on the list of commonly used passwords. Choose another one.'
  else if (!notPattern) problem = 'This password is a simple pattern (repeats or a keyboard run). Choose something less predictable.'
  return { chars, longEnough, notTooLong, notCommon, notPattern, noControl, problem }
}
