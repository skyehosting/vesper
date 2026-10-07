/**
 * Auth over HTTP + WS on Listener A (07 B2/B15/B16): password set/change, login, lockout, sudo expiry, devices,
 * local pairing, approval, audit log, leak check. @R1
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreOf, WsProbe, wsUrl } from '../server/helpers'
import { PASSWORD, startAccessServer, type AccessServer } from './helpers'

let t: AccessServer

beforeAll(async () => {
  t = await startAccessServer()
})
afterAll(() => t.close())

const desktopWs = async () => {
  const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: t.desktop })
  await p.hello()
  return p
}

describe('password (07 B15)', () => {
  it('only the desktop sets the first password; rules are enforced; set → auth state + audit', async () => {
    expect((await t.inject({ url: '/api/auth/state' })).json()).toMatchObject({ passwordSet: false, lockedUntilUtc: null })
    const browser = await t.login('browser')
    const r1 = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: browser, payload: { next: PASSWORD } })
    expect(r1.statusCode).toBe(403)
    expect(r1.json().error.code).toBe('desktop_only')
    const short = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: t.desktop, payload: { next: 'too short' } })
    expect(short.statusCode).toBe(400)
    expect(short.json().error.fields.next).toMatch(/at least 15/)
    const common = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: t.desktop, payload: { next: 'correct horse battery staple' } })
    expect(common.json().error.fields.next).toMatch(/commonly used/)
    // No password yet: login says so.
    const none = await t.loginPw({ ip: '10.50.0.1' })
    expect(none.res.statusCode).toBe(401)
    expect(none.res.json().error.message).toMatch(/No password is set/)

    await t.setPassword()
    expect((await t.inject({ url: '/api/auth/state' })).json()).toMatchObject({ passwordSet: true })
    const log = (await t.inject({ url: '/api/auth/log', cookie: t.desktop })).json() as { event: string }[]
    expect(log.map((e) => e.event)).toContain('password.set')
  })
})

describe('login', () => {
  it('wrong → 401; right → cookie (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age), device listed, desktop notified', async () => {
    const ws = await desktopWs()
    try {
      const bad = await t.loginPw({ password: 'nope nope nope nope', ip: '10.0.0.20' })
      expect(bad.res.statusCode).toBe(401)
      expect(bad.res.json().error).toMatchObject({ code: 'unauthorized' })
      expect(bad.cookie).toBeNull()

      const ok = await t.loginPw({ ip: '10.0.0.20', name: '  Pixel\u0000 8\n Pro  ' })
      expect(ok.res.statusCode).toBe(200)
      const setCookie = String(ok.res.headers['set-cookie'])
      expect(setCookie).toMatch(/^__Host-vesper_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/)
      const boot = (await t.inject({ url: '/api/bootstrap', cookie: ok.cookie! })).json()
      expect(boot).toMatchObject({ desktop: false, device: { kind: 'browser', listener: 'loopback', name: 'Pixel 8 Pro', sudo: true } })

      await ws.next('devices.changed')
      const note = await ws.next('notify')
      expect(note.title).toBe('New sign-in to Vesper')
      expect(note.body).toContain('"Pixel 8 Pro"')
      expect(note.deviceId).toBe(ok.res.json().deviceId)
      expect(t.notes.at(-1)?.title).toBe('New sign-in to Vesper')
      const devices = (await t.inject({ url: '/api/auth/devices', cookie: t.desktop })).json() as { id: string; name: string; lastIp: string }[]
      expect(devices.find((d) => d.id === ok.res.json().deviceId)).toMatchObject({ name: 'Pixel 8 Pro' })

      // Signing in again from the same browser replaces its device.
      const again = await t.inject({ method: 'POST', url: '/api/auth/login', cookie: ok.cookie!, payload: { password: PASSWORD, deviceName: 'Pixel' }, remoteAddress: '10.0.0.20' } as never)
      expect(again.statusCode).toBe(200)
      expect((await t.inject({ url: '/api/bootstrap', cookie: ok.cookie! })).statusCode).toBe(401)
    } finally {
      ws.close()
    }
  })

  it('per IP: the 6th attempt within a minute is 429 with retryAfter, even with the right password; other IPs pass', async () => {
    for (let i = 0; i < 5; i++) expect((await t.loginPw({ password: `wrong password ${i}xx`, ip: '10.0.0.30' })).res.statusCode).toBe(401)
    const locked = await t.loginPw({ ip: '10.0.0.30' })
    expect(locked.res.statusCode).toBe(429)
    expect(locked.res.json().error).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(locked.res.json().error.retryAfter).toBeGreaterThan(55)
    expect((await t.loginPw({ ip: '10.0.0.31' })).res.statusCode).toBe(200)
    t.advance(61_000)
    expect((await t.loginPw({ ip: '10.0.0.30' })).res.statusCode).toBe(200)
  })

  it('global ladder: 10 consecutive failures from many IPs lock everyone for 1 s, then 2 s …', async () => {
    for (let i = 0; i < 10; i++) await t.loginPw({ password: 'not the password!!', ip: `10.1.0.${i}` })
    const state = (await t.inject({ url: '/api/auth/state' })).json()
    expect(state.lockedUntilUtc).toBeGreaterThan(t.server.ctx.clock.now())
    const r = await t.loginPw({ ip: '10.1.1.1' })
    expect(r.res.statusCode).toBe(429)
    expect(r.res.json().error.retryAfter).toBe(1)
    t.advance(1100)
    const wrong = await t.loginPw({ password: 'not the password!!', ip: '10.1.1.2' })
    expect(wrong.res.statusCode).toBe(401)
    expect(wrong.res.json().error.retryAfter).toBe(2)
    t.advance(2100)
    expect((await t.loginPw({ ip: '10.1.1.3' })).res.statusCode).toBe(200)
    expect((await t.inject({ url: '/api/auth/state' })).json().lockedUntilUtc).toBeNull()
  })
})

describe('sudo (07 B2)', () => {
  it('password login grants 10 min; afterwards sudo routes need POST /api/auth/sudo', async () => {
    t.advance(61_000)
    const { cookie } = await t.loginPw({ ip: '10.2.0.1' })
    expect((await t.inject({ url: '/api/auth/log', cookie: cookie! })).statusCode).toBe(200)
    t.advance(10 * 60_000 + 1000)
    const denied = await t.inject({ url: '/api/auth/log', cookie: cookie! })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('sudo_required')
    const wrong = await t.inject({ method: 'POST', url: '/api/auth/sudo', cookie: cookie!, payload: { password: 'not it at all ok?' }, remoteAddress: '10.2.0.1' } as never)
    expect(wrong.statusCode).toBe(401)
    const ok = await t.inject({ method: 'POST', url: '/api/auth/sudo', cookie: cookie!, payload: { password: PASSWORD }, remoteAddress: '10.2.0.1' } as never)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().untilUtc).toBeGreaterThan(t.server.ctx.clock.now() + 9 * 60_000)
    expect((await t.inject({ url: '/api/auth/log', cookie: cookie! })).statusCode).toBe(200)
    // The desktop counts as sudo without a password.
    expect((await t.inject({ method: 'POST', url: '/api/auth/sudo', cookie: t.desktop, payload: { password: '' } })).statusCode).toBe(200)
  })
})

describe('devices', () => {
  it('revoking a device needs sudo, closes its sockets (4401) and drops it from the list; the desktop can’t be revoked', async () => {
    t.advance(61_000)
    const victim = (await t.loginPw({ ip: '10.3.0.1', name: 'Victim' })).cookie!
    const victimId = (await t.inject({ url: '/api/bootstrap', cookie: victim })).json().device.id as string
    const ws = new WsProbe(wsUrl(t), { origin: t.origin, cookie: victim })
    await ws.hello()
    const plain = await t.login('browser')
    const noSudo = await t.inject({ method: 'DELETE', url: `/api/auth/devices/${victimId}`, cookie: plain })
    expect(noSudo.json().error.code).toBe('sudo_required')
    expect((await t.inject({ method: 'DELETE', url: `/api/auth/devices/${victimId}`, cookie: t.desktop })).statusCode).toBe(204)
    expect((await ws.closedP).code).toBe(4401)
    expect((await t.inject({ url: '/api/bootstrap', cookie: victim })).statusCode).toBe(401)
    const list = (await t.inject({ url: '/api/auth/devices', cookie: t.desktop })).json() as { id: string; kind: string; current: boolean }[]
    expect(list.some((d) => d.id === victimId)).toBe(false)
    const desk = list.find((d) => d.current)!
    expect(desk.kind).toBe('desktop')
    expect((await t.inject({ method: 'DELETE', url: `/api/auth/devices/${desk.id}`, cookie: t.desktop })).statusCode).toBe(403)
    expect((await t.inject({ method: 'DELETE', url: '/api/auth/devices/dev_nope', cookie: t.desktop })).statusCode).toBe(404)
  })

  it('changing the password needs `current` off the desktop, revokes the other sessions (not the desktop) and closes them', async () => {
    t.advance(61_000)
    const changer = (await t.loginPw({ ip: '10.4.0.1', name: 'Changer' })).cookie!
    t.advance(61_000)
    const other = (await t.loginPw({ ip: '10.4.0.2', name: 'Other' })).cookie!
    const ws = new WsProbe(wsUrl(t), { origin: t.origin, cookie: other })
    await ws.hello()
    const desk = await desktopWs()
    try {
      const missing = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: changer, payload: { next: 'lantern meadow quartz 77' } })
      expect(missing.json().error.fields.current).toBeTruthy()
      const wrong = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: changer, payload: { current: 'nope nope nope nope', next: 'lantern meadow quartz 77' }, remoteAddress: '10.4.0.1' } as never)
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().error.fields.current).toMatch(/not the current/)
      const ok = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: changer, payload: { current: PASSWORD, next: 'lantern meadow quartz 77' }, remoteAddress: '10.4.0.1' } as never)
      expect(ok.statusCode).toBe(204)
      expect((await ws.closedP).code).toBe(4401)
      expect((await t.inject({ url: '/api/bootstrap', cookie: other })).statusCode).toBe(401)
      expect((await t.inject({ url: '/api/bootstrap', cookie: changer })).statusCode).toBe(200)
      expect((await t.inject({ url: '/api/bootstrap', cookie: t.desktop })).statusCode).toBe(200)
      expect(desk.closed).toBeNull()
      t.advance(61_000)
      expect((await t.loginPw({ ip: '10.4.0.3' })).res.statusCode).toBe(401)
      expect((await t.loginPw({ ip: '10.4.0.3', password: 'lantern meadow quartz 77' })).res.statusCode).toBe(200)
      // Back to the shared password for the rest of the file (the desktop needs no `current`).
      await t.setPassword()
    } finally {
      desk.close()
    }
  })
})

describe('pairing (07 B16)', () => {
  it('a local pairing link (Open in browser) needs no approval; codes are single-use', async () => {
    const r = await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: {} })
    expect(r.statusCode).toBe(200)
    const p = r.json()
    expect(p.target).toBe('local')
    expect(p.url).toBe(`http://vesper.localhost:${t.server.port}/pair#c=${p.code}`)
    expect(p.qrSvg).toMatch(/^<svg/)
    expect(p.expiresUtc - t.server.ctx.clock.now()).toBeGreaterThan(4 * 60_000)
    expect((await t.inject({ url: '/api/auth/state' })).json().pairingAvailable).toBe(true)

    const redeem = await t.inject({ method: 'POST', url: '/api/auth/pair/redeem', payload: { code: p.code, deviceName: 'Edge on this PC' } })
    expect(redeem.statusCode).toBe(200)
    expect(redeem.json().pending).toBe(false)
    const cookie = String(redeem.headers['set-cookie']).split(';')[0]
    expect((await t.inject({ url: '/api/bootstrap', cookie })).json().device).toMatchObject({ kind: 'paired', name: 'Edge on this PC' })
    const again = await t.inject({ method: 'POST', url: '/api/auth/pair/redeem', payload: { code: p.code, deviceName: 'x' } })
    expect(again.statusCode).toBe(401)
    // LAN/Tailscale links need their listener running.
    const lan = await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: { target: 'lan' } })
    expect(lan.statusCode).toBe(409)
    expect(lan.json().error.code).toBe('conflict')
  })

  it('an Open-in-browser device gets the local-browser lifetime (30 d absolute, cookie too) and replaces the browser’s earlier device (F07/F12, 07 B4)', async () => {
    const DAY = 86_400_000
    const localCode = async () => (await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: { target: 'local' } })).json().code as string
    const redeem = (code: string, cookie?: string) => t.inject({ method: 'POST', url: '/api/auth/pair/redeem', payload: { code, deviceName: 'Edge on this PC' }, cookie })
    const first = await redeem(await localCode())
    expect(String(first.headers['set-cookie'])).toMatch(new RegExp(`Max-Age=${(30 * DAY) / 1000}$`))
    const firstCookie = String(first.headers['set-cookie']).split(';')[0]

    // A second click on "Open in browser" from the same, already signed-in browser: the old device goes.
    const second = await redeem(await localCode(), firstCookie)
    expect(second.statusCode).toBe(200)
    const cookie = String(second.headers['set-cookie']).split(';')[0]
    expect((await t.inject({ url: '/api/bootstrap', cookie: firstCookie })).statusCode).toBe(401)
    const live = (await t.inject({ url: '/api/auth/devices', cookie: t.desktop })).json() as { id: string }[]
    expect(live.some((d) => d.id === first.json().deviceId)).toBe(false)

    const start = coreOf(t.server.ctx).clockOffsetMs
    try {
      // Used every 5 days (never idle for 7), it still ends after 30 days.
      for (let day = 5; day <= 25; day += 5) {
        t.advance(5 * DAY)
        expect((await t.inject({ url: '/api/bootstrap', cookie })).statusCode, `day ${day}`).toBe(200)
      }
      t.advance(6 * DAY)
      expect((await t.inject({ url: '/api/bootstrap', cookie })).statusCode).toBe(401)
    } finally {
      coreOf(t.server.ctx).clockOffsetMs = start
    }
  })

  it('pending devices: only public routes until approved; deny revokes; unattended ones expire after 10 min', async () => {
    const core = coreOf(t.server.ctx)
    const ws = await desktopWs()
    try {
      const a = core.auth.createDevice({ kind: 'paired', listener: 'loopback', name: 'Tablet', pending: true })
      const ca = `__Host-vesper_sid=${a.token}`
      expect((await t.inject({ url: '/api/auth/state', cookie: ca })).json()).toMatchObject({ signedIn: false, pendingApproval: true })
      expect((await t.inject({ url: '/api/bootstrap', cookie: ca })).statusCode).toBe(403)
      const pendingWs = new WsProbe(wsUrl(t), { origin: t.origin, cookie: ca })
      expect((await pendingWs.closedP).code).toBe(4401)
      const browser = await t.login('browser')
      expect((await t.inject({ method: 'POST', url: `/api/auth/devices/${a.deviceId}/approve`, cookie: browser, payload: { allow: true } })).json().error.code).toBe('desktop_only')
      expect((await t.inject({ method: 'POST', url: `/api/auth/devices/${a.deviceId}/approve`, cookie: t.desktop, payload: { allow: true } })).statusCode).toBe(204)
      await ws.next('devices.changed')
      expect((await t.inject({ url: '/api/bootstrap', cookie: ca })).statusCode).toBe(200)
      expect((await t.inject({ method: 'POST', url: `/api/auth/devices/${a.deviceId}/approve`, cookie: t.desktop, payload: { allow: true } })).statusCode).toBe(409)

      const b = core.auth.createDevice({ kind: 'paired', listener: 'loopback', name: 'Stranger', pending: true })
      expect((await t.inject({ method: 'POST', url: `/api/auth/devices/${b.deviceId}/approve`, cookie: t.desktop, payload: { allow: false } })).statusCode).toBe(204)
      expect((await t.inject({ url: '/api/auth/state', cookie: `__Host-vesper_sid=${b.token}` })).json()).toMatchObject({ signedIn: false, pendingApproval: false })

      const c = core.auth.createDevice({ kind: 'paired', listener: 'loopback', name: 'Forgotten', pending: true })
      t.advance(11 * 60_000)
      expect((await t.inject({ url: '/api/auth/state', cookie: `__Host-vesper_sid=${c.token}` })).json()).toMatchObject({ signedIn: false, pendingApproval: false })
      expect(core.repos.devices.byId(c.deviceId)?.revokedUtc).not.toBeNull()
    } finally {
      ws.close()
    }
  })
})

describe('audit log', () => {
  it('records the events and never a password, token or code', async () => {
    const pair = (await t.inject({ method: 'POST', url: '/api/auth/pair', cookie: t.desktop, payload: { target: 'local' } })).json()
    const log = (await t.inject({ url: '/api/auth/log?limit=500', cookie: t.desktop })).json() as { event: string; detail: string | null; ip: string | null }[]
    const events = new Set(log.map((e) => e.event))
    for (const e of ['password.set', 'password.change', 'login.ok', 'login.fail', 'sudo.ok', 'sudo.fail', 'device.revoke', 'pair.create', 'pair.redeem', 'device.approve', 'device.deny', 'device.expired']) expect(events, e).toContain(e)
    const text = JSON.stringify(log)
    for (const secret of [PASSWORD, 'lantern meadow quartz 77', pair.code, t.desktop.split('=')[1]]) expect(text.includes(secret), secret).toBe(false)
    expect(log.find((e) => e.event === 'login.fail')?.ip).toMatch(/^10\./)
  })
})

describe('leaks', () => {
  it('50 login/logout cycles leave no live devices, limiter buckets, codes or queued hashes behind', async () => {
    t.advance(120_000)
    const core = coreOf(t.server.ctx)
    const live = () => core.repos.devices.list().filter((d) => d.revokedUtc === null).length
    const before = live()
    for (let i = 0; i < 50; i++) {
      const { cookie } = await t.loginPw({ ip: `10.9.${i}.1` })
      expect((await t.inject({ method: 'POST', url: '/api/auth/logout', cookie: cookie! })).statusCode).toBe(204)
    }
    expect(live()).toBe(before)
    // Codes live 5 minutes (the audit test left one unredeemed).
    t.advance(6 * 60_000)
    const stats = t.access().auth.stats()
    expect(stats.scryptQueue).toBe(0)
    expect(stats.pairingCodes).toBe(0)
    // Buckets empty out on the next check after their window.
    await t.loginPw({ ip: '10.9.255.1' })
    expect(t.access().auth.stats().limiterBuckets).toBe(1)
  })
})
