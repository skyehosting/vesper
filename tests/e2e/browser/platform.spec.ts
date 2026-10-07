/**
 * platform-int over the built standalone server (out/main/server-node.js) and headless Chromium: Bootstrap carries
 * `mute` (test runs muted) and `gameMode`; forcing game mode in Settings reaches the page as `gamemode.changed`;
 * resource use and "Unload voice models now" answer; open-folder needs the desktop shell. @R14 @R19
 */
import { expect, test } from '@playwright/test'
import { launchServer, type TestServer } from '../launch'

let s: TestServer

test.beforeAll(async () => {
  s = await launchServer()
})

test.afterAll(async () => {
  await s?.close()
})

test('bootstrap: muted test run, game mode state; forcing game mode reaches the page live @R14', async () => {
  const boot = await s.api<{ mute?: boolean; gameMode?: { active: boolean; reason: string } }>('GET', '/api/bootstrap')
  expect(boot.json.mute).toBe(true)
  expect(boot.json.gameMode).toEqual({ active: false, reason: 'off' })

  // A second socket inside the page records gamemode.changed.
  await s.page.evaluate(async () => {
    const w = window as unknown as { __gm: { msgs: unknown[]; ws: WebSocket } }
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
    w.__gm = { msgs: [], ws }
    await new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error('ws error'))
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: false } }))
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { t: string }
        if (m.t === 'ready') resolve()
        if (m.t === 'gamemode.changed') w.__gm.msgs.push(m)
      }
    })
  })
  const desk = await s.login('desktop')
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'on' } })).status).toBe(200)
  await expect.poll(() => s.page.evaluate(() => (window as unknown as { __gm: { msgs: unknown[] } }).__gm.msgs)).toEqual([{ t: 'gamemode.changed', active: true, reason: 'forced' }])
  expect((await s.api<{ gameMode: unknown }>('GET', '/api/bootstrap')).json.gameMode).toEqual({ active: true, reason: 'forced' })
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'auto' } })).status).toBe(200)
  await expect.poll(() => s.page.evaluate(() => (window as unknown as { __gm: { msgs: unknown[] } }).__gm.msgs.length)).toBe(2)
  await s.page.evaluate(() => (window as unknown as { __gm: { ws: WebSocket } }).__gm.ws.close())
  await s.assertNoErrors()
})

test('resource use, unloading voice models, open-folder on the standalone server @R19', async () => {
  const r = await s.api<{ processes: { name: string; type: string; memMB: number }[]; budgetsMB: unknown; voice: unknown }>('GET', '/api/system/resources')
  expect(r.status).toBe(200)
  expect(r.json.processes).toHaveLength(1)
  expect(r.json.processes[0]).toMatchObject({ name: 'Vesper server', type: 'Server' })
  expect(r.json.processes[0].memMB).toBeGreaterThan(10)
  expect(r.json.budgetsMB).toEqual({ trayOnly: 250, windowIdle: 550, withStt: 850 })
  expect(r.json.voice).toEqual({ sttLoaded: false, winttsRunning: false })
  expect((await s.api('POST', '/api/system/unload-voice')).json).toEqual({ stt: false, wintts: false, clientHints: ['highlighter'] })
  const desk = await s.login('desktop')
  const open = await desk.api<{ error: { code: string } }>('POST', '/api/system/open-folder', { which: 'logs' })
  expect(open.status).toBe(501)
  expect(open.json.error.code).toBe('not_implemented')
  expect((await s.api<{ error: { code: string } }>('POST', '/api/system/open-folder', { which: 'logs' })).json.error.code).toBe('desktop_only')
})
