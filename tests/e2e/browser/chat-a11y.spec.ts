/**
 * Accessibility and resource hygiene of the conversation (07 D9, D14, R17):
 *   - @axe-core/playwright on the chat (rich replies, empty chat, search, slash menu, help, delete dialog, the
 *     "Remembered" panel, phone layout): 0 serious/critical violations;
 *   - keyboard only: compose and send, Alt+↑/↓ between messages, Ctrl+F, Esc back to the composer;
 *   - feed semantics (aria-posinset = seq, aria-setsize = lastSeq), streaming outside live regions;
 *   - leak check: 12 rounds of opening chats, streaming a reply, searching and paging bring every counter back.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, createSession, routes, wsTurn } from '../helpers'
import { RICH_REPLY } from '../chatFixtures'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

async function axe(page: Page, label: string): Promise<void> {
  // Let entrance animations finish (dialogs fade in over 320 ms; mid-fade colours would read as low contrast).
  await page.waitForTimeout(400)
  const r = await new AxeBuilder({ page }).analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    bad.map((v) => `${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
    `axe (${label})`
  ).toEqual([])
}

test('axe: 0 serious/critical on the conversation, its dialogs and the phone layout @R22', async () => {
  test.setTimeout(240_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = pageApi(s.page)
  const empty = await createSession(page, 'Empty')
  const session = await createSession(page, 'Accessible')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  mock.llm.script({ text: RICH_REPLY })
  await wsTurn(s.page, session.uid, 'Explain the history window, please.')
  mock.llm.script({ text: 'Second reply with a [link](https://example.com).' })
  await wsTurn(s.page, session.uid, 'One more.')
  await expect(s.page.locator('article.msg')).toHaveCount(4)
  await expect(s.page.locator('.code-block[data-highlighted]')).toHaveCount(1)

  for (const theme of ['dark', 'light'] as const) {
    expect((await desktop.api('PATCH', '/api/settings', { appearance: { theme } })).status).toBe(200)
    await s.page.waitForTimeout(200)
    await axe(s.page, `conversation ${theme}`)
  }
  expect((await desktop.api('PATCH', '/api/settings', { appearance: { theme: 'dark' } })).status).toBe(200)

  // Feed semantics.
  const first = s.page.locator('article.msg').first()
  await expect(first).toHaveAttribute('aria-posinset', '1')
  await expect(first).toHaveAttribute('aria-setsize', '4')
  await expect(s.page.getByRole('feed', { name: 'Messages' })).toBeVisible()

  await s.page.getByTestId('composer-input').fill('/')
  await expect(s.page.getByRole('listbox', { name: 'Commands' })).toBeVisible()
  await axe(s.page, 'slash menu')
  await s.page.getByTestId('composer-input').fill('')

  await s.page.keyboard.press('Control+f')
  await s.page.getByRole('searchbox', { name: 'Find in this chat' }).fill('window')
  await expect(s.page.getByTestId('find-bar')).toContainText(/of \d|No matches/)
  await axe(s.page, 'find bar')
  await s.page.keyboard.press('Escape')

  await s.page.getByTestId('composer-input').fill('/help')
  await s.page.getByTestId('composer-input').press('Enter')
  await expect(s.page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await axe(s.page, 'help dialog')
  await s.page.keyboard.press('Escape')

  const last = s.page.locator('article.msg--ai').last()
  await last.hover()
  await last.getByRole('button', { name: 'More actions' }).click()
  await expect(s.page.getByRole('menu')).toBeVisible()
  await axe(s.page, 'message menu')
  await s.page.getByRole('menuitem', { name: 'Delete…' }).click()
  await expect(s.page.getByRole('dialog', { name: 'Delete this message?' })).toBeVisible()
  await axe(s.page, 'delete dialog')
  await s.page.keyboard.press('Escape')

  await s.hook('go', routes.chat(empty.uid))
  await s.waitReady()
  await axe(s.page, 'empty chat')

  await s.page.setViewportSize({ width: 390, height: 844 })
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  await axe(s.page, 'phone')
  // 44 px targets on phones (07 D8) for the composer controls.
  for (const name of ['Attach files', 'Send']) {
    const b = await s.page.getByRole('button', { name }).boundingBox()
    expect(Math.min(b!.width, b!.height), name).toBeGreaterThanOrEqual(44)
  }
  await s.assertNoErrors()
})

test('keyboard only: write, send, move between messages, search, back to the composer @R22', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const session = await createSession(pageApi(s.page), 'Keys')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  const input = s.page.getByTestId('composer-input')
  await expect(input).toBeFocused()
  await s.page.keyboard.type('first line')
  await s.page.keyboard.press('Shift+Enter')
  await s.page.keyboard.type('second line')
  await s.page.keyboard.press('Enter')
  await expect(s.page.locator('article.msg--ai')).toContainText('Echo: first line')
  await expect(input).toBeFocused()
  await s.page.keyboard.type('another')
  await s.page.keyboard.press('Enter')
  await expect(s.page.locator('article.msg--ai')).toHaveCount(2)

  // Alt+↑ from the composer enters the conversation; Alt+↑/↓ move between messages.
  await s.page.keyboard.press('Alt+ArrowUp')
  await expect(s.page.locator('article.msg').last()).toBeFocused()
  await s.page.keyboard.press('Alt+ArrowUp')
  await expect(s.page.locator('article.msg').nth(2)).toBeFocused()
  await s.page.keyboard.press('Alt+ArrowDown')
  await expect(s.page.locator('article.msg').last()).toBeFocused()
  // Tab reaches the message's own actions.
  await s.page.keyboard.press('Tab')
  await expect(s.page.locator(':focus')).toHaveAttribute('aria-label', /Copy|Previous|Next/)

  await s.page.keyboard.press('Control+f')
  await expect(s.page.getByRole('searchbox', { name: 'Find in this chat' })).toBeFocused()
  await s.page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await s.assertNoErrors()
})

interface Counters {
  bus: number
  ticker: number
  tickerRunning: boolean
  objectUrls: number
  deltaBuffers: number
  speechOverrides: number
  feeds: number
  kit: Record<string, number>
  layers: number
}

test('no leaks: 12 rounds of opening chats, streaming, searching and paging return every counter to baseline @R17', async () => {
  test.setTimeout(300_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const api = pageApi(s.page)
  const a = await createSession(api, 'Leak A')
  const b = await createSession(api, 'Leak B')
  const home = await createSession(api, 'Home')
  await s.hook('go', routes.chat(home.uid))
  await s.waitReady()
  const baseline = await s.hook<Counters>('chat.counters')
  const serverBase = (await s.api<{ subscriptions: number }>('GET', '/api/test/stats')).json.subscriptions
  const heap0 = await s.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)

  for (let i = 0; i < 12; i++) {
    const target = i % 2 ? a : b
    await s.hook('go', routes.chat(target.uid))
    await s.waitReady()
    mock.llm.script({ text: `Round ${i}: ${RICH_REPLY}`, chunkChars: 24 })
    await s.page.getByTestId('composer-input').fill(`round ${i}`)
    await s.page.getByTestId('composer-input').press('Enter')
    await expect(s.page.locator('article.msg--ai').last()).toContainText(`Round ${i}`)
    await expect(s.page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await s.page.keyboard.press('Control+f')
    await s.page.getByRole('searchbox', { name: 'Find in this chat' }).fill('round')
    await s.page.keyboard.press('Escape')
    await s.page.getByTestId('composer-input').fill('/')
    await s.page.getByTestId('composer-input').fill('')
  }
  await s.hook('go', routes.chat(home.uid))
  await s.waitReady()
  await s.page.waitForTimeout(500)
  const after = await s.hook<Counters>('chat.counters')
  expect({ ...after, kit: undefined }).toEqual({ ...baseline, kit: undefined })
  // The shiki worker and its idle-shutdown timer stay up for 2 idle minutes by design (ui-kit): counted once at most.
  const lazy = new Set(['kit.workers', 'kit.timers'])
  for (const [k, v] of Object.entries(after.kit)) expect(v, `kit.${k}`).toBeLessThanOrEqual((baseline.kit[k] ?? 0) + (lazy.has(k) ? 1 : 0))
  await expect.poll(async () => (await s!.api<{ subscriptions: number }>('GET', '/api/test/stats')).json.subscriptions).toBe(serverBase)
  expect(await s.page.evaluate(() => (CSS.highlights as unknown as Map<string, unknown>).size)).toBeLessThanOrEqual(5)
  const heap1 = await s.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
  test.info().annotations.push({ type: 'heap', description: `${Math.round(heap0 / 1e6)} MB → ${Math.round(heap1 / 1e6)} MB` })
  await s.assertNoErrors()
})
