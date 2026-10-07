/**
 * Listener B — LAN HTTPS (07 B2/B10/B15/B16/D8/E8, research 06 §3.2/§4). Bound to 127.0.0.1 on a random port (test
 * mode only allows loopback for B, so no firewall prompt can ever appear). Real TLS requests check the certificate,
 * Host/Origin per listener, the cookie over HTTPS, WSS, pairing → pending → approve, revoke closing sockets. @R1
 */
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCertManager, TLS_KEY_SECRET, wantedSans } from '@server/net/tls'
import { coreOf } from '../server/helpers'
import { FakeRunner } from './fakeRunner'
import { cookieOf, httpsRequest, injectOn, PASSWORD, Socket, startAccessServer, type AccessServer } from './helpers'

let t: AccessServer
let runner: FakeRunner
let lanUrl: string

const lanListener = () => coreOf(t.server.ctx).listeners.get('lan')!
const same = (extra: Record<string, string> = {}) => ({ origin: lanUrl, 'x-vesper': '1', 'sec-fetch-site': 'same-origin', ...extra })

beforeAll(async () => {
  runner = new FakeRunner()
  t = await startAccessServer({ runner, ports: { lan: 0, tailnet: 0 }, hostname: () => 'Vesper-PC' })
})
afterAll(() => t.close())

describe('enabling LAN mode', () => {
  it('needs a password first (07 B15)', async () => {
    const r = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.fields.mode).toMatch(/password/)
    // Even when settings say LAN (e.g. PATCH /api/settings), nothing listens without a password.
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { access: { mode: 'lan' } } })
    await t.access().net.reconcile()
    expect(coreOf(t.server.ctx).listeners.get('lan')).toBeUndefined()
    expect((await t.inject({ url: '/api/network', cookie: t.desktop })).json().warnings.map((w: { code: string }) => w.code)).toContain('password_required')
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { access: { mode: 'local' } } })
  })

  it('only the desktop may change access; test builds refuse non-loopback addresses', async () => {
    await t.setPassword()
    const browser = await t.login('browser')
    expect((await t.inject({ method: 'PUT', url: '/api/network', cookie: browser, payload: { mode: 'lan' } })).json().error.code).toBe('desktop_only')
    const far = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan', lanAddress: '192.168.1.50' } })
    expect(far.statusCode).toBe(400)
    expect(far.json().error.fields.lanAddress).toMatch(/loopback/)
    const clash = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { lanPort: 41730 } })
    expect(clash.json().error.fields.lanPort).toMatch(/own port/)
  })

  it('starts Listener B with a stable EC P-256 / SHA-256 certificate and reports URLs, QR and fingerprint', async () => {
    const r = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
    expect(r.statusCode).toBe(200)
    const s = r.json()
    const port = lanListener().port
    lanUrl = `https://127.0.0.1:${port}`
    expect(s).toMatchObject({
      mode: 'lan',
      lan: { running: true, address: '127.0.0.1', port, url: lanUrl, urls: [lanUrl, `https://vesper-pc.local:${port}`], firewall: 'not-needed' },
      capabilities: { mic: true, install: false, warningFree: false }
    })
    expect(s.lan.qrSvg).toMatch(/^<svg/)
    expect(s.lan.certFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    // Loopback needs no firewall rule: nothing was probed or elevated.
    expect(runner.lines().filter((l) => l.startsWith('powershell'))).toEqual([])

    const res = await httpsRequest(lanUrl, { path: '/api/auth/state', headers: { host: `127.0.0.1:${port}` } })
    expect(res.status).toBe(200)
    expect(res.headers['strict-transport-security']).toBeUndefined()
    const x = new X509Certificate(res.cert!.raw)
    expect(x.fingerprint256).toBe(s.lan.certFingerprint)
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(x.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(x.subjectAltName).toContain('DNS:vesper-pc.local')
    expect(x.subjectAltName).toContain('DNS:localhost')
    expect(x.ca).toBe(false)
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
    const days = (Date.parse(x.validTo) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(390)
    expect(days).toBeLessThanOrEqual(398)
  })

  it('stores the key only in the secret store (internal name, hidden from clients) and keeps the cert across restarts', async () => {
    const roaming = t.server.ctx.paths.roaming
    const pem = fs.readFileSync(path.join(roaming, 'tls', 'lan-cert.pem'), 'utf8')
    expect(pem).toContain('BEGIN CERTIFICATE')
    expect(pem).not.toContain('PRIVATE KEY')
    expect(fs.readdirSync(path.join(roaming, 'tls'))).toEqual(['lan-cert.pem'])
    expect(await t.server.ctx.platform.secrets.list()).toContain(TLS_KEY_SECRET)
    const boot = (await t.inject({ url: '/api/bootstrap', cookie: t.desktop })).json()
    expect(boot.secretsSet).not.toContain(TLS_KEY_SECRET)
    expect(boot.secretsInvalid).toEqual([])
    expect(JSON.stringify(boot)).not.toContain('PRIVATE KEY')

    // A fresh manager on the same data loads the same certificate; a new SAN forces a new one.
    const fp = lanListener() && (await t.inject({ url: '/api/network', cookie: t.desktop })).json().lan.certFingerprint
    const certs = createCertManager({ dir: roaming, secrets: t.server.ctx.platform.secrets, log: t.server.ctx.log })
    const same = await certs.ensure(wantedSans({ hostname: 'Vesper-PC', addresses: ['127.0.0.1'] }), Date.now())
    expect(same.fingerprint256).toBe(fp)
    const certs2 = createCertManager({ dir: roaming, secrets: t.server.ctx.platform.secrets, log: t.server.ctx.log })
    const moved = await certs2.ensure(wantedSans({ hostname: 'Vesper-PC', addresses: ['127.0.0.1', '10.0.0.9'] }), Date.now())
    expect(moved.fingerprint256).not.toBe(fp)
    expect(moved.sans).toContain('IP:10.0.0.9')
  })
})

describe('Listener B guards and sessions', () => {
  it('Host allow-list per listener (421), exact Origin + X-Vesper for writes (403), no CORS', async () => {
    const port = lanListener().port
    expect((await httpsRequest(lanUrl, { path: '/api/auth/state', headers: { host: 'evil.example' } })).status).toBe(421)
    // Listener A's names are not B's.
    expect((await httpsRequest(lanUrl, { path: '/api/auth/state', headers: { host: t.host } })).status).toBe(421)
    expect((await httpsRequest(lanUrl, { path: '/api/auth/state', headers: { host: `vesper-pc.local:${port}` } })).status).toBe(200)
    const noOrigin = await httpsRequest(lanUrl, { method: 'POST', path: '/api/auth/login', headers: { host: `127.0.0.1:${port}`, 'x-vesper': '1' }, body: { password: PASSWORD } })
    expect(noOrigin.status).toBe(403)
    const httpOrigin = await httpsRequest(lanUrl, { method: 'POST', path: '/api/auth/login', headers: { host: `127.0.0.1:${port}`, ...same({ origin: `http://127.0.0.1:${port}` }) }, body: { password: PASSWORD } })
    expect(httpOrigin.status).toBe(403)
    const aOrigin = await httpsRequest(lanUrl, { method: 'POST', path: '/api/auth/login', headers: { host: `127.0.0.1:${port}`, ...same({ origin: t.origin }) }, body: { password: PASSWORD } })
    expect(aOrigin.status).toBe(403)
    expect(aOrigin.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('password login over HTTPS: Secure cookie, device classified "lan", WSS works; the desktop cookie is not a desktop here', async () => {
    const port = lanListener().port
    const login = await httpsRequest(lanUrl, { method: 'POST', path: '/api/auth/login', headers: { host: `127.0.0.1:${port}`, ...same() }, body: { password: PASSWORD, deviceName: 'Laptop' } })
    expect(login.status).toBe(200)
    const cookie = cookieOf({ headers: login.headers })!
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/)
    const boot = await httpsRequest(lanUrl, { path: '/api/bootstrap', headers: { host: `127.0.0.1:${port}`, cookie } })
    expect(boot.json).toMatchObject({ desktop: false, device: { kind: 'browser', listener: 'lan', name: 'Laptop' } })

    const ws = new Socket(`wss://127.0.0.1:${port}/ws`, { origin: lanUrl, cookie })
    await ws.hello()
    ws.close()
    const badWs = new Socket(`wss://127.0.0.1:${port}/ws`, { origin: t.origin, cookie })
    await expect(badWs.opened).rejects.toThrow()
    expect(badWs.rejected).toBe(403)

    const desk = await httpsRequest(lanUrl, { path: '/api/bootstrap', headers: { host: `127.0.0.1:${port}`, cookie: t.desktop } })
    expect(desk.status).toBe(401)
    expect((await injectOn(lanListener(), { method: 'PUT', url: '/api/network', cookie, payload: {} })).json().error.code).toBe('desktop_only')
  })

  it('pairing for LAN: redeem on B → pending (public routes only, WS refused) → desktop notified → approve → in', async () => {
    const desk = new Socket(`ws://${t.host}/ws`, { origin: t.origin, cookie: t.desktop })
    await desk.hello()
    try {
      const pair = (await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: {} })).json()
      expect(pair.target).toBe('lan')
      expect(pair.url).toBe(`${lanUrl}/pair#c=${pair.code}`)
      // A LAN code is not valid on the loopback listener.
      const wrongListener = await t.inject({ method: 'POST', url: '/api/auth/pair/redeem', payload: { code: pair.code, deviceName: 'x' } })
      expect(wrongListener.statusCode).toBe(401)

      const pair2 = (await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: { target: 'lan' } })).json()
      const port = lanListener().port
      const redeem = await httpsRequest(lanUrl, { method: 'POST', path: '/api/auth/pair/redeem', headers: { host: `127.0.0.1:${port}`, ...same() }, body: { code: pair2.code, deviceName: 'Pixel' } })
      expect(redeem.json).toMatchObject({ pending: true })
      const cookie = cookieOf({ headers: redeem.headers })!
      const pending = await desk.wait((m) => m.t === 'device.pending')
      expect(pending).toMatchObject({ name: 'Pixel', ip: '127.0.0.1' })
      expect(t.notes.at(-1)?.title).toBe('Allow a new device?')
      expect((await httpsRequest(lanUrl, { path: '/api/auth/state', headers: { host: `127.0.0.1:${port}`, cookie } })).json).toMatchObject({ pendingApproval: true, signedIn: false })
      expect((await httpsRequest(lanUrl, { path: '/api/bootstrap', headers: { host: `127.0.0.1:${port}`, cookie } })).status).toBe(403)
      const early = new Socket(`wss://127.0.0.1:${port}/ws`, { origin: lanUrl, cookie })
      expect((await early.closed).code).toBe(4401)

      const id = (pending as { deviceId: string }).deviceId
      expect((await t.inject({ method: 'POST', url: `/api/auth/devices/${id}/approve`, cookie: t.desktop, payload: { allow: true } })).statusCode).toBe(204)
      expect((await httpsRequest(lanUrl, { path: '/api/bootstrap', headers: { host: `127.0.0.1:${port}`, cookie } })).json).toMatchObject({ device: { kind: 'paired', listener: 'lan' } })

      // Revoking closes its live socket.
      const live = new Socket(`wss://127.0.0.1:${port}/ws`, { origin: lanUrl, cookie })
      await live.hello()
      expect((await t.inject({ method: 'DELETE', url: `/api/auth/devices/${id}`, cookie: t.desktop })).statusCode).toBe(204)
      expect((await live.closed).code).toBe(4401)
    } finally {
      desk.close()
    }
  })
})

describe('lifecycle', () => {
  it('pause stops B and closes its sockets; resume brings it back on the same port and certificate', async () => {
    const port = lanListener().port
    const fp = (await t.inject({ url: '/api/network', cookie: t.desktop })).json().lan.certFingerprint
    t.advance(61_000)
    const { cookie } = await t.loginPw({ ip: '10.7.0.1' })
    const ws = new Socket(`wss://127.0.0.1:${port}/ws`, { origin: lanUrl, cookie: cookie! })
    await ws.hello()
    const paused = (await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { paused: true } })).json()
    expect(paused.remote).toEqual({ paused: true, loginSuspended: false })
    expect(paused.lan.running).toBe(false)
    expect(paused.warnings.map((w: { code: string }) => w.code)).toContain('remote_paused')
    expect((await ws.closed).code).toBe(1001)
    await expect(httpsRequest(lanUrl, { path: '/api/auth/state' })).rejects.toThrow()
    const resumed = (await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { paused: false } })).json()
    expect(resumed.lan).toMatchObject({ running: true, certFingerprint: fp })
  })

  it('portable builds refuse LAN mode (07 E8)', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\x\\Vesper.exe'
    try {
      await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'local' } })
      const r = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
      expect(r.json().error.fields.mode).toMatch(/portable/)
      await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { access: { mode: 'lan' } } })
      await t.access().net.reconcile()
      expect(coreOf(t.server.ctx).listeners.get('lan')).toBeUndefined()
      const s = (await t.inject({ url: '/api/network', cookie: t.desktop })).json()
      expect(s.portable).toBe(true)
      expect(s.warnings.map((w: { code: string }) => w.code)).toContain('portable')
    } finally {
      delete process.env.PORTABLE_EXECUTABLE_FILE
    }
  })

  it('leak: 6 LAN on/off cycles leave only Listener A; every stopped server is closed', async () => {
    const core = coreOf(t.server.ctx)
    const seen = new Set<import('node:https').Server | import('node:http').Server>()
    for (let i = 0; i < 6; i++) {
      await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
      seen.add(core.listeners.get('lan')!.server)
      await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'local' } })
    }
    expect(core.listeners.all().map((l) => l.name)).toEqual(['loopback'])
    expect(seen.size).toBe(6)
    for (const s of seen) expect(s.listening).toBe(false)
    expect((await t.inject({ url: '/api/test/stats' })).json().clients).toBe(0)
  })
})

describe('remote sign-in suspension (07 B14/B15)', () => {
  it('after the hourly failure limit, password sign-in on B is refused while A still works; the desktop resumes it', async () => {
    const s = await startAccessServer({ runner: new FakeRunner(), ports: { lan: 0 }, limiter: { suspendAfter: 3, ladderStart: 100, perIpMax: 100 } })
    try {
      await s.setPassword()
      await s.inject({ method: 'PUT', url: '/api/network', cookie: s.desktop, payload: { mode: 'lan' } })
      const l = coreOf(s.server.ctx).listeners.get('lan')!
      const host = `127.0.0.1:${l.port}`
      const login = (password: string) => injectOn(l, { method: 'POST', url: '/api/auth/login', host, payload: { password, deviceName: 'x' } })
      for (let i = 0; i < 3; i++) expect((await login('wrong wrong wrong!')).statusCode).toBe(401)
      const refused = await login(PASSWORD)
      expect(refused.statusCode).toBe(403)
      expect(refused.json().error.message).toMatch(/paused/)
      expect(s.notes.some((n) => n.title === 'Vesper paused remote sign-in')).toBe(true)
      expect((await s.inject({ url: '/api/network', cookie: s.desktop })).json().remote.loginSuspended).toBe(true)
      expect((await s.loginPw()).res.statusCode).toBe(200)
      await s.inject({ method: 'PUT', url: '/api/network', cookie: s.desktop, payload: { resumeRemoteLogin: true } })
      expect((await login(PASSWORD)).statusCode).toBe(200)
    } finally {
      await s.close()
    }
  })
})

describe('address changes', () => {
  it('rebinds when the default route moves and stops (with a warning) when the address disappears', async () => {
    // Only loopback addresses are used, so nothing ever listens on a real network interface.
    let ifaces = [{ address: '127.0.0.1', name: 'Ethernet' }]
    let route: string | null = '127.0.0.1'
    const s = await startAccessServer({ runner: new FakeRunner(), ports: { lan: 0 }, loopbackOnly: false, interfaces: () => ifaces, defaultRoute: async () => route, lanWatchMs: 20 })
    try {
      await s.setPassword()
      const first = (await s.inject({ method: 'PUT', url: '/api/network', cookie: s.desktop, payload: { mode: 'lan' } })).json()
      expect(first.lan).toMatchObject({ address: '127.0.0.1', running: true })
      expect(first.interfaces).toEqual([{ address: '127.0.0.1', name: 'Ethernet', recommended: true }])
      const lan = () => coreOf(s.server.ctx).listeners.get('lan')
      ifaces = [{ address: '127.0.0.3', name: 'Wi-Fi' }]
      route = '127.0.0.3'
      await expect.poll(() => lan()?.url.includes('127.0.0.3') ?? false, { timeout: 5000 }).toBe(true)
      const moved = (await s.inject({ url: '/api/network', cookie: s.desktop })).json()
      expect(moved.lan.certFingerprint).not.toBe(first.lan.certFingerprint)
      ifaces = []
      route = null
      await expect.poll(() => lan() === undefined, { timeout: 5000 }).toBe(true)
      const gone = (await s.inject({ url: '/api/network', cookie: s.desktop })).json()
      expect(gone.warnings.map((w: { code: string }) => w.code)).toContain('lan_address_missing')
    } finally {
      await s.close()
    }
  })
})
