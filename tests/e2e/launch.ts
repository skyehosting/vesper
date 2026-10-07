/**
 * Launchers for the two e2e projects (05 §1, 07 E11). Both use fresh temp data dirs and a random port, so runs from
 * parallel worktrees never collide, and both remove their temp dirs on close.
 *
 *   const t = await launchApp({ mock })          // Electron: out/main/index.js, window on the secondary display
 *   await t.hook('go', '/settings'); await t.waitHook('ws.connected')
 *   await t.assertNoErrors(); await t.close()
 *
 *   const s = await launchServer({ mock })       // out/main/server-node.js + headless Chromium, logged in as a browser
 *   await s.page.goto(s.url); const desk = await s.login('desktop')
 *
 * Windows: the owner games on the primary monitor. The Electron window is placed by the dev-window marker
 * (%TEMP%\vesper-dev-window.json → secondary display, never focused), at VESPER_WINDOW_POS=corner, click-through.
 * Browsers are always headless.
 */
import { _electron as electron, chromium, expect, type Browser, type BrowserContext, type ElectronApplication, type LaunchOptions, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clientErrors, collectPageErrors, hookCaller, waitForHook, waitForReady, type HookFn } from './hooks'
import { rawRequest, type RawResponse } from './http'

export const ROOT = path.resolve(__dirname, '..', '..')
export const MAIN = path.resolve(ROOT, process.env.VESPER_MAIN ?? 'out/main/index.js')
export const SERVER_NODE = path.resolve(ROOT, process.env.VESPER_SERVER_NODE ?? 'out/main/server-node.js')

/** Anything with a `url` (a MockServer from tests/mocks/server.ts) or a plain base URL. */
export type MockRef = { url: string } | string

export interface CommonOptions {
  /** Mock provider server; becomes VESPER_MOCK_BASE. */
  mock?: MockRef
  /** Reuse data dirs (persistence across relaunch); dirs passed in are never deleted by close(). */
  dataDir?: string
  localDir?: string
  /** VESPER_FAKE_NOW (ms). */
  fakeNow?: number
  /** VESPER_FAKE_MIC: a WAV file the fake microphone plays. */
  fakeMic?: string
  /** Extra environment (wins over the defaults). */
  env?: Record<string, string>
}

export interface ApiResult<T = unknown> {
  status: number
  json: T
  text: string
}

/** A REST call as some device: (method, path, body?) → status + parsed JSON. */
export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<ApiResult<T>>

function mockUrl(m: MockRef | undefined): string | null {
  if (!m) return null
  return typeof m === 'string' ? m : m.url
}

function makeDirs(o: CommonOptions): { dataDir: string; localDir: string; owned: string[] } {
  const owned: string[] = []
  const mk = (kind: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `vesper-e2e-${kind}-`))
    owned.push(d)
    return d
  }
  return { dataDir: o.dataDir ?? mk('data'), localDir: o.localDir ?? mk('local'), owned }
}

/** Remove test data dirs (used after a relaunch on dirs the launcher did not create). */
export function removeDirs(dirs: string[]): void {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch {
      /* a file is still locked; the OS temp cleaner gets it */
    }
  }
}

/** The environment every Vesper process under test gets (05 §4 switches; all inert without VESPER_TEST=1). */
export function testEnv(o: CommonOptions & { dataDir: string; localDir: string }, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VESPER_')) env[k] = v
  Object.assign(env, {
    VESPER_TEST: '1',
    VESPER_DATA_DIR: o.dataDir,
    VESPER_LOCAL_DIR: o.localDir,
    VESPER_PORT: '0'
  })
  const base = mockUrl(o.mock)
  if (base) env.VESPER_MOCK_BASE = base
  if (o.fakeNow !== undefined) env.VESPER_FAKE_NOW = String(o.fakeNow)
  if (o.fakeMic) env.VESPER_FAKE_MIC = o.fakeMic
  Object.assign(env, extra, o.env ?? {})
  // The app must start as Electron, not as Node (npm test sets this), and must not load a dev server.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return env
}

async function assertClean(page: Page, errors: string[]): Promise<void> {
  let fromClient: string[] = []
  try {
    fromClient = (await clientErrors(page)).map((e) => `client: ${e}`)
  } catch {
    /* page gone */
  }
  const all = [...errors, ...fromClient]
  expect(all, all.join('\n')).toEqual([])
}

/** REST from inside the page: same origin, the page's own cookie, X-Vesper set (the way the client calls). */
export function pageApi(page: Page): Api {
  return async <T>(method: string, p: string, body?: unknown): Promise<ApiResult<T>> => {
    const r = await page.evaluate(
      async ({ method: m, p: url, body: b }) => {
        const res = await fetch(url, {
          method: m,
          credentials: 'same-origin',
          headers: { 'x-vesper': '1', ...(b === undefined ? {} : { 'content-type': 'application/json' }) },
          body: b === undefined ? undefined : JSON.stringify(b)
        })
        return { status: res.status, text: await res.text() }
      },
      { method, p, body }
    )
    return { status: r.status, text: r.text, json: parseJson(r.text) as T }
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    return undefined
  }
}

// ── Electron ──────────────────────────────────────────────────────────────────────────────────
export interface LaunchAppOptions extends CommonOptions {
  /** Window content size (default 1440x900). */
  size?: string
  /** 'corner' (default) or 'x,y'. */
  pos?: string
  /** Leave the window clickable for the real mouse (default: click-through). */
  clickable?: boolean
  timeoutMs?: number
}

export interface TestApp {
  app: ElectronApplication
  page: Page
  dataDir: string
  localDir: string
  /** Console errors and page errors seen so far. */
  errors: string[]
  hook: HookFn
  waitHook(dotted: string, o?: { timeout?: number; args?: unknown[] }): Promise<void>
  waitReady(): Promise<void>
  /** REST as the desktop device. */
  api: Api
  /** Console, page and client-collected errors are all empty. */
  assertNoErrors(): Promise<void>
  /** Close the app; temp dirs are removed unless `keepData` (to relaunch on the same data). */
  close(o?: { keepData?: boolean }): Promise<void>
}

export async function launchApp(o: LaunchAppOptions = {}): Promise<TestApp> {
  if (!fs.existsSync(MAIN)) throw new Error(`Built app not found at ${MAIN}. Run: npx electron-vite build`)
  const dirs = makeDirs(o)
  const env = testEnv(
    { ...o, ...dirs },
    {
      VESPER_WINDOW_SIZE: o.size ?? '1440x900',
      VESPER_WINDOW_POS: o.pos ?? 'corner',
      ...(o.clickable ? {} : { VESPER_CLICK_THROUGH: '1' })
    }
  )
  const timeout = o.timeoutMs ?? 30_000
  let app: ElectronApplication
  try {
    app = await electron.launch({ args: [MAIN], env, timeout })
  } catch (e) {
    removeDirs(dirs.owned)
    throw e
  }
  const errors: string[] = []
  let page: Page
  try {
    page = await app.firstWindow({ timeout })
    collectPageErrors(page, errors)
    await waitForReady(page, timeout)
  } catch (e) {
    await app.close().catch(() => undefined)
    removeDirs(dirs.owned)
    throw e
  }
  const hook = hookCaller(page)
  let closed = false
  return {
    app,
    page,
    dataDir: dirs.dataDir,
    localDir: dirs.localDir,
    errors,
    hook,
    waitHook: (dotted, w) => waitForHook(page, hook, dotted, w),
    waitReady: () => waitForReady(page, timeout),
    api: pageApi(page),
    assertNoErrors: () => assertClean(page, errors),
    async close(c = {}) {
      if (closed) return
      closed = true
      const proc = app.process()
      await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))])
      if (proc.exitCode === null) proc.kill()
      if (!c.keepData) removeDirs(dirs.owned)
    }
  }
}

// ── Standalone server + Chromium ──────────────────────────────────────────────────────────────
export interface LaunchServerOptions extends CommonOptions {
  /**
   * Runtime for server-node.js. 'electron' (default) runs it on Electron's own Node via ELECTRON_RUN_AS_NODE so
   * node:sqlite and crypto match the product (07 E6); 'node' uses the Node running Playwright.
   */
  runtime?: 'electron' | 'node'
  /** Device the browser context signs in as (default 'browser'); false = stay signed out. */
  login?: 'browser' | 'desktop' | false
  /** Navigate the page to the app and wait for ready (default true). */
  open?: boolean
  viewport?: { width: number; height: number }
  timeoutMs?: number
}

export interface TestServer {
  /** http://127.0.0.1:<port> as printed by VESPER_READY. */
  url: string
  proc: ChildProcess
  browser: Browser
  context: BrowserContext
  page: Page
  dataDir: string
  localDir: string
  errors: string[]
  hook: HookFn
  waitHook(dotted: string, o?: { timeout?: number; args?: unknown[] }): Promise<void>
  waitReady(): Promise<void>
  /** REST as the context's device (cookie header from the context; Origin, Sec-Fetch-Site and X-Vesper set). */
  api: Api
  /** Sign in another device through /api/test/login-as and get an Api bound to it (the context is untouched). */
  login(kind: 'browser' | 'desktop'): Promise<{ api: Api; cookie: string }>
  /** `Cookie` header value of the context for the server URL. */
  cookieHeader(): Promise<string>
  /** Server stdout + stderr so far. */
  output(): string
  assertNoErrors(): Promise<void>
  close(o?: { keepData?: boolean }): Promise<void>
}

/**
 * Chromium for the browser project. Prefers Playwright's own build; if that revision is not installed (no download
 * may happen on this machine), falls back to the newest installed ms-playwright build, then to Microsoft Edge.
 * VESPER_E2E_CHROMIUM=<path to chrome.exe> overrides.
 */
export function chromiumLaunchOptions(): LaunchOptions {
  const forced = process.env.VESPER_E2E_CHROMIUM
  if (forced) return { executablePath: forced }
  try {
    if (fs.existsSync(chromium.executablePath())) return {}
  } catch {
    /* unknown revision */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright')
  const candidates: Array<{ rev: number; exe: string }> = []
  try {
    for (const name of fs.readdirSync(root)) {
      const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name)
      if (!m) continue
      const exe =
        m[1] === 'chromium' ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'].map((p) => path.join(root, name, p)).find((p) => fs.existsSync(p)) : path.join(root, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
      // Prefer the headless shell of a revision over the full browser of the same revision.
      if (exe && fs.existsSync(exe)) candidates.push({ rev: Number(m[2]) * 2 + (m[1] === 'chromium' ? 0 : 1), exe })
    }
  } catch {
    /* no browsers directory */
  }
  candidates.sort((a, b) => b.rev - a.rev)
  if (candidates.length) return { executablePath: candidates[0].exe }
  return { channel: 'msedge' }
}

function electronBinary(): string {
  // The `electron` package's main export is the path of the binary when required from Node.
  const p = require('electron') as unknown
  if (typeof p !== 'string') throw new Error('could not resolve the Electron binary')
  return p
}

/** Spawn server-node.js and resolve with the URL from its `VESPER_READY <url>` line. */
export function spawnServer(env: Record<string, string>, runtime: 'electron' | 'node', timeoutMs: number): Promise<{ proc: ChildProcess; url: string; output: () => string }> {
  if (!fs.existsSync(SERVER_NODE)) throw new Error(`Built server not found at ${SERVER_NODE}. Run: npx electron-vite build`)
  const exe = runtime === 'electron' ? electronBinary() : process.execPath
  const procEnv = runtime === 'electron' ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
  const proc = spawn(exe, [SERVER_NODE], { env: procEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  const output = (): string => out
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`server-node did not print VESPER_READY within ${timeoutMs} ms. Output:\n${out}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      const m = /VESPER_READY (\S+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ proc, url: m[1].replace(/\/$/, ''), output })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server-node exited (${code}) before VESPER_READY. Output:\n${out}`))
    })
  })
}

/** Headers a same-origin browser request would carry. */
export function sameOriginHeaders(url: string, cookie: string): Record<string, string> {
  return { origin: url, 'sec-fetch-site': 'same-origin', 'x-vesper': '1', ...(cookie ? { cookie } : {}) }
}

function rawApi(url: string, cookie: () => Promise<string>): Api {
  return async <T>(method: string, p: string, body?: unknown): Promise<ApiResult<T>> => {
    const headers = sameOriginHeaders(url, await cookie())
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r: RawResponse = await rawRequest(url, { method, path: p, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, text: r.text, json: r.json as T }
  }
}

function cookieFrom(r: RawResponse): string {
  const set = r.headers['set-cookie'] ?? []
  return set.map((c) => c.split(';')[0]).join('; ')
}

export async function launchServer(o: LaunchServerOptions = {}): Promise<TestServer> {
  const dirs = makeDirs(o)
  const timeout = o.timeoutMs ?? 30_000
  let started: Awaited<ReturnType<typeof spawnServer>>
  try {
    started = await spawnServer(testEnv({ ...o, ...dirs }), o.runtime ?? 'electron', timeout)
  } catch (e) {
    removeDirs(dirs.owned)
    throw e
  }
  const { proc, url } = started
  const errors: string[] = []
  let browser: Browser | null = null
  const stop = async (keepData: boolean): Promise<void> => {
    await browser?.close().catch(() => undefined)
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    }
    if (!keepData) removeDirs(dirs.owned)
  }
  try {
    const args = ['--mute-audio']
    if (o.fakeMic) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${o.fakeMic}%noloop`)
    browser = await chromium.launch({ headless: true, args, ...chromiumLaunchOptions() })
    const context = await browser.newContext({ baseURL: url, viewport: o.viewport ?? { width: 1440, height: 900 } })
    const page = await context.newPage()
    collectPageErrors(page, errors)

    const login = async (kind: 'browser' | 'desktop'): Promise<{ api: Api; cookie: string }> => {
      const r = await rawRequest(url, { method: 'POST', path: '/api/test/login-as', headers: { ...sameOriginHeaders(url, ''), 'content-type': 'application/json' }, body: JSON.stringify({ kind }) })
      if (r.status >= 300) throw new Error(`/api/test/login-as ${kind} → ${r.status}: ${r.text}`)
      const cookie = cookieFrom(r)
      if (!cookie) throw new Error(`/api/test/login-as ${kind} set no cookie`)
      return { cookie, api: rawApi(url, async () => cookie) }
    }
    if (o.login !== false) {
      // Through the context's request so the cookie lands in the context exactly as the server set it.
      const r = await context.request.post(`${url}/api/test/login-as`, { data: { kind: o.login ?? 'browser' }, headers: sameOriginHeaders(url, '') })
      if (!r.ok()) throw new Error(`/api/test/login-as → ${r.status()}: ${await r.text()}`)
    }
    // Playwright's request client (and `context.cookies(url)`) skip Secure cookies over plain http, although Chromium
    // treats loopback as secure and sends them; so REST calls carry the context's cookies for this host explicitly.
    const host = new URL(url).hostname
    const cookieHeader = async (): Promise<string> =>
      (await context.cookies())
        .filter((c) => c.domain.replace(/^\./, '') === host || host.endsWith(c.domain))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')
    const hook = hookCaller(page)
    if (o.open !== false) {
      await page.goto(url)
      await waitForReady(page, timeout)
    }
    return {
      url,
      proc,
      browser,
      context,
      page,
      dataDir: dirs.dataDir,
      localDir: dirs.localDir,
      errors,
      hook,
      waitHook: (dotted, w) => waitForHook(page, hook, dotted, w),
      waitReady: () => waitForReady(page, timeout),
      api: rawApi(url, cookieHeader),
      login,
      cookieHeader,
      output: started.output,
      assertNoErrors: () => assertClean(page, errors),
      close: (c = {}) => stop(!!c.keepData)
    }
  } catch (e) {
    await stop(false)
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nServer output:\n${started.output()}`)
  }
}
