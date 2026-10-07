/**
 * VoyageScheduler (07 C11, ARC-11): owns every Voyage call inside db.worker, with two lanes over one rate budget.
 * - Foreground (query embeddings, reranks) never waits beyond its deadline (auto-recall 400 ms, search 1.2 s); when
 *   the budget can't be met it fails fast and the caller degrades to keyword-only.
 * - Background (the embed queue) uses only what is left and always keeps 1 request per minute in reserve.
 * Limits come from the tier (Settings "account tier"); "auto" starts at the free-trial limits (3 RPM / 10K TPM) and
 * steps up to tier 1 after 10 minutes without a 429, stepping back down on the next 429.
 * The window is account-wide (not per model) — conservative for paid tiers, exact for the free trial.
 * Clock and sleep are injected so tests can drive time.
 */
import { FREE_TRIAL_LIMITS, limitsFor, type VoyageTier } from '../../providers/voyage/catalogue'

export interface SchedulerClock {
  now(): number
  /** Resolves after `ms` (or early, rejecting, when `signal` aborts). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const t = setTimeout(done, Math.max(0, ms))
      function done() {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      function onAbort() {
        clearTimeout(t)
        reject(new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/** The foreground budget could not be met (no rate slot in time). */
export class BudgetExceeded extends Error {
  constructor() {
    super('voyage budget exceeded')
    this.name = 'BudgetExceeded'
  }
}

const WINDOW_MS = 60_000
const STEP_UP_AFTER_MS = 10 * 60_000
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 60_000

export class VoyageScheduler {
  private window: { t: number; tokens: number }[] = []
  private setting: 'auto' | VoyageTier = 'auto'
  private autoTier: VoyageTier = 'free'
  private calmSince: number
  private backoffUntil = 0
  private backoffAttempt = 0
  lastRateLimitAt = 0

  constructor(
    private readonly clock: SchedulerClock = realClock,
    private readonly random: () => number = Math.random
  ) {
    this.calmSince = clock.now()
  }

  setTier(t: 'auto' | VoyageTier): void {
    if (t === this.setting) return
    this.setting = t
    this.autoTier = 'free'
    this.calmSince = this.clock.now()
  }

  /** The tier the limits are taken from right now. */
  tier(): VoyageTier {
    if (this.setting !== 'auto') return this.setting
    if (this.autoTier === 'free' && this.clock.now() - this.calmSince >= STEP_UP_AFTER_MS) this.autoTier = 'tier1'
    return this.autoTier
  }

  limits(tier1Tpm: number): { rpm: number; tpm: number } {
    const t = this.tier()
    return t === 'free' ? { ...FREE_TRIAL_LIMITS } : limitsFor(t, tier1Tpm)
  }

  private prune(now: number): void {
    while (this.window.length && now - this.window[0].t >= WINDOW_MS) this.window.shift()
  }

  rpmUsed(): number {
    this.prune(this.clock.now())
    return this.window.length
  }

  /** Window entries (leak tests: bounded by the RPM limit). */
  get windowSize(): number {
    return this.window.length
  }

  /** Milliseconds until a request of `tokens` may start, keeping `reserve` requests per minute free. */
  waitMs(tokens: number, tier1Tpm: number, reserve: number): number {
    const now = this.clock.now()
    this.prune(now)
    const { rpm, tpm } = this.limits(tier1Tpm)
    let wait = 0
    const cap = Math.max(1, rpm - reserve)
    if (this.window.length >= cap) wait = Math.max(wait, this.window[this.window.length - cap].t + WINDOW_MS - now)
    let used = 0
    for (const w of this.window) used += w.tokens
    if (used + tokens > tpm) {
      let freed = 0
      for (const w of this.window) {
        freed += w.tokens
        if (used - freed + tokens <= tpm) {
          wait = Math.max(wait, w.t + WINDOW_MS - now)
          break
        }
      }
    }
    return Math.max(0, Math.ceil(wait))
  }

  /** Background lane: ms to wait (rate window and error backoff); 0 = go. */
  backgroundWaitMs(tokens: number, tier1Tpm: number): number {
    const now = this.clock.now()
    return Math.max(this.waitMs(tokens, tier1Tpm, 1), this.backoffUntil - now, 0)
  }

  /** Largest background batch in tokens: 0.8 × TPM per request (07 C11); ≤ 8K on the free trial. */
  batchTokenCap(tier1Tpm: number, modelCap: number, practicalCap: number): number {
    const { tpm } = this.limits(tier1Tpm)
    return Math.max(1, Math.min(Math.floor(0.8 * tpm), modelCap, practicalCap))
  }

  /** Record that a request started now. */
  record(tokens: number): void {
    const now = this.clock.now()
    this.prune(now)
    this.window.push({ t: now, tokens })
  }

  /** Foreground lane: wait for a slot only while the deadline allows, then run `fn`. */
  async foreground<T>(tokens: number, tier1Tpm: number, deadline: number, fn: () => Promise<T>): Promise<T> {
    const wait = this.waitMs(tokens, tier1Tpm, 0)
    if (this.clock.now() + wait >= deadline) throw new BudgetExceeded()
    if (wait > 0) await this.clock.sleep(wait)
    this.record(tokens)
    return fn()
  }

  /** A 429 arrived: step "auto" back to the free-trial limits and back off the background lane. */
  onRateLimited(retryAfterMs?: number): void {
    const now = this.clock.now()
    this.lastRateLimitAt = now
    this.calmSince = now
    if (this.setting === 'auto') this.autoTier = 'free'
    this.backoff(retryAfterMs)
  }

  /** Server/network trouble: back off the background lane (exponential, full jitter, 1 s → 60 s). */
  backoff(atLeastMs = 0): number {
    const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.backoffAttempt)
    this.backoffAttempt = Math.min(this.backoffAttempt + 1, 10)
    const ms = Math.max(atLeastMs, Math.round(this.random() * exp))
    this.backoffUntil = Math.max(this.backoffUntil, this.clock.now() + ms)
    return ms
  }

  onSuccess(): void {
    this.backoffAttempt = 0
    this.backoffUntil = 0
  }

  /** Estimated seconds to drain `items` inputs of `avgTokens` each at the current limits (background share). */
  etaSec(items: number, avgTokens: number, tier1Tpm: number, batchTokens: number, maxInputs: number): number | null {
    if (items <= 0) return 0
    const { rpm, tpm } = this.limits(tier1Tpm)
    const perReq = Math.max(1, Math.min(maxInputs, Math.floor(batchTokens / Math.max(1, avgTokens))))
    const requests = Math.ceil(items / perReq)
    const byRpm = (requests / Math.max(1, rpm - 1)) * 60
    const byTpm = ((items * avgTokens) / tpm) * 60
    return Math.ceil(Math.max(byRpm, byTpm))
  }
}
