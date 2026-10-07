/** Tray access items and "start with Windows" (research 06 §2.4, 07 B14/E8), without Electron. @R1 @R20 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { NetworkStatus } from '@shared/types/domain'
import { accessTrayItems, installTrayAccess, tailscaleLabel } from '../../../src/main/trayAccess'
import { autostartDecision, installAutostart, loginItemSettings } from '../../../src/main/autostart'
import { FakeRunner } from '../access/fakeRunner'
import { startAccessServer, type AccessServer } from '../access/helpers'

const base: NetworkStatus = {
  mode: 'local',
  loopback: { port: 41730, url: 'http://127.0.0.1:41730', browserUrl: 'http://vesper.localhost:41730' },
  lan: null,
  tailscale: null,
  passwordSet: true,
  portable: false,
  capabilities: { mic: true, install: true, warningFree: true },
  remote: { paused: false, loginSuspended: false }
}
const lanOn: NetworkStatus = {
  ...base,
  mode: 'lan',
  lan: { address: '10.0.0.5', port: 41731, url: 'https://10.0.0.5:41731', certFingerprint: 'AA', firewall: 'allowed', profile: 'private', running: true }
}
const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label)

describe('accessTrayItems', () => {
  it('nothing in local mode; LAN: copy link + pause; paused: checkbox checked and no copy', () => {
    const copied: string[] = []
    const paused: boolean[] = []
    const actions = { copy: (t: string) => void copied.push(t), setPaused: (p: boolean) => void paused.push(p) }
    expect(accessTrayItems(base, actions)).toEqual([])
    expect(accessTrayItems(null, actions)).toEqual([])
    const items = accessTrayItems(lanOn, actions)
    expect(labels(items)).toEqual(['Copy LAN link', 'Pause remote access'])
    items[0].click?.({} as never, undefined, {} as never)
    items[1].click?.({} as never, undefined, {} as never)
    expect(copied).toEqual(['https://10.0.0.5:41731'])
    expect(paused).toEqual([true])
    const p = accessTrayItems({ ...lanOn, lan: { ...lanOn.lan!, running: false, url: null }, remote: { paused: true, loginSuspended: false } }, actions)
    expect(labels(p)).toEqual(['Pause remote access'])
    expect(p[0]).toMatchObject({ type: 'checkbox', checked: true })
  })

  it('Tailscale: a status line and the ts.net link', () => {
    const ts = { installed: true, running: true, signedIn: true, dnsName: 'pc.tail.ts.net', serving: true, funnel: false, url: 'https://pc.tail.ts.net' }
    const s: NetworkStatus = { ...base, mode: 'tailscale', tailscale: ts }
    expect(labels(accessTrayItems(s, { copy: () => undefined, setPaused: () => undefined }))).toEqual(['Tailscale: on', 'Copy Tailscale link', 'Pause remote access'])
    expect(tailscaleLabel({ ...s, tailscale: { ...ts, funnel: true } })).toMatch(/Funnel/)
    expect(tailscaleLabel({ ...s, tailscale: { ...ts, installed: false } })).toBe('Tailscale: not installed')
    expect(tailscaleLabel({ ...s, tailscale: { ...ts, signedIn: false } })).toBe('Tailscale: signed out')
    expect(tailscaleLabel({ ...s, tailscale: null })).toBe('Tailscale: checking…')
  })
})

describe('installTrayAccess + installAutostart against a real server', () => {
  let t: AccessServer
  beforeAll(async () => {
    t = await startAccessServer({ runner: new FakeRunner(), ports: { lan: 0 } })
    await t.setPassword()
  })
  afterAll(() => t.close())

  it('the tray refreshes on network changes and its pause item pauses the server; disposing unregisters', async () => {
    const providers = new Map<string, () => MenuItemConstructorOptions[]>()
    let refreshes = 0
    const dispose = installTrayAccess(t.server.ctx, {
      register: (id, p) => {
        providers.set(id, p)
        return () => providers.delete(id)
      },
      refresh: () => void refreshes++,
      copy: () => undefined
    })
    expect(providers.get('access')!()).toEqual([])
    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
    expect(refreshes).toBeGreaterThan(0)
    const items = providers.get('access')!()
    expect(labels(items)).toEqual(['Copy LAN link', 'Pause remote access'])
    items[1].click?.({} as never, undefined, {} as never)
    await t.access().net.reconcile()
    expect(t.access().net.isPaused()).toBe(true)
    expect(providers.get('access')!()[0]).toMatchObject({ label: 'Pause remote access', checked: true })
    await t.access().net.setPaused(false)
    dispose()
    expect(providers.size).toBe(0)
    const before = refreshes
    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'local' } })
    expect(refreshes).toBe(before)
  })

  it('autostart: only a user change in a packaged, non-test, non-portable app calls setLoginItemSettings', async () => {
    expect(autostartDecision({ packaged: true, test: false, portable: false })).toBe('apply')
    expect(autostartDecision({ packaged: false, test: false, portable: false })).toBe('skip-dev')
    expect(autostartDecision({ packaged: true, test: true, portable: false })).toBe('skip-test')
    expect(autostartDecision({ packaged: true, test: false, portable: true })).toBe('skip-portable')
    expect(loginItemSettings(true)).toEqual({ openAtLogin: true, args: ['--background'] })

    const calls: unknown[] = []
    const logs: string[] = []
    const offReal = installAutostart(t.server.ctx, { packaged: true, test: false, portable: false, set: (o) => void calls.push(o), log: (m) => void logs.push(m) })
    const offDev = installAutostart(t.server.ctx, { packaged: false, test: false, portable: false, set: () => calls.push('dev!'), log: (m) => void logs.push(m) })
    expect(calls).toEqual([])
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { appearance: { theme: 'light' } } })
    expect(calls).toEqual([])
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { desktop: { startWithWindows: true } } })
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { desktop: { startWithWindows: true, closeToTray: true } } })
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { desktop: { startWithWindows: false } } })
    expect(calls).toEqual([
      { openAtLogin: true, args: ['--background'] },
      { openAtLogin: false, args: ['--background'] }
    ])
    expect(logs.filter((l) => l.includes('skip-dev'))).toHaveLength(2)
    offReal()
    offDev()
    await t.inject({ method: 'PATCH', url: '/api/settings', cookie: t.desktop, payload: { desktop: { startWithWindows: true } } })
    expect(calls).toHaveLength(2)
  })
})
