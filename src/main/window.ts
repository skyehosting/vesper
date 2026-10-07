/**
 * The Vesper window and the hardening of everything web content can do (07 B11). The window always loads the
 * loopback server (`http://127.0.0.1:<port>/`, also in dev — 07 E3) in its own partition `persist:vesper`, whose
 * cookie jar alone holds the per-launch desktop session cookie.
 */
import { app, BrowserWindow, Menu, screen, session, type MenuItemConstructorOptions, type Rectangle, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { TITLE_BAR_HEIGHT, type DesktopWindowState, type TitleBarOverlayColors } from '../preload/types'
import type { TestEnv } from './env'
import { writeJsonAtomic } from './jsonFile'
import { createLog } from './log'
import { decidePermission } from './permissions'
import { isSameOrigin, validateExternalUrl } from './urls'
import {
  DEFAULT_SIZE,
  MIN_SIZE,
  compensate,
  cornerPosition,
  displayFor,
  edgeError,
  initialPlacement,
  nearRect,
  refitPlacement,
  sanitizePlacement,
  type PersistedPlacement,
  type Placement,
  type Size
} from './windowBounds'

const log = createLog('window')

export const PARTITION = 'persist:vesper'

export const OVERLAY_DARK: TitleBarOverlayColors = { color: '#07070d', symbolColor: '#f3f1fb' }
export const OVERLAY_LIGHT: TitleBarOverlayColors = { color: '#f7f6fb', symbolColor: '#16141f' }

export function getWindowState(win: BrowserWindow | null): DesktopWindowState {
  if (!win || win.isDestroyed()) return { maximized: false, minimized: false, fullscreen: false, focused: false, visible: false }
  return {
    maximized: win.isMaximized(),
    minimized: win.isMinimized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
    visible: win.isVisible()
  }
}

// ── Session & web-contents hardening ──────────────────────────────────────────────────────────

/**
 * Permission handlers on the window's partition (07 B11) and a closed default session (nothing should ever load
 * there). `allowedOrigin()` is the loopback origin, or null before the server runs (then everything is denied).
 */
export function configureSessions(allowedOrigin: () => string | null): Session {
  const def = session.defaultSession
  def.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  def.setPermissionCheckHandler(() => false)
  def.setDevicePermissionHandler(() => false)

  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const media = permission === 'media' ? (details as Electron.MediaAccessPermissionRequest) : null
    const ok = decidePermission({
      permission,
      requester: media?.securityOrigin ?? details.requestingUrl,
      allowedOrigin: allowedOrigin(),
      mediaTypes: media?.mediaTypes
    })
    if (!ok) log.info(`permission denied: ${permission}`)
    cb(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    decidePermission({
      permission,
      requester: details.securityOrigin ?? requestingOrigin,
      allowedOrigin: allowedOrigin(),
      mediaTypes: permission === 'media' ? (details.mediaType ? [details.mediaType] : []) : undefined
    })
  )
  ses.setDevicePermissionHandler(() => false)
  // Exports and attachment downloads come from our own origin (Save As dialog); nothing else may download.
  ses.on('will-download', (e, item) => {
    if (!isSameOrigin(item.getURL(), allowedOrigin()) && !item.getURL().startsWith('blob:')) {
      log.warn('blocked a download from another origin')
      e.preventDefault()
    }
  })
  return ses
}

/** Hardening for every WebContents the app ever creates (window, devtools, anything injected). */
export function hardenWebContents(allowedOrigin: () => string | null, openExternal: (url: string) => void): void {
  app.on('web-contents-created', (_e, contents) => {
    // Links with target=_blank / window.open: never a new Electron window; http(s)/mailto go to the system browser
    // after validation (the renderer has already shown the owner the real host, 07 B8).
    contents.setWindowOpenHandler(({ url }) => {
      const safe = validateExternalUrl(url)
      if (safe && !isSameOrigin(safe, allowedOrigin())) openExternal(safe)
      else log.warn('blocked window.open')
      return { action: 'deny' }
    })
    const keepOnOrigin = (e: { preventDefault(): void }, url: string): void => {
      if (isSameOrigin(url, allowedOrigin())) return
      e.preventDefault()
      log.warn('blocked navigation away from the loopback origin')
    }
    contents.on('will-navigate', keepOnOrigin)
    contents.on('will-redirect', keepOnOrigin)
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })
  // Our only origin is plain-HTTP loopback; any certificate error is someone else's page — never accept it.
  app.on('certificate-error', (e, _wc, _url, _err, _cert, cb) => {
    e.preventDefault()
    cb(false)
  })
}

// ── Placement ────────────────────────────────────────────────────────────────────────────────

/** Test windows open exactly as asked (content size, position) and may be smaller than the normal minimum. */
function testPlacement(test: TestEnv): { bounds: Partial<Rectangle>; min: Size; contentSize: boolean } {
  const size = test.windowSize ?? DEFAULT_SIZE
  let bounds: Partial<Rectangle> = { ...size }
  const pos = test.windowPos
  if (pos?.kind === 'point') bounds = { ...bounds, x: pos.x, y: pos.y }
  else if (pos?.kind === 'corner') bounds = { ...bounds, ...cornerPosition(size, screen.getPrimaryDisplay().workArea) }
  return {
    bounds,
    min: { width: Math.min(MIN_SIZE.width, size.width), height: Math.min(MIN_SIZE.height, size.height) },
    contentSize: !!test.windowSize
  }
}

/**
 * `setBounds` until the window is where asked: across monitors with different scaling Windows converts with a small
 * error, so a try that lands off is followed by one asking for the target less the measured error (≤ 3 tries).
 */
function moveTo(win: BrowserWindow, target: Rectangle): void {
  let request = target
  let best = { request, error: Infinity }
  for (let attempt = 0; attempt < 3; attempt++) {
    win.setBounds(request)
    const actual = win.getBounds()
    const error = edgeError(actual, target)
    if (error < best.error) best = { request, error }
    if (nearRect(actual, target)) return
    request = compensate(request, target, actual)
  }
  if (!nearRect(win.getBounds(), target)) win.setBounds(best.request)
}

/**
 * A real window: shown (maximized when the placement says so), its normal bounds and maximized state saved as they
 * change (debounced), and kept inside the work area of its display when it is shown and when displays change.
 */
function keepOnScreen(win: BrowserWindow, placement: Placement, save: (data: PersistedPlacement) => void, show: () => void): void {
  let normal = placement.bounds
  let displayId = placement.displayId
  const inNormalState = (): boolean => !win.isMaximized() && !win.isMinimized() && !win.isFullScreen()

  let saveTimer: NodeJS.Timeout | null = null
  const flush = (): void => {
    if (win.isDestroyed()) return
    if (inNormalState()) normal = win.getBounds()
    save({ maximized: win.isMaximized(), bounds: normal })
  }
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flush()
    }, 500)
  }

  const refit = (why: 'displays' | 'shown' | 'moved' | 'restored'): void => {
    if (win.isDestroyed() || win.isFullScreen()) return
    const normalState = inNormalState()
    const current = normalState ? win.getBounds() : normal
    const next = refitPlacement(current, screen.getAllDisplays(), screen.getPrimaryDisplay(), win.isMaximized() ? win.getBounds() : current)
    const [minW, minH] = win.getMinimumSize()
    if (minW !== next.min.width || minH !== next.min.height) win.setMinimumSize(next.min.width, next.min.height)
    const movedDisplay = next.displayId !== displayId
    displayId = next.displayId
    // Dragged to another display or restored from maximized: only a window too large for its display is fitted — a
    // position the owner chose (even straddling two monitors) stays.
    const tooLarge = current.width > next.bounds.width || current.height > next.bounds.height
    if (why === 'moved' && !(movedDisplay && tooLarge)) return
    if (why === 'restored' && !tooLarge) return
    if (nearRect(current, next.bounds)) return
    if (normalState) moveTo(win, next.bounds)
    else {
      normal = next.bounds
      if (!win.isMinimized()) scheduleSave()
    }
  }

  let refitTimer: NodeJS.Timeout | null = null
  const scheduleRefit = (why: 'displays' | 'restored' = 'displays'): void => {
    if (refitTimer) clearTimeout(refitTimer)
    // Displays change in bursts (a scaling change reports every monitor); let Windows finish moving the window first.
    refitTimer = setTimeout(() => {
      refitTimer = null
      refit(why)
    }, 300)
  }

  win.once('ready-to-show', () => {
    // Created on a monitor whose scaling differs from the primary's, the window comes out a few DIP off its bounds.
    const created = win.getBounds()
    if (!nearRect(created, placement.bounds) && displayFor(screen.getAllDisplays(), created)?.id === placement.displayId) moveTo(win, placement.bounds)
    if (placement.maximize) win.maximize()
    show()
    if (placement.maximize) scheduleSave()
    setTimeout(() => refit('shown'), 400)
  })

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', () => {
    scheduleSave()
    scheduleRefit('restored')
  })
  win.on('moved', () => refit('moved'))
  // Closing (also to the tray) saves at once: the window may be destroyed before the debounce fires.
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    flush()
  })

  const onDisplays = (): void => scheduleRefit('displays')
  const events = ['display-metrics-changed', 'display-added', 'display-removed'] as const
  for (const ev of events) screen.on(ev as 'display-added', onDisplays)
  win.once('closed', () => {
    for (const ev of events) screen.removeListener(ev as 'display-added', onDisplays)
    if (refitTimer) clearTimeout(refitTimer)
    if (saveTimer) clearTimeout(saveTimer)
  })
}

// ── Window ───────────────────────────────────────────────────────────────────────────────────

export interface MainWindowOptions {
  dataDir: string
  test: TestEnv | null
  /** The loopback URL to load. */
  url: string
  /** Initial theme for the background and caption buttons (the page recolors them via the bridge). */
  dark: boolean
  icon: Electron.NativeImage | string | undefined
  /** Load without showing (the tray window the global push-to-talk hotkey needs, F73); `show()` it later. */
  hidden?: boolean
  onState(state: DesktopWindowState): void
}

function contextMenu(win: BrowserWindow, contents: WebContents): void {
  // Pages with their own context menus prevent the DOM event, and then this never fires.
  contents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => contents.replaceMisspelling(s) })
      if (items.length === 0) items.push({ label: 'No suggestions', enabled: false })
      items.push({ label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy })
      items.push({ role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' })
    } else if (params.selectionText.trim()) items.push({ role: 'copy' })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
}

export function createMainWindow(o: MainWindowOptions): BrowserWindow {
  const stateFile = path.join(o.dataDir, 'window-state.json')
  // Test windows with an explicit size/position are placed as asked and never persisted.
  const test = o.test && (o.test.windowSize || o.test.windowPos) ? testPlacement(o.test) : null
  let persisted: PersistedPlacement = {}
  if (!test) {
    try {
      persisted = sanitizePlacement(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
    } catch {
      persisted = {}
    }
  }
  const placement = test
    ? null
    : initialPlacement({ persisted, displays: screen.getAllDisplays(), primary: screen.getPrimaryDisplay(), requested: o.test?.windowSize ?? null })
  const min = placement?.min ?? test?.min ?? MIN_SIZE
  const overlay = o.dark ? OVERLAY_DARK : OVERLAY_LIGHT

  const win = new BrowserWindow({
    ...(placement?.bounds ?? test?.bounds),
    useContentSize: !!test?.contentSize,
    minWidth: min.width,
    minHeight: min.height,
    show: false,
    title: 'Vesper',
    icon: o.icon,
    backgroundColor: o.dark ? '#07070d' : '#f7f6fb',
    // Our own title area with the native Windows caption buttons drawn over its right end.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlay, height: TITLE_BAR_HEIGHT },
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      // Tests keep rendering while covered or unfocused.
      backgroundThrottling: !o.test
    }
  })

  const pushState = (): void => o.onState(getWindowState(win))
  for (const ev of ['maximize', 'unmaximize', 'minimize', 'restore', 'focus', 'blur', 'show', 'hide', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as 'maximize', pushState)
  }

  if (o.test) {
    // Test mode: audio muted (no test may play through the real speakers) unless VESPER_MUTE=0.
    if (o.test.mute) win.webContents.setAudioMuted(true)
  }

  const showWindow = (): void => {
    if (win.isDestroyed()) return
    if (o.hidden) {
      // Stays in the tray until opened; then it shows as a normally opened window would (maximized if it was).
      if (o.test?.clickThrough) win.setIgnoreMouseEvents(true)
      if (placement?.maximize) win.once('show', () => !win.isDestroyed() && win.maximize())
      return
    }
    if (o.test) {
      // Never steal focus while automated tests run.
      win.showInactive()
      // The real mouse passes through the test window; Playwright's CDP input is unaffected.
      if (o.test.clickThrough) win.setIgnoreMouseEvents(true)
    } else win.show()
  }
  // A hidden window must not be maximized yet: maximize() would show it.
  if (placement) keepOnScreen(win, o.hidden ? { ...placement, maximize: false } : placement, (data) => void writeJsonAtomic(stateFile, data).catch((e) => log.warn('window state save failed', e)), showWindow)
  else win.once('ready-to-show', showWindow)

  contextMenu(win, win.webContents)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    // DevTools in development builds only (the application menu, and with it the default accelerators, is removed).
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
      if (!app.isPackaged) win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })

  // A crashed renderer is reloaded (at most 3 times in 5 minutes), never left blank.
  const crashes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode })
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    while (crashes.length && now - crashes[0] > 5 * 60_000) crashes.shift()
    crashes.push(now)
    if (crashes.length <= 3) setTimeout(() => !win.isDestroyed() && void win.loadURL(o.url).catch(() => undefined), 1000)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) log.error('page failed to load', { code, desc, sameOrigin: isSameOrigin(url, new URL(o.url).origin) })
  })

  void win.loadURL(o.url).catch((e: unknown) => log.error('loadURL failed', e))
  return win
}

