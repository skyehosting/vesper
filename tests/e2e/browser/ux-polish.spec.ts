/**
 * Phase 4c UX polish regressions (fix-ux, docs/review/phase4b-findings.md): sidebar rows survive a visit to Settings
 * (F46), the first-run empty chat fits / scrolls at the owner's 1138x608 (F47), light-theme badges pass axe (F48), the
 * memory viewer and prompt library are one click away (F52), remembered replies read as plain text in the timeline
 * (F53), first-run copy (F56) and the in-flow, one-line "Connection lost" strip (F57). F50 (approval focus) is pinned
 * in access-ui.spec.ts; F55 (one read-only notice) in settings-wizard.spec.ts.
 * @R6 @R7 @R11 @R21 @R22
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, wsTurn } from '../helpers'
import { launchServer, type TestServer } from '../launch'
import { expectAxeClean, go } from '../memoryUi'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await mock?.close()
})
test.afterEach(async () => {
  await s?.close()
  s = null
})

async function desktop(viewport = { width: 1440, height: 900 }): Promise<TestServer> {
  s = await launchServer({ mock, login: 'desktop', open: false, viewport })
  await configureMockLlm(s.api, mock.url)
  await s.page.goto(s.url)
  await s.waitReady()
  return s
}

async function setTheme(t: TestServer, theme: 'dark' | 'light'): Promise<void> {
  expect((await t.api('PATCH', '/api/settings', { appearance: { theme } })).status).toBe(200)
  await t.page.waitForFunction((x) => document.documentElement.dataset.theme === x, theme)
}

const box = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox()
  expect(b, 'element has a box').not.toBeNull()
  return b!
}

/** Every sidebar chat row: the link fills the 34 px row (not a 6 px sliver), padding 1px 0, title at the row's left. */
async function expectRowsIntact(page: Page, label: string): Promise<void> {
  const rows = page.locator('.shell__sidebar .srow')
  expect(await rows.count(), `${label}: rows`).toBeGreaterThan(0)
  const m = await rows.evaluateAll((els) =>
    els.map((r) => {
      const link = r.querySelector<HTMLElement>('.srow__link')!.getBoundingClientRect()
      const cs = getComputedStyle(r)
      return { h: link.height, x: link.x, pad: cs.paddingTop + ' ' + cs.paddingLeft, display: cs.display }
    })
  )
  for (const r of m) {
    expect(r.h, `${label}: row link height`).toBeGreaterThanOrEqual(28)
    expect(r.pad, `${label}: row padding`).toBe('1px 0px')
    expect(r.display, `${label}: row display`).toBe('block')
    expect(r.x, `${label}: row x`).toBeLessThan(16)
  }
}

test('F46: sidebar rows keep their size after Settings and the provider editor load (client-side navigation) @R6 @R22', async () => {
  const t = await desktop()
  const a = await createSession(t.api, 'Lisbon trip')
  await createSession(t.api, 'Balcony garden')
  await go(t, `/s/${a.uid}`)
  await expectRowsIntact(t.page, 'chat, before Settings')
  // In-app navigation, as the owner moves around: the lazily loaded settings stylesheet stays in the document.
  await t.page.getByRole('link', { name: 'Settings' }).click()
  await expect(t.page.getByRole('heading', { name: 'General', level: 2 }).or(t.page.locator('.spage').first())).toBeVisible()
  await expectRowsIntact(t.page, 'on Settings')
  await t.page.getByRole('link', { name: /AI providers/ }).click()
  await expect(t.page.locator('.spage').first()).toBeVisible()
  await t.page.locator('.shell__sidebar').getByRole('link', { name: /^Lisbon trip/ }).click()
  await expect(t.page).toHaveURL(new RegExp(`/s/${a.uid}$`))
  await expectRowsIntact(t.page, 'back on the chat')
  // The settings rows themselves still look like settings rows.
  await t.page.getByRole('link', { name: 'Settings' }).click()
  const setRow = t.page.locator('#settings-body .set-row').first()
  await expect(setRow).toBeVisible()
  expect(await setRow.evaluate((e) => getComputedStyle(e).paddingTop)).toBe('14px')
  await t.assertNoErrors()
})

test('F47: the first-run empty chat at 1138x608 starts below the top bar and scrolls to everything @R22', async () => {
  const t = await desktop({ width: 1138, height: 608 })
  // The Quick-start state the wizard leaves: every optional step skipped, so the setup checklist is long.
  const r = await t.api('PATCH', '/api/settings', { wizard: { completed: true, path: 'quick', skipped: ['you', 'memory', 'voice-out', 'voice-in', 'access', 'look'] } })
  expect(r.status, r.text).toBe(200)
  await t.page.reload()
  await t.waitReady()
  await expect.poll(() => t.hook<string>('route')).toMatch(/^\/s\//)
  const state = t.page.locator('.chat__state')
  const empty = state.locator('.empty-state')
  await expect(empty).toBeVisible()
  await expect(t.page.locator('.chat__checklist .checklist')).toBeVisible()
  const sb = await box(state)
  const eb = await box(empty)
  // Nothing sits above the scroll origin (where it could never be scrolled back into view).
  expect(eb.y, 'empty state top vs its scroller').toBeGreaterThanOrEqual(sb.y - 0.5)
  // v1.1: the avatar is the hero over the greeting (its anchor sits in the scroller above the empty state).
  const star = state.locator('.avatar-anchor, .empty-state__star, .empty-state__icon').first()
  expect((await box(star)).y).toBeGreaterThanOrEqual(sb.y)
  // And the bottom of the checklist can be scrolled to.
  await state.evaluate((e) => e.scrollTo({ top: e.scrollHeight }))
  const last = t.page.locator('.chat__checklist .checklist__items li').last()
  await expect(last).toBeInViewport()
  await t.assertNoErrors()
})

test('F48: light theme — badges and the selected prompt pass axe on Settings, Memory and Prompts @R21 @R22', async () => {
  test.setTimeout(180_000)
  const t = await desktop()
  const trip = await createSession(t.api, 'Lisbon trip')
  await wsTurn(t.page, trip.uid, 'Plan a spring trip to Lisbon')
  expect((await t.api('POST', '/api/prompts', { name: 'Gentle editor', body: 'You are a gentle, precise editor.' })).status).toBe(200)
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(t, theme)
    for (const p of ['/settings/providers', '/settings/memory', '/settings/voice-out', '/settings/voice-in', '/settings/privacy', '/memory', '/memory/sessions']) {
      await go(t, p)
      await expectAxeClean(t.page, `${p} (${theme})`)
    }
    await go(t, '/prompts')
    await t.page.getByRole('button', { name: /Gentle editor/ }).or(t.page.getByRole('option', { name: /Gentle editor/ })).first().click()
    await expectAxeClean(t.page, `/prompts selected (${theme})`)
  }
  // The privacy badges really are on screen in light theme (the check above is not vacuous). The mock LLM is a custom
  // program on this PC, whose badge is neutral ("unless it forwards", 07 H-cs-2); Windows voices give a green one.
  expect((await t.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, provider: 'windows' } } })).status).toBe(200)
  await setTheme(t, 'light')
  await go(t, '/settings/privacy')
  await expectAxeClean(t.page, '/settings/privacy with a local voice (light)')
  // The first match may sit in the collapsed "other disclosures" list; any visible one proves it.
  await expect(t.page.locator('.badge--success, .badge--warning').filter({ visible: true }).first()).toBeVisible()
  await t.assertNoErrors()
})

test('F52: memory viewer and prompt library from the sidebar footer, the palette, Settings and the panel @R7 @R11 @R22', async () => {
  const t = await desktop()
  const page = t.page
  const a = await createSession(t.api, 'Lisbon trip')
  await go(t, `/s/${a.uid}`)
  const foot = page.locator('.sidebar__foot')
  await foot.getByRole('link', { name: 'Memory', exact: true }).click()
  await expect.poll(() => t.hook<string>('route')).toMatch(/^\/memory/)
  await expect(foot.getByRole('link', { name: 'Memory', exact: true })).toHaveAttribute('aria-current', 'page')
  await foot.getByRole('link', { name: 'Prompts', exact: true }).click()
  await expect.poll(() => t.hook<string>('route')).toBe('/prompts')
  await expect(foot.getByRole('link', { name: 'Prompts', exact: true })).toHaveAttribute('aria-current', 'page')
  // Both rows of the footer fit the sidebar: nothing overlaps the Settings label.
  const settingsBox = await box(foot.getByRole('link', { name: 'Settings', exact: true }))
  const firstIcon = await box(foot.getByRole('button', { name: 'Search all messages' }))
  expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(firstIcon.x + 0.5)

  // Ctrl+K: typing what the owner would look for finds them.
  for (const [q, name, route] of [
    ['timeline', /^Memory viewer/, /^\/memory/],
    ['memory', /^Memory viewer/, /^\/memory/],
    ['prompt', /^Prompt library/, /^\/prompts$/]
  ] as const) {
    await go(t, `/s/${a.uid}`)
    await page.keyboard.press('Control+k')
    const input = page.getByRole('combobox', { name: /type \/ for commands/ })
    await expect(input).toBeFocused()
    await input.fill(q)
    await expect(page.getByRole('option', { name })).toBeVisible()
    await page.getByRole('option', { name }).click()
    await expect.poll(() => t.hook<string>('route')).toMatch(route)
  }

  // Settings: listed under the sections.
  await go(t, '/settings/general')
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await nav.getByRole('link', { name: /^Memory viewer/ }).click()
  await expect.poll(() => t.hook<string>('route')).toMatch(/^\/memory/)
  await go(t, '/settings/general')
  await nav.getByRole('link', { name: /^Prompt library/ }).click()
  await expect.poll(() => t.hook<string>('route')).toBe('/prompts')

  // The header's Memory chip lands in the panel's memory section, which links on to the viewer.
  await go(t, `/s/${a.uid}`)
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  await page.locator('.shell__panel').getByRole('link', { name: 'Open the memory viewer' }).click()
  await expect.poll(() => t.hook<string>('route')).toMatch(/^\/memory/)
  await expectAxeClean(page, 'sidebar footer', '.sidebar__foot')
  await t.assertNoErrors()
})

test('F53: remembered AI replies read as plain text in the memory timeline @R7', async () => {
  const t = await desktop()
  const a = await createSession(t.api, 'History window')
  // The mock answers "Echo: <the message>", so the reply carries this markdown.
  await wsTurn(t.page, a.uid, "Here's how the **history window** works:\n\n## The idea\n\n1. Only three pages stay loaded (`3 × N` rows).\n\n```ts\nconst keep = 3\n```")
  await go(t, '/memory')
  const ai = t.page.getByTestId('memory-entry').filter({ hasText: 'ai response' }).first()
  await expect(ai).toBeVisible()
  const body = ai.locator('.ment__body')
  await expect(body).toContainText('history window works:')
  await expect(body).toContainText('const keep = 3')
  const text = (await body.textContent()) ?? ''
  expect(text).not.toMatch(/\*\*|##|`/)
  // The owner's own message stays exactly as typed.
  await expect(t.page.getByTestId('memory-entry').filter({ hasText: 'user response' }).first().locator('.ment__body')).toContainText('**history window**')
  await t.assertNoErrors()
})

test('F56: the guided wizard rail does not call every step optional @R3', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  await expect.poll(() => s!.hook<string>('route')).toBe('/setup')
  await page.getByText('Guided setup', { exact: true }).click()
  await page.getByRole('button', { name: 'Start guided setup' }).click()
  await expect(page.locator('.wiz__rail-sub')).toHaveText('A few minutes · only the AI service is required')
  await s.assertNoErrors()
})

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 }
] as const) {
  test(`F57: "Connection lost" is an in-flow strip under the top bar, one line (${vp.name}) @R22`, async () => {
    const t = await desktop({ width: vp.width, height: vp.height })
    const a = await createSession(t.api, 'Lisbon trip')
    await wsTurn(t.page, a.uid, 'Plan a spring trip to Lisbon')
    await go(t, `/s/${a.uid}`)
    const content = t.page.locator('.shell__content')
    const before = await box(content)
    // The server goes away (PC asleep, Vesper restarting).
    t.proc.kill()
    const strip = t.page.getByTestId('connection-banner')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expect(strip).toHaveClass(/conn-strip/)
    const bar = await box(t.page.locator('.shell__topbar'))
    const sb = await box(strip)
    const after = await box(content)
    // Under the top bar, and the page moved down by exactly the strip: nothing is covered.
    expect(sb.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5)
    expect(after.y).toBeGreaterThanOrEqual(sb.y + sb.height - 0.5)
    expect(after.y - before.y).toBeGreaterThan(20)
    expect(sb.width).toBeGreaterThan(vp.width * (vp.name === 'phone' ? 0.95 : 0.5))
    // One line: the text and the button share a row, nothing wraps.
    const text = strip.locator('.conn__text')
    const line = await text.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.3)
    expect((await box(text)).height).toBeLessThan(line * 1.6)
    expect(sb.height).toBeLessThanOrEqual(60)
    const btn = strip.getByRole('button', { name: 'Retry now' })
    await expect(btn).toBeVisible()
    expect(Math.abs((await box(btn)).y + (await box(btn)).height / 2 - (sb.y + sb.height / 2))).toBeLessThan(4)
    if (vp.name === 'phone') await expect(text).toHaveText(/^Reconnecting/)
    await t.page.screenshot({ path: test.info().outputPath(`offline-${vp.name}.png`) })
    // The floating pill does not show as well.
    await expect(t.page.locator('.conn-banner')).toHaveCount(0)
  })
}
