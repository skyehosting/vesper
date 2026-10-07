/**
 * H-v12-updates on the server: GET /api/system/update for every device, check/download/restart for the desktop app
 * only; without an updater (the standalone server, dev and test runs) the state is 'unsupported'; with one, its
 * changes reach every client as `update.state`; and what 'auto' asks before an unattended restart. No network. @R20
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/api'
import { ENDPOINT_AUTH } from '@server/http/endpoints'
import type { Platform, PlatformUpdater } from '@server/platform'
import { systemOf } from '@server/system'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { until } from './fakeHost'

describe('auth levels', () => {
  it('anyone signed in reads the state; only the desktop app checks, downloads and restarts', () => {
    expect(ENDPOINT_AUTH['GET /api/system/update']).toBe('device')
    expect(ENDPOINT_AUTH['POST /api/system/update/check']).toBe('desktop')
    expect(ENDPOINT_AUTH['POST /api/system/update/download']).toBe('desktop')
    expect(ENDPOINT_AUTH['POST /api/system/update/restart']).toBe('desktop')
  })
})

describe('without an updater (standalone server)', () => {
  let t: TestServer
  let desktop: string
  let browser: string
  beforeAll(async () => {
    t = await startTestServer()
    desktop = await t.login('desktop')
    browser = await t.login('browser')
  })
  afterAll(() => t.close())

  it("reports 'unsupported'; Check now says so; download and restart answer 501; other devices are refused", async () => {
    const r = await t.inject({ url: '/api/system/update', cookie: browser })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.json()).toEqual({ state: 'unsupported', currentVersion: '0.0.0-test' })
    expect((await t.inject({ method: 'POST', url: '/api/system/update/check', cookie: desktop })).json()).toEqual({ state: 'unsupported', currentVersion: '0.0.0-test' })
    for (const url of ['/api/system/update/download', '/api/system/update/restart']) {
      const d = await t.inject({ method: 'POST', url, cookie: desktop })
      expect(d.statusCode, url).toBe(501)
      expect(d.json().error.code).toBe('not_implemented')
    }
    for (const url of ['/api/system/update/check', '/api/system/update/download', '/api/system/update/restart']) {
      expect((await t.inject({ method: 'POST', url, cookie: browser })).json().error.code, url).toBe('desktop_only')
    }
    expect((await t.inject({ url: '/api/system/update' })).statusCode).toBe(401)
  })
})

describe('with the desktop updater attached', () => {
  let t: TestServer
  let desktop: string
  let browser: string
  let s: UpdateStatus = { state: 'idle', currentVersion: '1.1.3' }
  const listeners = new Set<(s: UpdateStatus) => void>()
  const calls = { checks: 0, downloads: 0, restarts: 0 }
  const emit = (next: UpdateStatus): void => {
    s = next
    for (const fn of listeners) fn(s)
  }
  const updater: PlatformUpdater = {
    status: () => s,
    async check() {
      calls.checks++
      emit({ state: 'available', currentVersion: '1.1.3', version: '1.2.0', releaseUrl: 'https://github.com/someone/vesper/releases/tag/v1.2.0', checkedUtc: 1 })
      return s
    },
    async download() {
      calls.downloads++
      emit({ ...s, state: 'downloading', percent: 0 })
      return s
    },
    restart() {
      if (s.state !== 'ready') return false
      calls.restarts++
      return true
    },
    onChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    }
  }
  beforeAll(async () => {
    t = await startTestServer({ platform: (p: Platform) => Object.assign(p, { isDesktop: true, updater }) })
    desktop = await t.login('desktop')
    browser = await t.login('browser')
  })
  afterAll(() => t.close())

  it('serves its state, relays every change as update.state, and maps the three actions', async () => {
    const phone = new WsProbe(wsUrl(t), { cookie: browser, origin: t.origin })
    await phone.hello()
    try {
      expect((await t.inject({ url: '/api/system/update', cookie: browser })).json()).toEqual({ state: 'idle', currentVersion: '1.1.3' })
      const checked = (await t.inject({ method: 'POST', url: '/api/system/update/check', cookie: desktop })).json()
      expect(checked).toMatchObject({ state: 'available', version: '1.2.0' })
      // Other devices watch it live (read-only).
      expect(await phone.next('update.state')).toEqual({ t: 'update.state', ...checked })
      expect((await t.inject({ method: 'POST', url: '/api/system/update/download', cookie: desktop })).json()).toMatchObject({ state: 'downloading', percent: 0 })
      expect((await phone.next('update.state')).t).toBe('update.state')
      // Nothing ready yet: restart is a conflict and does nothing.
      const early = await t.inject({ method: 'POST', url: '/api/system/update/restart', cookie: desktop })
      expect(early.statusCode).toBe(409)
      expect(early.json().error.message).toBe('No update is ready to install yet.')
      emit({ state: 'ready', currentVersion: '1.1.3', version: '1.2.0', percent: 100 })
      expect((await t.inject({ method: 'POST', url: '/api/system/update/restart', cookie: desktop })).statusCode).toBe(204)
      expect(calls).toEqual({ checks: 1, downloads: 1, restarts: 1 })
    } finally {
      phone.close()
    }
  })

  it("'auto' asks what an unattended restart would interrupt: replies, mics, game mode, anyone looking", async () => {
    const sys = systemOf(t.server.ctx)!
    // The previous test's socket is gone once the server has seen it close.
    await until(() => [...t.server.ctx.hub.clients()].length === 0, 3000, 'sockets closed')
    expect(sys.updateActivity()).toEqual({ streaming: false, mic: false, game: false, attended: false })
    const ws = new WsProbe(wsUrl(t), { cookie: browser, origin: t.origin })
    await ws.hello()
    try {
      // A tab in front (hello says visible + focused) counts as someone looking; hidden, it doesn't.
      expect(sys.updateActivity().attended).toBe(true)
      ws.send({ t: 'client.state', client: { visible: false, focused: false, audioUnlocked: false } })
      await until(() => !sys.updateActivity().attended, 3000, 'client hidden')
    } finally {
      ws.close()
    }
  })

  it('stops relaying when the server closes (no listener left behind)', async () => {
    const extra = await startTestServer({ platform: (p: Platform) => Object.assign(p, { updater }) })
    const before = listeners.size
    await extra.close()
    expect(listeners.size).toBe(before - 1)
  })
})
