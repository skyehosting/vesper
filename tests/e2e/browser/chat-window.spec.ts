/**
 * The history window gate (R5, 07 D1, research 03 §4.4): a seeded 1,000,000-message session; the scrubber to 10 %,
 * five pages up and five pages down with ≤ 3N message rows in memory and in the DOM, anchor drift ≤ 2 px on every
 * prepend/append, and no long task over 50 ms while a page is merged. Also: view state restored per device, "Jump to
 * latest" with the unread count, Ctrl+F in-session search.
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { rawRequest } from '../http'
import { launchServer, pageApi, sameOriginHeaders, type TestServer } from '../launch'
import { configureMockLlm, createSession, routes, wsTurn } from '../helpers'

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

interface WindowInfo {
  rows: number
  loSeq: number
  hiSeq: number
  lastSeq: number
  hasBefore: boolean
  hasAfter: boolean
  domMessages: number
  atBottom: boolean
  anchor: { seq: number; offset: number; pinned: boolean } | null
  loading: { up: boolean; down: boolean; replace: boolean }
}

const info = (s: TestServer): Promise<WindowInfo> => s.hook<WindowInfo>('chat.window')

/** POST /api/test/seed with a long timeout (a million rows take a while to insert). */
async function seed(s: TestServer, body: Record<string, number>): Promise<string[]> {
  const headers = { ...sameOriginHeaders(s.url, await s.cookieHeader()), 'content-type': 'application/json' }
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/test/seed', headers, body: JSON.stringify(body), timeoutMs: 240_000 })
  expect(r.status, r.text).toBe(200)
  return (r.json as { sessionUids: string[] }).sessionUids
}

/** Start observing long tasks in the page (idempotent). */
async function watchLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __long?: number[]; __longObs?: PerformanceObserver }
    if (w.__longObs) return
    w.__long = []
    w.__longObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long!.push(e.duration)
    })
    w.__longObs.observe({ type: 'longtask', buffered: false })
  })
}
const takeLongTasks = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __long?: number[] }
    const out = w.__long ?? []
    w.__long = []
    return out
  })

/**
 * Scroll the list to one end so the next page loads, and measure how far the row that was at the top of the
 * viewport moves when that page is merged (anchor drift). Returns the drift in px.
 */
async function pageOnce(page: Page, dir: 'up' | 'down'): Promise<{ drift: number; trail: string[]; before: { lo: number; hi: number }; after: { lo: number; hi: number } }> {
  return page.evaluate(
    async ({ dir: d }) => {
      const t = window.__vesperTest as unknown as { chat: { window(): { loSeq: number; hiSeq: number; loading: { up: boolean; down: boolean } } } }
      const list = document.querySelector<HTMLElement>('[data-testid="message-window"]')!
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
      const before = t.chat.window()
      list.scrollTop = d === 'up' ? 0 : list.scrollHeight
      await frame()
      await frame()
      const box = list.getBoundingClientRect()
      const anchorEl = Array.from(list.querySelectorAll<HTMLElement>('article.msg')).find((a) => a.getBoundingClientRect().bottom > box.top + 1)!
      const top0 = anchorEl.getBoundingClientRect().top
      const deadline = performance.now() + 15_000
      for (;;) {
        await frame()
        const w = t.chat.window()
        if ((d === 'up' && w.loSeq !== before.loSeq) || (d === 'down' && w.hiSeq !== before.hiSeq)) break
        if (performance.now() > deadline) throw new Error(`no ${d} page arrived (${JSON.stringify(w)})`)
      }
      // Let the merged rows lay out and measure (and any trim at the far end land).
      const trail: string[] = []
      for (let i = 0; i < 4; i++) {
        await frame()
        const x = t.chat.window() as unknown as { loSeq: number; hiSeq: number; rows: number; rendered: [number, number] | null }
        trail.push(`${x.loSeq}-${x.hiSeq}/${x.rows}@${JSON.stringify(x.rendered)}:${list.scrollTop}/${list.scrollHeight}`)
      }
      // The row on screen must be the same element (never remounted) and stay put.
      const drift = anchorEl.isConnected ? Math.abs(anchorEl.getBoundingClientRect().top - top0) : 9999
      const after = t.chat.window()
      return { drift, trail, before: { lo: before.loSeq, hi: before.hiSeq }, after: { lo: after.loSeq, hi: after.hiSeq } }
    },
    { dir }
  )
}

test('1M-message session: scrubber to 10 %, five pages up and down, ≤ 3N rows, drift ≤ 2 px, no long tasks @R5', async () => {
  test.setTimeout(300_000)
  s = await launchServer({ mock, timeoutMs: 60_000 })
  const t0 = Date.now()
  const [uid] = await seed(s, { sessions: 0, bigSession: 1_000_000 })
  test.info().annotations.push({ type: 'seed', description: `1M rows in ${Date.now() - t0} ms` })
  await s.hook('go', routes.chat(uid))
  await s.waitReady()
  await expect(s.page.getByTestId('message-window')).toBeVisible()
  const N = await s.hook<number>('chat.pageSize')
  expect(N).toBe(100)

  let w = await info(s)
  expect(w.lastSeq).toBe(1_000_000)
  expect(w.hiSeq).toBe(1_000_000)
  expect(w.atBottom).toBe(true)
  await expect(s.page.getByText('#1000000 ', { exact: false }).first()).toBeVisible()

  // Scrubber to 10 %: drag the thumb and release.
  const track = s.page.locator('.scrubber__track')
  const box = (await track.boundingBox())!
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height - 4)
  await s.page.mouse.down()
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5, { steps: 4 })
  await expect(s.page.locator('.scrubber__bubble')).toBeVisible()
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.1, { steps: 4 })
  await s.page.mouse.up()
  await expect.poll(async () => (await info(s!)).anchor?.seq ?? Infinity, { timeout: 15_000 }).toBeLessThan(110_000)
  w = await info(s)
  expect(w.anchor!.seq).toBeGreaterThan(90_000)
  expect(w.hasBefore && w.hasAfter).toBe(true)
  await expect(s.page.getByTestId('jump-latest')).toBeVisible()
  await expect(s.page.getByRole('slider', { name: 'Position in this conversation' })).toHaveAttribute('aria-valuetext', /message [\d,]+ of 1,000,000/)

  await watchLongTasks(s.page)
  const drifts: number[] = []
  for (const dir of ['up', 'up', 'up', 'up', 'up', 'down', 'down', 'down', 'down', 'down'] as const) {
    const r = await pageOnce(s.page, dir)
    drifts.push(r.drift)
    if (dir === 'up') expect(r.after.lo).toBe(r.before.lo - N)
    else expect(r.after.hi).toBe(r.before.hi + N)
    w = await info(s)
    expect(w.rows).toBeLessThanOrEqual(3 * N)
    expect(w.domMessages).toBeLessThanOrEqual(3 * N)
    expect(w.hiSeq - w.loSeq + 1).toBe(w.rows)
  }
  expect(Math.max(...drifts), `anchor drift per page: ${drifts.join(', ')}`).toBeLessThanOrEqual(2)
  const long = await takeLongTasks(s.page)
  expect(Math.max(0, ...long), `long tasks: ${long.join(', ')}`).toBeLessThanOrEqual(50)

  // A jump anywhere (search hit, citation) lands within 200 ms (07 D7) — request, merge and positioned row on screen.
  const jumpMs = await s.page.evaluate(async () => {
    const t = window.__vesperTest as unknown as { chat: { jumpToSeq(seq: number): Promise<void>; window(): { anchor: { seq: number } | null } } }
    const t0 = performance.now()
    await t.chat.jumpToSeq(500_000)
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r))
      const a = t.chat.window().anchor
      const row = document.querySelector('[data-testid="message-window"] article[data-seq="500000"]')
      if (row && a && Math.abs(a.seq - 500_000) < 20) return performance.now() - t0
      if (performance.now() - t0 > 5_000) return 99_999
    }
  })
  test.info().annotations.push({ type: 'jump', description: `${Math.round(jumpMs)} ms` })
  expect(jumpMs).toBeLessThanOrEqual(200)

  // Jump to latest brings the live edge back.
  await s.page.getByTestId('jump-latest').click()
  await expect.poll(async () => (await info(s!)).hiSeq).toBe(1_000_000)
  await expect.poll(async () => (await info(s!)).atBottom).toBe(true)
  await expect(s.page.getByTestId('jump-latest')).toHaveCount(0)
  await s.assertNoErrors()
})

test('view state is restored per device; new messages while reading show "Jump to latest" with a count @R5', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const [uid] = await seed(s, { sessions: 1, messagesPerSession: 600 })
  const other = await createSession(pageApi(s.page), 'Elsewhere')
  await s.hook('go', routes.chat(uid))
  await s.waitReady()
  await s.hook('chat.jumpToSeq', 450)
  await expect.poll(async () => (await info(s!)).anchor?.seq ?? 0).toBeGreaterThan(400)
  await s.page.waitForTimeout(400) // scroll idle → saved
  const saved = (await info(s)).anchor!
  expect(saved.pinned).toBe(false)

  await s.hook('go', routes.chat(other.uid))
  await s.waitReady()
  await s.hook('go', routes.chat(uid))
  await s.waitReady()
  await expect.poll(async () => (await info(s!)).anchor?.seq).toBe(saved.seq)
  expect(Math.abs((await info(s)).anchor!.offset - saved.offset)).toBeLessThanOrEqual(2)

  // A message arrives while reading history: not appended, the pill counts it.
  await wsTurn(s.page, uid, 'ping from another device')
  await expect(s.page.getByTestId('jump-latest')).toContainText('2 new')
  await s.page.getByTestId('jump-latest').click()
  // In the conversation itself (the reply is also announced in the page's sr-only live region, 07 D9).
  await expect(s.page.getByRole('feed').getByText('Echo: ping from another device')).toBeVisible()
  await expect.poll(async () => (await info(s!)).atBottom).toBe(true)
  await s.assertNoErrors()
})

test('Ctrl+F searches the whole session and jumps to hits outside the window @R5', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const [uid] = await seed(s, { sessions: 1, messagesPerSession: 900 })
  await s.hook('go', routes.chat(uid))
  await s.waitReady()
  await s.page.keyboard.press('Control+f')
  const find = s.page.getByRole('searchbox', { name: 'Find in this chat' })
  await expect(find).toBeFocused()
  await find.fill('#12 ')
  await find.press('Enter')
  await expect(s.page.getByTestId('find-bar')).toContainText(/1 of \d+/)
  await expect.poll(async () => (await info(s!)).loSeq).toBeLessThan(200)
  await expect(s.page.locator('article.msg.is-flash')).toHaveCount(1)
  const highlighted = await s.page.evaluate(() => (CSS.highlights as unknown as Map<string, { size: number }>).get('vesper-find-current')?.size ?? 0)
  expect(highlighted).toBeGreaterThan(0)
  await find.press('Escape')
  await expect(s.page.getByTestId('find-bar')).toHaveCount(0)
  await s.assertNoErrors()
})
