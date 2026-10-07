/**
 * sessions-ui screenshots (R22 polish review): every screen and state of the shell, sidebar, panel, search, palette and
 * shortcuts sheet at 1440×900, 1138×608 (the owner's primary monitor in DIP) and 390×844, dark and light. Files land in
 * test-results/sessions-ui-shots/ for review; the assertions only check each state rendered.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, type TestServer } from '../launch'
import { seedChats, setTheme, shot, shotPath, type Seeded } from './sessionsUi.seed'

let mock: MockServer
let s: TestServer
let seeded: Seeded

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  mock = await startMockServer()
  s = await launchServer({ mock })
  seeded = await seedChats(s, mock, { turns: true })
})

test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

const SIZES = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'owner', width: 1138, height: 608 },
  { name: 'phone', width: 390, height: 844 }
] as const

for (const size of SIZES) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screens ${size.name} ${theme} @R6 @R22`, async () => {
      const page = s.page
      await page.setViewportSize({ width: size.width, height: size.height })
      const phone = size.width < 720
      const tag = `${size.name}-${theme}`
      const lisbon = seeded.byTitle['Planning the Lisbon trip'].uid
      const spanish = seeded.byTitle['Spanish practice'].uid

      await s.hook('go', `/s/${lisbon}`)
      await s.waitReady()
      await setTheme(s, theme)
      await page.evaluate(() => (window as unknown as { __vesperTest: { store: { state(): { setPanelOpen(o: boolean): void; setSidebarOpen(o: boolean): void } } } }).__vesperTest.store.state().setPanelOpen(false))
      await expect(page.locator('.shead__title')).toContainText('Planning the Lisbon trip')
      await page.waitForTimeout(150)
      await shot(page, `${tag}-01-chat`)

      if (phone) {
        await page.getByRole('button', { name: 'Chats', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Chats' })).toBeVisible()
        await page.waitForTimeout(400)
        await shot(page, `${tag}-02-sidebar-sheet`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Chats' })).toBeHidden()
      }

      // Panel on a chat with prompt + links.
      await s.hook('go', `/s/${spanish}`)
      await s.waitReady()
      await page.getByRole('button', { name: 'Show chat panel' }).click()
      await expect(page.locator('.psec').first()).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, `${tag}-03-panel`)
      const body = page.locator('.panel__body')
      await body.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
      await shot(page, `${tag}-04-panel-mid`)
      await body.evaluate((el) => (el.scrollTop = el.scrollHeight))
      await shot(page, `${tag}-05-panel-end`)
      if (phone) await page.keyboard.press('Escape')
      else await page.getByRole('button', { name: 'Hide chat panel' }).click()

      // Palette.
      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
      await shot(page, `${tag}-06-palette`)
      await page.keyboard.type('/')
      await page.waitForTimeout(150)
      await shot(page, `${tag}-07-palette-commands`)
      await page.keyboard.type('continue ')
      await page.waitForTimeout(250)
      await shot(page, `${tag}-08-palette-args`)
      await page.keyboard.press('Escape')

      // Shortcuts.
      await page.keyboard.press('Control+/')
      await expect(page.getByRole('dialog', { name: 'Keyboard & commands' })).toBeVisible()
      await shot(page, `${tag}-09-shortcuts`)
      await page.keyboard.press('Escape')

      // Search.
      await s.hook('go', '/search?q=pastel')
      await s.waitReady()
      await expect(page.locator('.shit').first()).toBeVisible()
      await shot(page, `${tag}-10-search`)
      await s.hook('go', '/search')
      await s.waitReady()
      await shot(page, `${tag}-11-search-empty`)
      await s.hook('go', '/search?q=zzzqqq')
      await s.waitReady()
      await shot(page, `${tag}-12-search-none`)

      // Trash with one chat, game mode pill.
      await s.hook('go', `/s/${lisbon}`)
      await s.waitReady()
      await s.hook('nav.setGameMode', true, 'fullscreen')
      if (phone) await page.getByRole('button', { name: 'Chats', exact: true }).click()
      await page.getByRole('button', { name: 'Trash' }).click()
      await page.waitForTimeout(300)
      await shot(page, `${tag}-13-trash-gamemode`)
      await page.getByRole('button', { name: 'Back to chats' }).click()
      await s.hook('nav.setGameMode', false)
      if (phone) await page.keyboard.press('Escape')
    })
  }
}

test('accents, settings and constellation inside the shell @R22', async () => {
  const page = s.page
  await page.setViewportSize({ width: 1440, height: 900 })
  const spanish = seeded.byTitle['Spanish practice'].uid
  for (const [theme, accent] of [
    ['dark', 'violet'],
    ['light', 'rose'],
    ['dark', 'aurora'],
    ['light', 'ice']
  ] as const) {
    await s.hook('go', `/s/${spanish}`)
    await s.waitReady()
    await setTheme(s, theme, accent)
    await page.evaluate(() => (window as unknown as { __vesperTest: { store: { state(): { setPanelOpen(o: boolean): void } } } }).__vesperTest.store.state().setPanelOpen(true))
    await expect(page.locator('.psec').first()).toBeVisible()
    await shot(page, `accent-${theme}-${accent}`)
  }
  await setTheme(s, 'dark', 'gold')
  await page.setViewportSize({ width: 900, height: 700 })
  await page.waitForTimeout(200)
  await shot(page, 'medium-900-panel')
  await page.setViewportSize({ width: 1440, height: 900 })
  await s.hook('go', '/settings')
  await s.waitReady()
  await shot(page, 'shell-settings')
  await s.hook('go', '/constellation')
  await s.waitReady()
  await shot(page, 'shell-constellation')
  await page.setViewportSize({ width: 390, height: 844 })
  await s.hook('go', '/settings')
  await s.waitReady()
  await shot(page, 'shell-settings-phone')
})

test('interaction states: row menu, inline rename, model popover, filled Trash and Archived, no-match search @R6 @R22', async () => {
  const page = s.page
  for (const theme of ['dark', 'light'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 })
    const lisbon = seeded.byTitle['Planning the Lisbon trip'].uid
    await s.hook('go', `/s/${lisbon}`)
    await s.waitReady()
    await setTheme(s, theme)
    await page.evaluate(() => (window as unknown as { __vesperTest: { store: { state(): { setPanelOpen(o: boolean): void } } } }).__vesperTest.store.state().setPanelOpen(false))
    const sidebar = page.locator('.shell__sidebar')
    await sidebar.getByRole('link', { name: /^Weekly groceries/ }).hover()
    await sidebar.getByRole('button', { name: 'More for Weekly groceries' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await shot(page, `state-${theme}-row-menu`)
    await page.keyboard.press('Escape')
    await sidebar.getByRole('link', { name: /^Weekly groceries/ }).focus()
    await page.keyboard.press('F2')
    await shot(page, `state-${theme}-rename`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Model: / }).click()
    await expect(page.locator('.popover')).toBeVisible()
    await page.waitForTimeout(200)
    await shot(page, `state-${theme}-model-popover`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Rename chat:/ }).click()
    await shot(page, `state-${theme}-title-edit`)
    await page.keyboard.press('Escape')
    await sidebar.getByRole('searchbox').fill('qqqzz')
    await page.waitForTimeout(500)
    await shot(page, `state-${theme}-sidebar-nomatch`)
    await sidebar.getByRole('searchbox').fill('')
    await page.waitForTimeout(400)
  }
  // Fill Trash and Archived, then look at both.
  const g = seeded.byTitle['Garden layout ideas'].uid
  const t = seeded.byTitle['Taxes 2025 — what to keep'].uid
  await s.api('DELETE', `/api/sessions/${g}`)
  await s.api('PATCH', `/api/sessions/${t}`, { archived: true })
  await page.getByRole('button', { name: 'Trash' }).click()
  await expect(page.getByRole('button', { name: /^Restore Garden/ })).toBeVisible()
  await shot(page, 'state-light-trash-filled')
  await page.getByRole('button', { name: 'Archived chats' }).click()
  await expect(page.getByRole('button', { name: /^Unarchive Taxes/ })).toBeVisible()
  await shot(page, 'state-light-archived-filled')
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await s.api('POST', `/api/sessions/${g}/restore`)
  await s.api('PATCH', `/api/sessions/${t}`, { archived: false })
})

test('first run: an empty sidebar and the first chat @R6 @R22', async () => {
  const fresh = await launchServer({ mock })
  try {
    await fresh.waitReady()
    await fresh.page.waitForTimeout(300)
    await fresh.page.screenshot({ path: shotPath('first-run-dark'), animations: 'disabled', caret: 'hide' })
    await fresh.page.setViewportSize({ width: 390, height: 844 })
    await fresh.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await fresh.page.waitForTimeout(400)
    await fresh.page.screenshot({ path: shotPath('first-run-phone-sheet'), animations: 'disabled', caret: 'hide' })
  } finally {
    await fresh.close()
  }
})
