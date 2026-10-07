/**
 * Game mode (07 D3, spike S8): the detection rule, two-poll debounce, the setting (auto/on/off), effects (broadcast,
 * Bootstrap.gameMode, embedding paused, idle voice models unloaded, notifications held then summarised), and the
 * system-state host's hygiene (lazy start, restart with backoff then give up, stdin EOF on close, kill if stuck,
 * timers back to baseline). A fake host drives it; tests/unit/system/sysstate-real.test.ts runs the real one. @R14
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryOf } from '@server/memory/service'
import { sttImpl } from '@server/providers/stt'
import { systemOf, setSystemTestDeps, type SystemServer } from '@server/system'
import { classify, GameModeController } from '@server/system/gameMode'
import { installNotifyGate, MAX_HELD } from '@server/system/notifyGate'
import { SysStateHost, parseStateLine } from '@server/system/sysstateHost'
import type { Platform } from '@server/platform'
import { fakeLog } from '../../fakes'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { D3D, DESKTOP, fakeSysRunner, GAME, until, wait } from './fakeHost'

const FAST = { hostEnabled: true, intervalMs: 40, debounceMs: 60, startDelayMs: 0, backoffMs: [20, 40, 80] }

let t: TestServer | null = null
afterEach(async () => {
  setSystemTestDeps(null)
  await t?.close()
  t = null
})

async function start(o: { notes?: { title: string; body: string }[] } = {}): Promise<{ t: TestServer; sys: SystemServer; runner: ReturnType<typeof fakeSysRunner> }> {
  const runner = fakeSysRunner()
  setSystemTestDeps({ ...FAST, spawn: runner.spawn })
  const notes = o.notes
  t = await startTestServer({
    platform: (p: Platform) => (notes ? { ...p, notify: (title: string, body: string) => void notes.push({ title, body }) } : p)
  })
  const sys = systemOf(t.server.ctx)
  if (!sys) throw new Error('system module not registered')
  return { t, sys, runner }
}

const setMode = (tt: TestServer, gameMode: 'auto' | 'on' | 'off') => tt.server.ctx.settings.patch({ performance: { gameMode } })

describe('rule (07 §F S8)', () => {
  const self = new Set([process.pid])
  it('QUNS 3 / 2, or a captionless window covering its monitor that is not the shell or Vesper', () => {
    expect(classify(DESKTOP, self)).toEqual({ active: false, reason: 'off' })
    expect(classify(D3D, self)).toEqual({ active: true, reason: 'd3d' })
    expect(classify({ ...DESKTOP, quns: 2 }, self)).toEqual({ active: true, reason: 'busy' })
    expect(classify(GAME, self)).toEqual({ active: true, reason: 'fullscreen' })
    // A maximized normal window (has a caption, doesn't cover the taskbar) is not a game.
    expect(classify({ ...GAME, caption: true }, self).active).toBe(false)
    expect(classify({ ...GAME, covers: false }, self).active).toBe(false)
    // The desktop (Progman/WorkerW) covers the monitor without a caption.
    expect(classify({ ...GAME, shell: true, cls: 'Progman' }, self).active).toBe(false)
    // Vesper's own full-screen window never counts, whatever QUNS says.
    expect(classify({ ...GAME, pid: process.pid }, self).active).toBe(false)
    expect(classify({ ...D3D, quns: 2, pid: process.pid }, self).active).toBe(false)
    expect(classify({ ...GAME, fg: false }, self).active).toBe(false)
    expect(classify(null, self).active).toBe(false)
  })

  it('parses host lines defensively', () => {
    expect(parseStateLine('{"t":"ready","pid":12}')).toEqual({ ready: true, pid: 12 })
    expect(parseStateLine(JSON.stringify({ t: 'state', ...GAME }))).toEqual(GAME)
    expect(parseStateLine('{"t":"state","quns":"x","cls":5}')).toMatchObject({ quns: 0, cls: '', fg: false })
    expect(parseStateLine('nope')).toBeNull()
    expect(parseStateLine('{"t":"other"}')).toBeNull()
  })

  it('debounces: a change must hold for one more poll; a blink changes nothing', async () => {
    const changes: boolean[] = []
    const g = new GameModeController({ log: fakeLog(), setting: () => 'auto', host: null, selfPids: () => new Set(), debounceMs: 50, onChange: (n) => changes.push(n.active) })
    g.onHostState(GAME)
    await wait(20)
    g.onHostState(DESKTOP)
    await wait(80)
    expect(changes).toEqual([])
    g.onHostState(GAME)
    g.onHostState(GAME)
    await wait(80)
    expect(changes).toEqual([true])
    expect(g.state).toEqual({ active: true, reason: 'fullscreen' })
    await g.close()
    expect(g.timers()).toEqual({ pending: false, start: false })
  })
})

describe('game mode in the server', () => {
  it('auto: detects a game, broadcasts, pauses embedding, holds notifications; ends and delivers a summary', async () => {
    const notes: { title: string; body: string }[] = []
    const { t, sys, runner } = await start({ notes })
    const desktop = await t.login('desktop')
    const ws = new WsProbe(wsUrl(t), { cookie: desktop, origin: t.origin })
    await ws.hello()
    await until(() => runner.procs.length === 1, 3000, 'host start')
    expect(runner.last().args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-File', '-IntervalMs', '40']))
    const pause = vi.spyOn(memoryOf(t.server.ctx), 'setBackgroundPaused')
    runner.last().state(DESKTOP)
    await wait(100)
    expect(sys.gameMode.state.active).toBe(false)

    runner.last().state(GAME)
    expect(await ws.next('gamemode.changed')).toMatchObject({ active: true, reason: 'fullscreen' })
    expect(pause).toHaveBeenCalledWith('game', true)
    const boot = (await t.inject({ url: '/api/bootstrap', cookie: desktop })).json()
    expect(boot.gameMode).toEqual({ active: true, reason: 'fullscreen' })
    expect((await t.inject({ url: '/api/system/resources', cookie: desktop })).json().gameMode).toEqual({ active: true, reason: 'fullscreen' })

    // Notifications wait while playing…
    t.server.ctx.platform.notify('New device', 'Phone wants to pair')
    t.server.ctx.platform.notify('New sign-in', 'Laptop signed in')
    t.server.ctx.platform.notify('New sign-in', 'Tablet signed in')
    expect(notes).toEqual([])
    expect(sys.stats().heldNotifications).toBe(3)

    // …and arrive as one summary when the game is gone.
    runner.last().state(DESKTOP)
    expect(await ws.next('gamemode.changed')).toMatchObject({ active: false, reason: 'off' })
    expect(pause).toHaveBeenLastCalledWith('game', false)
    expect(notes).toEqual([{ title: '3 notifications while you were playing', body: 'New device · New sign-in' }])
    t.server.ctx.platform.notify('After', 'delivered at once')
    expect(notes[1]).toEqual({ title: 'After', body: 'delivered at once' })
    ws.close()
  })

  it('D3D full screen and QUNS busy count too; Vesper itself never does', async () => {
    const { sys, runner } = await start()
    await until(() => runner.procs.length === 1)
    runner.last().state(D3D)
    await until(() => sys.gameMode.state.reason === 'd3d')
    runner.last().state({ ...GAME, pid: process.pid })
    await until(() => !sys.gameMode.state.active)
    runner.last().state({ ...DESKTOP, quns: 2, pid: 9999 })
    await until(() => sys.gameMode.state.reason === 'busy')
  })

  it("setting: 'on' forces it and stops the host, 'off' ends it, 'auto' starts the host again", async () => {
    const { t, sys, runner } = await start()
    await until(() => runner.procs.length === 1)
    await setMode(t, 'on')
    expect(sys.gameMode.state).toEqual({ active: true, reason: 'forced' })
    await until(() => runner.procs[0].ended && runner.procs[0].exited, 3000, 'host stopped')
    await setMode(t, 'off')
    expect(sys.gameMode.state).toEqual({ active: false, reason: 'off' })
    await setMode(t, 'auto')
    await until(() => runner.procs.length === 2, 3000, 'host restarted')
    runner.last().state(GAME)
    await until(() => sys.gameMode.state.active)
  })

  it('a crashing host restarts with backoff, then gives up (≤ 3 starts / 5 min) and reads off', async () => {
    const { sys, runner } = await start()
    await until(() => runner.procs.length === 1)
    runner.last().state(GAME)
    await until(() => sys.gameMode.state.active)
    runner.last().exit(1)
    await until(() => runner.procs.length === 2, 3000, 'restart 1')
    runner.last().exit(1)
    await until(() => runner.procs.length === 3, 3000, 'restart 2')
    runner.last().exit(1)
    await until(() => sys.host!.gaveUp, 3000, 'give up')
    await wait(150)
    expect(runner.procs.length).toBe(3)
    expect(sys.gameMode.state.active).toBe(false)
    expect(sys.stats().host).toMatchObject({ running: false, restartTimer: false })
  })

  it('close: stdin EOF ends the host; a stuck host is killed; nothing keeps running', async () => {
    const { t: tt, sys, runner } = await start()
    await until(() => runner.procs.length === 1)
    runner.last().ignoreEof = true
    await tt.close()
    t = null
    expect(runner.procs[0].ended).toBe(true)
    expect(runner.procs[0].killed).toBe(true)
    expect(sys.stats()).toMatchObject({ unloadTimer: false, gameModeTimers: { pending: false, start: false }, host: { running: false, restartTimer: false } })
  }, 15000)

  it('game mode unloads idle voice models (never an open mic)', async () => {
    const { t, sys, runner } = await start()
    const stt = sttImpl(t.server.ctx)!
    const unload = vi.spyOn(stt, 'unload').mockResolvedValue()
    const stats = vi.spyOn(stt, 'stats')
    stats.mockResolvedValue({ mics: 1, byMic: 1, earlyFrames: 0, cloudJobs: 0, process: null, alive: true, spawned: 1, idleTimer: false })
    expect(await sys.unloadVoice({ onlyIdle: true })).toEqual({ stt: false, wintts: false, clientHints: ['highlighter'] })
    expect(unload).not.toHaveBeenCalled()
    stats.mockResolvedValue({ mics: 0, byMic: 0, earlyFrames: 0, cloudJobs: 0, process: null, alive: true, spawned: 1, idleTimer: false })
    await until(() => runner.procs.length === 1)
    runner.last().state(GAME)
    await until(() => unload.mock.calls.length === 1, 3000, 'idle unload on game start')
    expect(sys.stats().unloadTimer).toBe(true)
    runner.last().state(DESKTOP)
    await until(() => !sys.gameMode.state.active)
    expect(sys.stats().unloadTimer).toBe(false)
  })

  it('leak check: 20 on/off/auto cycles leave no host, timer or held notification behind', async () => {
    const { t, sys, runner } = await start()
    await until(() => runner.procs.length === 1)
    for (let i = 0; i < 20; i++) {
      await setMode(t, 'on')
      t.server.ctx.platform.notify('x', 'y')
      await setMode(t, 'off')
      await setMode(t, 'auto')
      await until(() => sys.host!.running, 3000, `host up ${i}`)
    }
    await setMode(t, 'off')
    await until(() => runner.procs.every((p) => p.exited), 3000, 'all hosts exited')
    expect(sys.stats()).toMatchObject({ unloadTimer: false, heldNotifications: 0, gameModeTimers: { pending: false, start: false }, host: { running: false, restartTimer: false, exits: 0 } })
  })
})

describe('notification gate', () => {
  it('passes through when not held; bounded while held; one held = delivered as is; close drops and restores', () => {
    const got: string[] = []
    const p = { notify: (title: string) => void got.push(title) } as unknown as Platform
    const original = p.notify
    const g = installNotifyGate(p)
    p.notify('a', '')
    g.hold(true)
    p.notify('b', 'only one')
    g.hold(false)
    expect(got).toEqual(['a', 'b'])
    g.hold(true)
    for (let i = 0; i < MAX_HELD * 3; i++) p.notify(`t${i}`, '')
    expect(g.held).toBe(MAX_HELD * 3)
    g.hold(false)
    expect(got[2]).toBe(`${MAX_HELD * 3} notifications while you were playing`)
    g.hold(true)
    p.notify('dropped at quit', '')
    g.close()
    expect(p.notify).toBe(original)
    expect(got).toHaveLength(3)
  })
})

describe('host restart budget (unit)', () => {
  it('spawns once per start(); stop() cancels a pending restart', async () => {
    const runner = fakeSysRunner()
    const states: number[] = []
    const h = new SysStateHost({ script: 'x/sysstate.ps1', log: fakeLog(), spawn: runner.spawn, onState: (s) => states.push(s.quns), backoffMs: [30] })
    h.start()
    h.start()
    expect(runner.procs.length).toBe(1)
    runner.last().state(D3D)
    await until(() => states.length === 1)
    h.probe()
    expect(runner.last().lines).toEqual(['{"op":"probe"}'])
    runner.last().exit(3)
    expect(h.stats().restartTimer).toBe(true)
    await h.stop()
    await wait(60)
    expect(runner.procs.length).toBe(1)
    expect(h.stats()).toMatchObject({ running: false, restartTimer: false })
  })
})
