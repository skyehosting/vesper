import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { ENDPOINT_AUTH, ENDPOINT_KEYS } from '@server/http/endpoints'
import { installGuards } from '@server/http/guards'
import type { AuthCore } from '@server/auth/core'
import { coreOf, startTestServer, type TestServer } from './helpers'

let t: TestServer
let browser: string
let desktop: string
const browserCookie = () => browser
const desktopCookie = () => desktop

beforeAll(async () => {
  t = await startTestServer()
  browser = await t.login('browser')
  desktop = await t.login('desktop')
})
afterAll(() => t.close())

/** Fill route params with harmless values. */
const sample = (url: string) => url.replace(/:seq/g, '1').replace(/:[a-zA-Z]+/g, 'x')

describe('Host allow-list (DNS rebinding, 07 B3/B4)', () => {
  it('accepts 127.0.0.1, localhost and vesper.localhost on the bound port', async () => {
    for (const h of [t.host, `localhost:${t.server.port}`, `vesper.localhost:${t.server.port}`]) {
      const r = await t.inject({ url: '/api/auth/state', headers: { host: h } })
      expect(r.statusCode, h).toBe(200)
    }
  })

  it('refuses other hosts, other ports and *.ts.net with 421', async () => {
    for (const h of ['evil.example', `evil.example:${t.server.port}`, '127.0.0.1:1', `pc.tail1234.ts.net`, `pc.tail1234.ts.net:${t.server.port}`, '']) {
      const r = await t.inject({ url: '/api/auth/state', headers: { host: h } })
      expect(r.statusCode, h).toBe(421)
    }
  })
})

describe('CSRF: Origin, Sec-Fetch-Site, x-vesper (07 B15, research 06 §5.3)', () => {
  const post = (headers: Record<string, string | undefined>) =>
    t.inject({ method: 'POST', url: '/api/sessions', payload: {}, cookie: browser, headers: headers as Record<string, string> })

  it('accepts a same-origin request with the header', async () => {
    expect((await post({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200)
  })

  it('refuses a missing or foreign Origin', async () => {
    expect((await post({ origin: undefined })).statusCode).toBe(403)
    expect((await post({ origin: 'http://127.0.0.1:1' })).statusCode).toBe(403)
    expect((await post({ origin: 'http://evil.example' })).statusCode).toBe(403)
    expect((await post({ origin: 'null' })).statusCode).toBe(403)
  })

  it('refuses same-site and cross-site Fetch Metadata', async () => {
    expect((await post({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403)
    expect((await post({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403)
    expect((await post({ 'sec-fetch-site': 'none' })).statusCode).toBe(200)
  })

  it('requires x-vesper: 1', async () => {
    expect((await post({ 'x-vesper': undefined })).statusCode).toBe(403)
    expect((await post({ 'x-vesper': '0' })).statusCode).toBe(403)
  })

  it('refuses cross-site reads of the API', async () => {
    const r = await t.inject({ url: '/api/sessions', cookie: browser, headers: { 'sec-fetch-site': 'cross-site' } })
    expect(r.statusCode).toBe(403)
  })

  it('refuses cross-site reads of the API however the path is spelled (F05)', async () => {
    for (const url of ['/%61pi/sessions', '/%61%70%69/sessions', '/api/%73essions', '/%61pi/sessions?x=1', '/%61pi/nope']) {
      for (const sfs of ['cross-site', 'same-site']) {
        const r = await t.inject({ url, cookie: browser, headers: { 'sec-fetch-site': sfs } })
        expect(r.statusCode, `${url} ${sfs}`).toBe(403)
      }
    }
    // An undecodable path never reaches a route.
    expect((await t.inject({ url: '/%zz/x', cookie: browser, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(400)
    // The same request from the app itself still works.

    expect((await t.inject({ url: '/%61pi/sessions', cookie: browser, headers: { 'sec-fetch-site': 'same-origin' } })).statusCode).toBe(200)
  })

  it('never sends CORS headers', async () => {
    const r = await t.inject({ url: '/api/auth/state', headers: { origin: 'http://evil.example' } })
    expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([])
    const pre = await t.inject({ method: 'OPTIONS', url: '/api/sessions', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } })
    expect(Object.keys(pre.headers).filter((k) => k.startsWith('access-control-'))).toEqual([])
  })

  it('sends the production CSP and security headers', async () => {
    const r = await t.inject({ url: '/api/auth/state' })
    const csp = String(r.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline\' \'wasm') // no inline scripts in production
    expect(csp).not.toContain('upgrade-insecure-requests')
    expect(r.headers['strict-transport-security']).toBeUndefined()
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
  })
})

describe('authorization levels (07 B2)', () => {
  it('every Endpoints entry is registered', () => {
    const app = t.server.ctx.app!
    for (const key of ENDPOINT_KEYS) {
      const [method, url] = key.split(' ')
      expect(app.hasRoute({ method: method as 'GET', url }), key).toBe(true)
    }
  })

  it('enforces each endpoint’s declared level', async () => {
    for (const key of ENDPOINT_KEYS) {
      const [method, url] = key.split(' ')
      const level = ENDPOINT_AUTH[key]
      // Logging out revokes the cookie used; give it throwaway devices.
      const [browser, desktop] = key === 'POST /api/auth/logout' ? [await t.login('browser'), await t.login('browser')] : [browserCookie(), desktopCookie()]
      const anon = await t.inject({ method: method as 'GET', url: sample(url), payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
      if (level === 'public') expect(anon.statusCode, `${key} anon`).not.toBe(401)
      else expect(anon.statusCode, `${key} anon`).toBe(401)
      const asBrowser = await t.inject({ method: method as 'GET', url: sample(url), cookie: browser, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
      if (level === 'desktop') expect(asBrowser.json().error.code, key).toBe('desktop_only')
      else if (level === 'sudo') expect(asBrowser.json().error.code, key).toBe('sudo_required')
      else expect([401, 403], `${key} browser`).not.toContain(asBrowser.statusCode)
      const asDesktop = await t.inject({ method: method as 'GET', url: sample(url), cookie: desktop, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })
      if (key !== 'POST /api/auth/logout') expect([401, 403], `${key} desktop`).not.toContain(asDesktop.statusCode)
    }
  })

  it('stubs answer 501 with the error envelope', async () => {
    // open-folder needs the desktop shell: on the standalone server it answers 501 (platform-int).
    for (const key of ['POST /api/system/open-folder'] as const) {
      const [method, url] = key.split(' ')
      const r = await t.inject({ method: method as 'GET', url: sample(url), cookie: desktop, payload: method === 'GET' ? undefined : {} })
      expect(r.statusCode, key).toBe(501)
      expect(r.json(), key).toMatchObject({ error: { code: 'not_implemented', retryable: false } })
    }
  })

  it('a pending device gets only the public routes (07 B16)', async () => {
    const core = coreOf(t.server.ctx)
    const { token } = core.auth.createDevice({ kind: 'paired', listener: 'loopback', name: 'Phone', pending: true })
    const cookie = `__Host-vesper_sid=${token}`
    const pending = await t.inject({ url: '/api/auth/state', cookie })
    expect(pending.statusCode).toBe(200)
    expect(pending.json()).toMatchObject({ signedIn: false, pendingApproval: true })
    const r = await t.inject({ url: '/api/bootstrap', cookie })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('forbidden')
    core.repos.devices.approve((await t.inject({ url: '/api/auth/devices', cookie: desktop })).json().find((d: { name: string }) => d.name === 'Phone').id)
    expect((await t.inject({ url: '/api/bootstrap', cookie })).statusCode).toBe(200)
    expect((await t.inject({ url: '/api/auth/state', cookie })).json()).toMatchObject({ signedIn: true, pendingApproval: false })
    expect((await t.inject({ url: '/api/auth/state' })).json()).toMatchObject({ signedIn: false, pendingApproval: false })
  })

  it('revoked, unknown and malformed sessions are anonymous', async () => {
    const extra = await t.login('browser')
    expect((await t.inject({ url: '/api/bootstrap', cookie: extra })).statusCode).toBe(200)
    expect((await t.inject({ method: 'POST', url: '/api/auth/logout', cookie: extra })).statusCode).toBe(204)
    expect((await t.inject({ url: '/api/bootstrap', cookie: extra })).statusCode).toBe(401)
    expect((await t.inject({ url: '/api/bootstrap', cookie: '__Host-vesper_sid=nope' })).statusCode).toBe(401)
    expect((await t.inject({ url: '/api/bootstrap', cookie: `__Host-vesper_sid=${'a'.repeat(500)}` })).statusCode).toBe(401)
  })

  it('a new desktop session revokes the previous one (07 B11)', async () => {
    const first = await t.login('desktop')
    const second = await t.login('desktop')
    expect((await t.inject({ url: '/api/bootstrap', cookie: first })).statusCode).toBe(401)
    const b = (await t.inject({ url: '/api/bootstrap', cookie: second })).json()
    expect(b).toMatchObject({ desktop: true, device: { kind: 'desktop', sudo: true, listener: 'loopback' } })
    desktop = second
  })

  it('a desktop cookie is not a desktop session on another listener (07 B3)', async () => {
    const core = coreOf(t.server.ctx)
    const c = await core.listeners.start({
      name: 'tailnet',
      bindHost: '127.0.0.1',
      port: 0,
      hosts: (p) => [`127.0.0.1:${p}`],
      origins: (p) => [`http://127.0.0.1:${p}`]
    })
    try {
      const host = `127.0.0.1:${c.port}`
      const r = await c.app.inject({ url: '/api/bootstrap', headers: { host, cookie: desktop } })
      expect(r.statusCode).toBe(401)
      const b = await c.app.inject({ url: '/api/bootstrap', headers: { host, cookie: browser } })
      expect(b.json()).toMatchObject({ desktop: false, device: { listener: 'tailnet' } })
      // Listener A's hosts are not accepted on C.
      expect((await c.app.inject({ url: '/api/auth/state', headers: { host: t.host } })).statusCode).toBe(421)
    } finally {
      await core.listeners.stop('tailnet')
    }
  })

  it('a route without config.auth fails at registration', async () => {
    const app = Fastify()
    installGuards(app, { name: 'loopback', hosts: new Set(), origins: new Set() }, {} as AuthCore)
    expect(() => app.get('/x', () => 'x')).toThrow(/config\.auth/)
    expect(() => app.get('/y', { config: { auth: 'public' } }, () => 'y')).not.toThrow()
    await app.close()
  })
})

describe('test endpoints', () => {
  it('stats and clock work in test mode', async () => {
    const s = await t.inject({ url: '/api/test/stats' })
    expect(s.json()).toMatchObject({ clients: 0, subscriptions: 0 })
    const before = t.server.ctx.clock.now()
    const c = await t.inject({ method: 'POST', url: '/api/test/clock', payload: { offsetMs: 86_400_000 }, headers: { origin: undefined, 'x-vesper': undefined } })
    expect(c.json().now - before).toBeGreaterThanOrEqual(86_400_000 - 1000)
    await t.inject({ method: 'POST', url: '/api/test/clock', payload: { offsetMs: 0 } })
  })

  it('do not exist without VESPER_TEST=1', async () => {
    process.env.VESPER_TEST = '0'
    try {
      const off = await startTestServer()
      try {
        expect((await off.inject({ url: '/api/test/ping' })).statusCode).toBe(404)
        expect((await off.inject({ url: '/api/auth/state' })).json().version).toBe('0.0.0-test')
      } finally {
        await off.close()
      }
    } finally {
      process.env.VESPER_TEST = '1'
    }
  })
})
