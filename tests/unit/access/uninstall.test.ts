/**
 * Uninstall cleanup (07 B14, F74): the NSIS hook, the shipped PowerShell script and the mapping marker the app writes.
 * Nothing here touches the real Tailscale or the firewall: the script runs against a stub `tailscale.cmd` that only
 * logs its arguments, and with a temporary install dir (no firewall rule can match it, so nothing is elevated).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { firewallRemoveLine, MAPPING_MARKER, UNINSTALL_SCRIPT, uninstallCleanupScript } from '@server/net/uninstall'
import { FakeRunner } from './fakeRunner'
import { startAccessServer } from './helpers'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRIPT_FILE = path.join(ROOT, 'build', UNINSTALL_SCRIPT)
const EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe'

describe('uninstall hook wiring', () => {
  it('build/uninstall-cleanup.ps1 is exactly the generated script (ASCII)', () => {
    const want = uninstallCleanupScript()
    if (!fs.existsSync(SCRIPT_FILE)) fs.writeFileSync(SCRIPT_FILE, want) // first run generates it; commit the file
    const have = fs.readFileSync(SCRIPT_FILE, 'utf8').replace(/\r\n/g, '\n')
    expect(have, 'build/uninstall-cleanup.ps1 is stale: delete it and re-run this test to regenerate').toBe(want)
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(want)).toBe(true)
  })

  it('electron-builder ships the script next to the app resources and includes the NSIS hook', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/\n\s*- from: build\/uninstall-cleanup\.ps1\s*\n\s*to: uninstall-cleanup\.ps1/)
    expect(yml).toMatch(/\nnsis:\s*\n(?:\s+.*\n)*?\s+include: build\/installer\.nsh/)
  })

  it('the NSIS hook runs the script on uninstall only (not on updates), with -Silent when silent', () => {
    const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8')
    const macro = /!macro customUnInstall\s*\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? ''
    expect(macro).toMatch(/\$\{ifNot\} \$\{isUpdated\}/i)
    const calls = macro.split('\n').filter((l) => l.includes('nsExec::ExecToLog'))
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c).toContain(`-ExecutionPolicy Bypass -File "$INSTDIR\\resources\\${UNINSTALL_SCRIPT}" -InstallDir "$INSTDIR"`)
      expect(c).toContain('-NoProfile -NonInteractive')
    }
    expect(calls.filter((c) => c.includes('-Silent'))).toHaveLength(1)
    expect(macro).toMatch(/\$\{if\} \$\{Silent\}/i)
    // Missing script (an older install's files) → skipped, not an error.
    expect(macro).toContain(`\${FileExists} "$INSTDIR\\resources\\${UNINSTALL_SCRIPT}"`)
  })

  it('removes only the "Vesper (LAN)" rule of one exact program, and refuses unsafe paths', () => {
    expect(firewallRemoveLine('C:\\Users\\o\\AppData\\Local\\Programs\\Vesper\\Vesper.exe')).toBe(
      'netsh advfirewall firewall delete rule name="Vesper (LAN)" program="C:\\Users\\o\\AppData\\Local\\Programs\\Vesper\\Vesper.exe" dir=in'
    )
    expect(() => firewallRemoveLine('C:\\x" & del')).toThrow()
    expect(() => firewallRemoveLine('C:\\%TEMP%\\Vesper.exe')).toThrow()
    const s = uninstallCleanupScript()
    expect(s).toContain(`$line = 'netsh advfirewall firewall delete rule name="Vesper (LAN)" program="' + $exe + '" dir=in'`)
    expect(s).toContain("Where-Object { $_.DisplayName -eq 'Vesper (LAN)'")
    expect(s).toContain("@('funnel', '--https=443', 'off')")
    expect(s).toContain("@('serve', '--https=443', 'off')")
  })
})

describe('the app records its mapping for the uninstaller', () => {
  it('marker follows the mapping: written when serving, removed with it (mode change and quit)', async () => {
    const runner = new FakeRunner()
    const a = await startAccessServer({ runner, ports: { tailnet: 0 }, tailscaleExe: () => EXE, tailWatchMs: { first: 3_600_000, max: 3_600_000, recheck: 3_600_000 } })
    const marker = path.join(a.server.ctx.paths.roaming, MAPPING_MARKER)
    const putMode = (payload: object) => a.inject({ method: 'PUT', url: '/api/network', cookie: a.desktop, payload })
    try {
      await a.setPassword()
      expect(fs.existsSync(marker)).toBe(false)
      await putMode({ mode: 'tailscale' })
      const port = runner.ts.mapping!.port
      expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ port, funnel: false })
      await putMode({ funnel: true })
      expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ port, funnel: true })
      await putMode({ mode: 'local', funnel: false })
      expect(runner.ts.mapping).toBeNull()
      expect(fs.existsSync(marker)).toBe(false)
      await putMode({ mode: 'tailscale' })
      expect(fs.existsSync(marker)).toBe(true)
    } finally {
      await a.close()
    }
    // Quit without "keep remote access while closed" removes the mapping and the marker.
    expect(runner.ts.mapping).toBeNull()
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('the cleanup script, run for real against a stub tailscale', () => {
  let dir: string
  let script: string
  let stub: string
  let dataDir: string
  let installDir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-uninstall-'))
    script = path.join(dir, UNINSTALL_SCRIPT)
    fs.writeFileSync(script, uninstallCleanupScript())
    stub = path.join(dir, 'tailscale.cmd')
    // Logs every call; `serve status --json` prints serve.json. Exit 0 always.
    fs.writeFileSync(stub, ['@echo off', 'echo %*>>"%~dp0calls.log"', 'if "%1 %2 %3"=="serve status --json" type "%~dp0serve.json"', 'exit /b 0', ''].join('\r\n'))
    dataDir = path.join(dir, 'data')
    installDir = path.join(dir, 'install')
    fs.mkdirSync(dataDir)
    fs.mkdirSync(installDir)
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  const serveJson = (port: number, funnel: boolean, host = 'vesper-pc.tail1234.ts.net') => {
    const key = `${host}:443`
    return JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [key]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } }, ...(funnel ? { AllowFunnel: { [key]: true } } : {}) })
  }
  function run(o: { marker: object | null; serve: string; silent?: boolean }): { calls: string[]; out: string; markerLeft: boolean } {
    const marker = path.join(dataDir, MAPPING_MARKER)
    if (o.marker) fs.writeFileSync(marker, JSON.stringify(o.marker))
    else fs.rmSync(marker, { force: true })
    fs.writeFileSync(path.join(dir, 'serve.json'), o.serve)
    fs.rmSync(path.join(dir, 'calls.log'), { force: true })
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', installDir, '-DataDir', dataDir, '-Tailscale', stub]
    if (o.silent) args.push('-Silent')
    const out = execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    const log = path.join(dir, 'calls.log')
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
    return { calls, out, markerLeft: fs.existsSync(marker) }
  }

  it("turns off Vesper's Funnel then Serve mapping and forgets the marker", { timeout: 90_000 }, () => {
    const r = run({ marker: { port: 41732, funnel: true }, serve: serveJson(41732, true) })
    expect(r.calls).toEqual(['serve status --json', 'funnel --https=443 off', 'serve --https=443 off'])
    expect(r.markerLeft).toBe(false)
    // A temporary install dir has no firewall rule: nothing is elevated.
    expect(r.out).not.toContain('elevated')
  })

  it('Serve only: no funnel command', { timeout: 90_000 }, () => {
    const r = run({ marker: { port: 41732, funnel: false }, serve: serveJson(41732, false) })
    expect(r.calls).toEqual(['serve status --json', 'serve --https=443 off'])
  })

  it("never touches a mapping that is not Vesper's (another port, or nothing served)", { timeout: 90_000 }, () => {
    let r = run({ marker: { port: 41732, funnel: false }, serve: serveJson(8080, true) })
    expect(r.calls).toEqual(['serve status --json'])
    expect(r.markerLeft).toBe(true)
    r = run({ marker: { port: 41732, funnel: false }, serve: '{}' })
    expect(r.calls).toEqual(['serve status --json'])
  })

  it('no marker (Vesper never served, or already removed) or a damaged one: Tailscale is not even asked', { timeout: 90_000 }, () => {
    expect(run({ marker: null, serve: serveJson(41732, false) }).calls).toEqual([])
    expect(run({ marker: { port: 'x' }, serve: serveJson(41732, false), silent: true }).calls).toEqual([])
  })
})
