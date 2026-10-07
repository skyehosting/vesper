/**
 * The setup wizard in the desktop app (07 D11, R3): the first launch opens it, a restart in the middle resumes on the
 * same step, finishing it means the next launch opens the chats. The AI service is the mock's OpenAI-compatible
 * address typed into the Custom preset (loopback http is allowed, 07 B1).
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, removeDirs, type TestApp } from '../launch'
// axe runs in the browser project: its page-per-frame analysis isn't supported in an Electron window.
import { expectStep } from '../settingsWizard'

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

test('first launch opens the wizard; a restart resumes it; once finished the app opens the chats @R3 @R2', async () => {
  test.setTimeout(180_000)
  t = await launchApp({ mock })
  const { dataDir, localDir } = t
  try {
    await expect.poll(() => t!.hook<string>('route')).toBe('/setup')
    await expectStep(t.hook, 'welcome')
    await t.page.getByText('Quick start', { exact: true }).click()
    await t.page.getByRole('button', { name: 'Start quick setup' }).click()
    await expectStep(t.hook, 'provider')
    await t.page.getByText('Custom', { exact: true }).click()
    const url = t.page.getByLabel('Address (base URL)')
    await url.fill(`${mock.url}/v1`)
    await url.blur()
    await t.page.getByRole('button', { name: 'Test connection' }).click()
    await expect(t.page.locator('[data-test-result="success"]')).toBeVisible()

    // Restart with the wizard half done.
    await t.close({ keepData: true })
    t = await launchApp({ mock, dataDir, localDir })
    await expect.poll(() => t!.hook<string>('route')).toBe('/setup')
    await expectStep(t.hook, 'provider')
    await expect(t.page.getByLabel('Address (base URL)')).toHaveValue(`${mock.url}/v1`)
    await t.page.getByRole('combobox', { name: 'Model' }).click()
    await t.page.getByRole('option', { name: /^mock-echo/ }).click()
    await expect(t.page.locator('[data-test-result="success"]')).toContainText('the model answered')
    await t.page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expectStep(t.hook, 'finale')
    await t.page.getByRole('button', { name: 'Start chatting' }).click({ timeout: 20_000 })
    await expect.poll(() => t!.hook<string>('route')).not.toBe('/setup')
    await t.assertNoErrors()

    // Finished: the next launch goes straight to the chats.
    await t.close({ keepData: true })
    t = await launchApp({ mock, dataDir, localDir })
    await t.waitHook('ws.connected')
    expect(await t.hook<string>('route')).not.toBe('/setup')
    await t.assertNoErrors()
  } finally {
    await t?.close()
    t = null
    removeDirs([dataDir, localDir])
  }
})
