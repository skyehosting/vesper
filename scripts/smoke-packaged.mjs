#!/usr/bin/env node
/**
 * Packaged-app smoke test (07 B10, review F43) — run by `npm run smoke:packaged`, which builds the RELEASE flavour
 * (VESPER_BUILD_TEST=0) and an unpacked package (electron-builder --dir, the inspect fuse left on so Playwright can
 * attach), then:
 *
 *   node scripts/smoke-packaged.mjs --exe release/smoke/win-unpacked/Vesper.exe [--keep]
 *
 * What it checks on the real Vesper.exe:
 *   1. it starts (as a login item would: --background, so no window appears, nothing takes focus) and is packaged;
 *   2. the server answers on loopback: the web client's page, its notices, /api/auth/state — and /api/test/ping is 404;
 *   3. the web client loads in a window of the app's own session (partition, preload from the asar, CSP) — created
 *      hidden, never shown — and `window.__vesperTest` is undefined while the preload's `vesperDesktop` exists;
 *   4. the test switches are inert: it is launched WITH VESPER_TEST=1 and VESPER_* paths, and must ignore them;
 *   5. it exits cleanly on quit (exit code 0) and leaves no process behind (utility processes, PowerShell hosts).
 *
 * Isolation: a release build ignores VESPER_DATA_DIR, so the process gets its own Windows profile folders (USERPROFILE,
 * APPDATA, LOCALAPPDATA → temp folders, removed afterwards unless --keep), checked first with a throwaway Electron
 * app of the same runtime; if appData would not land in the temp folder, nothing is launched. The owner's real %APPDATA%\Vesper is never touched, and the single-
 * instance lock lives in that temp profile, so a running Vesper is not disturbed. Nothing is installed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

const args = process.argv.slice(2)
const exeArg = args[args.indexOf('--exe') + 1]
const keep = args.includes('--keep')
if (!args.includes('--exe') || !exeArg) {
  console.error('usage: node scripts/smoke-packaged.mjs --exe <path to Vesper.exe> [--keep]')
  process.exit(2)
}
if (process.platform !== 'win32') {
  console.error('The packaged smoke test runs on Windows (the only packaged target).')
  process.exit(2)
}
const exe = path.resolve(exeArg)
if (!fs.existsSync(exe)) {
  console.error(`Not found: ${exe}. Build it with: npm run smoke:packaged`)
  process.exit(2)
}
const exeDir = path.dirname(exe)

/** @type {Array<{ name: string; ok: boolean; detail: string }>} */
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/** Processes started from this package (by executable or command line), from a read-only CIM query. */
function packageProcesses() {
  const dir = exeDir.replace(/'/g, "''")
  const ps = `Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}', [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf('${dir}', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf('Get-CimInstance', [StringComparison]::OrdinalIgnoreCase) -lt 0) } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    return out
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

/** app.getPath('appData') of a throwaway Electron app run with `env` (no window, quits at once). */
function preflightAppData(env, root) {
  const dir = path.join(root, 'preflight')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vesper-smoke-preflight', main: 'main.js' }))
  fs.writeFileSync(path.join(dir, 'main.js'), "const { app } = require('electron'); app.whenReady().then(() => { process.stdout.write('APPDATA=' + app.getPath('appData') + String.fromCharCode(10)); app.quit() })")
  try {
    const electronExe = createRequire(import.meta.url)('electron')
    const out = execFileSync(electronExe, [dir], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    return /APPDATA=(.+)/.exec(out)?.[1]?.trim() ?? null
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function findReadyUrl(dir) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.log$/.test(e.name)) {
        const m = /ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(fs.readFileSync(p, 'utf8'))
        if (m) return m[1]
      }
    }
  }
  return null
}

async function main() {
  console.log(`Vesper packaged smoke — ${exe}`)
  const before = packageProcesses()
  if (before && before.length) {
    console.error(`Processes from this package are already running (${before.join(', ')}); close them first.`)
    return 2
  }
  // A temp Windows profile: Electron resolves appData from USERPROFILE (APPDATA alone is ignored), Vesper's local
  // folder from LOCALAPPDATA.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-smoke-'))
  const roaming = path.join(root, 'AppData', 'Roaming')
  const local = path.join(root, 'AppData', 'Local')
  fs.mkdirSync(roaming, { recursive: true })
  fs.mkdirSync(local, { recursive: true })
  const decoy = path.join(root, 'decoy')
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VESPER_') && k !== 'ELECTRON_RUN_AS_NODE')),
    USERPROFILE: root,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    // A release build must ignore every test switch (07 B10): if these took effect, the checks below would see it.
    VESPER_TEST: '1',
    VESPER_DATA_DIR: decoy,
    VESPER_LOCAL_DIR: decoy,
    VESPER_PORT: '0'
  }

  // Preflight: the same Electron runtime (node_modules/electron, same version as the package) must resolve appData into
  // the temp profile under this environment — otherwise the packaged app would open the owner's real profile.
  const resolved = preflightAppData(env, root)
  if (!resolved || !resolved.toLowerCase().startsWith(root.toLowerCase())) {
    console.error(`Refusing to launch: with this environment Electron's appData is ${resolved ?? 'unknown'}, not inside ${root}.`)
    fs.rmSync(root, { recursive: true, force: true })
    return 2
  }

  let app = null
  let exitCode = null
  try {
    app = await electron.launch({ executablePath: exe, args: ['--background'], env, timeout: 60_000 })
    const proc = app.process()
    const exited = new Promise((r) => proc.once('exit', (code) => r(code)))
    exited.then((c) => (exitCode = c))

    // 1. Started, packaged, no window.
    const info = await app.evaluate(({ app: a, BrowserWindow }) => ({ packaged: a.isPackaged, version: a.getVersion(), userData: a.getPath('userData'), windows: BrowserWindow.getAllWindows().length }))
    check('the app starts packaged', info.packaged, `version ${info.version}`)
    check('its data stays in the temp profile', info.userData.toLowerCase().startsWith(roaming.toLowerCase()), info.userData)
    check('a background start opens no window (nothing takes focus)', info.windows === 0)

    // 2. The server.
    let url = null
    for (let i = 0; i < 120 && !url; i++) {
      url = findReadyUrl(local) ?? findReadyUrl(roaming)
      if (!url) await new Promise((r) => setTimeout(r, 500))
    }
    if (!check('the server reports ready on loopback', !!url, url ?? 'no "ready on" line in the log within 60 s')) throw new Error('no server')
    const get = (p) => fetch(`${url}${p}`, { redirect: 'manual', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(15_000) })
    const page = await get('/')
    const html = page.ok ? await page.text() : ''
    check('the web client page is served', page.ok && /<script[^>]+src=/.test(html), `HTTP ${page.status}`)
    const notices = await get('/THIRD_PARTY_NOTICES.txt')
    check('third-party notices are served', notices.ok, `HTTP ${notices.status}`)
    const state = await get('/api/auth/state')
    check('/api/auth/state answers', state.ok, `HTTP ${state.status}`)
    const ping = await get('/api/test/ping')
    check('/api/test/ping is 404 (no test routes in a release build)', ping.status === 404, `HTTP ${ping.status}`)
    const login = await fetch(`${url}/api/test/login-as`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-vesper': '1' }, body: '{"kind":"desktop"}', signal: AbortSignal.timeout(15_000) })
    check('/api/test/login-as is 404', login.status === 404, `HTTP ${login.status}`)
    check('VESPER_DATA_DIR was ignored', !fs.existsSync(decoy))

    // 3. The web client in the app's own session, in a window that is never shown.
    const client = await app.evaluate(
      async ({ app: a, BrowserWindow }, target) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { partition: 'persist:vesper', preload: `${a.getAppPath()}/out/preload/index.js`, sandbox: true, contextIsolation: true, nodeIntegration: false }
        })
        const errors = []
        win.webContents.on('console-message', (_e, level, message) => {
          if (level >= 3) errors.push(String(message).slice(0, 200))
        })
        try {
          await win.loadURL(target)
          let rendered = false
          for (let i = 0; i < 40 && !rendered; i++) {
            rendered = await win.webContents.executeJavaScript('!!document.getElementById("root") && document.getElementById("root").childElementCount > 0')
            if (!rendered) await new Promise((r) => setTimeout(r, 250))
          }
          const probe = await win.webContents.executeJavaScript('({ testHooks: typeof window.__vesperTest, desktop: typeof window.vesperDesktop, title: document.title })')
          return { rendered, ...probe, errors }
        } finally {
          win.destroy()
        }
      },
      url
    )
    check('the web client renders in the app session', client.rendered, `title "${client.title}"`)
    check('window.__vesperTest is undefined', client.testHooks === 'undefined', `typeof = ${client.testHooks}`)
    check('the preload bridge loads from the asar', client.desktop === 'object', `typeof vesperDesktop = ${client.desktop}`)
    check('no console errors while loading', client.errors.length === 0, client.errors.slice(0, 3).join(' | '))

    // 5. Clean exit.
    await app.evaluate(({ app: a }) => a.quit()).catch(() => undefined)
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20_000))])
    check('it exits on quit with code 0', code === 0, `exit ${code}`)
    app = null
    let left = packageProcesses()
    for (let i = 0; i < 10 && left && left.length; i++) {
      await new Promise((r) => setTimeout(r, 500))
      left = packageProcesses()
    }
    check('no process is left behind', !!left && left.length === 0, left === null ? 'could not list processes' : left.join(', '))
  } catch (e) {
    check('smoke run', false, e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : String(e))
  } finally {
    if (app) {
      await app.close().catch(() => undefined)
      if (exitCode === null) {
        try {
          app.process().kill()
        } catch {
          /* gone */
        }
      }
    }
    if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    else console.log(`(kept ${root})`)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} check(s) failed.` : `\nAll ${results.length} checks passed.`)
  return failed.length ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
