/**
 * Vesper's Electron main process: lifecycle, the in-process server, the window, the tray (02 §1, 07 B11, D2, E8).
 * Order matters: paths, sandbox, Chromium switches and the single-instance lock are set before `ready`.
 */
import { app, clipboard, globalShortcut, Menu, nativeTheme, powerMonitor, session, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DESKTOP_IPC } from '../preload/types'
import { startServer } from '../server/app'
import { recoverDamagedDatabase, type StartupDbError } from '../server/data/backup'
import { markDatabaseAtRest } from '../server/system/cleanShutdown'
import { MIGRATIONS } from '../server/db/migrations'
import type { RunningServer } from '../server/services'
import { installDevWindowOverride } from './devWindow'
import { ask } from './dialogs'
import { testEnv } from './env'
import { registerDesktopIpc } from './ipc'
import { closeAction, isBackgroundLaunch, isDarkTheme, warmDelayMs } from './lifecycle'
import { createLog, setLogDir } from './log'
import { resolveDirs } from './paths'
import { createElectronPlatform, type DesktopPlatform } from './platform'
import { startWithRecovery } from './startup'
import { installAutostart } from './autostart'
import { installGlobalHotkey } from './hotkey'
import { systemOf } from '../server/system'
import { appIcon, createTray, destroyTray, refreshTrayMenu, registerTrayItems, setTrayMic, trayMicState } from './tray'
import { installTrayAccess } from './trayAccess'
import { originOf } from './urls'
import { consumeBackgroundRelaunch, createDesktopUpdater } from './updater'
import { configureSessions, createMainWindow, getWindowState, hardenWebContents, PARTITION } from './window'

const log = createLog('main')
const test = testEnv()

// ── Before ready ──────────────────────────────────────────────────────────────────────────────
// userData is pinned to %APPDATA%\Vesper explicitly: a dev run (`electron out/main/index.js`) would otherwise be named
// "Electron". Chromium's caches go to the local profile (07 E8).
const dirs = resolveDirs({
  defaultUserData: path.join(app.getPath('appData'), 'Vesper'),
  localAppData: process.env.LOCALAPPDATA ?? null,
  home: os.homedir(),
  test
})
app.setPath('userData', dirs.dataDir)
// H-v12-updates: a relaunch after an unattended update starts in the tray when the window was hidden then.
const background = isBackgroundLaunch(process.argv) || consumeBackgroundRelaunch(dirs.localDir, process.argv)

/** Everything else that must happen before `ready` — only in the instance that holds the lock. */
function prepare(): void {
  app.setPath('sessionData', dirs.sessionDataDir)
  app.commandLine.appendSwitch('disk-cache-dir', dirs.cacheDir)
  app.setAppLogsPath(dirs.logsDir)
  setLogDir(dirs.logsDir)

  app.enableSandbox()
  Menu.setApplicationMenu(null)
  app.setAppUserModelId('com.vesper.app')

  if (__VESPER_TEST__ && test) {
    // Keep rendering while the test window is covered or unfocused; deterministic screenshots.
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-background-timer-throttling')
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
    // DPR 1 unless a spec asks for a real high-density window (VESPER_TEST_SCALE, 1–3: hairline captures).
    const scale = Number(process.env.VESPER_TEST_SCALE)
    app.commandLine.appendSwitch('force-device-scale-factor', scale >= 1 && scale <= 3 ? String(scale) : '1')
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
    if (test.fakeMic) {
      // getUserMedia gets the WAV instead of a real microphone (07 E10). No `use-fake-ui-for-media-stream`: it would
      // grant every request without asking our permission handler (measured: the camera too), so tests would no longer
      // exercise the production policy — which already grants the microphone to our origin without a prompt.
      app.commandLine.appendSwitch('use-fake-device-for-media-stream')
      app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(test.fakeMic)}%noloop`)
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────────────────────
let platform: DesktopPlatform | null = null
let server: RunningServer | null = null
let win: BrowserWindow | null = null
/** The loopback origin the window, permissions and IPC are bound to (null until the server runs). */
let allowedOrigin: string | null = null
let quitting = false
let closeToTray = false
let keepWarmSec = 30
let dark = true
let warmTimer: NodeJS.Timeout | null = null
/** Set while the shell itself destroys a hidden window (closed to tray), so 'closed' does not quit. */
let destroyingHidden = false
let openWhenReady = false
/** The global push-to-talk hotkey is registered: a window hidden in the tray stays loaded to receive it (F73). */
let hotkeyKeepsWindow = false
/** bootstrap() decided whether to open the window (a hidden one for the hotkey is only made after that). */
let booted = false
/** A hidden window loaded for the hotkey: give its page this long after load to connect and wire push-to-talk. */
const WAKE_SETTLE_MS = 1500
const WAKE_TIMEOUT_MS = 20_000
const disposers: (() => void | Promise<void>)[] = []

function clearWarmTimer(): void {
  if (warmTimer) clearTimeout(warmTimer)
  warmTimer = null
}

function sendState(): void {
  if (win && !win.isDestroyed()) win.webContents.send(DESKTOP_IPC.state, getWindowState(win))
}

/**
 * Windows is ending the session (shutdown, restart, log off): Electron emits no will-quit then, so the temporary-chat
 * folder (07 B9) is removed synchronously right here, best effort. The next start sweeps whatever is left (F64).
 * The database is checkpointed and marked at rest, so the next cold launch skips the full quick_check (07 H12).
 */
function removeTempNow(): void {
  const ctx = server?.ctx
  if (!ctx) return
  if (markDatabaseAtRest(ctx)) log.info('session ending: database checkpointed')
  try {
    fs.rmSync(ctx.paths.temp, { recursive: true, force: true })
    log.info('session ending: temporary files removed')
  } catch (e) {
    log.warn('session ending: could not remove temporary files', e)
  }
}

function openWindow(): void {
  clearWarmTimer()
  if (quitting) return
  if (!server) {
    // Asked for (second launch, notification) while the server is still starting: open once it runs.
    openWhenReady = true
    return
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  createWindow(server, false)
}

function createWindow(srv: RunningServer, hidden: boolean): BrowserWindow {
  const w = createMainWindow({
    dataDir: dirs.dataDir,
    test,
    url: srv.loopbackUrl,
    dark,
    icon: platform ? appIcon(platform.resourcesDir) : undefined,
    hidden,
    onState: () => sendState()
  })
  win = w
  w.on('session-end', () => removeTempNow())
  w.on('close', (e) => {
    if (closeAction({ quitting, closeToTray, background }) === 'close') return
    e.preventDefault()
    w.hide()
    log.info('window hidden to the tray')
    scheduleWarmDestroy(w)
  })
  w.on('closed', () => {
    if (win === w) win = null
    const intended = destroyingHidden
    destroyingHidden = false
    if (!quitting && !intended) app.quit()
  })
  return w
}

/**
 * F73: the global push-to-talk hotkey needs a loaded window — a "Start with Windows" launch never opens one. Load it
 * hidden in the tray (shown by Open like any tray window); true once its page has loaded and had a moment to connect.
 */
function wakeForHotkey(): Promise<boolean> {
  if (quitting || !server || !booted) return Promise.resolve(false)
  let w = win && !win.isDestroyed() ? win : null
  if (!w) {
    w = createWindow(server, true)
    log.info('window loaded hidden for the push-to-talk hotkey')
  }
  const target = w
  const wc = target.webContents
  if (!wc.isLoading()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settle: NodeJS.Timeout | null = null
    const done = (ok: boolean): void => {
      clearTimeout(guard)
      if (settle) clearTimeout(settle)
      if (!wc.isDestroyed()) {
        wc.removeListener('did-finish-load', loaded)
        wc.removeListener('did-fail-load', failed)
      }
      target.removeListener('closed', failed)
      resolve(ok)
    }
    const loaded = (): void => {
      settle = setTimeout(() => done(!target.isDestroyed()), WAKE_SETTLE_MS)
    }
    const failed = (): void => done(false)
    const guard = setTimeout(failed, WAKE_TIMEOUT_MS)
    wc.once('did-finish-load', loaded)
    wc.once('did-fail-load', failed)
    target.once('closed', failed)
  })
}

/** Closed to the tray: free the renderer after `desktop.keepWindowWarmSec` (07 D2); Open recreates it. */
function scheduleWarmDestroy(w: BrowserWindow): void {
  clearWarmTimer()
  const delay = warmDelayMs(keepWarmSec)
  if (delay == null || hotkeyKeepsWindow) return
  warmTimer = setTimeout(() => {
    warmTimer = null
    if (w.isDestroyed() || w.isVisible() || hotkeyKeepsWindow) return
    destroyingHidden = true
    w.destroy()
    log.info(`window destroyed after ${delay / 1000} s in the tray`)
  }, delay)
}

function applyDesktopSettings(s: { closeToTray?: boolean; keepWindowWarmSec?: number } | undefined): void {
  closeToTray = !!s?.closeToTray
  keepWarmSec = s?.keepWindowWarmSec ?? 30
}

function watchSettings(srv: RunningServer): void {
  const settings = srv.ctx?.settings
  if (!settings) return
  try {
    const s = settings.get()
    applyDesktopSettings(s.desktop)
    dark = isDarkTheme(s.appearance?.theme, nativeTheme.shouldUseDarkColors)
    disposers.push(settings.subscribe('desktop', (next) => applyDesktopSettings(next.desktop)))
    disposers.push(
      settings.subscribe('appearance', (next) => {
        dark = isDarkTheme(next.appearance?.theme, nativeTheme.shouldUseDarkColors)
        if (win && !win.isDestroyed()) win.setBackgroundColor(dark ? '#07070d' : '#f7f6fb')
      })
    )
  } catch (e) {
    log.warn('settings unavailable; desktop defaults in use', e)
  }
}

async function bootstrap(): Promise<void> {
  configureSessions(() => allowedOrigin)
  const p = createElectronPlatform({ dataDir: dirs.dataDir, localDir: dirs.localDir, test })
  platform = p
  p.onNotificationClick(() => openWindow())
  // H-v12-updates: attached before the server starts, so its `update.state` relay sees it. Null in dev and test runs.
  const updates = createDesktopUpdater({
    packaged: app.isPackaged,
    test: !!test,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    localDir: dirs.localDir
  })
  if (updates) p.updater = updates.bridge

  const devRendererUrl = !app.isPackaged ? (process.env.ELECTRON_RENDERER_URL ?? null) : null
  const srv = await startWithRecovery({
    start: (port) =>
      startServer(p, {
        port: port ?? test?.port ?? undefined,
        devRendererUrl,
        webDir: path.join(p.appDir, 'web'),
        workersDir: path.join(p.appDir, 'main')
      }),
    ask: (spec) => ask(spec),
    onError: (e, kind, attempt) => log.error(`server start failed (${kind}, attempt ${attempt})`, e),
    // 07 C19 (F60): the owner chose Restore or Start fresh for a damaged database; the damaged files are kept.
    recoverDb: (e, choice) => {
      const d = (e as StartupDbError).details
      const dbLog = createLog('database')
      const asServerLog = { ...dbLog, child: () => asServerLog }
      recoverDamagedDatabase(d.dbFile, d.backupsDir, choice, { schemaVersion: Math.max(...MIGRATIONS.map((m) => m.version)), log: asServerLog })
    },
    logFile: path.join(dirs.logsDir, 'main.log')
  })
  if (!srv) {
    log.info('quitting: the server could not start')
    quitting = true
    app.exit(1)
    return
  }
  server = srv
  allowedOrigin = originOf(srv.loopbackUrl)
  disposers.push(() => srv.close())
  // macOS/Linux report a shutdown here; on Windows the window's 'session-end' does (when a window exists).
  powerMonitor.on('shutdown', removeTempNow)
  disposers.push(() => void powerMonitor.off('shutdown', removeTempNow))

  // The per-launch desktop session (§5.3): only in this partition's jar, session-only (no expiry), HttpOnly.
  const cookie = await srv.createDesktopSession()
  await session.fromPartition(PARTITION).cookies.set({
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict'
  })

  watchSettings(srv)
  if (updates && srv.ctx) {
    const ctx = srv.ctx
    updates.start({
      settings: () => ctx.settings.get().updates,
      subscribe: (fn) => ctx.settings.subscribe('updates', fn),
      // Without the system module nothing is known: treat Vesper as busy (no unattended restart).
      activity: () => systemOf(ctx)?.updateActivity() ?? { streaming: true, mic: false, game: false, attended: false },
      windowHidden: () => !(win && !win.isDestroyed() && win.isVisible())
    })
    const onResume = (): void => updates.resumed()
    powerMonitor.on('resume', onResume)
    disposers.push(() => {
      powerMonitor.off('resume', onResume)
      updates.dispose()
    })
  }
  disposers.push(
    registerDesktopIpc({
      window: () => (win && !win.isDestroyed() ? win : null),
      allowedOrigin: () => allowedOrigin,
      close: () => win?.close(),
      openExternal: (url) => p.openExternal(url)
    })
  )
  createTray({ resourcesDir: p.resourcesDir, onOpen: () => openWindow(), onQuit: () => app.quit() })
  disposers.push(() => destroyTray())
  // 07 B17 (F21): a red dot on the tray icon while any device streams mic audio to this PC.
  const sys = srv.ctx ? systemOf(srv.ctx) : null
  if (sys) disposers.push(sys.onMicActivity((devices) => setTrayMic(devices.map((d) => d.name))))
  if (__VESPER_TEST__ && test) (globalThis as { __vesperTrayMic?: () => unknown }).__vesperTrayMic = trayMicState
  disposers.push(installTrayAccess(srv.ctx, { register: registerTrayItems, refresh: refreshTrayMenu, copy: (t) => clipboard.writeText(t), warn: (m, e) => log.warn(m, e) }))
  disposers.push(installAutostart(srv.ctx, { packaged: app.isPackaged, test: !!test, portable: !!process.env.PORTABLE_EXECUTABLE_FILE, set: (o) => app.setLoginItemSettings(o), log: (m) => log.info(m) }))

  // 07 D6: opt-in global push-to-talk hotkey (voice.globalHotkey); presses go to the focused desktop client.
  if (srv.ctx) {
    const ctx = srv.ctx
    disposers.push(
      installGlobalHotkey({
        api: globalShortcut,
        setting: () => ctx.settings.get().voice.globalHotkey ?? null,
        subscribe: (fn) => ctx.settings.subscribe('voice', fn),
        press: () => systemOf(ctx)?.hotkey() ?? false,
        notice: (text) => ctx.hub.broadcast({ t: 'toast', tone: 'warning', text }, { desktopOnly: true }),
        // F73: keep the hidden window loaded while the hotkey is on; free it again (07 D2) once it is off.
        active: (on) => {
          hotkeyKeepsWindow = on
          if (on) clearWarmTimer()
          else if (!quitting && win && !win.isDestroyed() && !win.isVisible()) scheduleWarmDestroy(win)
        },
        unavailable: (text) => p.notify('Push-to-talk', text),
        wake: () => wakeForHotkey(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
        log: (m) => log.info(m)
      })
    )
  }

  if (!background || openWhenReady) openWindow()
  booted = true
  // A background launch (login item) opens no window; the hotkey still needs one loaded (F73).
  if (hotkeyKeepsWindow && !(win && !win.isDestroyed())) void wakeForHotkey()
  if (__VESPER_TEST__ && test) process.stdout.write(`VESPER_READY ${srv.loopbackUrl}\n`)
  log.info(`ready on ${srv.loopbackUrl}${background ? ' (background)' : ''}`)
}

function main(): void {
  installDevWindowOverride()
  hardenWebContents(
    () => allowedOrigin,
    (url) => void platform?.openExternal(url).catch((e: unknown) => log.warn('openExternal failed', e))
  )

  app.on('second-instance', (_e, argv) => {
    // A second launch brings the window forward — except a background launch (login item) while already running.
    if (!isBackgroundLaunch(argv)) openWindow()
  })
  // Windows closing never quits by themselves: the close handler decides (tray or quit).
  app.on('window-all-closed', () => undefined)
  app.on('before-quit', () => {
    quitting = true
    clearWarmTimer()
  })
  let shutDown = false
  app.on('will-quit', (e) => {
    if (shutDown) return
    e.preventDefault()
    shutDown = true
    const all = (async () => {
      for (const d of disposers.reverse()) {
        try {
          await d()
        } catch (err) {
          log.warn('shutdown step failed', err)
        }
      }
    })()
    const timeout = new Promise<void>((r) => setTimeout(r, 5000))
    void Promise.race([all, timeout]).finally(() => app.exit(0))
  })
  process.on('uncaughtException', (e) => log.error('uncaught exception', e))
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e))

  app
    .whenReady()
    .then(bootstrap)
    .catch(async (e: unknown) => {
      log.error('startup failed', e)
      await ask({
        type: 'error',
        title: 'Vesper',
        message: "Vesper couldn't start.",
        detail: `${e instanceof Error ? e.message : String(e)}\n\nDetails are in ${path.join(dirs.logsDir, 'main.log')}.`,
        buttons: ['Quit'],
        cancelId: 0
      }).catch(() => 0)
      quitting = true
      app.exit(1)
    })
}

// One Vesper per data dir (the lock lives in userData): a second launch hands over to the first (focus/restore) and
// exits before touching Chromium's profile.
if (app.requestSingleInstanceLock({ background })) {
  prepare()
  main()
} else app.exit(0)
