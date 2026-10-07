/**
 * Startup and session lifecycle:
 *   GET /api/auth/state (public), then GET /api/bootstrap when it says signedIn
 *     signed out / 401 / 403 → phase 'login' (remember where the user was going)
 *     ok  → store bootstrap, apply appearance, open the WebSocket, phase 'ready';
 *           first run on the desktop (wizard not completed) → /setup
 * Also wires app-level realtime events (settings, session list, toasts) and the "session ended" paths
 * (REST 401, WS close 4401) back into the login flow.
 */
import type { Bootstrap } from '@shared/api'
import { toast } from '../components/Toast'
import { api, setApiHooks } from '../lib/api'
import { ApiErrorException, isApiError, parseErrorBody, toApiError } from '../lib/errors.logic'
import { getLocation, navigate } from '../lib/router'
import { useStore } from '../lib/store'
import { installTestHooks, pushTestError } from '../lib/testHooks'
import { installWsDomListeners, setWsErrorReporter, ws } from '../lib/ws'
import { loadSessions } from '../features/sessions/data'
import { clearAllDrafts, installDraftCleanup } from '../features/chat/composer/draft'
import { appearanceOf, applyAppearance } from './appearance'
import { matchPattern } from '../lib/router.logic'
import { routes } from './routes'

/** Path to return to after signing in. */
let afterLogin: string | null = null
let booting: Promise<void> | null = null
let wired = false
let retryTimer: number | null = null

export function boot(): Promise<void> {
  booting ??= run().finally(() => {
    booting = null
  })
  return booting
}

async function run(): Promise<void> {
  const s = useStore.getState()
  if (retryTimer !== null) window.clearTimeout(retryTimer)
  retryTimer = null
  wireOnce()
  if (s.phase !== 'ready') s.setPhase('booting')

  // auth/state first: a signed-out browser goes straight to the login page instead of collecting a 401 from bootstrap.
  let err: unknown = null
  try {
    const auth = await api('GET /api/auth/state')
    useStore.getState().setAuthState(auth)
    if (auth.signedIn) {
      enterApp(await api('GET /api/bootstrap'))
      return
    }
    err = new ApiErrorException(parseErrorBody(401, null), 401)
  } catch (e) {
    err = e
  }
  if (isApiError(err, 'unauthorized') || isApiError(err, 'forbidden')) {
    ws.stop()
    // Signed out, revoked or expired (also when the browser opens already signed out): unsent drafts must not stay
    // readable in this browser (F09). Before the phase change, so the composers that unmount then save nothing.
    clearAllDrafts()
    const here = getLocation().path
    // access-ui: public pages (/pair, whose code is in the #fragment) stay where they are instead of → /login.
    const publicPage = routes.some((r) => r.public && r.path !== '/login' && matchPattern(r.path, getLocation().pathname))
    if (!here.startsWith('/login') && !publicPage) afterLogin = here
    useStore.getState().setPhase('login')
    if (getLocation().pathname !== '/login' && !publicPage) navigate('/login', { replace: true })
    if (__VESPER_TEST__) void probeTestMode()
    return
  }
  // Server unreachable or failing: show the error and retry by itself (the server may still be starting).
  useStore.getState().setPhase('error', toApiError(err))
  retryTimer = window.setTimeout(() => void boot(), 3000)
}

function enterApp(b: Bootstrap): void {
  const s = useStore.getState()
  s.setBootstrap(b)
  applyAppearance(appearanceOf(b.settings))
  if (__VESPER_TEST__ && b.isTest) installTestHooks()
  ws.start()
  // voice-client: speech + mic client (synced reveal, barge-in, audio unlock), lazily so the audio core stays out of
  // the startup bundle; idempotent across re-logins.
  void import('../features/voice/install').then((m) => m.installVoiceClient())
  s.setPhase('ready')
  void loadSessions('')

  const path = getLocation().pathname
  // settings.json was damaged (F59): the wizard never re-runs silently — Settings says what happened, keeps the damaged
  // file's name and offers "Set up again".
  const settingsLost = b.health?.settingsRecovered?.kind === 'reset'
  if (!b.settings.wizard.completed && b.desktop && settingsLost && !path.startsWith('/settings') && path !== '/setup') {
    navigate('/settings', { replace: true })
  } else if (!b.settings.wizard.completed && b.desktop && !settingsLost && path !== '/setup') {
    navigate('/setup', { replace: true })
  } else if (path === '/login') {
    const next = afterLogin && !afterLogin.startsWith('/login') ? afterLogin : '/'
    afterLogin = null
    navigate(next, { replace: true })
  }
}

/** Before sign-in there is no bootstrap to read `isTest` from; the loopback test endpoint answers only in test mode. */
async function probeTestMode(): Promise<void> {
  try {
    const res = await fetch('/api/test/ping', { credentials: 'same-origin', cache: 'no-store' })
    if (res.ok) installTestHooks()
  } catch {
    // not test mode
  }
}

/** The session ended under us (revoked, expired, password changed): back to the login flow. */
function sessionEnded(): void {
  if (useStore.getState().phase !== 'ready') return
  ws.stop()
  void boot()
}

function wireOnce(): void {
  if (wired) return
  wired = true
  setWsErrorReporter((e) => {
    pushTestError(e)
    console.error('[vesper ws]', e)
  })
  setApiHooks({ onUnauthorized: sessionEnded })
  installWsDomListeners()
  installDraftCleanup()

  const st = useStore.getState
  ws.onStatus((info) => {
    st().setConn(info)
    if (info.status === 'unauthorized') sessionEnded()
  })
  ws.on('settings.changed', (m) => {
    st().applySettings(m.settings)
    applyAppearance(appearanceOf(m.settings))
  })
  ws.on('sessions.changed', () => void loadSessions())
  ws.on('session.updated', (m) => st().upsertSession(m.session))
  ws.on('session.deleted', (m) => {
    st().removeSession(m.sessionUid)
    if (getLocation().pathname === `/s/${m.sessionUid}`) navigate('/', { replace: true })
  })
  // A temporary chat ended (07 B9): closed on another device, idle for 24 h, or the app quit. Ending it here already
  // left the chat (and said so), so the notice is only for the chat being read when it ends elsewhere.
  ws.on('session.ended', (m) => {
    st().removeSession(m.sessionUid)
    if (getLocation().pathname !== `/s/${m.sessionUid}`) return
    navigate('/', { replace: true })
    toast.info('This temporary chat has ended. Nothing from it was saved.', { id: `ended-${m.sessionUid}` })
  })
  ws.on('toast', (m) => void toast.show(m.tone, m.text))
  // After a reconnect the list may be stale (sessions created/renamed elsewhere meanwhile).
  let wasReady = false
  ws.onStatus((info) => {
    if (info.status === 'ready' && wasReady) void loadSessions()
    if (info.status === 'ready') wasReady = true
  })
}

/** Sign in with the password, then boot into the app. Throws ApiErrorException (wrong password, lockout). */
export async function signIn(password: string, deviceName: string): Promise<void> {
  await api('POST /api/auth/login', { body: { password, deviceName } })
  await boot()
}

export async function signOut(): Promise<void> {
  try {
    await api('POST /api/auth/logout')
  } finally {
    ws.stop()
    afterLogin = null
    await boot()
  }
}
