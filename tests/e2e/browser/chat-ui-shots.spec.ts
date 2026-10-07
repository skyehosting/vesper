/**
 * chat-ui screenshots (Phase 3 quality pass): every conversation state at 1440×900, 1138×608 (the owner's primary
 * monitor in DIP) and 390×844, dark and light. Files land in the test output dir (PW_OUT); the spec also asserts
 * that the pages render without console errors and without horizontal overflow.
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type Api, type TestServer } from '../launch'
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

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1138', width: 1138, height: 608 },
  { name: 'phone', width: 390, height: 844 }
] as const

async function setTheme(api: Api, theme: 'dark' | 'light'): Promise<void> {
  const r = await api('PATCH', '/api/settings', { appearance: { theme } })
  expect(r.status, r.text).toBe(200)
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() => {
    const out: string[] = []
    // Content inside its own horizontal scroller (code, tables, wide formulas, the attachment tray) is fine.
    const scrolls = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true
      }
      return false
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.chat *'))) {
      if (scrolls(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName}.${el.className}`)
    }
    return out.slice(0, 5)
  })
  expect(over, 'elements overflowing the viewport').toEqual([])
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

test('conversation screenshots: rich replies, empty chat, composer states @R5 @R18 @R22', async () => {
  test.setTimeout(240_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = pageApi(s.page)

  const empty = await createSession(page, 'A fresh start')
  const session = await createSession(page, 'History window, explained')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()

  mock.llm.script({ text: RICH_REPLY })
  await wsTurn(s.page, session.uid, 'Can you explain how the history window works? I want to understand why it never slows down.')
  mock.llm.script({ text: 'The scrubber position is $$f = \\frac{seq - 1}{lastSeq - 1}$$ so dragging to 10 % lands near message 100,000 of a million.' })
  await wsTurn(s.page, session.uid, 'And how does the scrubber map to messages?')
  await expect(s.page.locator('article.msg')).toHaveCount(4)
  await expect(s.page.locator('.code-block[data-highlighted]')).toHaveCount(1)

  for (const theme of ['dark', 'light'] as const) {
    await setTheme(desktop.api, theme)
    for (const v of VIEWPORTS) {
      await s.page.setViewportSize({ width: v.width, height: v.height })
      await s.hook('go', routes.chat(session.uid))
      await s.waitReady()
      await expect(s.page.locator('.md-math .katex').first()).toBeVisible()
      await noHorizontalOverflow(s.page)
      await shoot(s.page, `chat-${theme}-${v.name}`)
      // Hover the newest reply's actions, then the composer with a slash menu open.
      await s.page.getByTestId('composer-input').fill('/')
      await shoot(s.page, `chat-${theme}-${v.name}-slash`)
      await s.page.getByTestId('composer-input').fill('')
      await s.hook('go', routes.chat(empty.uid))
      await s.waitReady()
      await shoot(s.page, `empty-${theme}-${v.name}`)
    }
  }
  await s.assertNoErrors()
})

async function pasteFiles(page: Page): Promise<void> {
  await page.getByTestId('composer-input').evaluate(async (el) => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 1200, 800)
    grad.addColorStop(0, '#f5b84c')
    grad.addColorStop(1, '#3b2a6b')
    g.fillStyle = grad
    g.fillRect(0, 0, 1200, 800)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'sunset.png', { type: 'image/png' }))
    dt.items.add(new File(['# Notes\n\nPacking list'], 'packing-list.md', { type: 'text/markdown' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

test('conversation states: streaming, search, remembered, attachments, errors, editing, big history @R5 @R14 @R18 @R22', async () => {
  test.setTimeout(300_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = pageApi(s.page)
  const session = await createSession(page, 'Planning the lighthouse trip')

  const runs = [
    { v: VIEWPORTS[0], theme: 'dark' as const },
    { v: VIEWPORTS[2], theme: 'dark' as const },
    { v: VIEWPORTS[1], theme: 'light' as const },
    { v: VIEWPORTS[2], theme: 'light' as const }
  ]
  for (const { v: v0, theme } of runs) {
    await setTheme(desktop.api, theme)
    const v = { ...v0, name: `${theme}-${v0.name}` }
    await s.page.setViewportSize({ width: v.width, height: v.height })
    await s.hook('go', routes.chat(session.uid))
    await s.waitReady()
    // Streaming, mid-reply.
    mock.llm.script({ text: RICH_REPLY, chunkChars: 3, delayMs: 30 })
    await s.page.getByTestId('composer-input').fill('Walk me through it again, slowly.')
    await s.page.getByTestId('composer-input').press('Enter')
    await expect(s.page.locator('article.msg--ai').last().locator('.md p').first()).toBeVisible()
    await s.page.waitForTimeout(700)
    await shoot(s.page, `state-streaming-${v.name}`)
    await expect(s.page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 30_000 })

    // Attachments waiting in the composer.
    await pasteFiles(s.page)
    await expect(s.page.locator('.att-chip')).toHaveCount(2)
    await expect(s.page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })
    await s.page.getByTestId('composer-input').fill('Here is the sunset from last night and my list.')
    await shoot(s.page, `state-attachments-${v.name}`)
    mock.llm.script({ text: 'What a sky! Your list looks complete — maybe add a **rain jacket**.' })
    await s.page.getByTestId('composer-input').press('Enter')
    await expect(s.page.locator('article.msg--ai').last()).toContainText('rain jacket')
    await shoot(s.page, `state-sent-attachments-${v.name}`)

    // Find in chat.
    await s.page.keyboard.press('Control+f')
    await s.page.getByRole('searchbox', { name: 'Find in this chat' }).fill('window')
    await s.page.keyboard.press('Enter')
    await expect(s.page.getByTestId('find-bar')).toContainText(/of/)
    await shoot(s.page, `state-find-${v.name}`)
    await s.page.keyboard.press('Escape')

    // Error with its action.
    mock.llm.script({ error: { status: 401, message: 'bad key' } })
    await s.page.getByTestId('composer-input').fill('Are you there?')
    await s.page.getByTestId('composer-input').press('Enter')
    await expect(s.page.locator('[data-error-code="provider_auth"]').last()).toBeVisible()
    await shoot(s.page, `state-error-${v.name}`)

    // Editing the last message.
    await s.page.getByTestId('composer-input').click()
    await s.page.keyboard.press('ArrowUp')
    await expect(s.page.getByRole('textbox', { name: 'Edit message' })).toBeVisible()
    await shoot(s.page, `state-edit-${v.name}`)
    await s.page.keyboard.press('Escape')
  }

  // Remembered chip, expanded (memory on, a linked conversation, a native tool call).
  await setTheme(desktop.api, 'dark')
  await s.page.setViewportSize({ width: 1440, height: 900 })
  const claude = { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: `${mock.url}/anthropic`, model: 'claude-opus-5-5' }
  await desktop.api('PATCH', '/api/settings', { llm: { profiles: [claude], defaultProfile: 'claude' }, memory: { enabled: true, autoRecall: false, voyage: { tier: 'tier1' } } })
  await desktop.api('PUT', '/api/secrets/llm:claude', { value: 'sk-ant-e2e-0123456789' })
  await desktop.api('PUT', '/api/secrets/voyage', { value: 'pa-e2e-key' })
  const trip = await createSession(page, 'Trip planning')
  await wsTurn(s.page, trip.uid, 'We should plan a trip to Lisbon in the spring')
  await wsTurn(s.page, trip.uid, 'Book a hotel near the castle in Lisbon')
  const short = (await page<{ shortId: string }>('GET', `/api/sessions/${trip.uid}`)).json.shortId
  const mem = await createSession(page, 'Where were we?')
  await page('PUT', `/api/sessions/${mem.uid}/links/${short}`, {})
  await expect.poll(async () => (await page<{ indexed: number }>('GET', '/api/memory/status')).json.indexed, { timeout: 20_000 }).toBeGreaterThanOrEqual(4)
  await s.hook('go', routes.chat(mem.uid))
  await s.waitReady()
  mock.llm.script({ text: 'Let me check.', toolCalls: [{ name: 'memory_search', input: { query: 'Lisbon trip hotel' } }] }, { text: 'You were planning **Lisbon in the spring**, with a hotel near the castle.' })
  await s.page.getByTestId('composer-input').fill('Remind me what trip I was planning?')
  await s.page.getByTestId('composer-input').press('Enter')
  await s.page.getByRole('button', { name: /Remembered/ }).click()
  await expect(s.page.getByRole('region', { name: /remembered/ })).toContainText('Lisbon')
  await shoot(s.page, 'state-remembered-1440')

  // A long history: the scrubber, its bubble and "Jump to latest".
  const big = (await s.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 0, bigSession: 20_000 })).json.sessionUids[0]
  for (const v of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[2]]) {
    await s.page.setViewportSize({ width: v.width, height: v.height })
    await s.hook('go', routes.chat(big))
    await s.waitReady()
    await s.hook('chat.jumpToSeq', 6_000)
    await expect(s.page.getByTestId('jump-latest')).toBeVisible()
    const box = (await s.page.locator('.scrubber__track').boundingBox())!
    await s.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.42)
    await expect(s.page.locator('.scrubber__bubble')).toBeVisible()
    await shoot(s.page, `state-history-${v.name}`)
    await s.page.mouse.move(10, 10)
  }
  await s.assertNoErrors()
})
