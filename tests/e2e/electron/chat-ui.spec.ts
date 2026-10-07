/**
 * The conversation in the desktop window (chat-ui, Phase 3): the composer sends, a rich reply renders under the
 * production CSP (shiki in its worker, KaTeX and its fonts lazily), a pasted image is downscaled and uploaded, and the
 * history window pages a seeded session — all with zero console errors. (External links are not clicked here: in the
 * desktop app they open the system browser.)
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, type TestApp } from '../launch'
import { configureMockLlm, createSession, routes } from '../helpers'
import { RICH_REPLY } from '../chatFixtures'

let mock: MockServer
let t: TestApp | null = null

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

test('desktop: compose, rich reply (code worker + KaTeX under the CSP), paste an image, page history @R1 @R5 @R18', async () => {
  test.setTimeout(180_000)
  t = await launchApp({ mock })
  await t.waitHook('ws.connected')
  await configureMockLlm(t.api, mock.url)
  const session = await createSession(t.api, 'Desktop chat')
  await t.hook('go', routes.chat(session.uid))
  await t.waitReady()

  mock.llm.script({ text: `${RICH_REPLY}\n\nAnd a formula: $$e^{i\\pi} + 1 = 0$$` })
  const input = t.page.getByTestId('composer-input')
  await input.fill('Show me everything you can render.')
  await input.press('Enter')
  const reply = t.page.locator('article.msg--ai')
  await expect(reply.locator('.code-block[data-highlighted]')).toHaveCount(1, { timeout: 20_000 })
  await expect(reply.locator('.md-math .katex')).toBeVisible()
  await expect(reply.locator('.md-table table')).toBeVisible()

  await input.evaluate(async (el) => {
    const c = document.createElement('canvas')
    c.width = 2000
    c.height = 1000
    const g = c.getContext('2d')!
    g.fillStyle = '#7dd3fc'
    g.fillRect(0, 0, 2000, 1000)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'sky.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(t.page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })
  await input.fill('A clear sky.')
  await input.press('Enter')
  await expect(t.page.locator('article.msg--user .msg-att--image img').last()).toBeVisible()

  // A longer session pages older rows in.
  const seeded = await t.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 1, messagesPerSession: 450 })
  await t.hook('go', routes.chat(seeded.json.sessionUids[0]))
  await t.waitReady()
  await t.hook('chat.scrollToTop')
  await expect.poll(async () => (await t!.hook<{ loSeq: number }>('chat.window')).loSeq, { timeout: 15_000 }).toBeLessThan(351)
  await t.assertNoErrors()
})
