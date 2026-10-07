/**
 * Auto-update logic (H-v12-updates), pure and unit-tested: when the updater runs at all, the check schedule (first
 * check ~30 s after start, then the owner's interval, errors backing off), what each behaviour mode does, the idle rule
 * for 'auto', the state machine over the engine's events, the once-per-version "Update ready" notice and the status
 * line Settings → About shows. `UpdateController` drives an injected engine: src/main/updater.ts adapts
 * electron-updater to it. No Node or DOM APIs — the main process and the web client both import this file.
 */
import type { UpdateStatus } from './api'
import type { UpdateInterval, UpdateMode } from './settings'

/** The first check after start (the start itself stays quiet). */
export const FIRST_CHECK_DELAY_MS = 30_000
/** A check that is already due (a shorter interval chosen, a resume from sleep) waits this long. */
export const MIN_CHECK_DELAY_MS = 10_000
/** Failed checks back off up to this (or the interval, if that is longer). */
export const MAX_BACKOFF_MS = 6 * 3_600_000
/** 'auto' installs only after nobody has looked at Vesper for this long. */
export const AUTO_INSTALL_IDLE_MS = 5 * 60_000
/** How often 'auto' looks for that idle moment once an update is ready. */
export const IDLE_POLL_MS = 60_000

export const CHECK_ERROR = "Couldn't check for updates. Vesper will try again later."
export const DOWNLOAD_ERROR = "Couldn't download the update."

const INTERVAL_MS: Readonly<Record<string, number>> = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 3_600_000, '1d': 86_400_000 }

/** The interval in ms; null for 'off' (and anything unknown). */
export function intervalMs(v: UpdateInterval | string): number | null {
  return Object.hasOwn(INTERVAL_MS, v) ? INTERVAL_MS[v] : null
}

/** Settings → About's interval choices, in order. */
export const INTERVAL_LABELS: Readonly<Record<UpdateInterval, string>> = {
  off: 'Off',
  '5m': 'Every 5 minutes',
  '15m': 'Every 15 minutes',
  '1h': 'Hourly',
  '1d': 'Daily'
}

// ── where updates come from ───────────────────────────────────────────────────────────────────
export interface GithubRepo {
  owner: string
  repo: string
}

/** package.json ships `repository.url` with this owner until the real GitHub account is filled in. */
export const PLACEHOLDER_OWNER = 'OWNER'

/** owner/repo from package.json's `repository` (an object with `url`, or a string); null when it isn't GitHub. */
export function githubRepo(repository: unknown): GithubRepo | null {
  const raw = typeof repository === 'string' ? repository : typeof repository === 'object' && repository ? (repository as { url?: unknown }).url : null
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  const m =
    /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url) ?? /^(?:github:)?([\w-][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(url)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** The release page of a version (tags are `v<version>`; the release workflow insists). */
export function releasePageUrl(r: GithubRepo, version: string): string {
  return `https://github.com/${r.owner}/${r.repo}/releases/tag/v${version}`
}

export type UpdaterSupport = { run: false; why: 'dev' | 'test' | 'no-repo' } | { run: true; checkOnly: boolean }

/** Never in dev (unpackaged) or test runs, nor with the placeholder repository; the portable build only checks. */
export function updaterSupport(o: { packaged: boolean; test: boolean; portable: boolean; repo: GithubRepo | null }): UpdaterSupport {
  if (o.test) return { run: false, why: 'test' }
  if (!o.packaged) return { run: false, why: 'dev' }
  if (!o.repo || o.repo.owner === PLACEHOLDER_OWNER) return { run: false, why: 'no-repo' }
  return { run: true, checkOnly: o.portable }
}

// ── schedule ──────────────────────────────────────────────────────────────────────────────────
/** After `failures` failed checks in a row: the interval doubled per failure, capped at max(interval, 6 h). */
export function backoffMs(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs
  return Math.min(baseMs * 2 ** Math.min(failures, 20), Math.max(baseMs, MAX_BACKOFF_MS))
}

/**
 * ms until the next automatic check; null when checks are off. The first one is FIRST_CHECK_DELAY_MS after start;
 * later ones an interval (backed off after failures) after the last attempt; one already due waits MIN_CHECK_DELAY_MS.
 */
export function nextCheckDelay(o: { interval: UpdateInterval; failures: number; lastCheckUtc: number | null; startedUtc: number; now: number }): number | null {
  const base = intervalMs(o.interval)
  if (base === null) return null
  const due = o.lastCheckUtc === null ? o.startedUtc + FIRST_CHECK_DELAY_MS : o.lastCheckUtc + backoffMs(base, o.failures)
  return due > o.now ? due - o.now : MIN_CHECK_DELAY_MS
}

// ── behaviour modes ───────────────────────────────────────────────────────────────────────────
export interface ModeBehaviour {
  /** Download as soon as a version is found. */
  autoDownload: boolean
  /** A downloaded version installs when Vesper quits. */
  autoInstallOnAppQuit: boolean
  /** Restart into it by itself once Vesper is idle ('auto'). */
  installWhenIdle: boolean
  /** Downloading is possible at all (not in the portable build). */
  canDownload: boolean
}

export function modeBehaviour(mode: UpdateMode, checkOnly: boolean): ModeBehaviour {
  if (checkOnly) return { autoDownload: false, autoInstallOnAppQuit: false, installWhenIdle: false, canDownload: false }
  switch (mode) {
    case 'ask':
      // Nothing downloads until the owner says so; once they have, closing Vesper installs it.
      return { autoDownload: false, autoInstallOnAppQuit: true, installWhenIdle: false, canDownload: true }
    case 'auto':
      return { autoDownload: true, autoInstallOnAppQuit: true, installWhenIdle: true, canDownload: true }
    default:
      return { autoDownload: true, autoInstallOnAppQuit: true, installWhenIdle: false, canDownload: true }
  }
}

/** What 'auto' must know before restarting by itself. */
export interface UpdateActivity {
  /** A reply is being written or spoken. */
  streaming: boolean
  /** A device streams microphone audio (dictation, push-to-talk, Talk mode). */
  mic: boolean
  /** Game mode is on (a full-screen game or app is in front, or the owner forced it). */
  game: boolean
  /** A Vesper window or tab is visible and focused right now (this PC or another device). */
  attended: boolean
}

/** The idle rule for 'auto': nothing going on, and nobody has looked at Vesper for AUTO_INSTALL_IDLE_MS. */
export function mayInstallNow(a: UpdateActivity, unattendedForMs: number): boolean {
  return !a.streaming && !a.mic && !a.game && !a.attended && unattendedForMs >= AUTO_INSTALL_IDLE_MS
}

// ── state machine ─────────────────────────────────────────────────────────────────────────────
export type EngineEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'download-started' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'check-failed' }
  | { kind: 'download-failed' }

function clean(s: UpdateStatus): UpdateStatus {
  const out = { ...s } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as unknown as UpdateStatus
}

/** The next status after an engine event (`now` stamps finished checks; `releaseUrl` names the release page). */
export function reduceStatus(s: UpdateStatus, e: EngineEvent, x: { now: number; releaseUrl: (version: string) => string }): UpdateStatus {
  const base: UpdateStatus = { state: s.state, currentVersion: s.currentVersion, portable: s.portable, checkedUtc: s.checkedUtc }
  // A version found earlier stays known while checking again, and through a failed check or download.
  const known = s.version && (s.state === 'available' || s.state === 'checking') ? { version: s.version, releaseUrl: s.releaseUrl } : {}
  switch (e.kind) {
    case 'checking':
      return clean({ ...base, ...known, state: 'checking' })
    case 'available':
      return clean({ ...base, state: 'available', version: e.version, releaseUrl: x.releaseUrl(e.version), checkedUtc: x.now })
    case 'not-available':
      return clean({ ...base, state: 'up-to-date', checkedUtc: x.now })
    case 'download-started':
      return clean({ ...base, state: 'downloading', version: s.version, releaseUrl: s.releaseUrl, percent: 0 })
    case 'progress':
      return clean({ ...base, state: 'downloading', version: s.version, releaseUrl: s.releaseUrl, percent: Math.max(0, Math.min(100, Math.round(e.percent))) })
    case 'downloaded': {
      const version = e.version || s.version
      return clean({ ...base, state: 'ready', version, releaseUrl: version ? x.releaseUrl(version) : undefined, percent: 100 })
    }
    case 'check-failed':
      return known.version ? clean({ ...base, ...known, state: 'available', error: CHECK_ERROR }) : clean({ ...base, state: 'error', error: CHECK_ERROR })
    case 'download-failed':
      return clean({ ...base, state: 'available', version: s.version, releaseUrl: s.releaseUrl, error: DOWNLOAD_ERROR })
  }
}

/**
 * A log-safe name for an updater error: its code (ERR_UPDATER_…, ENOTFOUND) or HTTP status — never the message,
 * which carries URLs and response bodies.
 */
export function errorCode(e: unknown): string {
  const o = (typeof e === 'object' && e ? e : {}) as { code?: unknown; statusCode?: unknown }
  if (typeof o.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(o.code)) return o.code
  if (typeof o.statusCode === 'number') return `HTTP ${o.statusCode}`
  return 'unknown'
}

// ── the "Update ready" notice ─────────────────────────────────────────────────────────────────
/**
 * The version the "Update ready — Restart" pill offers, or null: only in the desktop app, never in Talk mode, and
 * once per version — a version the owner dismissed stays dismissed.
 */
export function readyNoticeVersion(o: { status: UpdateStatus | null | undefined; desktop: boolean; talk: boolean; dismissed: string | null }): string | null {
  const s = o.status
  if (!o.desktop || o.talk || !s || s.state !== 'ready' || !s.version) return null
  return s.version === o.dismissed ? null : s.version
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function agoText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

const EVERY: Readonly<Record<UpdateInterval, string>> = { off: '', '5m': 'every 5 minutes', '15m': 'every 15 minutes', '1h': 'every hour', '1d': 'once a day' }

/** Settings → About's status line. */
export function updateStatusText(s: UpdateStatus, o: { checkEvery: UpdateInterval; mode: UpdateMode; now: number }): string {
  const v = s.version ?? ''
  switch (s.state) {
    case 'unsupported':
      return 'Updates come to the installed Vesper app on your PC.'
    case 'idle':
      return o.checkEvery === 'off' ? 'Automatic checks are off.' : `Vesper looks for a new version ${EVERY[o.checkEvery]}.`
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `Vesper is up to date.${s.checkedUtc ? ` Checked ${agoText(o.now - s.checkedUtc)}.` : ''}`
    case 'available':
      if (s.portable) return `Version ${v} is available. The portable app doesn't update itself: download it from the release page.`
      return o.mode === 'ask' ? `Version ${v} is available.` : `Version ${v} is available. Vesper downloads it in the background.`
    case 'downloading':
      return `Downloading version ${v}…`
    case 'ready':
      return o.mode === 'auto'
        ? `Version ${v} is ready. It installs when you close Vesper, or by itself while you're away.`
        : `Version ${v} is ready. It installs when you close Vesper.`
    case 'error':
      return s.error ?? CHECK_ERROR
  }
}

// ── controller ────────────────────────────────────────────────────────────────────────────────
/** What the controller needs from electron-updater (src/main/updater.ts) or a fake. */
export interface UpdateEngine {
  configure(b: { autoDownload: boolean; autoInstallOnAppQuit: boolean }): void
  /** Resolves when the check is done (an automatic download continues on its own); rejects when it failed. */
  check(): Promise<void>
  download(): Promise<void>
  /** Quit, install silently and start the new version. */
  install(): void
}

export interface UpdateControllerDeps {
  /** Created on first use, so the updater library loads only when the first check runs. */
  engine(): Promise<UpdateEngine>
  settings(): { checkEvery: UpdateInterval; mode: UpdateMode }
  checkOnly: boolean
  currentVersion: string
  releaseUrl(version: string): string
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(h: unknown): void
  activity(): UpdateActivity
  /** One line, never message text or tokens. */
  log(msg: string): void
  /** Just before an unattended install ('auto'). */
  beforeAutoInstall?(): void
}

export class UpdateController {
  private s: UpdateStatus
  private readonly listeners = new Set<(s: UpdateStatus) => void>()
  private timer: unknown = null
  private idleTimer: unknown = null
  private failures = 0
  private lastCheckUtc: number | null = null
  private startedUtc = 0
  private started = false
  private closed = false
  private checking: Promise<UpdateStatus> | null = null
  private enginePromise: Promise<UpdateEngine> | null = null
  private eng: UpdateEngine | null = null
  private lastAttendedUtc = 0

  constructor(private readonly d: UpdateControllerDeps) {
    this.s = clean({ state: 'idle', currentVersion: d.currentVersion, portable: d.checkOnly || undefined })
  }

  status(): UpdateStatus {
    return this.s
  }

  onChange(fn: (s: UpdateStatus) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Begin the schedule (the first check FIRST_CHECK_DELAY_MS from now). */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.startedUtc = this.d.now()
    this.schedule()
  }

  /** The interval or mode changed (or the PC woke up): the schedule and the mode apply right away. */
  settingsChanged(): void {
    this.schedule()
    const b = this.behaviour()
    this.eng?.configure({ autoDownload: b.autoDownload, autoInstallOnAppQuit: b.autoInstallOnAppQuit })
    if (b.autoDownload && this.s.state === 'available' && !this.checking) void this.download()
    this.watchIdle()
  }

  /** Check now (Check now, or the schedule). Nothing to do while a download runs or one is ready. */
  check(): Promise<UpdateStatus> {
    if (this.closed) return Promise.resolve(this.s)
    if (this.checking) return this.checking
    if (this.s.state === 'downloading' || this.s.state === 'ready') return Promise.resolve(this.s)
    const run = this.runCheck().finally(() => {
      this.checking = null
      this.schedule()
    })
    this.checking = run
    return run
  }

  /** Download the version that is available ('ask', or a retry after a failed download). */
  async download(): Promise<UpdateStatus> {
    if (this.closed || !this.behaviour().canDownload || this.s.state !== 'available' || !this.s.version) return this.s
    this.apply({ kind: 'download-started' })
    try {
      const engine = await this.engine()
      await engine.download()
    } catch (e) {
      // (status(): the events may have moved the state on while this awaited.)
      if (this.status().state === 'downloading') this.downloadFailed(e)
    }
    return this.s
  }

  /** "Restart to update": false when nothing is ready. */
  restart(): boolean {
    if (this.closed || this.s.state !== 'ready' || !this.eng) return false
    this.d.log(`restarting into version ${this.s.version ?? '?'}`)
    this.eng.install()
    return true
  }

  /**
   * Events from the engine. A failed check is reported by check() itself (its promise rejects), so an error counts
   * here only while a download runs — or right after a version was found, when the automatic download failed at once.
   */
  handle(e: EngineEvent | { kind: 'error'; error?: unknown }): void {
    if (this.closed) return
    if (e.kind === 'error') {
      const autoDownloadFailed = this.s.state === 'available' && !this.checking && this.behaviour().autoDownload
      if (this.s.state === 'downloading' || autoDownloadFailed) this.downloadFailed(e.error)
      return
    }
    if (e.kind === 'checking' && this.s.state === 'checking') return
    this.apply(e)
    if (e.kind === 'available') this.d.log(`version ${e.version} is available`)
    if (e.kind === 'downloaded') {
      this.d.log(`version ${this.s.version ?? '?'} is downloaded`)
      this.watchIdle()
    }
  }

  close(): void {
    this.closed = true
    this.clear()
    this.listeners.clear()
  }

  /** Timers in use (leak checks). */
  timers(): { check: boolean; idle: boolean } {
    return { check: this.timer !== null, idle: this.idleTimer !== null }
  }

  private behaviour(): ModeBehaviour {
    return modeBehaviour(this.d.settings().mode, this.d.checkOnly)
  }

  private engine(): Promise<UpdateEngine> {
    if (!this.enginePromise) {
      const p = this.d.engine().then((eng) => {
        this.eng = eng
        return eng
      })
      // A failed load is retried by the next check.
      p.catch(() => {
        if (this.enginePromise === p) this.enginePromise = null
      })
      this.enginePromise = p
    }
    return this.enginePromise
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.clearCheckTimer()
    this.apply({ kind: 'checking' })
    try {
      const engine = await this.engine()
      const b = this.behaviour()
      engine.configure({ autoDownload: b.autoDownload, autoInstallOnAppQuit: b.autoInstallOnAppQuit })
      await engine.check()
      this.failures = 0
      // The engine always answers available / not available; if it said nothing, nothing was found.
      if (this.s.state === 'checking') this.apply({ kind: 'not-available' })
    } catch (e) {
      this.failures++
      this.apply({ kind: 'check-failed' })
      this.d.log(`update check failed (${errorCode(e)}; ${this.failures} in a row)`)
    } finally {
      this.lastCheckUtc = this.d.now()
    }
    return this.s
  }

  private downloadFailed(e: unknown): void {
    this.failures++
    this.apply({ kind: 'download-failed' })
    this.d.log(`update download failed (${errorCode(e)})`)
    this.schedule()
  }

  private apply(e: EngineEvent): void {
    const next = reduceStatus(this.s, e, { now: this.d.now(), releaseUrl: (v) => this.d.releaseUrl(v) })
    if (JSON.stringify(next) === JSON.stringify(this.s)) return
    this.s = next
    for (const fn of [...this.listeners]) {
      try {
        fn(next)
      } catch {
        /* a listener's problem is not the updater's */
      }
    }
  }

  private schedule(): void {
    this.clearCheckTimer()
    if (!this.started || this.closed || this.checking) return
    if (this.s.state === 'downloading' || this.s.state === 'ready') return
    const delay = nextCheckDelay({ interval: this.d.settings().checkEvery, failures: this.failures, lastCheckUtc: this.lastCheckUtc, startedUtc: this.startedUtc, now: this.d.now() })
    if (delay === null) return
    this.timer = this.d.setTimer(() => {
      this.timer = null
      void this.check()
    }, delay)
  }

  /** 'auto' with a version ready: look for an idle moment every IDLE_POLL_MS. */
  private watchIdle(): void {
    const want = !this.closed && this.s.state === 'ready' && this.behaviour().installWhenIdle
    if (!want) {
      if (this.idleTimer !== null) this.d.clearTimer(this.idleTimer)
      this.idleTimer = null
      return
    }
    if (this.idleTimer !== null) return
    this.lastAttendedUtc = this.d.now()
    const tick = (): void => {
      this.idleTimer = null
      if (this.closed || this.s.state !== 'ready' || !this.behaviour().installWhenIdle) return
      const now = this.d.now()
      let a: UpdateActivity
      try {
        a = this.d.activity()
      } catch {
        a = { streaming: true, mic: false, game: false, attended: false }
      }
      if (a.attended) this.lastAttendedUtc = now
      if (mayInstallNow(a, now - this.lastAttendedUtc) && this.eng) {
        this.d.log(`installing version ${this.s.version ?? '?'} while Vesper is idle`)
        this.d.beforeAutoInstall?.()
        this.eng.install()
        return
      }
      this.idleTimer = this.d.setTimer(tick, IDLE_POLL_MS)
    }
    this.idleTimer = this.d.setTimer(tick, IDLE_POLL_MS)
  }

  private clearCheckTimer(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer)
    this.timer = null
  }

  private clear(): void {
    this.clearCheckTimer()
    if (this.idleTimer !== null) this.d.clearTimer(this.idleTimer)
    this.idleTimer = null
  }
}
