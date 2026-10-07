/**
 * Auto-updates from GitHub Releases (H-v12-updates), on electron-updater's NSIS updater. The schedule, the modes and
 * the state machine live in src/shared/updater.logic.ts (UpdateController); this file adapts electron-updater to it
 * and hands the server a PlatformUpdater (`platform.updater`).
 *
 * - Light on the network: a check is ONE small request — `releases/latest/download/latest.yml` (~400 bytes, GitHub
 *   redirects it to the latest release's asset). The stock GitHub provider would also read the releases Atom feed
 *   and the latest-release page, so `LatestYmlProvider` replaces its lookup and keeps its download paths
 *   (`releases/download/v<version>/…`), which the blockmap differential download needs (the old blockmap's URL is the
 *   new one with the version swapped).
 * - Where from: owner/repo come from package.json `repository` (the same field electron-builder publishes with).
 *   While it still names the placeholder owner, nothing runs.
 * - Never in dev (unpackaged) or test runs. The portable build only checks (no download, no install).
 * - electron-updater loads on the first check (~30 s after start), not at startup; its own logger is off. Our log
 *   gets state changes and error codes only.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import type { UpdateInfo } from 'electron-updater'
import type { ResolvedUpdateFileInfo } from 'electron-updater/out/types'
import type { PlatformUpdater } from '../server/platform'
import type { UpdateInterval, UpdateMode } from '@shared/settings'
import { githubRepo, releasePageUrl, UpdateController, updaterSupport, type EngineEvent, type GithubRepo, type UpdateActivity, type UpdateEngine } from '@shared/updater.logic'
import { createLog } from './log'

const log = createLog('updates')

/** Written before an unattended install; the relaunch (`--updated`) then starts in the tray, as Vesper was. */
const BACKGROUND_MARKER = 'update-relaunch-background'

export interface DesktopUpdater {
  /** What the server sees (attach as `platform.updater`). */
  readonly bridge: PlatformUpdater
  /** Begin the schedule once the server runs (settings, activity and the tray state come from it). */
  start(o: {
    settings(): { checkEvery: UpdateInterval; mode: UpdateMode }
    subscribe(fn: () => void): () => void
    activity(): UpdateActivity
    /** The window is hidden right now (closed to the tray, or never opened). */
    windowHidden(): boolean
  }): void
  /** The PC woke up: a check that came due while it slept runs soon. */
  resumed(): void
  dispose(): void
}

/** owner/repo from the shipped package.json; null when it can't be read. */
function shippedRepo(appPath: string): GithubRepo | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')) as { repository?: unknown }
    return githubRepo(pkg.repository)
  } catch {
    return null
  }
}

/** Null when this build never updates itself (dev, test, placeholder repository). */
export function createDesktopUpdater(o: { packaged: boolean; test: boolean; portable: boolean; appPath: string; version: string; localDir: string }): DesktopUpdater | null {
  const repo = shippedRepo(o.appPath)
  const support = updaterSupport({ packaged: o.packaged, test: o.test, portable: o.portable, repo })
  if (!support.run || !repo) {
    if (support.run === false && support.why === 'no-repo') log.info('updates off: package.json names no GitHub repository yet')
    return null
  }
  let settings: () => { checkEvery: UpdateInterval; mode: UpdateMode } = () => ({ checkEvery: 'off', mode: 'install-on-close' })
  let activity: () => UpdateActivity = () => ({ streaming: true, mic: false, game: false, attended: true })
  let windowHidden: () => boolean = () => false
  let unsubscribe: (() => void) | null = null

  const controller: UpdateController = new UpdateController({
    engine: () => loadEngine(repo, (e) => controller.handle(e)),
    settings: () => settings(),
    checkOnly: support.checkOnly,
    currentVersion: o.version,
    releaseUrl: (v) => releasePageUrl(repo, v),
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return t
    },
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    activity: () => activity(),
    log: (m) => log.info(m),
    beforeAutoInstall: () => {
      if (!windowHidden()) return
      try {
        fs.mkdirSync(o.localDir, { recursive: true })
        fs.writeFileSync(path.join(o.localDir, BACKGROUND_MARKER), String(Date.now()))
      } catch {
        /* the new version then opens its window; nothing else depends on it */
      }
    }
  })

  const bridge: PlatformUpdater = {
    status: () => controller.status(),
    check: () => controller.check(),
    download: () => controller.download(),
    restart: () => controller.restart(),
    onChange: (fn) => controller.onChange(fn)
  }

  log.info(`updates from github.com/${repo.owner}/${repo.repo}${support.checkOnly ? ' (portable: check only)' : ''}`)
  return {
    bridge,
    start(s) {
      settings = s.settings
      activity = s.activity
      windowHidden = s.windowHidden
      unsubscribe = s.subscribe(() => controller.settingsChanged())
      controller.start()
    },
    resumed: () => controller.settingsChanged(),
    dispose() {
      unsubscribe?.()
      unsubscribe = null
      controller.close()
    }
  }
}

/**
 * A relaunch after an unattended update starts in the tray when the window was hidden then (the marker), so an
 * update never pops a window up while the owner is away. The marker is removed either way; only an `--updated`
 * start honours it.
 */
export function consumeBackgroundRelaunch(localDir: string, argv: readonly string[]): boolean {
  const file = path.join(localDir, BACKGROUND_MARKER)
  let found = false
  try {
    found = fs.existsSync(file)
    if (found) fs.rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
  return found && argv.includes('--updated')
}

type LatestInfo = UpdateInfo & { tag: string }

/** electron-updater, configured for GitHub Releases through the one-request provider. Loaded on first use. */
async function loadEngine(repo: GithubRepo, emit: (e: EngineEvent | { kind: 'error'; error?: unknown }) => void): Promise<UpdateEngine> {
  // A plain require at run time (like src/server/ws/wsLib.ts): the package stays external, inside app.asar, and its
  // getter-style exports (`autoUpdater`) work as they do in CommonJS.
  const req = createRequire(import.meta.url)
  const mod = req('electron-updater') as typeof import('electron-updater')
  const helpers = req('electron-updater/out/providers/Provider') as typeof import('electron-updater/out/providers/Provider')
  const base = new URL('https://github.com')
  const prefix = `/${repo.owner}/${repo.repo}/releases`

  class LatestYmlProvider extends mod.Provider<LatestInfo> {
    constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) {
      // GitHub serves release assets from S3-like storage: one byte range per request.
      super({ ...runtime, isUseMultipleRangeRequest: false })
    }

    async getLatestVersion(): Promise<LatestInfo> {
      const file = `${this.getDefaultChannelName()}.yml`
      const url = new URL(`${prefix}/latest/download/${file}`, base)
      const raw = await this.httpRequest(url, { accept: 'application/x-yaml, text/yaml, text/plain, */*', 'cache-control': 'no-cache' })
      const info = helpers.parseUpdateInfo(raw, file, url)
      return { ...info, tag: `v${info.version}` }
    }

    resolveFiles(info: LatestInfo): ResolvedUpdateFileInfo[] {
      return helpers.resolveFiles(info, base, (p) => `${prefix}/download/${info.tag}/${p.replace(/ /g, '-')}`)
    }
  }

  const u = mod.autoUpdater
  u.logger = null
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.allowPrerelease = false
  u.allowDowngrade = false
  u.fullChangelog = false
  u.setFeedURL({ provider: 'custom', updateProvider: LatestYmlProvider })
  u.on('checking-for-update', () => emit({ kind: 'checking' }))
  u.on('update-available', (info) => emit({ kind: 'available', version: info.version }))
  u.on('update-not-available', () => emit({ kind: 'not-available' }))
  u.on('download-progress', (p) => emit({ kind: 'progress', percent: p.percent }))
  u.on('update-downloaded', (e) => emit({ kind: 'downloaded', version: e.version }))
  // Always listened to: an unhandled 'error' event would throw. The controller logs the code, never the message.
  u.on('error', (error) => emit({ kind: 'error', error }))
  return {
    configure(b) {
      u.autoDownload = b.autoDownload
      u.autoInstallOnAppQuit = b.autoInstallOnAppQuit
    },
    async check() {
      const r = await u.checkForUpdates()
      // An automatic download reports through events ('error' included); its promise must not go unhandled.
      r?.downloadPromise?.catch(() => undefined)
    },
    async download() {
      await u.downloadUpdate()
    },
    install() {
      // Silent install, then start the new version.
      u.quitAndInstall(true, true)
    }
  }
}
