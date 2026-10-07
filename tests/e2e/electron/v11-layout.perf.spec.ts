/**
 * v11 layout performance pass (opt-in: V11_PERF=1): the avatar behind the messages on the real GPU path (Electron,
 * ANGLE), window on the secondary display (dev-window marker), never focused. Per window size: the canvas buffer,
 * frames and renderer-thread CPU while speaking, idle drift, rest (0 fps), unfocused; the GPU process's CPU from
 * app.getAppMetrics(). Reference rows: the presence lab (the Star alone) and Talk mode's full stage.
 * Results: <V11_OUT>/perf.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import type { FrameStats } from '../presence'

const OUT = process.env.V11_OUT ?? path.resolve('test-results', 'v11-layout')
const SIZES = (process.env.V11_SIZES ?? '1440x900,1138x608').split(',')

test.skip(!process.env.V11_PERF, 'v11 layout performance pass: set V11_PERF=1')
test.describe.configure({ timeout: 900_000 })

let t: TestApp | null = null
let mock: MockServer
const results: Record<string, unknown> = {}

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

for (const size of SIZES) {
  test(`backdrop perf ${size}`, async () => {
    t = await launchApp({ mock, size })
    await configureMockLlm(t.api, mock.url)
    const seeded = (await t.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 1, messagesPerSession: 60 })).json.sessionUids[0]
    await t.waitHook('presence.surface')
    const cdp = await t.page.context().newCDPSession(t.page)
    await cdp.send('Performance.enable')
    const task = async (): Promise<number> => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
    const gpu = async (): Promise<number> =>
      t!.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'GPU').reduce((n, m) => n + m.cpu.percentCPUUsage, 0))
    const span = async (ms: number): Promise<{ cpuPct: number; gpuPct: number; frames: number; fps: number; budget: string }> => {
      await gpu()
      await t!.hook('presence.resetFrames')
      const t0 = await task()
      await t!.page.waitForTimeout(ms)
      const cpu = (await task()) - t0
      const g = await gpu()
      const f = await t!.hook<FrameStats>('presence.frames')
      return { cpuPct: Math.round((cpu / ms) * 1000) / 10, gpuPct: Math.round(g * 10) / 10, frames: f.frames, fps: Math.round((f.frames / ms) * 10000) / 10, budget: `${f.budget.reason}@${f.budget.fps}` }
    }
    const canvas = async (): Promise<unknown> =>
      t!.page.evaluate(() => {
        const c = document.querySelector('.presence-host canvas') as HTMLCanvasElement | null
        const host = document.querySelector('.presence-host')?.getBoundingClientRect()
        return { buffer: c ? `${c.width}x${c.height}` : null, css: host ? `${Math.round(host.width)}x${Math.round(host.height)}` : null, dpr: window.devicePixelRatio }
      })
    const speak = (): Promise<unknown> =>
      t!.hook('presence.speak', 'A long, slow sentence for the star to sing along with while we watch how much of the processor and the graphics chip it needs to do so, in the middle of the chat behind the words.')

    const row: Record<string, unknown> = {}
    await t.hook('presence.setFocus', true)
    for (const where of ['chat', 'lab', 'talk'] as const) {
      await t.hook('go', where === 'chat' ? `/s/${seeded}` : where === 'lab' ? '/presence-lab' : `/talk/${seeded}`)
      await t.waitReady()
      await t.page.waitForTimeout(1200)
      const r: Record<string, unknown> = { canvas: await canvas(), kind: (await t.hook<{ kind: string }>('presence.surface')).kind }
      await speak()
      await t.page.waitForTimeout(500)
      r.speaking = await span(3000)
      await t.hook('audio.stop')
      if (where === 'chat') {
        await t.page.waitForTimeout(800)
        r.idle = await span(2000)
        // Rest: idle ≤ 20 fps for 20 s, then 0.
        await expect.poll(async () => (await t!.hook<FrameStats>('presence.frames')).running, { timeout: 30_000, intervals: [1000] }).toBe(false)
        r.rest = await span(3000)
        // Reading at rest: the scroll fades the avatar by CSS opacity only — it must not wake the renderer.
        const box = await t.page.locator('.mw__list').boundingBox()
        await t.hook('presence.resetFrames')
        if (box) {
          await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          for (let i = 0; i < 6; i++) {
            await t.page.mouse.wheel(0, -240)
            await t.page.waitForTimeout(120)
          }
        }
        await t.page.waitForTimeout(400)
        r.readingScrollFrames = (await t.hook<FrameStats>('presence.frames')).frames
        await t.hook('presence.setFocus', false)
        await t.page.waitForTimeout(600)
        r.unfocusedIdle = await span(2000)
        await t.hook('presence.setFocus', true)
      }
      row[where] = r
    }
    // Diagnostics: what the speaking chat costs without the backdrop (Star hidden in chat; style Off) and with the
    // backdrop at medium quality (no bloom pass).
    await t.hook('go', `/s/${seeded}`)
    await t.waitReady()
    for (const [name, prefs] of [
      ['chatMedium', { quality: 'medium' }],
      ['chatHidden', { quality: undefined, showInChat: false }],
      ['chatStyleOff', { showInChat: undefined, style: 'off' }]
    ] as const) {
      await t.hook('presence.setPrefs', prefs)
      await t.page.waitForTimeout(900)
      await speak()
      await t.page.waitForTimeout(500)
      row[name] = { kind: (await t.hook<{ kind: string }>('presence.surface')).kind, canvas: await canvas(), speaking: await span(3000) }
      await t.hook('audio.stop')
    }
    await t.hook('presence.setPrefs', { style: undefined })
    results[size] = row
    fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(results, null, 1))
    console.log(size, JSON.stringify(row))
    await t.hook('go', '/settings')
  })
}
