/** VoyageScheduler (07 C11): lanes, reserve, budgets, tiers, backoff — on a fake clock. */
import { describe, expect, it } from 'vitest'
import { BudgetExceeded, VoyageScheduler, type SchedulerClock } from '@server/memory/engine/scheduler'

function fakeClock(start = 1_000_000): SchedulerClock & { t: number; slept: number[] } {
  const c = {
    t: start,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms)
      c.t += ms
    }
  }
  return c
}

const LITE = 16_000_000

describe('VoyageScheduler', () => {
  it('free trial: 3 RPM, the background lane keeps 1 request per minute for the foreground', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c, () => 0.5)
    expect(s.tier()).toBe('free')
    expect(s.backgroundWaitMs(1000, LITE)).toBe(0)
    s.record(1000)
    c.t += 1000
    s.record(1000)
    // Two used: the background must wait for the window, the foreground still has its slot.
    expect(s.backgroundWaitMs(1000, LITE)).toBeGreaterThan(50_000)
    expect(s.waitMs(1000, LITE, 0)).toBe(0)
    s.record(1000)
    expect(s.waitMs(10, LITE, 0)).toBe(59_000)
    expect(s.rpmUsed()).toBe(3)
  })

  it('free trial: 10K TPM caps tokens per window and batches at 0.8 × TPM', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c)
    expect(s.batchTokenCap(LITE, 1_000_000, 100_000)).toBe(8000)
    s.record(8000)
    expect(s.waitMs(3000, LITE, 0)).toBe(60_000)
    expect(s.waitMs(2000, LITE, 0)).toBe(0)
  })

  it('foreground never waits beyond its deadline', async () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c)
    for (let i = 0; i < 3; i++) s.record(10)
    await expect(s.foreground(10, LITE, c.t + 400, async () => 'x')).rejects.toBeInstanceOf(BudgetExceeded)
    c.t += 59_800 // the oldest slot frees in 200 ms
    expect(await s.foreground(10, LITE, c.t + 400, async () => 'ok')).toBe('ok')
    expect(c.slept).toEqual([200])
  })

  it('auto tier steps up after 10 minutes without a 429 and back down on one', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c)
    expect(s.limits(LITE)).toEqual({ rpm: 3, tpm: 10_000 })
    c.t += 10 * 60_000
    expect(s.tier()).toBe('tier1')
    expect(s.limits(LITE)).toEqual({ rpm: 2000, tpm: 16_000_000 })
    s.onRateLimited()
    expect(s.tier()).toBe('free')
    c.t += 9 * 60_000
    expect(s.tier()).toBe('free')
    c.t += 60_000
    expect(s.tier()).toBe('tier1')
  })

  it('a fixed tier ignores the auto rules', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c)
    s.setTier('tier2')
    expect(s.limits(LITE)).toEqual({ rpm: 4000, tpm: 32_000_000 })
    s.onRateLimited()
    expect(s.tier()).toBe('tier2')
  })

  it('backs off exponentially with full jitter, capped at 60 s, and resets on success', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c, () => 1)
    const seq = [s.backoff(), s.backoff(), s.backoff(), s.backoff(), s.backoff(), s.backoff(), s.backoff(), s.backoff()]
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(s.backgroundWaitMs(0, LITE)).toBe(60_000)
    s.onSuccess()
    expect(s.backgroundWaitMs(0, LITE)).toBe(0)
    expect(s.backoff(5000)).toBe(5000)
  })

  it('estimates the queue ETA from the binding limit', () => {
    const s = new VoyageScheduler(fakeClock())
    // 1,000 messages × 60 tokens on the free trial: 60K tokens / 10K TPM = 6 minutes.
    expect(s.etaSec(1000, 60, LITE, 8000, 1000)).toBe(360)
    expect(s.etaSec(0, 60, LITE, 8000, 1000)).toBe(0)
    s.setTier('tier1')
    expect(s.etaSec(1000, 60, LITE, 100_000, 1000)).toBeLessThan(5)
  })

  it('keeps its window bounded (leak check)', () => {
    const c = fakeClock()
    const s = new VoyageScheduler(c)
    s.setTier('tier1')
    for (let i = 0; i < 10_000; i++) {
      s.record(10)
      c.t += 100
    }
    expect(s.windowSize).toBeLessThanOrEqual(601)
  })
})
