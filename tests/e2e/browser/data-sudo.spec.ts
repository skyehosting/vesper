/**
 * F49: opening Settings → Data on a phone or a browser (no password entered, so no sudo) must not pop the
 * "Confirm it's you" prompt by itself (07 B2: the password is asked for an action that needs it). The backups list
 * offers an inline unlock that asks only on that click, and a pending prompt never follows the user to another page.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
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

test('Settings → Data on a browser device asks for the password only on an action, and the prompt stays on its page (F49) @R1 @R22', async () => {
  s = await launchServer({ mock, viewport: { width: 390, height: 844 } })
  const page = s.page
  const sudoRequests: string[] = []
  page.on('response', (r) => {
    if (r.status() === 403 && new URL(r.url()).pathname.startsWith('/api/')) sudoRequests.push(new URL(r.url()).pathname)
  })
  await s.hook('go', '/settings/data')
  await s.waitReady()
  const prompt = page.getByRole('dialog', { name: /^Confirm it.s you/ })
  const unlock = page.getByRole('button', { name: 'Show backups' })
  await expect(unlock).toBeVisible()
  await expect(page.getByTestId('data-usage')).toBeVisible()
  await expect(prompt).toHaveCount(0)
  // The list was asked for without the prompt: one refused read, no dialog.
  expect(sudoRequests).toEqual(['/api/backups'])

  // The owner asks for it: now the prompt opens.
  await unlock.click()
  await expect(prompt).toBeVisible()
  // Leaving the page (a phone's back gesture, a link elsewhere) closes it instead of covering the next page.
  await s.hook('go', '/settings/chat')
  await expect(prompt).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Enter sends' })).toBeVisible()

  // Cancel keeps the inline unlock.
  await s.hook('go', '/settings/data')
  await s.waitReady()
  await page.getByRole('button', { name: 'Show backups' }).click()
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: 'Cancel' }).click()
  await expect(prompt).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show backups' })).toBeVisible()
  // The refused reads are expected (403 sudo_required); nothing else went wrong.
  s.errors.splice(0, s.errors.length, ...s.errors.filter((e) => !/status of 403/.test(e)))
  await s.assertNoErrors()
})
