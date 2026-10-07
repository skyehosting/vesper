/** Lockout ladder, per-IP limits, suspension (07 B14/B15) and pairing codes (07 B16) on an injected clock. @R1 */
import { describe, expect, it } from 'vitest'
import { LoginLimiter } from '@server/auth/limiter'
import { PAIR_TTL_MS, PairingCodes } from '@server/auth/pairing'

describe('LoginLimiter', () => {
  it('per IP: 5 attempts per rolling minute, then 429 with the seconds left; other IPs unaffected', () => {
    const l = new LoginLimiter()
    let t = 1_000_000
    for (let i = 0; i < 5; i++) expect(l.check('password', '10.0.0.5', 'lan', t + i * 1000)).toEqual({ ok: true })
    expect(l.check('password', '10.0.0.5', 'lan', t + 10_000)).toEqual({ ok: false, reason: 'ip', retryAfterSec: 50 })
    // ::ffff: mapped is the same client.
    expect(l.check('password', '::ffff:10.0.0.5', 'lan', t + 10_000)).toMatchObject({ ok: false, reason: 'ip' })
    expect(l.check('password', '10.0.0.6', 'lan', t + 10_000)).toEqual({ ok: true })
    // The pairing bucket is separate.
    expect(l.check('pair', '10.0.0.5', 'lan', t + 10_000)).toEqual({ ok: true })
    t += 60_001
    expect(l.check('password', '10.0.0.5', 'lan', t)).toEqual({ ok: true })
  })

  it('global ladder: from the 10th consecutive failure, 1, 2, 4 … 60 s; success resets', () => {
    const l = new LoginLimiter({ perIpMax: 1000 })
    let t = 0
    for (let i = 0; i < 9; i++) {
      expect(l.check('password', `ip${i}`, 'tailnet', t)).toEqual({ ok: true })
      l.failure(t)
    }
    expect(l.lockedUntil(t)).toBeNull()
    l.failure(t) // 10th
    expect(l.lockedUntil(t)).toBe(t + 1000)
    expect(l.check('password', 'fresh-ip', 'tailnet', t + 500)).toEqual({ ok: false, reason: 'ladder', retryAfterSec: 1 })
    expect(l.check('password', 'fresh-ip', 'tailnet', t + 1000)).toEqual({ ok: true })
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      t += 100_000
      l.failure(t)
      delays.push((l.lockedUntil(t) ?? t) - t)
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
    // Pairing is not on the password ladder.
    expect(l.check('pair', 'x', 'lan', t + 1)).toEqual({ ok: true })
    l.success()
    expect(l.lockedUntil(t + 1)).toBeNull()
  })

  it('50 failures within an hour suspend remote password sign-in only; resume lifts it', () => {
    const l = new LoginLimiter({ perIpMax: 1000, ladderStart: 1000 })
    let suspendedAt = -1
    for (let i = 0; i < 60; i++) if (l.failure(i * 1000)) suspendedAt = i
    expect(suspendedAt).toBe(49)
    expect(l.isSuspended()).toBe(true)
    expect(l.check('password', 'a', 'lan', 70_000)).toEqual({ ok: false, reason: 'suspended' })
    expect(l.check('password', 'a', 'tailnet', 70_000)).toEqual({ ok: false, reason: 'suspended' })
    expect(l.check('password', 'a', 'loopback', 70_000)).toEqual({ ok: true })
    expect(l.check('pair', 'a', 'tailnet', 70_000)).toEqual({ ok: true })
    l.resume()
    expect(l.check('password', 'b', 'lan', 70_000)).toEqual({ ok: true })
    // Failures spread over more than an hour never suspend.
    const slow = new LoginLimiter({ ladderStart: 1000 })
    for (let i = 0; i < 100; i++) expect(slow.failure(i * 80_000)).toBe(false)
  })

  it('a restored suspension (kv) is honoured', () => {
    expect(new LoginLimiter({}, { suspended: true }).check('password', 'x', 'lan', 0)).toEqual({ ok: false, reason: 'suspended' })
  })

  it('leak: 5,000 IPs come and go and the buckets return to zero', () => {
    const l = new LoginLimiter()
    for (let i = 0; i < 5000; i++) l.check('password', `10.1.${i >> 8}.${i & 255}`, 'lan', i)
    expect(l.size()).toBe(5000)
    l.prune(5000 + 60_001)
    expect(l.size()).toBe(0)
  })
})

describe('PairingCodes', () => {
  it('128-bit, single use, 5 minutes, only on the listener it was made for', () => {
    const p = new PairingCodes()
    const a = p.create(0, 'lan')
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.expiresUtc).toBe(PAIR_TTL_MS)
    expect(p.redeem(a.code, 'lan', 1000)).toBe('lan')
    expect(p.redeem(a.code, 'lan', 1000)).toBeNull()

    const b = p.create(0, 'tailnet')
    expect(p.redeem(b.code, 'lan', 10)).toBeNull()
    // Consumed by the mismatched attempt too.
    expect(p.redeem(b.code, 'tailnet', 10)).toBeNull()

    const c = p.create(0, 'local')
    expect(p.redeem(c.code, 'loopback', PAIR_TTL_MS)).toBeNull()
    expect(p.redeem('x'.repeat(10), 'lan', 0)).toBeNull()
  })

  it('leak: codes expire and at most 8 are live', () => {
    const p = new PairingCodes()
    for (let i = 0; i < 100; i++) p.create(i, 'local')
    expect(p.active(100)).toBe(8)
    expect(p.active(100 + PAIR_TTL_MS)).toBe(0)
  })
})
