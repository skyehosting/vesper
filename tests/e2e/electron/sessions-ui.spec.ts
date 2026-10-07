/**
 * sessions-ui in the desktop window (R1 hybrid, R6): the title-bar overlay leaves room for the native caption buttons
 * (top bar, or the session panel's head when it is open), the keyboard shortcuts and the Ctrl+K palette work inside
 * Electron, and the desktop may export a chat (it counts as sudo, 07 B2). Screenshots at the owner's
 * 1138×608 in dark and light go to test-results/sessions-ui-shots/.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, wsTurn } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import { shotPath } from '../browser/sessionsUi.seed'

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})

test.afterAll(async () => {
  await t?.close()
  await mock?.close()
})

test('desktop window: caption-button room, shortcuts, palette @R1 @R6 @R22', async () => {
  t = await launchApp({ mock, size: '1138x608' })
  await t.waitHook('ws.connected')
  await configureMockLlm(t.api, mock.url)
  const a = await createSession(t.api, 'Desk notes')
  await createSession(t.api, 'Weekend plans')
  await t.hook('go', `/s/${a.uid}`)
  await t.waitReady()
  await wsTurn(t.page, a.uid, 'Remember the plants on Friday')
  const page = t.page

  await expect(page.locator('html')).toHaveClass(/is-desktop/)
  const pad = async (sel: string): Promise<number> => page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
  expect(await pad('.shell__topbar')).toBeGreaterThanOrEqual(140)
  // The title bar is a drag region; its buttons are not.
  expect(await page.locator('.shell__topbar').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region'))).toBe('drag')
  expect(await page.getByRole('button', { name: 'Show chat panel' }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region'))).toBe('no-drag')
  await page.screenshot({ path: shotPath('electron-dark-01-chat'), animations: 'disabled', caret: 'hide' })

  // With the panel open, its head (now at the window's right edge) takes the caption room.
  await page.keyboard.press('Control+.')
  await expect(page.locator('.psec').first()).toBeVisible()
  expect(await pad('.panel__head')).toBeGreaterThanOrEqual(140)
  expect(await pad('.shell__topbar')).toBeLessThan(40)
  await page.screenshot({ path: shotPath('electron-dark-02-panel'), animations: 'disabled', caret: 'hide' })

  // (Export is exercised in the browser project: in Electron a download opens a native Save dialog.)
  expect((await t.api('GET', `/api/export?session=${a.uid}&format=md`)).text).toContain('Remember the plants on Friday')
  await page.keyboard.press('Control+.')

  // Palette → another chat.
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('combobox', { name: /type \/ for commands/ })).toBeFocused()
  await page.keyboard.type('weekend')
  await page.keyboard.press('Enter')
  await expect(page.locator('.shead__title')).toContainText('Weekend plans')

  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.screenshot({ path: shotPath('electron-light-01-chat'), animations: 'disabled', caret: 'hide' })
  await t.assertNoErrors()
})
