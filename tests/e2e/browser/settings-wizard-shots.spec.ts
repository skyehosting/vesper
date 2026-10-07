/**
 * Screenshots of every Settings page and wizard step for review (07 D8: phone layout; 04: both themes), at 1440×900,
 * 1138×608 (the owner's primary monitor in DIP) and 390×844, dark and light. Opt-in: VESPER_SHOTS=1 (they take a few
 * minutes; VESPER_SHOTS=quick → 1440×900 dark only); files land in $PW_OUT/shots. Tagged @R22 (polish).
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, type TestServer } from '../launch'
import { expectStep, settled, shot } from '../settingsWizard'

const QUICK = process.env.VESPER_SHOTS === 'quick'
const SIZES = QUICK ? [{ w: 1440, h: 900 }] : [{ w: 1440, h: 900 }, { w: 1138, h: 608 }, { w: 390, h: 844 }]
const THEMES = QUICK ? (['dark'] as const) : (['dark', 'light'] as const)
const SECTIONS = ['general', 'providers', 'chat', 'memory', 'voice-out', 'voice-in', 'appearance', 'access', 'privacy', 'data', 'performance', 'about'] as const
const KEY = 'sk-test-good-key-123456'

test.skip(!process.env.VESPER_SHOTS, 'screenshots are opt-in: VESPER_SHOTS=1')
test.describe.configure({ mode: 'serial' })

let mock: MockServer
let s: TestServer

test.beforeAll(async () => {
  mock = await startMockServer()
  mock.llm.requireKey(KEY)
  s = await launchServer({ mock, login: 'desktop' })
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

async function theme(t: 'dark' | 'light'): Promise<void> {
  const r = await s.api('PATCH', '/api/settings', { appearance: { theme: t } })
  expect(r.status).toBe(200)
  await expect(s.page.locator('html')).toHaveAttribute('data-theme', t)
}

async function next(page: Page, label = 'Continue'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
}

async function walkWizard(page: Page, tag: string): Promise<void> {
  await s.api('PATCH', '/api/settings', { llm: { profiles: [], defaultProfile: null }, wizard: { step: 'welcome', path: null, completed: false, skipped: [] }, profile: { userName: '' } })
  await s.api('DELETE', '/api/secrets/llm:openai')
  await s.hook('go', '/settings/about')
  await s.waitReady()
  await s.hook('go', '/setup?rerun=1')
  await s.waitReady()
  await expectStep(s.hook, 'welcome')
  await page.waitForTimeout(400)
  await shot(page, `wizard-0-welcome-${tag}`)
  await page.getByRole('button', { name: 'Start guided setup' }).click()
  await expectStep(s.hook, 'provider')
  await page.waitForTimeout(400)
  await shot(page, `wizard-1a-provider-${tag}`)
  await page.getByText('OpenAI', { exact: true }).click()
  await expect(page.getByLabel('API key')).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, `wizard-1b-provider-picked-${tag}`)
  await page.getByLabel('API key').fill('sk-wrong-key-000000000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // The server checks the key on save and refuses it; the field says so (nothing is stored).
  await expect(page.getByText(/rejected this key \(401\)/)).toBeVisible()
  await page.getByLabel('API key').scrollIntoViewIfNeeded()
  await shot(page, `wizard-1c-provider-key-refused-${tag}`)
  await page.getByLabel('API key').fill(KEY)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[data-test-result="success"]')).toBeVisible()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /mock-echo/ }).click()
  await expect(page.getByText('Connected — the model answered')).toBeVisible()
  await settled(s.hook, page)
  await page.locator('[data-test-result]').scrollIntoViewIfNeeded()
  await shot(page, `wizard-1d-provider-ok-${tag}`)
  await next(page)
  await expectStep(s.hook, 'you')
  await page.getByLabel('What should I call you?').fill('Raven')
  await settled(s.hook, page)
  await shot(page, `wizard-2-you-${tag}`)
  await next(page)
  for (const id of ['memory', 'voice-out', 'voice-in', 'access']) {
    await expectStep(s.hook, id)
    await page.waitForTimeout(350)
    await shot(page, `wizard-${id}-${tag}`)
    await page.getByRole('button', { name: 'Skip for now' }).click()
  }
  await expectStep(s.hook, 'look')
  await page.waitForTimeout(350)
  await shot(page, `wizard-7-look-${tag}`)
  await next(page)
  await expectStep(s.hook, 'summary')
  await page.waitForTimeout(350)
  await shot(page, `wizard-8-summary-${tag}`)
  await next(page, 'Meet Vesper')
  await expectStep(s.hook, 'finale')
  await page.waitForTimeout(300)
  await shot(page, `wizard-9-finale-start-${tag}`)
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible()
  await page.waitForTimeout(2000)
  await shot(page, `wizard-9-finale-done-${tag}`)
}

test('wizard steps @R22 @R3', async () => {
  test.setTimeout(600_000)
  const page = s.page
  for (const t of THEMES) {
    await theme(t)
    for (const z of SIZES) {
      await page.setViewportSize({ width: z.w, height: z.h })
      await walkWizard(page, `${z.w}-${t}`)
    }
  }
})

test('settings pages @R22 @R20', async () => {
  test.setTimeout(600_000)
  const page = s.page
  for (const t of THEMES) {
    await theme(t)
    for (const z of SIZES) {
      await page.setViewportSize({ width: z.w, height: z.h })
      if (z.w < 720) {
        await s.hook('go', '/settings')
        await s.waitReady()
        await page.waitForTimeout(500)
        await shot(page, `settings-list-${z.w}-${t}`)
      }
      for (const id of SECTIONS) {
        await s.hook('go', `/settings/${id}`)
        await s.waitReady()
        await page.waitForTimeout(250)
        await shot(page, `settings-${id}-${z.w}-${t}`)
        // …and the bottom of the page (the body scrolls, not the window).
        await page.locator('#settings-body').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
        await page.waitForTimeout(150)
        await shot(page, `settings-${id}-${z.w}-${t}-end`)
      }
    }
  }
})
