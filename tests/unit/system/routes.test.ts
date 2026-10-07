/**
 * platform-int routes and host plumbing: resource use (07 D2) with and without app metrics, "Unload voice models now",
 * the fixed open-folder set (desktop only, never a client path), Bootstrap.mute (test runs muted by default), the
 * global push-to-talk relay to the focused-or-last desktop client (07 D6), restore → Platform.restart (07 C20), and
 * worker execArgv on the plain-Node platforms (07 B6 heap cap). @R14 @R19
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNodePlatform } from '@server/nodePlatform'
import type { AppProcessMetric, Platform, WorkerHandle } from '@server/platform'
import { processName, systemOf } from '@server/system'
import { fakePlatform } from '../../fakes'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { until } from './fakeHost'

const METRICS: AppProcessMetric[] = [
  { pid: 100, type: 'Browser', name: null, privateKB: 120 * 1024, workingSetKB: 180 * 1024, cpuPercent: 0.4 },
  { pid: 101, type: 'Tab', name: null, privateKB: 200 * 1024, workingSetKB: 260 * 1024, cpuPercent: 1.26 },
  { pid: 102, type: 'GPU', name: null, privateKB: 60 * 1024, workingSetKB: 90 * 1024, cpuPercent: 0 },
  { pid: 103, type: 'Utility', name: 'Vesper Speech recognition', privateKB: null, workingSetKB: 300 * 1024, cpuPercent: 0 }
]

describe('resources, unload, open-folder (standalone server)', () => {
  let t: TestServer
  let desktop: string
  let browser: string
  beforeAll(async () => {
    t = await startTestServer()
    desktop = await t.login('desktop')
    browser = await t.login('browser')
  })
  afterAll(() => t.close())

  it('GET /api/system/resources: the server process, budgets, voice state, game mode', async () => {
    const r = (await t.inject({ url: '/api/system/resources', cookie: browser })).json()
    expect(r.processes).toHaveLength(1)
    expect(r.processes[0]).toMatchObject({ name: 'Vesper server', pid: process.pid, type: 'Server', privateMB: null })
    expect(r.processes[0].memMB).toBeGreaterThan(10)
    expect(r.budgetsMB).toEqual({ trayOnly: 250, windowIdle: 550, withStt: 850 })
    expect(r.voice).toEqual({ sttLoaded: false, winttsRunning: false })
    expect(r.gameMode).toEqual({ active: false, reason: 'off' })
  })

  it('POST /api/system/unload-voice answers what was unloaded + the client hint', async () => {
    const r = await t.inject({ method: 'POST', url: '/api/system/unload-voice', cookie: browser })
    expect(r.json()).toEqual({ stt: false, wintts: false, clientHints: ['highlighter'] })
  })

  it('open-folder needs the desktop shell: 501 on the standalone server, desktop_only for others', async () => {
    expect((await t.inject({ method: 'POST', url: '/api/system/open-folder', cookie: desktop, payload: { which: 'logs' } })).json().error.code).toBe('not_implemented')
    expect((await t.inject({ method: 'POST', url: '/api/system/open-folder', cookie: browser, payload: { which: 'logs' } })).json().error.code).toBe('desktop_only')
  })

  it('Bootstrap.mute: on by default in test runs; VESPER_MUTE=0 turns it off', async () => {
    expect((await t.inject({ url: '/api/bootstrap', cookie: browser })).json().mute).toBe(true)
    process.env.VESPER_MUTE = '0'
    try {
      expect((await t.inject({ url: '/api/bootstrap', cookie: browser })).json().mute).toBe(false)
    } finally {
      delete process.env.VESPER_MUTE
    }
  })
})

describe('desktop host (metrics, openPath, restart)', () => {
  let t: TestServer
  let desktop: string
  const opened: string[] = []
  let restarts = 0
  beforeAll(async () => {
    t = await startTestServer({
      platform: (p: Platform) => ({
        ...p,
        isDesktop: true,
        metrics: () => METRICS.map((m) => ({ ...m })),
        openPath: async (dir: string) => {
          opened.push(dir)
          return dir.includes('missing') ? 'missing' : ''
        },
        restart: () => void restarts++
      })
    })
    desktop = await t.login('desktop')
  })
  afterAll(() => t.close())

  it('resources from app metrics: private working sets, plain names, total', async () => {
    const r = (await t.inject({ url: '/api/system/resources', cookie: desktop })).json()
    expect(r.processes.map((p: { name: string }) => p.name)).toEqual(['Vesper (app + server)', 'Window', 'Graphics', 'Vesper Speech recognition'])
    expect(r.processes[1]).toMatchObject({ pid: 101, type: 'Tab', memMB: 200, privateMB: 200, cpu: 1.3 })
    // No private bytes reported → the working set stands in.
    expect(r.processes[3]).toMatchObject({ memMB: 300, privateMB: null })
    expect(r.totalMB).toBe(680)
    expect(processName('Utility', null)).toBe('Helper')
  })

  it('open-folder opens only the server’s own folders (created first); anything else is refused', async () => {
    const paths = t.server.ctx.paths
    for (const [which, dir] of [
      ['data', paths.roaming],
      ['roaming', paths.roaming],
      ['local', paths.local],
      ['logs', paths.logs],
      ['backups', paths.backups],
      ['exports', paths.exports],
      ['models', paths.models]
    ] as const) {
      const r = await t.inject({ method: 'POST', url: '/api/system/open-folder', cookie: desktop, payload: { which } })
      expect(r.statusCode, which).toBe(204)
      expect(opened[opened.length - 1]).toBe(dir)
      expect(fs.statSync(dir).isDirectory()).toBe(true)
    }
    for (const payload of [{ which: 'C:\\Windows' }, { which: '..' }, { which: 'logs', path: 'C:\\' }, {}]) {
      expect((await t.inject({ method: 'POST', url: '/api/system/open-folder', cookie: desktop, payload })).statusCode).toBe(400)
    }
    expect(opened).toHaveLength(7)
  })

  it('a staged restore restarts the app right away when the host can (07 C20)', async () => {
    const b = (await t.inject({ method: 'POST', url: '/api/backup', cookie: desktop })).json()
    const ws = new WsProbe(wsUrl(t), { cookie: desktop, origin: t.origin })
    await ws.hello()
    try {
      expect((await t.inject({ method: 'POST', url: '/api/backups/restore', cookie: desktop, payload: { file: b.file } })).statusCode).toBe(204)
      expect((await ws.next('toast')).text).toMatch(/restarting/)
      await until(() => restarts === 1, 3000, 'restart')
    } finally {
      ws.close()
      fs.rmSync(path.join(t.server.ctx.paths.roaming, 'vesper.db.restore'), { force: true })
    }
  })
})

describe('global push-to-talk relay (07 D6)', () => {
  let t: TestServer
  beforeAll(async () => {
    t = await startTestServer()
  })
  afterAll(() => t.close())

  it('goes to the focused desktop client, else the last one; presses toggle; browsers never get it', async () => {
    const sys = systemOf(t.server.ctx)!
    expect(sys.hotkey()).toBe(false)
    // One desktop device (a new desktop login revokes the previous one), two sockets: e.g. after a window reload.
    const desktop = await t.login('desktop')
    const d1 = new WsProbe(wsUrl(t), { cookie: desktop, origin: t.origin })
    const d2 = new WsProbe(wsUrl(t), { cookie: desktop, origin: t.origin })
    const phone = new WsProbe(wsUrl(t), { cookie: await t.login('browser'), origin: t.origin })
    await Promise.all([d1.hello(), d2.hello(), phone.hello()])
    const focus = async (p: WsProbe, focused: boolean) => {
      p.send({ t: 'client.state', client: { visible: true, focused, audioUnlocked: true } })
      await new Promise((r) => setTimeout(r, 50))
    }
    await focus(d1, false)
    await focus(d2, true)
    await focus(phone, true)
    expect(sys.hotkey()).toBe(true)
    expect(await d2.next('hotkey.ptt')).toEqual({ t: 'hotkey.ptt', down: true })
    expect(sys.hotkey()).toBe(true)
    expect(await d2.next('hotkey.ptt')).toEqual({ t: 'hotkey.ptt', down: false })
    // Nobody focused: the last target keeps it.
    await focus(d2, false)
    sys.hotkey()
    expect(await d2.next('hotkey.ptt')).toEqual({ t: 'hotkey.ptt', down: true })
    // Another desktop client gains focus: it gets a fresh toggle (down).
    await focus(d1, true)
    sys.hotkey()
    expect(await d1.next('hotkey.ptt')).toEqual({ t: 'hotkey.ptt', down: true })
    expect(phone.msgs.some((m) => m.t === 'hotkey.ptt')).toBe(false)
    for (const p of [d1, d2, phone]) p.close()
  })
})

describe('worker execArgv (07 B6 heap cap on every platform)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-execargv-'))
  const script = path.join(dir, 'heap.cjs')
  fs.writeFileSync(script, "process.send({ limit: require('v8').getHeapStatistics().heap_size_limit, argv: process.execArgv }, () => process.exit(0))\n")
  afterEach(() => undefined)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  const report = (h: WorkerHandle) => new Promise<{ limit: number; argv: string[] }>((resolve) => h.on('message', (m) => resolve(m as { limit: number; argv: string[] })))

  it('node platform and the fake platform pass execArgv to the child', async () => {
    const node = createNodePlatform({ appDir: dir, version: '0', dataDir: dir })
    const fake = fakePlatform(dir)
    for (const p of [node, fake]) {
      const capped = await report(p.forkWorker(script, [], { name: 'heap', execArgv: ['--max-old-space-size=96'] }))
      expect(capped.argv).toContain('--max-old-space-size=96')
      // V8 adds young-generation space to the old-space cap.
      expect(capped.limit).toBeLessThan(200 * 1024 * 1024)
      const free = await report(p.forkWorker(script, [], { name: 'heap' }))
      expect(free.argv).not.toContain('--max-old-space-size=96')
      expect(free.limit).toBeGreaterThan(capped.limit)
    }
    expect(fake.workers.map((w) => w.execArgv ?? null)).toEqual([['--max-old-space-size=96'], null])
  })
})
