/**
 * One-time pairing codes (07 B16, research 06 §5.7): 128 random bits, 5-minute TTL, single use, valid only on the
 * listener they were minted for (a LAN code can't be redeemed through the tailnet and vice versa). Only SHA-256 of a
 * code is held, in memory: a restart invalidates every code, which is the safe direction. At most MAX_ACTIVE codes
 * exist; expired ones are dropped on every call, so nothing accumulates.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PairTarget } from '@shared/api'
import type { Listener } from '@shared/types/domain'

export const PAIR_TTL_MS = 5 * 60_000
const MAX_ACTIVE = 8

const LISTENER_OF: Record<PairTarget, Listener> = { local: 'loopback', lan: 'lan', tailnet: 'tailnet' }

interface Entry {
  expiresUtc: number
  target: PairTarget
}

const digest = (code: string) => createHash('sha256').update(code).digest('hex')

export class PairingCodes {
  private readonly codes = new Map<string, Entry>()

  private sweep(now: number): void {
    for (const [k, e] of this.codes) if (e.expiresUtc <= now) this.codes.delete(k)
  }

  create(now: number, target: PairTarget): { code: string; expiresUtc: number } {
    this.sweep(now)
    while (this.codes.size >= MAX_ACTIVE) this.codes.delete(this.codes.keys().next().value as string)
    const code = randomBytes(16).toString('base64url')
    const expiresUtc = now + PAIR_TTL_MS
    this.codes.set(digest(code), { expiresUtc, target })
    return { code, expiresUtc }
  }

  /** The code's target if it is valid on `listener` (it is consumed either way once it matched). */
  redeem(code: string, listener: Listener, now: number): PairTarget | null {
    this.sweep(now)
    if (typeof code !== 'string' || code.length < 16 || code.length > 64) return null
    const k = digest(code)
    const e = this.codes.get(k)
    if (!e) return null
    this.codes.delete(k)
    return LISTENER_OF[e.target] === listener ? e.target : null
  }

  active(now: number): number {
    this.sweep(now)
    return this.codes.size
  }

  clear(): void {
    this.codes.clear()
  }
}
