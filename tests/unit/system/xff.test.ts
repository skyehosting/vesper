/**
 * Per-IP lockout behind Tailscale Serve (07 B3/B15, access-server gap): every tailnet client reaches Listener C from
 * 127.0.0.1, so C — and only C — takes the client address from X-Forwarded-For (the proxy's own, last entry). A forged
 * header on Listener A changes nothing. @R1
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientIp } from '@server/http/auth'
import { coreOf } from '../server/helpers'
import { FakeRunner } from '../access/fakeRunner'
import { injectOn, PASSWORD, startAccessServer, type AccessServer } from '../access/helpers'

const EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe'
const DNS = 'vesper-pc.tail1234.ts.net'

describe('clientIp', () => {
  it('trusts the last X-Forwarded-For entry only on the tailnet listener from a loopback peer', () => {
    expect(clientIp('tailnet', '127.0.0.1', '100.64.0.7')).toBe('100.64.0.7')
    expect(clientIp('tailnet', '::ffff:127.0.0.1', 'fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
    // A client-sent value comes first; the proxy appends the real address.
    expect(clientIp('tailnet', '127.0.0.1', '1.2.3.4, 100.64.0.7')).toBe('100.64.0.7')
    expect(clientIp('tailnet', '127.0.0.1', ['9.9.9.9', '100.64.0.8'])).toBe('100.64.0.8')
    expect(clientIp('tailnet', '127.0.0.1', '100.64.0.7:51234')).toBe('100.64.0.7')
    // Garbage or absent → the socket address.
    expect(clientIp('tailnet', '127.0.0.1', 'not-an-ip')).toBe('127.0.0.1')
    expect(clientIp('tailnet', '127.0.0.1', undefined)).toBe('127.0.0.1')
    expect(clientIp('tailnet', '127.0.0.1', '')).toBe('127.0.0.1')
    // Other listeners, or a non-loopback peer, never use the header.
    expect(clientIp('loopback', '127.0.0.1', '100.64.0.7')).toBe('127.0.0.1')
    expect(clientIp('lan', '192.168.1.20', '100.64.0.7')).toBe('192.168.1.20')
    expect(clientIp('tailnet', '192.168.1.20', '100.64.0.7')).toBe('192.168.1.20')
  })
})

describe('lockout buckets on Listener C', () => {
  let t: AccessServer
  beforeAll(async () => {
    t = await startAccessServer({ runner: new FakeRunner(), ports: { lan: 0, tailnet: 0 }, tailscaleExe: () => EXE })
    await t.setPassword()
    const r = await t.inject({ method: 'POST', url: '/api/network/tailscale/serve', cookie: t.desktop, payload: { on: true } })
    if (r.statusCode !== 200) throw new Error(`serve → ${r.statusCode}`)
  })
  afterAll(() => t.close())

  const loginOnC = (ip: string, password = 'wrong password, not the right one') => {
    const l = coreOf(t.server.ctx).listeners.get('tailnet')!
    return injectOn(l, { method: 'POST', url: '/api/auth/login', host: DNS, headers: { 'x-forwarded-for': ip }, payload: { password, deviceName: 'Phone' } })
  }

  it('one tailnet device locking itself out does not lock out another', async () => {
    for (let i = 0; i < 5; i++) expect((await loginOnC('100.64.0.10')).json().error.code).not.toBe('rate_limited')
    expect((await loginOnC('100.64.0.10')).json().error.code).toBe('rate_limited')
    // A different tailnet address has its own bucket: the right password works.
    const ok = await loginOnC('100.64.0.11', PASSWORD)
    expect(ok.statusCode).toBe(200)
    // The audit log records the forwarded address.
    const log = (await t.inject({ url: '/api/auth/log', cookie: t.desktop })).json() as { event: string; ip: string | null }[]
    expect(log.some((e) => e.ip === '100.64.0.11')).toBe(true)
  })

  it('a forged header on Listener A is ignored (its bucket stays 127.0.0.1)', async () => {
    t.advance(120_000)
    for (let i = 0; i < 5; i++) {
      await t.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.0.0.${i}` }, payload: { password: 'nope nope nope nope', deviceName: 'x' } })
    }
    const sixth = await t.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.0.0.99' }, payload: { password: 'nope nope nope nope', deviceName: 'x' } })
    expect(sixth.json().error.code).toBe('rate_limited')
  })
})
