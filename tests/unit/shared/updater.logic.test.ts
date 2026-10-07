/**
 * H-v12-updates: the updater's pure logic — interval parsing, when it runs at all (never dev, test or the placeholder
 * repository; the portable build only checks), the schedule and its error backoff, what each mode does, the idle rule
 * for 'auto', the state machine, the once-per-version "Update ready" notice — and UpdateController over a fake engine
 * and a fake clock (nothing here touches the network). @R20
 */
import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../../src/shared/api'
import type { UpdateInterval, UpdateMode } from '../../../src/shared/settings'
import { defaultSettings, settingsSchema } from '../../../src/shared/settings'
import {
  AUTO_INSTALL_IDLE_MS,
  backoffMs,
  CHECK_ERROR,
  DOWNLOAD_ERROR,
  errorCode,
  FIRST_CHECK_DELAY_MS,
  githubRepo,
  IDLE_POLL_MS,
  intervalMs,
  MAX_BACKOFF_MS,
  mayInstallNow,
  MIN_CHECK_DELAY_MS,
  modeBehaviour,
  nextCheckDelay,
  readyNoticeVersion,
  reduceStatus,
  releasePageUrl,
  updateStatusText,
  UpdateController,
  updaterSupport,
  type EngineEvent,
  type UpdateActivity,
  type UpdateEngine
} from '../../../src/shared/updater.logic'

const MIN = 60_000
const HOUR = 60 * MIN

describe('settings', () => {
  it('defaults: hourly checks, install when Vesper closes; unknown values are refused', () => {
    expect(defaultSettings().updates).toEqual({ checkEvery: '1h', mode: 'install-on-close' })
    expect(settingsSchema.safeParse({ updates: { checkEvery: '2h' } }).success).toBe(false)
    expect(settingsSchema.safeParse({ updates: { mode: 'never' } }).success).toBe(false)
    // An older settings.json without the block gets the defaults.
    expect(settingsSchema.parse({ chat: {} }).updates.checkEvery).toBe('1h')
  })
})

describe('interval parsing', () => {
  it('maps every choice; off and unknown values are null', () => {
    expect(intervalMs('5m')).toBe(5 * MIN)
    expect(intervalMs('15m')).toBe(15 * MIN)
    expect(intervalMs('1h')).toBe(HOUR)
    expect(intervalMs('1d')).toBe(24 * HOUR)
    expect(intervalMs('off')).toBeNull()
    expect(intervalMs('toString')).toBeNull()
    expect(intervalMs('')).toBeNull()
  })
})

describe('where updates come from, and when the updater runs', () => {
  const repo = { owner: 'someone', repo: 'vesper' }
  it('reads package.json repository in its usual spellings', () => {
    expect(githubRepo({ type: 'git', url: 'https://github.com/someone/vesper.git' })).toEqual(repo)
    expect(githubRepo('git+https://github.com/someone/vesper.git')).toEqual(repo)
    expect(githubRepo('git@github.com:someone/vesper.git')).toEqual(repo)
    expect(githubRepo('github:someone/vesper')).toEqual(repo)
    expect(githubRepo('someone/vesper')).toEqual(repo)
    expect(githubRepo({ url: 'https://gitlab.com/someone/vesper.git' })).toBeNull()
    expect(githubRepo(undefined)).toBeNull()
    expect(releasePageUrl(repo, '1.2.0')).toBe('https://github.com/someone/vesper/releases/tag/v1.2.0')
  })

  it('never in dev, test runs or with the placeholder owner; portable checks only', () => {
    const on = { packaged: true, test: false, portable: false, repo }
    expect(updaterSupport(on)).toEqual({ run: true, checkOnly: false })
    expect(updaterSupport({ ...on, portable: true })).toEqual({ run: true, checkOnly: true })
    expect(updaterSupport({ ...on, packaged: false })).toEqual({ run: false, why: 'dev' })
    expect(updaterSupport({ ...on, test: true })).toEqual({ run: false, why: 'test' })
    expect(updaterSupport({ ...on, repo: null })).toEqual({ run: false, why: 'no-repo' })
    expect(updaterSupport({ ...on, repo: githubRepo({ url: 'https://github.com/OWNER/vesper.git' }) })).toEqual({ run: false, why: 'no-repo' })
  })
})

describe('schedule and backoff', () => {
  const at = { startedUtc: 1_000_000, failures: 0, lastCheckUtc: null as number | null }
  it('first check ~30 s after start, then the interval after the last attempt; off never', () => {
    expect(nextCheckDelay({ ...at, interval: '1h', now: at.startedUtc })).toBe(FIRST_CHECK_DELAY_MS)
    expect(nextCheckDelay({ ...at, interval: '1h', now: at.startedUtc + 10_000 })).toBe(FIRST_CHECK_DELAY_MS - 10_000)
    expect(nextCheckDelay({ ...at, interval: '5m', lastCheckUtc: 2_000_000, now: 2_000_000 + MIN })).toBe(4 * MIN)
    expect(nextCheckDelay({ ...at, interval: 'off', now: at.startedUtc })).toBeNull()
  })

  it('a check that is already due (a shorter interval chosen) waits only a moment', () => {
    expect(nextCheckDelay({ ...at, interval: '5m', lastCheckUtc: 0, now: 3 * HOUR })).toBe(MIN_CHECK_DELAY_MS)
    expect(nextCheckDelay({ ...at, interval: '1h', now: at.startedUtc + HOUR })).toBe(MIN_CHECK_DELAY_MS)
  })

  it('errors back off: doubling per failure, capped at 6 h (or the interval when longer)', () => {
    expect(backoffMs(5 * MIN, 0)).toBe(5 * MIN)
    expect(backoffMs(5 * MIN, 1)).toBe(10 * MIN)
    expect(backoffMs(5 * MIN, 3)).toBe(40 * MIN)
    expect(backoffMs(5 * MIN, 50)).toBe(MAX_BACKOFF_MS)
    expect(backoffMs(HOUR, 2)).toBe(4 * HOUR)
    expect(backoffMs(24 * HOUR, 3)).toBe(24 * HOUR)
    expect(nextCheckDelay({ ...at, interval: '15m', failures: 2, lastCheckUtc: 0, now: 0 })).toBe(60 * MIN)
  })
})

describe('modes', () => {
  it('install-on-close downloads and installs on quit; ask waits; auto also installs when idle; portable never', () => {
    expect(modeBehaviour('install-on-close', false)).toEqual({ autoDownload: true, autoInstallOnAppQuit: true, installWhenIdle: false, canDownload: true })
    expect(modeBehaviour('ask', false)).toEqual({ autoDownload: false, autoInstallOnAppQuit: true, installWhenIdle: false, canDownload: true })
    expect(modeBehaviour('auto', false)).toEqual({ autoDownload: true, autoInstallOnAppQuit: true, installWhenIdle: true, canDownload: true })
    for (const m of ['install-on-close', 'ask', 'auto'] as const) expect(modeBehaviour(m, true)).toEqual({ autoDownload: false, autoInstallOnAppQuit: false, installWhenIdle: false, canDownload: false })
  })

  it("the idle rule for 'auto': nothing going on and nobody looking for a few minutes", () => {
    const idle: UpdateActivity = { streaming: false, mic: false, game: false, attended: false }
    expect(mayInstallNow(idle, AUTO_INSTALL_IDLE_MS)).toBe(true)
    expect(mayInstallNow(idle, AUTO_INSTALL_IDLE_MS - 1)).toBe(false)
    expect(mayInstallNow({ ...idle, streaming: true }, HOUR)).toBe(false)
    expect(mayInstallNow({ ...idle, mic: true }, HOUR)).toBe(false)
    expect(mayInstallNow({ ...idle, game: true }, HOUR)).toBe(false)
    expect(mayInstallNow({ ...idle, attended: true }, HOUR)).toBe(false)
  })
})

describe('state machine', () => {
  const x = { now: 5000, releaseUrl: (v: string) => `https://example.test/v${v}` }
  const s0: UpdateStatus = { state: 'idle', currentVersion: '1.1.3' }
  const go = (s: UpdateStatus, ...events: EngineEvent[]): UpdateStatus => events.reduce((acc, e) => reduceStatus(acc, e, x), s)

  it('checking → available → downloading → ready', () => {
    expect(go(s0, { kind: 'checking' })).toEqual({ state: 'checking', currentVersion: '1.1.3' })
    expect(go(s0, { kind: 'checking' }, { kind: 'available', version: '1.2.0' })).toEqual({ state: 'available', currentVersion: '1.1.3', version: '1.2.0', releaseUrl: 'https://example.test/v1.2.0', checkedUtc: 5000 })
    const dl = go(s0, { kind: 'available', version: '1.2.0' }, { kind: 'progress', percent: 41.6 })
    expect(dl).toMatchObject({ state: 'downloading', version: '1.2.0', percent: 42 })
    expect(go(dl, { kind: 'downloaded', version: '1.2.0' })).toMatchObject({ state: 'ready', version: '1.2.0', percent: 100, checkedUtc: 5000 })
    expect(go(s0, { kind: 'not-available' })).toEqual({ state: 'up-to-date', currentVersion: '1.1.3', checkedUtc: 5000 })
  })

  it('a failed check is an error, unless a version was already found; a failed download keeps the version', () => {
    expect(go(s0, { kind: 'checking' }, { kind: 'check-failed' })).toEqual({ state: 'error', currentVersion: '1.1.3', error: CHECK_ERROR })
    const avail = go(s0, { kind: 'available', version: '1.2.0' })
    expect(go(avail, { kind: 'checking' }, { kind: 'check-failed' })).toMatchObject({ state: 'available', version: '1.2.0', error: CHECK_ERROR })
    expect(go(avail, { kind: 'download-started' }, { kind: 'download-failed' })).toMatchObject({ state: 'available', version: '1.2.0', error: DOWNLOAD_ERROR })
  })

  it('logs codes, never messages', () => {
    expect(errorCode(Object.assign(new Error('GET https://github.com/x?token=abc failed'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))).toBe('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
    expect(errorCode({ statusCode: 404, message: 'body' })).toBe('HTTP 404')
    expect(errorCode(new Error('secret text'))).toBe('unknown')
    expect(errorCode({ code: 'has spaces and https://x' })).toBe('unknown')
  })

  it('status lines', () => {
    const o = { checkEvery: '1h' as UpdateInterval, mode: 'install-on-close' as UpdateMode, now: 10 * MIN }
    expect(updateStatusText(s0, o)).toBe('Vesper looks for a new version every hour.')
    expect(updateStatusText(s0, { ...o, checkEvery: 'off' })).toBe('Automatic checks are off.')
    expect(updateStatusText({ ...s0, state: 'up-to-date', checkedUtc: 5 * MIN }, o)).toBe('Vesper is up to date. Checked 5 minutes ago.')
    expect(updateStatusText({ ...s0, state: 'available', version: '1.2.0', portable: true }, o)).toContain('release page')
    expect(updateStatusText({ ...s0, state: 'ready', version: '1.2.0' }, { ...o, mode: 'auto' })).toContain("by itself while you're away")
    expect(updateStatusText({ state: 'unsupported', currentVersion: '1.1.3' }, o)).toBe('Updates come to the installed Vesper app on your PC.')
  })
})

describe('the "Update ready" notice', () => {
  const ready: UpdateStatus = { state: 'ready', currentVersion: '1.1.3', version: '1.2.0' }
  it('desktop only, never in Talk mode, once per version', () => {
    expect(readyNoticeVersion({ status: ready, desktop: true, talk: false, dismissed: null })).toBe('1.2.0')
    expect(readyNoticeVersion({ status: ready, desktop: false, talk: false, dismissed: null })).toBeNull()
    expect(readyNoticeVersion({ status: ready, desktop: true, talk: true, dismissed: null })).toBeNull()
    expect(readyNoticeVersion({ status: ready, desktop: true, talk: false, dismissed: '1.2.0' })).toBeNull()
    // A newer version is offered again.
    expect(readyNoticeVersion({ status: { ...ready, version: '1.2.1' }, desktop: true, talk: false, dismissed: '1.2.0' })).toBe('1.2.1')
    expect(readyNoticeVersion({ status: { ...ready, state: 'downloading' }, desktop: true, talk: false, dismissed: null })).toBeNull()
    expect(readyNoticeVersion({ status: null, desktop: true, talk: false, dismissed: null })).toBeNull()
  })
})

// ── controller over a fake engine and clock ───────────────────────────────────────────────────
interface Harness {
  c: UpdateController
  advance(ms: number): Promise<void>
  flush(): Promise<void>
  pending(): number
  calls: { checks: number; downloads: number; installs: number; configured: { autoDownload: boolean; autoInstallOnAppQuit: boolean }[]; loads: number }
  settings: { checkEvery: UpdateInterval; mode: UpdateMode }
  activity: UpdateActivity
  /** What the next checks answer. */
  latest: { version: string | null; fail?: boolean; failDownload?: boolean }
  logs: string[]
  states: string[]
  markers: number
}

function harness(o: { checkOnly?: boolean; settings?: Partial<Harness['settings']> } = {}): Harness {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const calls: Harness['calls'] = { checks: 0, downloads: 0, installs: 0, configured: [], loads: 0 }
  const h = {
    calls,
    settings: { checkEvery: '1h' as UpdateInterval, mode: 'install-on-close' as UpdateMode, ...o.settings },
    activity: { streaming: false, mic: false, game: false, attended: false } as UpdateActivity,
    latest: { version: null } as Harness['latest'],
    logs: [] as string[],
    states: [] as string[],
    markers: 0
  }
  let auto = { autoDownload: false, autoInstallOnAppQuit: false }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const engine: UpdateEngine = {
    configure(b) {
      auto = b
      calls.configured.push(b)
    },
    async check() {
      calls.checks++
      c.handle({ kind: 'checking' })
      await Promise.resolve()
      if (h.latest.fail) throw Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED https://github.com/…'), { code: 'ERR_INTERNET_DISCONNECTED' })
      if (!h.latest.version) {
        c.handle({ kind: 'not-available' })
        return
      }
      const version = h.latest.version
      c.handle({ kind: 'available', version })
      if (auto.autoDownload) void engine.download().catch(() => undefined)
    },
    async download() {
      calls.downloads++
      await Promise.resolve()
      if (h.latest.failDownload) {
        c.handle({ kind: 'error', error: { code: 'ERR_DOWNLOAD' } })
        throw new Error('download failed')
      }
      c.handle({ kind: 'progress', percent: 50 })
      await Promise.resolve()
      c.handle({ kind: 'downloaded', version: h.latest.version ?? '' })
    },
    install() {
      calls.installs++
    }
  }
  const c: UpdateController = new UpdateController({
    engine: async () => {
      calls.loads++
      return engine
    },
    settings: () => h.settings,
    checkOnly: !!o.checkOnly,
    currentVersion: '1.1.3',
    releaseUrl: (v) => `https://github.com/someone/vesper/releases/tag/v${v}`,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => void timers.delete(id as number),
    activity: () => h.activity,
    log: (m) => h.logs.push(m),
    beforeAutoInstall: () => void h.markers++
  })
  c.onChange((s) => h.states.push(s.state))
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  return Object.assign(h, { c, advance, flush, pending: () => timers.size })
}

describe('UpdateController', () => {
  it('nothing happens before start; the first check is ~30 s after start; then hourly', async () => {
    const h = harness()
    await h.advance(HOUR)
    expect(h.calls.loads).toBe(0)
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS - 1)
    expect(h.calls.checks).toBe(0)
    await h.advance(1)
    expect(h.calls.checks).toBe(1)
    expect(h.c.status()).toMatchObject({ state: 'up-to-date', currentVersion: '1.1.3' })
    await h.advance(HOUR - 1)
    expect(h.calls.checks).toBe(1)
    await h.advance(1)
    expect(h.calls.checks).toBe(2)
    h.c.close()
    expect(h.pending()).toBe(0)
  })

  it('off: no automatic checks, Check now still works; changing the interval reschedules at once', async () => {
    const h = harness({ settings: { checkEvery: 'off' } })
    h.c.start()
    await h.advance(24 * HOUR)
    expect(h.calls.checks).toBe(0)
    expect(h.pending()).toBe(0)
    await h.c.check()
    expect(h.calls.checks).toBe(1)
    expect(h.pending()).toBe(0)
    // Daily → 5 minutes: the next check comes 5 minutes after the last one, not a day later.
    h.settings.checkEvery = '1d'
    h.c.settingsChanged()
    await h.advance(MIN)
    h.settings.checkEvery = '5m'
    h.c.settingsChanged()
    await h.advance(4 * MIN)
    expect(h.calls.checks).toBe(2)
    h.settings.checkEvery = 'off'
    h.c.settingsChanged()
    expect(h.pending()).toBe(0)
    h.c.close()
  })

  it('errors back off quietly and log only a code', async () => {
    const h = harness({ settings: { checkEvery: '5m' } })
    h.latest.fail = true
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS)
    expect(h.c.status()).toEqual({ state: 'error', currentVersion: '1.1.3', error: CHECK_ERROR })
    // 5 min × 2 after the first failure, × 4 after the second.
    await h.advance(10 * MIN - 1)
    expect(h.calls.checks).toBe(1)
    await h.advance(1)
    expect(h.calls.checks).toBe(2)
    await h.advance(20 * MIN)
    expect(h.calls.checks).toBe(3)
    expect(h.logs.filter((l) => l.includes('failed'))).toEqual(['update check failed (ERR_INTERNET_DISCONNECTED; 1 in a row)', 'update check failed (ERR_INTERNET_DISCONNECTED; 2 in a row)', 'update check failed (ERR_INTERNET_DISCONNECTED; 3 in a row)'])
    expect(h.logs.join('\n')).not.toMatch(/github\.com|net::/)
    // Back online: the next one works and the interval is back to 5 minutes.
    h.latest.fail = false
    await h.advance(40 * MIN)
    expect(h.c.status().state).toBe('up-to-date')
    const n = h.calls.checks
    await h.advance(5 * MIN)
    expect(h.calls.checks).toBe(n + 1)
    h.c.close()
  })

  it('install-on-close: finds, downloads, is ready; installs on quit (engine flag) or on Restart; stops checking once ready', async () => {
    const h = harness()
    h.latest.version = '1.2.0'
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS)
    expect(h.calls.configured.at(-1)).toEqual({ autoDownload: true, autoInstallOnAppQuit: true })
    expect(h.states).toEqual(['checking', 'available', 'downloading', 'ready'])
    expect(h.c.status()).toMatchObject({ state: 'ready', version: '1.2.0', releaseUrl: 'https://github.com/someone/vesper/releases/tag/v1.2.0' })
    expect(h.pending()).toBe(0)
    await h.advance(5 * HOUR)
    expect(h.calls.checks).toBe(1)
    expect(h.calls.installs).toBe(0)
    expect(h.c.restart()).toBe(true)
    expect(h.calls.installs).toBe(1)
    h.c.close()
  })

  it('ask: nothing downloads until Download; then Restart', async () => {
    const h = harness({ settings: { mode: 'ask' } })
    h.latest.version = '1.2.0'
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS)
    expect(h.c.status()).toMatchObject({ state: 'available', version: '1.2.0' })
    expect(h.calls.downloads).toBe(0)
    expect(h.c.restart()).toBe(false)
    await h.c.download()
    expect(h.calls.downloads).toBe(1)
    expect(h.c.status().state).toBe('ready')
    expect(h.c.restart()).toBe(true)
    h.c.close()
  })

  it('a failed download keeps the version, offers Download again and backs off', async () => {
    const h = harness({ settings: { mode: 'ask' } })
    h.latest.version = '1.2.0'
    h.latest.failDownload = true
    await h.c.check()
    await h.c.download()
    await h.flush()
    expect(h.c.status()).toMatchObject({ state: 'available', version: '1.2.0', error: DOWNLOAD_ERROR })
    h.latest.failDownload = false
    await h.c.download()
    expect(h.c.status().state).toBe('ready')
    h.c.close()
  })

  it('switching ask → install-on-close downloads the version already found', async () => {
    const h = harness({ settings: { mode: 'ask' } })
    h.latest.version = '1.2.0'
    await h.c.check()
    h.settings.mode = 'install-on-close'
    h.c.settingsChanged()
    await h.flush()
    expect(h.calls.downloads).toBe(1)
    expect(h.c.status().state).toBe('ready')
    h.c.close()
  })

  it("auto: restarts by itself only when idle for a few minutes — never while busy, watched or in a game", async () => {
    const h = harness({ settings: { mode: 'auto' } })
    h.latest.version = '1.2.0'
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS)
    expect(h.c.status().state).toBe('ready')
    // Someone is looking: the idle clock keeps restarting.
    h.activity.attended = true
    await h.advance(10 * MIN)
    expect(h.calls.installs).toBe(0)
    // Nobody looks, but a game runs / a reply streams / a mic is open.
    h.activity = { streaming: false, mic: false, game: true, attended: false }
    await h.advance(10 * MIN)
    h.activity = { streaming: true, mic: false, game: false, attended: false }
    await h.advance(2 * IDLE_POLL_MS)
    h.activity = { streaming: false, mic: true, game: false, attended: false }
    await h.advance(2 * IDLE_POLL_MS)
    expect(h.calls.installs).toBe(0)
    h.activity = { streaming: false, mic: false, game: false, attended: false }
    await h.advance(IDLE_POLL_MS)
    expect(h.calls.installs).toBe(1)
    expect(h.markers).toBe(1)
    expect(h.logs.some((l) => l.startsWith('installing version 1.2.0 while Vesper is idle'))).toBe(true)
    h.c.close()
  })

  it('auto, then back to install-on-close: the idle watch stops', async () => {
    const h = harness({ settings: { mode: 'auto' } })
    h.latest.version = '1.2.0'
    await h.c.check()
    await h.flush()
    expect(h.c.timers().idle).toBe(true)
    h.settings.mode = 'install-on-close'
    h.c.settingsChanged()
    expect(h.c.timers().idle).toBe(false)
    await h.advance(HOUR)
    expect(h.calls.installs).toBe(0)
    h.c.close()
  })

  it('portable: checks only — never downloads or installs; the release page is the way', async () => {
    const h = harness({ checkOnly: true })
    h.latest.version = '1.2.0'
    expect(h.c.status()).toEqual({ state: 'idle', currentVersion: '1.1.3', portable: true })
    h.c.start()
    await h.advance(FIRST_CHECK_DELAY_MS)
    expect(h.calls.configured.at(-1)).toEqual({ autoDownload: false, autoInstallOnAppQuit: false })
    expect(h.c.status()).toMatchObject({ state: 'available', version: '1.2.0', portable: true, releaseUrl: 'https://github.com/someone/vesper/releases/tag/v1.2.0' })
    await h.c.download()
    expect(h.calls.downloads).toBe(0)
    expect(h.c.restart()).toBe(false)
    // It keeps checking (a newer version may come).
    await h.advance(HOUR)
    expect(h.calls.checks).toBe(2)
    h.c.close()
  })

  it('concurrent Check now calls share one check', async () => {
    const h = harness()
    const [a, b] = await Promise.all([h.c.check(), h.c.check()])
    expect(a).toEqual(b)
    expect(h.calls.checks).toBe(1)
    h.c.close()
  })
})
