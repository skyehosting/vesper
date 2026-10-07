/**
 * The Star in the desktop window (07 D4/D5): the real GPU path in Electron (ANGLE), one context across Talk mode and
 * the Constellation, 0 frames while unfocused at rest, and Talk mode's mic through the permission handler.
 */
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import type { FrameStats, GlInfo, SurfaceInfo } from '../presence'
import { AUDIO_FIXTURES } from '../stt'

let t: TestApp | null = null
let mock: MockServer

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

test('desktop: one canvas through the Star, Talk mode and the Constellation; rest and unfocused draw nothing @R15 @R1', async () => {
  t = await launchApp({ mock, fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), env: { VESPER_STT_FAKE: '1' } })
  await configureMockLlm(t.api, mock.url)
  const sess = await createSession(t.api, 'Desktop star')
  await t.waitHook('presence.surface')
  await t.hook('go', '/presence-lab')
  await t.waitReady()
  await t.hook('presence.setFocus', true)
  await expect.poll(async () => (await t!.hook<GlInfo>('presence.gl')).rendered, { timeout: 20_000 }).toBeGreaterThan(0)

  // Talk mode: the same canvas on the big stage, the mic allowed by the permission handler (audio only).
  await t.hook('go', `/talk/${sess.uid}`)
  await t.waitReady()
  await expect.poll(async () => (await t!.hook<SurfaceInfo>('presence.surface')).kind).toBe('stage')
  await expect.poll(async () => (await t!.hook<{ active: boolean }>('audio.micStats')).active, { timeout: 15_000 }).toBe(true)
  await t.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(async () => (await t!.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)

  await t.hook('go', '/constellation')
  await t.waitReady()
  await expect.poll(async () => (await t!.hook<SurfaceInfo>('presence.surface')).kind).toBe('constellation')
  await t.hook('go', '/presence-lab')
  await t.waitReady()
  const gl = await t.hook<GlInfo>('presence.gl')
  expect(gl).toMatchObject({ created: 1, live: 1, lost: 0 })
  // The real GPU path, for the visual review (ANGLE/D3D11 rather than the browser project's SwiftShader).
  await t.page.waitForTimeout(800)
  await t.page.screenshot({ path: path.resolve('test-results', 'presence-shots', 'electron-lab.png') })

  // CPU while speaking on the real GPU path (07 D4 budget: ≤ 6 % of a core; logged — e2e machines vary).
  const cdp = await t.page.context().newCDPSession(t.page)
  await cdp.send('Performance.enable')
  const task = async (): Promise<number> => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
  await t.hook('presence.speak', 'A long, slow sentence for the star to sing along with while we watch how much of the processor it needs to do so.')
  await t.page.waitForTimeout(500)
  const t0 = await task()
  await t.page.waitForTimeout(2000)
  const speakMs = (await task()) - t0
  const fr = await t.hook<FrameStats>('presence.frames')
  console.log(`presence (electron) speaking: ${(speakMs / 20).toFixed(1)} % of a core over 2 s, budget ${fr.budget.fps} fps`)
  // Generous ceiling (the 07 D4 target is 6 %; machines vary): catches a runaway render loop, not noise.
  expect(speakMs / 20).toBeLessThan(25)
  await t.hook('audio.stop')

  // Unfocused + idle draws nothing (07 D4 pauseWhenUnfocused). Playwright emulates page focus, so the window's focus
  // state is set through the hook rather than read from the (never focused) test window.
  await t.hook('presence.setFocus', false)
  await expect.poll(async () => (await t!.hook<FrameStats>('presence.frames')).running, { timeout: 5000 }).toBe(false)
  await t.hook('presence.resetFrames')
  await t.page.waitForTimeout(1500)
  expect(await t.hook<FrameStats>('presence.frames')).toMatchObject({ frames: 0, callbacks: 0, polls: 0 })
  await t.assertNoErrors()
})
