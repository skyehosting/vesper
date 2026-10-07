/**
 * Test hooks for Playwright and scripts/shot.mjs (05 §3). Installed only in test builds (`__VESPER_TEST__`) running
 * in test mode (bootstrap.isTest, or a reachable /api/test/ping before sign-in). The release build compiles all of
 * this out, and the packaged smoke test asserts `window.__vesperTest` is undefined (07 B10).
 *
 *   window.__vesperTest = {
 *     ready(), route(), go(path), errors,
 *     ws: { connected(), status(), stats(), drop() },
 *     store: { state() },
 *     <ns>: { … }            // registerTestHooks('<ns>', {…}) from a feature's testHooks.ts
 *   }
 */
import { apiInflight } from './api'
import { navigate, getLocation } from './router'
import { useStore } from './store'
import { ws } from './ws'

type Hooks = Record<string, unknown>

const namespaces: Record<string, Hooks> = {}
const errors: string[] = []
let installed = false
let api: VesperTestApi | null = null
/** The pathname React last committed an outlet for; differs from location while a navigation is still rendering. */
let committedPath: string | null = null

/** Called by the route outlets after commit (test builds only). */
export function markRouteCommitted(pathname: string): void {
  if (__VESPER_TEST__) committedPath = pathname
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

/** Record an error for tests to assert on (`errors` must stay empty in a clean run). No-op outside test builds. */
export function pushTestError(e: unknown): void {
  if (!__VESPER_TEST__) return
  errors.push(describe(e))
  if (errors.length > 200) errors.splice(0, errors.length - 200)
}

if (__VESPER_TEST__) {
  // Collect from the very start so boot failures are visible to tests too.
  window.addEventListener('error', (e) => {
    // Chromium's benign "ResizeObserver loop completed with undelivered notifications" (an `error` event with no Error
    // object, never thrown): an element first observed WHILE observers are being delivered gets its first
    // notification one frame later. Here that happens when the kit VirtualList's observer re-lays out its rows with
    // flushSync (so rows never overlap for a frame); flushSync first flushes React's pending passive effects, and a
    // freshly mounted component elsewhere (e.g. the R3F canvas's own size observer in the presence host) calls
    // observe() from inside that delivery. Nothing is lost and nothing loops — it is not an app error.
    if (!e.error && /^ResizeObserver loop completed with undelivered notifications/.test(e.message)) return
    pushTestError(e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => pushTestError(e.reason))
}

/**
 * Merge `hooks` into `window.__vesperTest[ns]`. Safe to call at import time (registrations made before install are
 * kept). Returns an unregister function. No-op in release builds.
 */
export function registerTestHooks(ns: string, hooks: Hooks): () => void {
  if (!__VESPER_TEST__) return () => undefined
  const cur = namespaces[ns] ?? {}
  namespaces[ns] = { ...cur, ...hooks }
  if (api) api[ns] = namespaces[ns]
  return () => {
    const now = namespaces[ns]
    if (!now) return
    for (const k of Object.keys(hooks)) if (now[k] === hooks[k]) delete now[k]
  }
}

export function testHooksInstalled(): boolean {
  return installed
}

/**
 * App is idle and showing real content: booted (or on the login page), the current URL's outlet committed (a redirect
 * such as first-run → /setup is not still rendering), no API request in flight, no Suspense fallback, no loading marker.
 */
function notReadyReason(): string | null {
  const { phase } = useStore.getState()
  if (phase !== 'ready' && phase !== 'login') return 'phase:' + phase
  if (phase === 'ready' && !ws.connected()) return 'ws:' + ws.status
  if (committedPath !== location.pathname) return 'route:' + String(committedPath) + '!=' + location.pathname
  if (apiInflight() > 0) return 'api:' + apiInflight()
  if (document.querySelector('[data-suspense-fallback]')) return 'suspense'
  if (document.querySelector('[data-loading]')) return 'loading'
  if (document.fonts && document.fonts.status !== 'loaded') return 'fonts'
  return null
}

function isReady(): boolean {
  return notReadyReason() === null
}

export function installTestHooks(): void {
  if (!__VESPER_TEST__ || installed) return
  installed = true
  // Base namespaces go through the same table, so a later registerTestHooks('ws', …) extends instead of replacing.
  namespaces.ws = {
    connected: () => ws.connected(),
    status: () => ws.conn,
    stats: () => ws.stats(),
    /** Drop the socket as if the network failed; the client reconnects with backoff. */
    drop: () => ws.simulateDrop(),
    ...namespaces.ws
  }
  namespaces.store = { state: () => useStore.getState(), ...namespaces.store }
  api = {
    ...namespaces,
    ready: isReady,
    /** Why ready() is false (null when ready): for diagnosing waits. */
    notReady: notReadyReason,
    route: () => getLocation().path,
    go: (path: string) => navigate(path),
    errors,
    ws: namespaces.ws as VesperTestApi['ws']
  }
  window.__vesperTest = api
}
