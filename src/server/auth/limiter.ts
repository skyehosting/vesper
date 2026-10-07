/**
 * Password-guessing limits (07 B14/B15, research 06 §5.4). Time comes from the caller (the server clock), so tests
 * drive it without waiting.
 * - Per IP: 5 attempts per rolling minute, per kind ('password' = login and sudo, 'pair' = code redemption).
 * - Global ladder: proxied clients (Tailscale Serve) all arrive from 127.0.0.1, so per-IP limits alone are not enough.
 *   From the 10th consecutive failure each further attempt waits 1, 2, 4 … 60 s after the last failure.
 * - 50 failures within an hour suspend password sign-in on Listeners B and C (other devices) until the desktop resumes
 *   it; the PC itself (Listener A) keeps the ladder only, and desktop-minted pairing keeps working.
 * Memory is bounded: per-IP buckets are dropped as soon as their window is empty, and at most MAX_IPS are kept.
 */
import type { Listener } from '@shared/types/domain'

export type LimitKind = 'password' | 'pair'

export interface LimiterOptions {
  perIpMax: number
  perIpWindowMs: number
  ladderStart: number
  ladderMaxMs: number
  suspendAfter: number
  suspendWindowMs: number
}

export const LIMITER_DEFAULTS: LimiterOptions = {
  perIpMax: 5,
  perIpWindowMs: 60_000,
  ladderStart: 10,
  ladderMaxMs: 60_000,
  suspendAfter: 50,
  suspendWindowMs: 3_600_000
}

const MAX_IPS = 10_000

export type LimitVerdict = { ok: true } | { ok: false; reason: 'ip' | 'ladder'; retryAfterSec: number } | { ok: false; reason: 'suspended' }

export class LoginLimiter {
  private readonly opts: LimiterOptions
  private readonly attempts = new Map<string, number[]>()
  private consecutive = 0
  private lastFailureAt = 0
  private failures: number[] = []
  private suspended: boolean
  private lastPrune = 0

  constructor(opts: Partial<LimiterOptions> = {}, initial: { suspended?: boolean } = {}) {
    this.opts = { ...LIMITER_DEFAULTS, ...opts }
    this.suspended = !!initial.suspended
  }

  /** Bucket key: IPv4-mapped IPv6 and plain IPv4 are the same client. */
  private key(kind: LimitKind, ip: string | null): string {
    return `${kind}|${(ip ?? '?').replace(/^::ffff:/, '')}`
  }

  private window(key: string, now: number): number[] {
    const list = this.attempts.get(key)
    if (!list) return []
    const fresh = list.filter((t) => now - t < this.opts.perIpWindowMs)
    if (fresh.length) this.attempts.set(key, fresh)
    else this.attempts.delete(key)
    return fresh
  }

  /** Ladder delay after `consecutive` failures, or 0. */
  private ladderMs(): number {
    if (this.consecutive < this.opts.ladderStart) return 0
    return Math.min(this.opts.ladderMaxMs, 1000 * 2 ** (this.consecutive - this.opts.ladderStart))
  }

  /** Global lock end (for AuthState.lockedUntilUtc), or null. */
  lockedUntil(now: number): number | null {
    const ms = this.ladderMs()
    if (!ms) return null
    const until = this.lastFailureAt + ms
    return until > now ? until : null
  }

  isSuspended(): boolean {
    return this.suspended
  }

  /** May this attempt run? Records it against the per-IP window when it may. */
  check(kind: LimitKind, ip: string | null, listener: Listener, now: number): LimitVerdict {
    if (kind === 'password' && this.suspended && listener !== 'loopback') return { ok: false, reason: 'suspended' }
    const key = this.key(kind, ip)
    const recent = this.window(key, now)
    if (recent.length >= this.opts.perIpMax) {
      return { ok: false, reason: 'ip', retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.opts.perIpWindowMs - now) / 1000)) }
    }
    if (kind === 'password') {
      const until = this.lockedUntil(now)
      if (until) return { ok: false, reason: 'ladder', retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) }
    }
    // Stale buckets go at most one window after they emptied; the cap guards against a flood within one window.
    if (now - this.lastPrune > this.opts.perIpWindowMs || (!this.attempts.has(key) && this.attempts.size >= MAX_IPS)) this.prune(now)
    recent.push(now)
    this.attempts.set(key, recent)
    return { ok: true }
  }

  /** A wrong password. Returns true when this failure suspended remote sign-in (notify the desktop once). */
  failure(now: number): boolean {
    this.consecutive++
    this.lastFailureAt = now
    this.failures = this.failures.filter((t) => now - t < this.opts.suspendWindowMs)
    this.failures.push(now)
    if (!this.suspended && this.failures.length >= this.opts.suspendAfter) {
      this.suspended = true
      return true
    }
    return false
  }

  success(): void {
    this.consecutive = 0
  }

  /** Desktop "resume sign-in from other devices". */
  resume(): void {
    this.suspended = false
    this.failures = []
    this.consecutive = 0
  }

  /** Drop every empty window; when still full, the oldest buckets go (Map keeps insertion order). */
  prune(now: number): void {
    this.lastPrune = now
    for (const k of [...this.attempts.keys()]) this.window(k, now)
    for (const k of this.attempts.keys()) {
      if (this.attempts.size < MAX_IPS) break
      this.attempts.delete(k)
    }
  }

  /** Buckets currently held (leak tests). */
  size(): number {
    return this.attempts.size
  }
}
