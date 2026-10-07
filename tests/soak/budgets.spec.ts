/**
 * Soak 7 — resident-memory budgets (07 D2) measured, not asserted as constants: the packaged-like desktop app (built
 * out/main, Electron) on the secondary display, summed over every app process: the private working set (Task Manager's "Memory", read from the Windows performance counters; 07 D2 names it),
 * with the commit charge (`memory.privateBytes`, what Settings → Resource use shows) recorded next to it:
 *   window idle on a chat (the Star on its stage)   ≤ 550 MB
 *   + speech recognition loaded (Talk mode open)     ≤ 850 MB
 *   closed to the tray (renderer destroyed, voice models unloaded) ≤ 250 MB
 * The +STT row runs the scripted recognizer (VESPER_STT_FAKE: the real Silero VAD in the STT utility, no Parakeet
 * weights, which no test may download), so it bounds everything but the model's own ~0.6 GB; the report says so.
 */
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchApp, type TestApp } from '../e2e/launch'
import { AUDIO_FIXTURES } from '../e2e/stt'
import { finish, privateWorkingSets, Recorder, round, steady } from './soak'

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await t?.close()
  await mock?.close()
})

interface Reading {
  /** Private working set (Task Manager's "Memory"), the D2 metric; MB per process type and in total. */
  totalMB: number
  byType: Record<string, number>
  /** Private bytes (commit charge, what Settings → Resource use shows), for the record. */
  commitMB: number
  commitByType: Record<string, number>
}

async function metrics(app: TestApp['app']): Promise<Reading> {
  const list = (await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, commitMB: ((m.memory as { privateBytes?: number }).privateBytes ?? m.memory.workingSetSize) / 1024 }))
  )) as Array<{ pid: number; type: string; commitMB: number }>
  const pws = privateWorkingSets(list.map((m) => m.pid))
  const r: Reading = { totalMB: 0, byType: {}, commitMB: 0, commitByType: {} }
  for (const m of list) {
    // Without the counter (not Windows, counters disabled) fall back to the commit charge: stricter, never looser.
    const ws = pws[m.pid] ?? m.commitMB
    r.byType[m.type] = round((r.byType[m.type] ?? 0) + ws)
    r.commitByType[m.type] = round((r.commitByType[m.type] ?? 0) + m.commitMB)
    r.totalMB += ws
    r.commitMB += m.commitMB
  }
  r.totalMB = round(r.totalMB)
  r.commitMB = round(r.commitMB)
  return r
}

/** The lowest of a few readings over `ms` (working sets settle after GC and trimming). */
async function settled(app: TestApp['app'], ms: number): Promise<Reading> {
  let best = await metrics(app)
  const end = Date.now() + ms
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000))
    const m = await metrics(app)
    if (m.totalMB < best.totalMB) best = m
  }
  return best
}

const show = (r: Reading): string => `private working set ${JSON.stringify(r.byType)}; commit ${r.commitMB} MB ${JSON.stringify(r.commitByType)}`

test('desktop memory budgets: window idle ≤ 550 MB, + speech recognition ≤ 850 MB, tray only ≤ 250 MB (07 D2) @R17', async () => {
  test.setTimeout(10 * 60_000)
  const rec = new Recorder('budgets')
  t = await launchApp({ mock, fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), env: { VESPER_STT_FAKE: '1' }, timeoutMs: 60_000 })
  await configureMockLlm(t.api, mock.url)
  await steady(t.api)
  expect((await t.api('PATCH', '/api/settings', { desktop: { closeToTray: true, keepWindowWarmSec: 0 }, voice: { stt: { enabled: true } } })).status).toBe(200)
  const sess = await createSession(t.api, 'Budgets')
  await t.hook('go', `/s/${sess.uid}`)
  await t.waitReady()
  await t.waitHook('presence.surface')

  const idle = await settled(t.app, 15_000)
  rec.check('window idle (MB, ≤ 550)', idle.totalMB, 550)
  rec.note(`window idle: ${show(idle)}`)

  await t.hook('go', `/talk/${sess.uid}`)
  await t.waitReady()
  await expect.poll(async () => (await t!.api<{ voice: { sttLoaded: boolean } }>('GET', '/api/system/resources')).json.voice.sttLoaded, { timeout: 30_000 }).toBe(true)
  const stt = await settled(t.app, 10_000)
  rec.check('+ speech recognition (MB, ≤ 850)', stt.totalMB, 850)
  rec.note(`with speech recognition (scripted recognizer + Silero VAD; Parakeet weights not loaded): ${show(stt)}`)

  // Close to the tray: the window hides, its renderer is destroyed at once (keepWindowWarmSec 0); unload voice.
  await t.hook('go', `/s/${sess.uid}`)
  await t.waitReady()
  expect((await t.api('POST', '/api/system/unload-voice')).status).toBe(200)
  await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(() => t!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 15_000 }).toBe(0)
  const tray = await settled(t.app, Number(process.env.SOAK_TRAY_MS ?? 15_000))
  rec.check('tray only (MB, ≤ 250)', tray.totalMB, 250)
  rec.note(`tray only: ${show(tray)}`)
  await finish(rec, t)
  await t.close()
  t = null
  rec.done()
})
