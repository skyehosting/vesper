/**
 * Listener C + the Tailscale lifecycle (07 B3/B14) against a fake runner: the exact commands that WOULD run, Host
 * allow-list = the ts.net name only, no desktop session on C, Funnel auto-off, startup/quit teardown, pause. @R1
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findTailscale, parseServeStatus, parseStatus, transition, tsCommands } from '@server/net/tailscale'
import { coreOf } from '../server/helpers'
import { FakeRunner } from './fakeRunner'
import { injectOn, startAccessServer, type AccessServer } from './helpers'

const EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe'
const DNS = 'vesper-pc.tail1234.ts.net'

let t: AccessServer
let runner: FakeRunner

const tail = () => coreOf(t.server.ctx).listeners.get('tailnet')
const put = async (payload: object) => {
  const r = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload })
  if (r.statusCode !== 200) throw new Error(`PUT /api/network ${r.statusCode} ${r.body}`)
  return r.json()
}

beforeAll(async () => {
  runner = new FakeRunner()
  // The Tailscale watcher (F08) has its own test below; here it must never act between a test's steps.
  t = await startAccessServer({ runner, ports: { lan: 0, tailnet: 0 }, tailscaleExe: () => EXE, tailWatchMs: { first: 3_600_000, max: 3_600_000, recheck: 3_600_000 } })
})
afterAll(() => t.close())

describe('parsers and command builders', () => {
  it('finds the CLI in Program Files, else PATH', () => {
    expect(findTailscale({ ProgramFiles: 'C:\\Program Files' }, (p) => p === EXE)).toBe(EXE)
    expect(findTailscale({}, () => false)).toBe('tailscale')
  })

  it('reads status and serve status defensively', () => {
    expect(parseStatus({ code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'PC.tail1.ts.net.' }, CertDomains: ['pc.tail1.ts.net'] }), stderr: '' })).toEqual({
      running: true,
      signedIn: true,
      dnsName: 'pc.tail1.ts.net',
      httpsEnabled: true
    })
    expect(parseStatus({ code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }), stderr: '' })).toMatchObject({ running: true, signedIn: false, dnsName: null })
    expect(parseStatus({ code: 1, stdout: 'failed to connect to local Tailscale daemon', stderr: '' })).toMatchObject({ running: false })
    expect(parseStatus({ code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'evil.example.' } }), stderr: '' }).dnsName).toBeNull()
    const web = { Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:41732' } } } }, AllowFunnel: { 'pc.tail1.ts.net:443': true } }
    expect(parseServeStatus({ code: 0, stdout: JSON.stringify(web), stderr: '' }, 'pc.tail1.ts.net')).toEqual({ port: 41732, funnel: true })
    expect(parseServeStatus({ code: 0, stdout: '{}', stderr: '' }, 'pc.tail1.ts.net')).toEqual({ port: null, funnel: false })
    expect(parseServeStatus({ code: 0, stdout: 'not json', stderr: '' }, null)).toEqual({ port: null, funnel: false })
  })

  it('transition: no-op when in place; off-before-on; never touches a mapping that is not Vesper’s', () => {
    const line = (c: { args: string[] }) => c.args.join(' ')
    expect(transition('ts', { port: 41732, funnel: false }, [41732], { port: 41732, funnel: false })).toEqual([])
    expect(transition('ts', { port: null, funnel: false }, [41732], { port: 41732, funnel: false }).map(line)).toEqual(['serve --bg --https=443 http://127.0.0.1:41732'])
    expect(transition('ts', { port: 41732, funnel: false }, [41732], { port: 41732, funnel: true }).map(line)).toEqual(['serve --https=443 off', 'funnel --bg --https=443 http://127.0.0.1:41732'])
    expect(transition('ts', { port: 41732, funnel: true }, [41732], null).map(line)).toEqual(['funnel --https=443 off', 'serve --https=443 off'])
    expect(transition('ts', { port: 8080, funnel: false }, [41732], null)).toEqual([])
    expect(tsCommands.serveOn('ts', 5).kind).toBe('mutate')
    expect(tsCommands.status('ts').kind).toBe('probe')
  })
})

describe('Tailscale mode', () => {
  it('local mode never runs tailscale until asked; GET /api/network probes read-only', async () => {
    expect(runner.commands).toEqual([])
    const s = (await t.inject({ url: '/api/network', cookie: t.desktop })).json()
    expect(s.tailscale).toMatchObject({ installed: true, running: true, signedIn: true, dnsName: DNS, serving: false, version: '1.90.1' })
    expect(runner.commands.every((c) => c.kind === 'probe')).toBe(true)
  })

  it('needs a password; then serves Listener C through `tailscale serve` (exact commands)', async () => {
    const r = await t.inject({ method: 'POST', url: '/api/network/tailscale/serve', cookie: t.desktop, payload: { on: true } })
    expect(r.statusCode).toBe(400)
    await t.setPassword()
    runner.clear()
    const r2 = await t.inject({ method: 'POST', url: '/api/network/tailscale/serve', cookie: t.desktop, payload: { on: true } })
    expect(r2.statusCode).toBe(200)
    const port = tail()!.port
    expect(runner.lines('mutate')).toEqual([`tailscale serve --bg --https=443 http://127.0.0.1:${port}`])
    expect(runner.lines('elevate')).toEqual([])
    expect(r2.json()).toMatchObject({
      mode: 'tailscale',
      tailscale: { serving: true, funnel: false, url: `https://${DNS}`, listenerPort: port },
      capabilities: { mic: true, install: true, warningFree: true }
    })
    expect(tail()!.url).toBe(`http://127.0.0.1:${port}`)
    // Reconciling again changes nothing.
    runner.clear()
    await t.access().net.reconcile()
    expect(runner.lines('mutate')).toEqual([])
  })

  it('Listener C accepts only the ts.net Host; no desktop session on C; Listener A refuses ts.net (421)', async () => {
    const l = tail()!
    expect((await injectOn(l, { url: '/api/auth/state', host: DNS })).statusCode).toBe(200)
    expect((await injectOn(l, { url: '/api/auth/state', host: `${DNS}:443` })).statusCode).toBe(200)
    expect((await injectOn(l, { url: '/api/auth/state', host: `127.0.0.1:${l.port}` })).statusCode).toBe(421)
    expect((await injectOn(l, { url: '/api/bootstrap', host: DNS, cookie: t.desktop })).statusCode).toBe(401)
    expect((await t.inject({ url: '/api/auth/state', headers: { host: DNS } })).statusCode).toBe(421)
    // Password login over C: classified tailnet; Tailscale-User-Login only lands in the audit log.
    const login = await injectOn(l, { method: 'POST', url: '/api/auth/login', host: DNS, headers: { 'tailscale-user-login': 'owner@example.com' }, payload: { password: 'violin harbor 1987 tide', deviceName: 'Phone' } })
    expect(login.statusCode).toBe(200)
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    expect((await injectOn(l, { url: '/api/bootstrap', host: DNS, cookie })).json().device).toMatchObject({ listener: 'tailnet' })
    const log = (await t.inject({ url: '/api/auth/log', cookie: t.desktop })).json() as { event: string; detail: string }[]
    expect(log.find((e) => e.event === 'login.ok')?.detail).toContain('owner@example.com')
    // Origin must be the https ts.net origin.
    const wrongOrigin = await injectOn(l, { method: 'POST', url: '/api/auth/logout', host: DNS, origin: `http://${DNS}`, cookie })
    expect(wrongOrigin.statusCode).toBe(403)
  })

  it('pairing for the tailnet: https://<ts.net>/pair#c=…, redeemable on C only, pending', async () => {
    const p = (await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: {} })).json()
    expect(p).toMatchObject({ target: 'tailnet', url: `https://${DNS}/pair#c=${p.code}` })
    const r = await injectOn(tail()!, { method: 'POST', url: '/api/auth/pair/redeem', host: DNS, payload: { code: p.code, deviceName: 'iPhone' } })
    expect(r.json()).toMatchObject({ pending: true })
  })

  it('Funnel: off→on swaps the handler, warns "public", and turns itself off after funnelAutoOffHours', async () => {
    runner.clear()
    const port = tail()!.port
    const s = await put({ funnel: true, funnelAutoOffHours: 8 })
    expect(runner.lines('mutate')).toEqual(['tailscale serve --https=443 off', `tailscale funnel --bg --https=443 http://127.0.0.1:${port}`])
    expect(s.tailscale).toMatchObject({ serving: true, funnel: true })
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('funnel_public')
    const until = s.tailscale.funnelUntilUtc as number
    expect(until - t.server.ctx.clock.now()).toBeGreaterThan(8 * 3_600_000 - 5000)

    runner.clear()
    t.advance(8 * 3_600_000 + 1000)
    await t.access().net.reconcile()
    await t.access().net.reconcile()
    expect(t.server.ctx.settings.get().access.funnel).toBe(false)
    expect(runner.lines('mutate')).toEqual(['tailscale funnel --https=443 off', 'tailscale serve --https=443 off', `tailscale serve --bg --https=443 http://127.0.0.1:${port}`])
    expect(t.notes.some((n) => n.title === 'Vesper turned Funnel off')).toBe(true)
  })

  it('consent and failures become warnings; an existing non-Vesper mapping is never overwritten', async () => {
    await put({ mode: 'local' })
    runner.ts.failNext = { stdout: 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc\n' }
    const s = await put({ mode: 'tailscale', funnel: true })
    expect(s.tailscale.consentUrl).toBe('https://login.tailscale.com/f/funnel?node=abc')
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('tailscale_consent')
    await put({ funnel: false })
    expect((await t.inject({ url: '/api/network', cookie: t.desktop })).json().tailscale.serving).toBe(true)

    await put({ mode: 'local' })
    runner.ts.mapping = { port: 8080, funnel: false }
    runner.clear()
    const other = await put({ mode: 'tailscale' })
    expect(runner.lines('mutate')).toEqual([])
    expect(other.warnings.find((w: { code: string }) => w.code === 'tailscale_failed').message).toMatch(/already used/)
    runner.ts.mapping = null
    await put({ mode: 'local' })
  })

  it('missing / stopped / signed-out Tailscale: warnings, no commands, Listener C still local-only', async () => {
    runner.ts.installed = false
    runner.clear()
    let s = await put({ mode: 'tailscale' })
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('tailscale_missing')
    expect(runner.lines('mutate')).toEqual([])
    expect(tail()!.guard.hosts.size).toBe(0)
    runner.ts.installed = true
    runner.ts.backendState = 'NeedsLogin'
    s = await t.access().net.refresh(true).then(() => put({ keepRemoteWhileClosed: false }))
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('tailscale_signed_out')
    runner.ts.backendState = 'Running'
    await t.access().net.refresh(true)
    await put({ mode: 'local' })
  })

  it('mode → local stops C and removes Vesper’s mapping; a recorded mapping is cleaned up at the next reconcile (startup)', async () => {
    await put({ mode: 'tailscale' })
    const port = tail()!.port
    runner.clear()
    await put({ mode: 'local' })
    expect(tail()).toBeUndefined()
    expect(runner.lines('mutate')).toEqual(['tailscale serve --https=443 off'])
    expect(runner.ts.mapping).toBeNull()
    // Startup after a crash: settings say local, kv still remembers the mapping.
    t.server.ctx.repos.kv.set('access.tailscale.mapping', { port, funnel: true })
    runner.ts.mapping = { port, funnel: true }
    runner.clear()
    await t.access().net.reconcile()
    expect(runner.lines('mutate')).toEqual(['tailscale funnel --https=443 off', 'tailscale serve --https=443 off'])
    expect(t.server.ctx.repos.kv.get('access.tailscale.mapping')).toBeNull()
  })

  it('pause stops C but keeps the mapping; resume restarts C', async () => {
    await put({ mode: 'tailscale' })
    runner.clear()
    await put({ paused: true })
    expect(tail()).toBeUndefined()
    expect(runner.lines('mutate')).toEqual([])
    expect(runner.ts.mapping).not.toBeNull()
    await put({ paused: false })
    expect(tail()).toBeDefined()
    // Tests bind C on a random port, so the mapping follows it; with the fixed settings port nothing would run.
    expect(runner.lines('mutate')).toEqual(['tailscale serve --https=443 off', `tailscale serve --bg --https=443 http://127.0.0.1:${tail()!.port}`])
  })
})

describe('Tailscale not Running yet at reconcile (F08)', () => {
  const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 3000) => {
    const t0 = Date.now()
    while (!(await ok())) {
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('re-probes with backoff until Tailscale runs, then fills C’s Host allow-list and the mapping; follows a rename; stops outside Tailscale mode', async () => {
    const r = new FakeRunner()
    r.ts.backendState = 'NeedsLogin' // e.g. Vesper started at Windows sign-in before tailscaled connected
    const a = await startAccessServer({ runner: r, ports: { tailnet: 0 }, tailscaleExe: () => EXE, tailWatchMs: { first: 40, max: 160, recheck: 250 } })
    try {
      await a.setPassword()
      await a.inject({ method: 'PUT', url: '/api/network', cookie: a.desktop, payload: { mode: 'tailscale' } })
      const c = () => coreOf(a.server.ctx).listeners.get('tailnet')!
      expect(c().guard.hosts.size).toBe(0)
      expect((await injectOn(c(), { url: '/api/auth/state', host: DNS })).statusCode).toBe(421)
      expect(r.ts.mapping).toBeNull()

      // Nobody opens Settings: the watcher alone must notice that Tailscale is up now.
      r.ts.backendState = 'Running'
      await until('C accepts the ts.net name', async () => (await injectOn(c(), { url: '/api/auth/state', host: DNS })).statusCode === 200)
      await until('serve mapping', () => r.ts.mapping?.port === c().port)
      expect(a.access().net.status().tailscale).toMatchObject({ dnsName: DNS, serving: true })

      // The node is renamed in the admin console: the slow re-check picks up the new name.
      const renamed = 'vesper-desk.tail1234.ts.net'
      r.ts.dnsName = renamed
      await until('C follows the rename', () => c().guard.hosts.has(renamed), 3000)
      expect(c().guard.hosts.has(DNS)).toBe(false)

      // Leaving Tailscale mode stops the watcher: no more probes.
      await a.inject({ method: 'PUT', url: '/api/network', cookie: a.desktop, payload: { mode: 'local' } })
      r.clear()
      await new Promise((res) => setTimeout(res, 600))
      expect(r.lines()).toEqual([])
    } finally {
      await a.close()
    }
  })

  it('backs off: while Tailscale stays down the probes thin out (first → max)', async () => {
    const r = new FakeRunner()
    r.ts.backendState = 'Stopped'
    const a = await startAccessServer({ runner: r, ports: { tailnet: 0 }, tailscaleExe: () => EXE, tailWatchMs: { first: 30, max: 120, recheck: 10_000 } })
    try {
      await a.setPassword()
      await a.inject({ method: 'PUT', url: '/api/network', cookie: a.desktop, payload: { mode: 'tailscale' } })
      r.clear()
      await new Promise((res) => setTimeout(res, 900))
      const probes = r.lines('probe').filter((l) => l.endsWith('status --json') && !l.includes('serve')).length
      // 30 + 60 + 120 + 120 … ms: about 8 probes in 900 ms (a fixed 30 ms poll would be ~30).
      expect(probes).toBeGreaterThanOrEqual(3)
      expect(probes).toBeLessThanOrEqual(12)
    } finally {
      await a.close()
    }
  })
})

describe('quit (07 B14)', () => {

  it('removes the mapping on close unless "keep remote access while closed"; the runner is closed', async () => {
    const r1 = new FakeRunner()
    const a = await startAccessServer({ runner: r1, ports: { tailnet: 0 }, tailscaleExe: () => EXE })
    await a.setPassword()
    await a.inject({ method: 'PUT', url: '/api/network', cookie: a.desktop, payload: { mode: 'tailscale' } })
    r1.clear()
    await a.close()
    expect(r1.lines('mutate')).toEqual(['tailscale serve --https=443 off'])
    expect(r1.closed).toBe(1)

    const r2 = new FakeRunner()
    const b = await startAccessServer({ runner: r2, ports: { tailnet: 0 }, tailscaleExe: () => EXE })
    await b.setPassword()
    await b.inject({ method: 'PUT', url: '/api/network', cookie: b.desktop, payload: { mode: 'tailscale', keepRemoteWhileClosed: true } })
    r2.clear()
    await b.close()
    expect(r2.lines('mutate')).toEqual([])
  })
})
