/**
 * Shell layout regression (owner report, 1.1.2): hiding the sidebar on a wide desktop window squeezed the chat into the
 * narrow first grid column — it looked like the phone layout. The main column must keep the full remaining width, with
 * the sidebar hidden and shown again, and with the chat panel open.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, routes } from '../helpers'
import { launchServer, type TestServer } from '../launch'

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

async function mainWidth(t: TestServer): Promise<number> {
  return t.page.locator('main.shell__main').evaluate((el) => el.getBoundingClientRect().width)
}

test('hiding the sidebar on a wide window keeps the chat full width, not the phone layout @R22', async () => {
  s = await launchServer({ mock, viewport: { width: 1440, height: 900 } })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const chat = await createSession(desktop.api, 'Layout check')
  await s.hook('go', routes.chat(chat.uid))
  const page = s.page
  await expect(page.locator('form.composer')).toBeVisible()

  const withSidebar = await mainWidth(s)
  const sidebarW = await page.locator('aside.shell__sidebar').evaluate((el) => el.getBoundingClientRect().width)
  expect(withSidebar).toBeGreaterThan(1440 - sidebarW - 40)

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()
  // The whole window minus nothing: the chat takes the sidebar's room instead of shrinking to its slot.
  await expect.poll(() => mainWidth(s!)).toBeGreaterThan(1400)
  expect(await page.locator('html').evaluate((el) => el.classList.contains('is-phone'))).toBe(false)

  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect.poll(() => mainWidth(s!)).toBeGreaterThan(1440 - sidebarW - 40)
  await s.assertNoErrors()
})
