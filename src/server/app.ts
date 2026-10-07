/**
 * Server entry: startServer(platform, opts) → RunningServer (services.ts). Builds the ServerContext (paths, DB,
 * repositories, settings, secrets, hub, log, clock), registers the WebSocket handler modules, and starts Listener A on
 * http://127.0.0.1:<port> (trying port+1…+10 when busy, 07 C19). Listeners B/C are added by access-server through
 * `coreOf(ctx).listeners`. Never imports electron: the same code runs in Electron and under plain Node.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { NetworkStatus } from '@shared/types/domain'
import { createAuthCore, SESSION_COOKIE } from './auth/core'
import { isTemporarySession } from './chat/temporary'
import { bindCore, type ServerCore } from './core'
import { MIGRATIONS } from './db/migrations'
import { createRepos } from './db/repos/index'
import { isCorruption, MAIN_BUSY_TIMEOUT_MS, openDb } from './db/sqlite'
import { applyPendingRestore, assertDatabaseUsable, migrateWithBackup, StartupDbError, usableBackups } from './data/backup'
import { toApiError } from './http/errors'
import { createListenerRegistry, loopbackSpec } from './http/listeners'
import { createLog } from './log'
import type { Platform } from './platform'
import type { RunningServer, ServerContext, StartOptions } from './services'
import { createSecretsService } from './settings/secrets'
import { createSettingsStore } from './settings/store'
import { CLEAN_MARKER, DB_FILE, takeCleanMarker, writeCleanMarker } from './system/cleanShutdown'
import { markTempDir, sweepStaleTempDirs, tempDirName } from './system/tempSweep'
import { isTestMode, testEnv } from './testMode'
import { registerWsHandlers } from './ws/handlers'
import { createHub, type HubOptions } from './ws/hub'

export interface StartOptionsExtra extends StartOptions {
  /** Tests: hub timings (ping interval, rate limits). */
  hub?: HubOptions
}

/** %LOCALAPPDATA%\Vesper for the real data dir (07 E8); a sibling "<dataDir>-local" otherwise. */
export function localDirFor(platform: Platform): string {
  const fromEnv = testEnv('VESPER_LOCAL_DIR')
  if (fromEnv) return path.resolve(fromEnv)
  const provided = (platform as Platform & { localDir?: string }).localDir
  if (provided) return provided
  const roaming = process.env.APPDATA
  const local = process.env.LOCALAPPDATA
  if (roaming && local && path.resolve(platform.dataDir).toLowerCase() === path.join(roaming, 'Vesper').toLowerCase()) return path.join(local, 'Vesper')
  return `${path.resolve(platform.dataDir)}-local`
}

export async function startServer(platform: Platform, opts: StartOptionsExtra): Promise<RunningServer> {
  const testMode = isTestMode()
  const roaming = path.resolve(platform.dataDir)
  const local = localDirFor(platform)
  // Temporary-chat files (07 B9): %TEMP%\Vesper-<pid>; tests keep them inside their own dir, or under VESPER_TEMP_ROOT
  // to exercise the release layout (and its sweep) in a temp root of their own.
  const tempRoot = __VESPER_TEST__ && testMode ? (testEnv('VESPER_TEMP_ROOT') ?? null) : os.tmpdir()
  const paths: ServerContext['paths'] = {
    roaming,
    local,
    attachments: path.join(roaming, 'attachments'),
    models: path.join(local, 'models'),
    logs: path.join(local, 'logs'),
    backups: path.join(roaming, 'backups'),
    exports: path.join(roaming, 'exports'),
    temp: tempRoot ? path.join(tempRoot, tempDirName(process.pid)) : path.join(local, 'temp')
  }
  for (const d of [roaming, local, paths.logs]) fs.mkdirSync(d, { recursive: true })

  const log = createLog({ dir: paths.logs, console: !platform.isPackaged && !testMode })
  log.info('starting', { version: platform.version, test: testMode, packaged: platform.isPackaged })
  // A crash, a kill or a Windows shutdown skips close(): earlier runs' temporary-chat files are removed now (F04).
  if (tempRoot) sweepStaleTempDirs(tempRoot, { selfPid: process.pid, log: log.child('temp') })
  fs.mkdirSync(paths.temp, { recursive: true })
  if (tempRoot) markTempDir(paths.temp, process.pid, platform.now())

  const dbFile = path.join(roaming, DB_FILE)
  // 07 C20: a restore staged by POST /api/backups/restore is swapped in before the database is opened.
  const restored = applyPendingRestore(dbFile, paths.backups, log, platform.now())
  // 07 C19 (F60): a read-only check first; a damaged file stops the start with a typed error the desktop answers with
  // a restore dialog (never written to, never deleted). 07 H12: the full quick_check (every page) only when the last
  // run did not close this file cleanly; otherwise the header and schema (milliseconds, whatever the size).
  const cleanMarker = path.join(local, CLEAN_MARKER)
  const wasClean = takeCleanMarker(cleanMarker, dbFile, log) && !restored
  try {
    assertDatabaseUsable(dbFile, paths.backups, Math.max(...MIGRATIONS.map((m) => m.version)), log, { full: !wasClean })
  } catch (e) {
    log.close()
    throw e
  }
  // 07 C9: the main thread waits at most 250 ms for db.worker's lock; hot write paths retry asynchronously.
  let db: ReturnType<typeof openDb>
  try {
    db = openDb(dbFile, { busyTimeoutMs: MAIN_BUSY_TIMEOUT_MS })
  } catch (e) {
    log.error('opening the database failed', { error: e })
    log.close()
    if (isCorruption(e)) {
      const schema = Math.max(...MIGRATIONS.map((m) => m.version))
      throw new StartupDbError('DB_CORRUPT', `Vesper's database is damaged (${e instanceof Error ? e.message : String(e)}).`, { dbFile, backupsDir: paths.backups, backups: usableBackups(paths.backups, schema) }, { cause: e })
    }
    throw e
  }
  const closers: (() => void | Promise<void>)[] = []
  let core: ServerCore | null = null
  try {
    // 07 C20: backup before every migration; a failed migration puts the backup back.
    await migrateWithBackup(db, { dbFile, backupsDir: paths.backups, migrations: MIGRATIONS, log, now: platform.now() })
    const repos = createRepos(db)
    const settings = await createSettingsStore(path.join(roaming, 'settings.json'), log.child('settings'))
    const secrets = createSecretsService(platform.secrets, log.child('secrets'))

    // `core` is filled right below; the closures only run after startup.
    const getCore = () => core as ServerCore
    const hub = createHub(
      {
        now: () => getCore().ctx.clock.now(),
        log,
        toApiError,
        sessionExists: (uid) => {
          const s = repos.sessions.byUid(uid)
          // Phase 3 engine-int: temporary chats live in memory only (07 B9) and are subscribable too.
          return (!!s && s.deletedUtc === null) || isTemporarySession(getCore().ctx, uid)
        },
        // F01: the same revocation, approval and lifetime rules as REST (auth core), re-checked on every ping tick.
        stillValid: (c) => getCore().auth.stillValid(c.device.id),
        seen: (c, ip) => getCore().auth.touch(c.device.id, ip)
      },
      opts.hub
    )

    const ctx: ServerContext = {
      platform,
      db,
      repos,
      settings,
      secrets,
      hub,
      log,
      clock: { now: () => platform.now() + (core?.clockOffsetMs ?? 0) },
      services: { testers: {} },
      paths,
      onClose: (fn) => void closers.push(fn),
      toApiError
    }

    const auth = createAuthCore(ctx, { version: platform.version, passwordSet: () => fs.existsSync(path.join(roaming, 'auth.json')) })
    const listeners = createListenerRegistry({ ctx, auth, hub, webDir: opts.webDir, devRendererUrl: opts.devRendererUrl ?? null })
    let networkProvider: (() => NetworkStatus) | null = null
    core = {
      ctx,
      repos,
      settings,
      secrets,
      hub,
      log,
      auth,
      listeners,
      opts,
      version: platform.version,
      testMode,
      clockOffsetMs: 0,
      eventLoopDelay: null,
      loopbackUrl: () => listeners.get('loopback')?.url ?? '',
      networkStatus: () => (networkProvider ? networkProvider() : defaultNetworkStatus(getCore())),
      setNetworkStatusProvider: (fn) => {
        networkProvider = fn
      }
    }
    bindCore(core)

    settings.onChange((next) => hub.broadcast({ t: 'settings.changed', settings: next }))
    registerWsHandlers(ctx)

    const configured = settings.get().access.port
    const wanted = opts.port ?? configured
    const a = await listeners.start(loopbackSpec(wanted, wanted === 0 ? 0 : 10))
    ctx.app = a.app
    if (wanted !== 0 && wanted === configured && a.port !== configured) {
      log.warn('port busy; moved', { from: configured, to: a.port })
      await settings.patch({ access: { port: a.port } }).catch(() => undefined)
    }
    if (testMode) {
      core.eventLoopDelay = monitorEventLoopDelay({ resolution: 10 })
      core.eventLoopDelay.enable()
    }
    log.info('listening', { url: a.url })
  } catch (e) {
    log.error('startup failed', { error: e })
    try {
      db.close()
    } catch {
      /* already closed */
    }
    log.close()
    throw e
  }

  const c = core as ServerCore
  let closing: Promise<void> | null = null
  return {
    ctx: c.ctx,
    port: c.listeners.get('loopback')!.port,
    loopbackUrl: c.loopbackUrl(),
    async createDesktopSession() {
      const r = c.auth.createDesktopSession()
      return { name: SESSION_COOKIE, value: r.token, url: c.loopbackUrl() }
    },
    close() {
      closing ??= (async () => {
        c.hub.close()
        await c.listeners.closeAll().catch((e: unknown) => log.warn('closing listeners', { error: e }))
        for (const fn of closers.reverse()) {
          try {
            await fn()
          } catch (e) {
            log.warn('close hook failed', { error: e })
          }
        }
        await c.settings.flush()
        c.eventLoopDelay?.disable()
        try {
          db.exec('PRAGMA optimize')
          db.close()
          // Only after a close that went through: the next start can skip the full quick_check (07 H12).
          writeCleanMarker(cleanMarker, dbFile, platform.now(), log)
        } catch (e) {
          log.warn('closing the database', { error: e })
        }
        log.info('stopped')
        log.close()
        fs.rmSync(paths.temp, { recursive: true, force: true })
      })()
      return closing
    }
  }
}

function defaultNetworkStatus(core: ServerCore): NetworkStatus {
  const port = core.listeners.get('loopback')?.port ?? 0
  return {
    mode: core.settings.get().access.mode,
    loopback: { port, url: `http://127.0.0.1:${port}`, browserUrl: `http://vesper.localhost:${port}` },
    lan: null,
    tailscale: null,
    passwordSet: core.auth.state().passwordSet,
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    capabilities: { mic: true, install: true, warningFree: true }
  }
}

