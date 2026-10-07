/**
 * H-v12-updates: Settings → About → Updates over the built standalone server and headless Chromium, with the
 * test-only fake updater (POST /api/test/updater, behind __VESPER_TEST__; it never touches the network). Without an
 * updater the page says where updates come from; with one: the interval and behaviour save at once, Check now finds a
 * version, 'Ask first' offers Download, the progress shows, "Update ready — Restart" appears in the top bar (dismissed
 * once per version, also after a reload), and Restart reaches the updater. Other devices see the state, read-only.
 * @R20
 */
import { expect, test } from '@playwright/test'
import { launchServer, type TestServer } from '../launch'
import { expectNoAxeViolations, settled } from '../settingsWizard'

let s: TestServer | null = null

test.afterEach(async () => {
  await s?.close()
  s = null
})

type Counts = { counts: { checks: number; downloads: number; restarts: number } | null }

test('Updates: check, Download, progress, ready, the top-bar pill, Restart @R20', async () => {
  s = await launchServer({ login: 'desktop' })
  const page = s.page
  const api = s.api
  await api('PATCH', '/api/settings', { wizard: { completed: true } })
  await s.hook('go', '/settings/about')
  await s.waitReady()
  const status = page.getByTestId('update-status')
  const group = page.locator('#updates')
  // The standalone server has no updater of its own.
  await expect(status).toHaveText('Updates come to the installed Vesper app on your PC.')
  await expect(group.getByRole('button', { name: 'Check now' })).toHaveCount(0)

  // Attach the fake: the open page switches over live (update.state).
  const drive = (body: unknown) => api<Counts>('POST', '/api/test/updater', body)
  expect((await drive({ onCheck: { state: 'available', version: '9.9.0' } })).status).toBe(200)
  await expect(status).toHaveText('Vesper looks for a new version every hour.')

  // The two settings save at once.
  await group.getByRole('combobox', { name: /Check for updates/ }).click()
  await page.getByRole('option', { name: 'Daily' }).click()
  await expect(status).toHaveText('Vesper looks for a new version once a day.')
  await group.getByRole('radio', { name: 'Ask first' }).click()
  await expect(group.getByText('Tells you about a new version; nothing downloads until you choose Download.')).toBeVisible()
  await settled(s.hook, page)
  expect((await api<{ updates: unknown }>('GET', '/api/settings')).json.updates).toEqual({ checkEvery: '1d', mode: 'ask' })

  // Check now → a new version; 'Ask first' offers Download.
  await group.getByRole('button', { name: 'Check now' }).click()
  await expect(status).toHaveText('Version 9.9.0 is available.')
  await group.getByRole('button', { name: 'Download', exact: true }).click()
  const bar = group.getByRole('progressbar', { name: 'Downloading version 9.9.0' })
  await expect(bar).toHaveAttribute('aria-valuenow', '0')
  await drive({ status: { state: 'downloading', percent: 40 } })
  await expect(bar).toHaveAttribute('aria-valuenow', '40')
  await expect(status).toHaveText('Downloading version 9.9.0…')

  // Ready: the row and the top-bar pill.
  await drive({ status: { state: 'ready' } })
  await expect(status).toHaveText('Version 9.9.0 is ready. It installs when you close Vesper.')
  await expect(bar).toHaveCount(0)
  const pill = page.getByTestId('update-pill')
  await expect(pill).toContainText('Update ready')
  await expectNoAxeViolations(page, 'settings/about with an update ready')

  // Another device sees the state, and can't act on it.
  const phone = await s.login('browser')
  expect((await phone.api<{ state: string; version: string }>('GET', '/api/system/update')).json).toMatchObject({ state: 'ready', version: '9.9.0' })
  expect((await phone.api<{ error: { code: string } }>('POST', '/api/system/update/restart')).json.error.code).toBe('desktop_only')

  // The pill's Restart asks the updater to install.
  await pill.getByRole('button', { name: /^Restart/ }).click()
  await expect.poll(async () => (await api<Counts>('GET', '/api/test/updater')).json.counts?.restarts).toBe(1)

  // Dismissed once per version — still gone after a reload, while About keeps the state.
  await pill.getByRole('button', { name: 'Dismiss the update notice' }).click()
  await expect(pill).toHaveCount(0)
  await page.reload()
  await s.waitReady()
  await expect(status).toHaveText('Version 9.9.0 is ready. It installs when you close Vesper.')
  await expect(page.getByTestId('update-pill')).toHaveCount(0)

  // "Restart to update" in Settings → About.
  await group.getByRole('button', { name: 'Restart to update' }).click()
  await expect.poll(async () => (await api<Counts>('GET', '/api/test/updater')).json.counts).toEqual({ checks: 1, downloads: 1, restarts: 2 })
  await s.assertNoErrors()
})
