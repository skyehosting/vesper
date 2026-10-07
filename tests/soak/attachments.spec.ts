/**
 * Soak 6 (LEAK-1 row 6): 500 attachment paste/remove cycles in the composer (an image, so a preview blob URL and a
 * client-side downscale each time). Gates: blob URLs outstanding 0 (createObjectURL/revokeObjectURL wrapper) and the
 * composer's own counter 0; renderer heap +≤ 15 MB and DOM nodes back to the post-warm-up value; no canvas WebGL.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { cycles, finish, installPageCounters, pageCounters, Recorder, renderer, settle, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

test('500 attachment paste/remove cycles leave no blob URL behind @R18 @R17', async () => {
  const total = cycles(500, 20)
  test.setTimeout(10 * 60_000 + total * 3_000)
  const rec = new Recorder('attachments')
  rec.cycles('paste/remove', total)
  s = await launchServer({ mock, open: false, login: 'desktop', timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  await configureMockLlm(s.api, mock.url)
  await steady(s.api)
  const sess = await createSession(s.api, 'Soak: attachments')
  await s.hook('go', `/s/${sess.uid}`)
  await settle(s)
  const input = s.page.getByTestId('composer-input')
  const chips = s.page.locator('.att-chip')

  const cycle = async (i: number): Promise<void> => {
    await input.evaluate(async (el, n) => {
      const c = document.createElement('canvas')
      c.width = 900
      c.height = 600
      const g = c.getContext('2d')!
      g.fillStyle = `hsl(${(n * 37) % 360} 60% 50%)`
      g.fillRect(0, 0, 900, 600)
      g.fillStyle = '#fff'
      g.font = '64px sans-serif'
      g.fillText(`paste ${n}`, 40, 120)
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], `paste-${n}.png`, { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, i)
    await expect(chips).toHaveCount(1)
    await expect(chips.first().locator('img')).toBeVisible()
    await expect(chips.first()).not.toContainText(/Uploading|Preparing/, { timeout: 15_000 })
    await chips.first().getByRole('button', { name: /^Remove / }).click()
    await expect(chips).toHaveCount(0)
  }

  const warm = Math.max(5, Math.round(total / 20))
  for (let i = 0; i < warm; i++) await cycle(i)
  await s.page.waitForTimeout(500)
  const base = await renderer(s.page)
  const heap: number[] = [base.heapMB]
  const every = Math.max(1, Math.round((total - warm) / 10))
  for (let i = warm; i < total; i++) {
    await cycle(i)
    if ((i - warm + 1) % every === 0) heap.push((await renderer(s.page)).heapMB)
  }
  await s.page.waitForTimeout(800)
  const end = await renderer(s.page)
  const pc = await pageCounters(s.page)
  const own = await s.hook<{ objectUrls: number }>('chat.counters')
  rec.check('blob URLs outstanding (wrapper)', pc.blobs, 0)
  rec.check("composer's object URL counter", own.objectUrls, 0)
  rec.atLeast('blob URLs created (the previews ran)', pc.blobsMade, total)
  rec.check('DOM nodes over warm-up', end.nodes - base.nodes, 50)
  rec.check('WebGL contexts from attachments', pc.glContexts, 1)
  rec.gate({ name: 'renderer heap after GC', unit: 'MB', values: heap, threshold: 15 })
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
