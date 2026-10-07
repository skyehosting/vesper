#!/usr/bin/env node
/**
 * Screenshot any route of the BUILT desktop app (npx electron-vite build first).
 *
 *   node scripts/shot.mjs --route /settings --size 1440x900 --out .shots/settings.png
 *        [--wait 500] [--until ws.connected] [--timeout 45000] [--main out/main/index.js]
 *        [--mock-base http://127.0.0.1:PORT] [--seed '{"sessions":3,"messagesPerSession":20}']
 *        [--fake-now <ms>] [--pos corner|x,y] [--keep-open <ms>] [--full-page]
 *
 * Fresh temp data dirs, VESPER_TEST=1 and a random port, like e2e. The window opens where the dev-window marker
 * (%TEMP%\vesper-dev-window.json, e.g. {"display":"secondary"}) puts it, never focused, click-through for the real
 * mouse unless --keep-open. Hooks are called as functions only (the CSP forbids string eval).
 * Prints a JSON report {ok, out, route, errors[]}; exit 1 on console/page errors or a timeout, 2 on bad usage.
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true
    else {
      out[a.slice(2)] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// A leading slash is optional: Git Bash rewrites '/settings' into a Windows path unless MSYS_NO_PATHCONV=1.
const route = `/${(typeof args.route === 'string' ? args.route : '').replace(/^\/+/, '')}`
const size = typeof args.size === 'string' ? args.size : '1440x900'
const slug = route.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home'
const outFile = path.resolve(root, typeof args.out === 'string' ? args.out : `.shots/${slug}-${size}.png`)
const mainPath = path.resolve(root, typeof args.main === 'string' ? args.main : 'out/main/index.js')
const timeout = Number(args.timeout ?? 45000)
const until = typeof args.until === 'string' ? args.until : 'ready'
const keepOpen = Number(args['keep-open'] ?? 0)
const ALLOWED = [/Download the React DevTools/i]

if (/^\/[A-Za-z]:[\\/]/.test(route)) {
  console.error(`--route looks like a Windows path (${route}); pass it without the leading slash or set MSYS_NO_PATHCONV=1`)
  process.exit(2)
}
if (!/^\d+x\d+$/.test(size)) {
  console.error('--size must look like 1440x900')
  process.exit(2)
}
if (!fs.existsSync(mainPath)) {
  console.error(`Built app not found at ${mainPath}. Run: npx electron-vite build`)
  process.exit(2)
}
const marker = path.join(os.tmpdir(), 'vesper-dev-window.json')
if (!fs.existsSync(marker)) console.error(`note: ${marker} is missing, so the window opens on the default display`)
fs.mkdirSync(path.dirname(outFile), { recursive: true })

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-shot-data-'))
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-shot-local-'))
const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VESPER_')) env[k] = v
Object.assign(env, {
  VESPER_TEST: '1',
  VESPER_DATA_DIR: dataDir,
  VESPER_LOCAL_DIR: localDir,
  VESPER_PORT: '0',
  VESPER_WINDOW_SIZE: size,
  VESPER_WINDOW_POS: typeof args.pos === 'string' ? args.pos : 'corner'
})
if (!(keepOpen > 0)) env.VESPER_CLICK_THROUGH = '1'
if (typeof args['mock-base'] === 'string') env.VESPER_MOCK_BASE = args['mock-base']
if (typeof args['fake-now'] === 'string') env.VESPER_FAKE_NOW = args['fake-now']
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE

const errors = []
const report = { ok: false, out: outFile, route, size, errors }
let app
let page

/** window.__vesperTest.<dotted>(...a), awaited in the page. */
const callHook = (p, a = []) =>
  page.evaluate(
    async ({ p, a }) => {
      const parts = p.split('.')
      let owner = window.__vesperTest
      for (const part of parts.slice(0, -1)) owner = owner?.[part]
      const fn = owner?.[parts[parts.length - 1]]
      if (typeof fn !== 'function') throw new Error(`No test hook: __vesperTest.${p}`)
      return await fn.apply(owner, a)
    },
    { p, a }
  )

try {
  app = await electron.launch({ args: [mainPath], env, timeout: 30000 })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error' && !ALLOWED.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.waitForFunction(() => typeof window.__vesperTest?.ready === 'function' && window.__vesperTest.ready() === true, null, { timeout })

  if (typeof args.seed === 'string') {
    const seed = await page.evaluate(async (body) => {
      const r = await fetch('/api/test/seed', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vesper': '1' }, body })
      return { status: r.status, text: await r.text() }
    }, args.seed)
    if (seed.status >= 300) throw new Error(`/api/test/seed → ${seed.status}: ${seed.text}`)
    report.seed = JSON.parse(seed.text)
  }

  await callHook('go', [route])
  const deadline = Date.now() + timeout
  for (;;) {
    let ok = false
    try {
      ok = !!(await callHook(until))
    } catch {
      ok = false
    }
    if (ok) break
    if (Date.now() > deadline) throw new Error(`Timed out waiting for __vesperTest.${until}()`)
    await page.waitForTimeout(150)
  }
  const extra = Number(args.wait ?? 0)
  if (extra > 0) await page.waitForTimeout(extra)
  report.finalRoute = await callHook('route').catch(() => null)
  errors.push(...(await page.evaluate(() => (Array.isArray(window.__vesperTest?.errors) ? [...window.__vesperTest.errors] : []))).map((e) => `client: ${e}`))
  await page.screenshot({ path: outFile, fullPage: !!args['full-page'] })
  if (keepOpen > 0) await page.waitForTimeout(keepOpen)
  report.ok = errors.length === 0
} catch (e) {
  errors.push(`shot failed: ${e && e.message ? e.message : String(e)}`)
  try {
    if (page) await page.screenshot({ path: outFile })
  } catch {
    /* no window to capture */
  }
} finally {
  try {
    await app?.close()
  } catch {
    /* already gone */
  }
  for (const d of [dataDir, localDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch {
      /* locked; left for the temp cleaner */
    }
  }
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
