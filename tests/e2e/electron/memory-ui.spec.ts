/**
 * memory-ui in the desktop app (the window is the desktop device, sudo implied — 07 B2): the memory, privacy and data
 * pages render with the real data paths, a Voyage key saves through the desktop-only secrets route, the protocols are
 * editable. @R1 @R7 @R21
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, type TestApp } from '../launch'
import { configureMockLlm } from '../helpers'

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await t?.close()
  await mock?.close()
})

test('memory, privacy and data pages on the desktop @R7 @R21', async () => {
  t = await launchApp({ mock })
  await t.waitHook('ws.connected')
  await configureMockLlm(t.api, mock.url)
  const go = async (p: string): Promise<void> => {
    await t!.hook('go', p)
    await t!.waitReady()
  }
  const page = t.page

  await go('/settings/memory')
  const key = page.getByLabel('Voyage AI API key')
  await key.fill('pa-e2e-desktop-key')
  await key.press('Enter')
  await expect(page.getByTestId('voyage-test-result')).toContainText('Connected')

  await go('/settings/privacy')
  // The desktop sees its real data folders (bootstrap.dataPaths) with Open folder.
  await expect(page.getByText(t.dataDir, { exact: true })).toBeVisible()
  // POST /api/system/open-folder is platform-int's (a 501 stub until then): the button is there, not clicked here.
  await expect(page.getByRole('button', { name: 'Open folder' }).first()).toBeVisible()

  await go('/memory/protocols')
  await expect(page.getByTestId('protocols-editor')).toBeEditable()

  await go('/settings/data')
  await expect(page.getByTestId('data-usage')).toContainText('Chats & memory')
  await go('/')
  await t.assertNoErrors()
})
