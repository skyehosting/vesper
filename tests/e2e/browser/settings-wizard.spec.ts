/**
 * settings-wizard acceptance (07 D11/D12/D13, R3, R20): the Guided wizard end to end against the mocks (LLM presets
 * with a rejected key and a missing model, Voyage, ElevenLabs voices filling in, a speech-model download from the
 * mock GitHub server, the finale greeting in the chosen voice), resuming on the same step after a restart, Quick
 * start in under a minute, every Settings page without serious axe violations, instant save with revert + field
 * message, search jumps, live updates, remote read-only, the phone list → page flow, and no polling left behind.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer } from '../../mocks/server'
import { clientErrors } from '../hooks'
import { launchServer, removeDirs, type TestServer } from '../launch'
import { expectNoAxeViolations, expectStep, settled, shot } from '../settingsWizard'

const KEY = 'sk-e2e-good-key-1234567890'

let mock: MockServer
let s: TestServer | null = null
let catalogFile = ''

test.beforeAll(async () => {
  mock = await startMockServer()
  // The mock GitHub release server's model archive as an extra catalogue entry (voice-in-server's switch).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-sw-'))
  catalogFile = path.join(dir, 'catalog.json')
  // Marked recommended so the wizard's short list (recommended or already downloaded) offers it next to Parakeet.
  fs.writeFileSync(catalogFile, JSON.stringify([{ ...mock.models.catalogEntry({ id: 'mock-model' }), recommended: true }]))
})

test.beforeEach(() => {
  mock.reset()
  mock.llm.requireKey(KEY)
  mock.llm.setModels(['mock-echo', 'gone-model'])
})

test.afterEach(async () => {
  await s?.close()
  s = null
})

test.afterAll(async () => {
  await mock?.close()
  removeDirs([path.dirname(catalogFile)])
})

async function cont(page: Page, label = 'Continue'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
}

/** Pick OpenAI, save `key`, and wait for the automatic Test to finish. */
async function connectOpenAI(page: Page, key: string): Promise<void> {
  await page.getByText('OpenAI', { exact: true }).click()
  const field = page.getByLabel('API key')
  await expect(field).toBeVisible()
  await field.fill(key)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[data-test-result]')).toBeVisible()
}

async function chooseModel(page: Page, id: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: new RegExp(`^${id}`) }).click()
}

test('Guided setup end to end against the mocks, with a restart in the middle @R3 @R2 @R7 @R12 @R19 @R21', async () => {
  test.setTimeout(180_000)
  s = await launchServer({ mock, login: 'desktop', env: { VESPER_STT_TEST_CATALOG: catalogFile, VESPER_STT_MODEL_DIR: '' } })
  const page = s.page
  const api = s.api
  // First run on the desktop: boot opens the wizard by itself.
  await expect.poll(() => s!.hook<string>('route')).toBe('/setup')
  await expectStep(s.hook, 'welcome')
  await expectNoAxeViolations(page, 'wizard welcome')
  await page.getByText('Guided setup', { exact: true }).click()
  await cont(page, 'Start guided setup')

  // 1 · AI provider: a wrong key (the server checks it on save and refuses it: 400 provider_auth, upstream 401), then
  // a model the service doesn't have (404), then a working one.
  await expectStep(s.hook, 'provider')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await page.getByText('OpenAI', { exact: true }).click()
  const keyField = page.getByLabel('API key')
  await keyField.fill('sk-e2e-wrong-key-000000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // Shown in the key field like the voice and Voyage keys; nothing is stored, the typed key stays to fix.
  await expect(page.getByText('OpenAI rejected this key (401)')).toBeVisible()
  await expect(keyField).toHaveAttribute('aria-invalid', 'true')
  await expect(keyField).toHaveValue('sk-e2e-wrong-key-000000')
  expect((await api<{ secretsSet: string[] }>('GET', '/api/bootstrap')).json.secretsSet.filter((n) => n.startsWith('llm:'))).toEqual([])
  await expect(page.locator('[data-test-result]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(page.getByText(/What OpenAI receives/)).toBeVisible()
  await expectNoAxeViolations(page, 'wizard provider (key refused)')
  await keyField.fill(KEY)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[data-test-result="success"]')).toContainText('2 models are available')
  mock.llm.script({ error: { status: 404 }, match: { model: 'gone-model' } })
  await chooseModel(page, 'gone-model')
  await expect(page.locator('[data-test-result="danger"]')).toContainText('Model not found (404)')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await chooseModel(page, 'mock-echo')
  await expect(page.locator('[data-test-result="success"]')).toContainText('Connected — the model answered')
  await cont(page)

  // 2 · You
  await expectStep(s.hook, 'you')
  await page.getByLabel('What should I call you?').fill('Raven')
  await settled(s.hook, page)
  await expectNoAxeViolations(page, 'wizard you')

  // Restart in the middle: the server and the window go away; the wizard comes back on the same step.
  const { dataDir, localDir } = s
  await s.close({ keepData: true })
  s = await launchServer({ mock, login: 'desktop', dataDir, localDir, env: { VESPER_STT_TEST_CATALOG: catalogFile, VESPER_STT_MODEL_DIR: '' } })
  try {
    const p2 = s.page
    await expect.poll(() => s!.hook<string>('route')).toBe('/setup')
    await expectStep(s.hook, 'you')
    await expect(p2.getByLabel('What should I call you?')).toHaveValue('Raven')
    await cont(p2)

    // Every step below is the owning feature's real page under the wizard's ONE navigation bar.
    const navBars = () => p2.locator('.wiz__nav')
    const continues = () => p2.getByRole('button', { name: /^(Continue|Use this voice|Continue without a key)$/ })

    // 3 · Memory (memory-ui's page): memory on, the Voyage key saved through its field (the server validates it with
    // a real embed), then its Test.
    await expectStep(s.hook, 'memory')
    await expect(navBars()).toHaveCount(1)
    await p2.getByRole('switch', { name: /Remember with Voyage AI/ }).click()
    await expect(p2.getByRole('button', { name: 'Continue without a key' })).toBeVisible()
    const voyage = p2.locator('[data-secret="voyage"]')
    await voyage.getByLabel('Voyage AI API key').fill('pa-e2e-voyage-key')
    await voyage.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(p2.getByTestId('voyage-test-result')).toContainText('Connected.')
    await expect(continues()).toHaveCount(1)
    await expectNoAxeViolations(p2, 'wizard memory')
    await cont(p2)

    // 4 · Voice (voice-client's page): ElevenLabs, its key → the voices fill in and the first premade voice is chosen
    // without a click (07 C22); "Use this voice" turns voice replies on before moving on.
    await expectStep(s.hook, 'voice-out')
    await expect(navBars()).toHaveCount(1)
    // The voice page saves the provider and shows it once the server answers (not optimistic): click, then wait.
    await p2.locator('label.radio-card', { hasText: 'ElevenLabs' }).click()
    await expect(p2.getByRole('radio', { name: /ElevenLabs/ })).toBeChecked()
    await expect(p2.getByRole('button', { name: 'Use this voice' })).toBeDisabled()
    await p2.getByLabel('ElevenLabs key').fill('xi-e2e-key')
    await p2.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(p2.getByRole('button', { name: 'Use this voice' })).toBeEnabled({ timeout: 15_000 })
    await expect(continues()).toHaveCount(1)
    await expectNoAxeViolations(p2, 'wizard voice out')
    await cont(p2, 'Use this voice')
    const tts = (await s.api<{ voice: { tts: { enabled: boolean; provider: string; voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts
    expect(tts).toMatchObject({ enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria' })

    // 5 · Microphone (voice-client's page): download the speech model from the mock GitHub server — progress in the
    // row and in the rail — then use it; Continue turns voice input on.
    await expectStep(s.hook, 'voice-in')
    await expect(navBars()).toHaveCount(1)
    const model = p2.getByTestId('stt-model-mock-model')
    await model.getByRole('button', { name: 'Download' }).click()
    await expect(p2.locator('.wiz__dl')).toBeVisible()
    const useIt = model.getByRole('button', { name: 'Use this model' })
    await expect(useIt.or(model.getByText('In use'))).toBeVisible({ timeout: 60_000 })
    if (await useIt.isVisible()) await useIt.click()
    await expect(model.getByText('In use')).toBeVisible()
    // P23: the model in use is ready, so voice input is on already (the switch and the try-out agree with "In use").
    await expect(p2.getByRole('switch', { name: /Use voice input/ })).toBeChecked()
    await expect(continues()).toHaveCount(1)
    await expectNoAxeViolations(p2, 'wizard voice in')
    await cont(p2)
    const stt = (await s.api<{ voice: { stt: { enabled: boolean; provider: string; model: string } } }>('GET', '/api/settings')).json.voice.stt
    expect(stt).toMatchObject({ enabled: true, provider: 'local', model: 'mock-model' })

    // 6 · Access (access-ui's page): This PC only is the default; another mode needs a password first; Continue
    // saves the mode.
    await expectStep(s.hook, 'access')
    await expect(navBars()).toHaveCount(1)
    await expect(p2.getByRole('radio', { name: 'This PC only' })).toBeChecked()
    await p2.locator('label.radio-card', { hasText: 'Local network' }).click()
    await expect(p2.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await expect(p2.getByText('Set a password above to continue, or choose This PC only.')).toBeVisible()
    await p2.locator('label.radio-card', { hasText: 'This PC only' }).click()
    await expect(continues()).toHaveCount(1)
    await expectNoAxeViolations(p2, 'wizard access')
    await cont(p2)

    // 7 · Look: the accent applies at once.
    await expectStep(s.hook, 'look')
    await p2.getByRole('radio', { name: 'Rose' }).check()
    await expect(p2.locator('html')).toHaveAttribute('data-accent', 'rose')
    await expectNoAxeViolations(p2, 'wizard look')
    await cont(p2)

    // 8 · Summary, with an Edit link that comes back here.
    await expectStep(s.hook, 'summary')
    const row = (id: string) => p2.locator(`[data-summary="${id}"]`)
    await expect(row('provider')).toContainText('OpenAI · mock-echo')
    await expect(row('you')).toContainText('Raven')
    await expect(row('memory')).toContainText('On · Voyage')
    await expect(row('voice-out')).toContainText('ElevenLabs · ')
    await expect(row('voice-in')).toContainText('On this PC')
    await expect(row('access')).toContainText('This PC only')
    await expect(row('look')).toContainText('Rose')
    await expectNoAxeViolations(p2, 'wizard summary')
    await row('you').getByRole('button', { name: 'Edit You' }).click()
    await expectStep(s.hook, 'you')
    await cont(p2)
    await expectStep(s.hook, 'summary')
    expect((await s.api<{ wizard: { skipped: string[] } }>('GET', '/api/settings')).json.wizard.skipped).toEqual([])

    // Finale: the Star greets Raven in the ElevenLabs voice (a sample request reached the mock), then offers a phone.
    mock.recorder.clear()
    await cont(p2, 'Meet Vesper')
    await expectStep(s.hook, 'finale')
    await expect(p2.getByRole('button', { name: 'Start chatting' })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => p2.locator('.wiz-finale--done').count(), { timeout: 20_000 }).toBe(1)
    expect(mock.recorder.find((r) => r.method === 'POST' && r.path.includes('/text-to-speech/')).length).toBeGreaterThan(0)
    await expect(p2.locator('.wiz-finale__greeting')).toContainText('Hi Raven.')
    // Spoken, not the text fallback: the greeting was revealed with its audio (07 A4: the first synced reveal).
    await expect(p2.locator('.wiz-finale__greeting--text')).toHaveCount(0)
    await expect(p2.getByRole('button', { name: 'Pair your phone' })).toBeVisible()
    await expectNoAxeViolations(p2, 'wizard finale')
    await shot(p2, 'e2e-wizard-finale')
    await p2.getByRole('button', { name: 'Start chatting' }).click()
    await expect.poll(() => s!.hook<string>('route')).not.toBe('/setup')
    const done = await s.api<{ wizard: { completed: boolean; step: string | null } }>('GET', '/api/settings')
    expect(done.json.wizard).toMatchObject({ completed: true, step: null })
    await s.assertNoErrors()
  } finally {
    await s.close()
    s = null
    removeDirs([dataDir, localDir])
  }
})

test('Quick start: connect an AI and start chatting in under 60 seconds @R3 @R2', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  const t0 = Date.now()
  await expectStep(s.hook, 'welcome')
  await page.getByText('Quick start', { exact: true }).click()
  await cont(page, 'Start quick setup')
  await expectStep(s.hook, 'provider')
  // One working step: no "Step 1 of 1" with a bar that already looks full (F56).
  await expect(page.locator('.wiz__progress-text')).toHaveText('Quick start · one step, then you can chat')
  await expect(page.locator('.wiz__progress-track')).toHaveCount(0)
  await connectOpenAI(page, KEY)
  await chooseModel(page, 'mock-echo')
  await expect(page.locator('[data-test-result="success"]')).toContainText('the model answered')
  await cont(page)
  await expectStep(s.hook, 'finale')
  await page.getByRole('button', { name: 'Start chatting' }).click({ timeout: 20_000 })
  await expect.poll(() => s!.hook<string>('route')).not.toBe('/setup')
  const elapsed = Date.now() - t0
  expect(elapsed, `Quick start took ${elapsed} ms`).toBeLessThan(60_000)
  const st = await s.api<{ wizard: { completed: boolean; path: string; skipped: string[] }; llm: { defaultProfile: string } }>('GET', '/api/settings')
  expect(st.json.wizard).toMatchObject({ completed: true, path: 'quick' })
  expect(st.json.wizard.skipped).toEqual(['you', 'memory', 'voice-out', 'voice-in', 'access', 'look'])
  expect(st.json.llm.defaultProfile).toBe('openai')
  await s.assertNoErrors()
})

test('a browser on another device is told to finish setup on the PC @R3 @R1', async () => {
  s = await launchServer({ mock })
  await s.hook('go', '/setup')
  await s.waitReady()
  await expect(s.page.getByRole('heading', { name: 'Finish setup on your PC' })).toBeVisible()
  await expectNoAxeViolations(s.page, 'wizard remote notice')
})

test('every Settings page renders without serious axe violations; search, instant save, revert, live updates @R20 @R22', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  await s.api('PATCH', '/api/settings', { wizard: { completed: true } })
  for (const id of ['general', 'providers', 'chat', 'memory', 'voice-out', 'voice-in', 'appearance', 'access', 'privacy', 'data', 'performance', 'about']) {
    await s.hook('go', `/settings/${id}`)
    await s.waitReady()
    await expect(page.locator('.settings__link[aria-current="page"]')).toBeVisible()
    await expectNoAxeViolations(page, `settings/${id}`)
  }

  // Search jumps to the row (opening Advanced when needed), highlights it and focuses its control.
  await s.hook('go', '/settings/general')
  await s.waitReady()
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  await search.fill('page size')
  await expect(page.getByRole('link', { name: /Messages per page/ })).toBeVisible()
  await search.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).toBe('/settings/chat?find=chat.pageSize')
  await expect(page.locator('[data-setting="chat.pageSize"]')).toHaveClass(/is-target/)
  await expect(page.locator('[data-setting="chat.pageSize"] [role="slider"]')).toBeFocused()
  await search.fill('summarize')
  await search.press('Enter')
  await expect(page.locator('[data-setting="chat.contextFill"]')).toBeVisible()
  // Other owners' pages are reachable the same way: a voice control (found by its control id) and an access row
  // under Advanced (data-setting).
  await search.fill('silence before sending')
  await search.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).toBe('/settings/voice-in?find=voice.stt.silenceMs')
  await expect(page.locator('#settings-body .is-target [role="slider"]')).toBeFocused()
  await search.fill('sign out idle devices')
  await search.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).toBe('/settings/access?find=access.idleTimeoutDays')
  await expect(page.locator('[data-setting="access.idleTimeoutDays"]')).toHaveClass(/is-target/)
  await expect(page.locator('[data-setting="access.idleTimeoutDays"]')).toBeInViewport()
  await search.fill('qqqzzz')
  await expect(page.getByText('No settings match')).toBeVisible()
  await search.press('Escape')

  // Instant save: a switch goes to the server at once.
  await s.hook('go', '/settings/chat')
  await s.waitReady()
  const autoTitle = page.getByRole('switch', { name: 'Name chats automatically' })
  await expect(autoTitle).toHaveAttribute('aria-checked', 'true')
  await autoTitle.click()
  await settled(s.hook, page)
  expect((await s.api<{ chat: { autoTitle: boolean } }>('GET', '/api/settings')).json.chat.autoTitle).toBe(false)

  // A refused save reverts the control and says why under it (07 D12).
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation', message: "Some values aren't valid.", retryable: false, fields: { 'chat.showReasoning': 'Not allowed right now' } } }) })
  })
  const reasoning = page.getByRole('switch', { name: 'Show thinking' })
  await reasoning.click()
  await expect(page.locator('[data-setting="chat.showReasoning"] .field-error')).toHaveText('Not allowed right now')
  await expect(reasoning).toHaveAttribute('aria-checked', 'false')
  await page.unroute('**/api/settings')

  // Live updates: a change made elsewhere shows up here without a reload.
  expect((await s.api('PATCH', '/api/settings', { chat: { sendOnEnter: false } })).status).toBe(200)
  await expect(page.getByRole('switch', { name: 'Enter sends' })).toHaveAttribute('aria-checked', 'false')

  // Leaving Performance stops its resource polling (the interval belongs to the page).
  await s.hook('go', '/settings/performance')
  await s.waitReady()
  await expect(page.getByRole('cell', { name: /MB/ }).first()).toBeVisible()
  let polls = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/system/resources')) polls++
  })
  await s.hook('go', '/settings/about')
  await s.waitReady()
  await page.waitForTimeout(4000)
  expect(polls).toBe(0)
  // The only console error is the refused PATCH this test staged.
  expect(s.errors.filter((e) => !/status of 400/.test(e))).toEqual([])
  expect(await clientErrors(page)).toEqual([])
})

test('desktop-only settings are read-only on another device; phones get a list → page flow @R1 @R20', async () => {
  s = await launchServer({ mock, viewport: { width: 390, height: 844 } })
  const page = s.page
  await s.hook('go', '/settings')
  await s.waitReady()
  // 12 sections, then the memory viewer and the prompt library (F52).
  await expect(page.locator('.settings__sections:not(.settings__elsewhere) .settings__link')).toHaveCount(12)
  await expect(page.locator('.settings__elsewhere .settings__link')).toHaveCount(2)
  const links = page.locator('.settings__link')
  for (const box of await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44)
  await expectNoAxeViolations(page, 'settings list (phone)')
  await page.getByRole('link', { name: /AI providers/ }).click()
  // One read-only notice, not two near-identical banners (F55).
  await expect(page.getByText('You can look at these settings here; change them in the Vesper app on your PC.')).toBeVisible()
  await expect(page.locator('#settings-body .banner').filter({ hasText: /Vesper app on your PC/ })).toHaveCount(1)
  await page.getByRole('button', { name: 'All settings' }).click()
  await page.getByRole('link', { name: /Chat/ }).click()
  await expect(page.getByRole('switch', { name: 'Enter sends' })).toBeDisabled()
  await expect(page.getByText(/change them in the Vesper app on your PC/)).toBeVisible()
  await expectNoAxeViolations(page, 'settings/chat (phone, read-only)')
  await s.assertNoErrors()
})

test('switching Settings pages and replaying the wizard leaves no listeners, layers or audio behind @R17', async () => {
  test.setTimeout(180_000)
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  // A voice for the finale, so its audio path (sample → engine → reveal) is part of the cycle.
  await s.api('PATCH', '/api/settings', { wizard: { completed: true }, voice: { tts: { enabled: true, provider: 'elevenlabs' } } })
  expect((await s.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const sections = ['general', 'providers', 'chat', 'appearance', 'performance', 'about']
  const visitAll = async (): Promise<void> => {
    for (const id of sections) {
      await s!.hook('go', `/settings/${id}`)
      await s!.waitReady()
    }
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('voice')
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('')
  }
  const finale = async (): Promise<void> => {
    await s!.api('PATCH', '/api/settings', { wizard: { path: 'quick', step: 'finale' } })
    // The page learns it through settings.changed; open the wizard only once it has.
    await page.waitForFunction(() => {
      const st = (window as unknown as { __vesperTest: { store: { state(): { settings: { wizard: { step: string | null } } | null } } } }).__vesperTest.store.state()
      return st.settings?.wizard.step === 'finale'
    })
    await s!.hook('go', '/setup')
    await expectStep(s!.hook, 'finale')
    await expect(page.locator('.wiz-finale--done')).toHaveCount(1, { timeout: 20_000 })
    await s!.hook('go', '/settings/general')
    await s!.waitReady()
  }
  await visitAll()
  await finale()
  await page.waitForTimeout(1000)
  const base = { ws: await s.hook<{ listeners: number; binary: number; status: number }>('ws.stats'), kit: await s.hook<Record<string, number>>('settings.kit'), audio: await s.hook<Record<string, number>>('audio.counters') }
  for (let i = 0; i < 10; i++) await visitAll()
  for (let i = 0; i < 3; i++) await finale()
  // Leaks persist; teardown may take a few frames (a 30 ms stop fade, a reveal unbinding), so poll for the baseline.
  await expect.poll(() => s!.hook('ws.stats'), { timeout: 5000 }).toMatchObject({ listeners: base.ws.listeners, binary: base.ws.binary, status: base.ws.status })
  await expect.poll(() => s!.hook('settings.kit'), { timeout: 5000 }).toEqual(base.kit)
  const pick = (c: Record<string, number>): Record<string, number> => ({ nodes: c.nodes, sources: c.sources, buffers: c.buffers, replies: c.replies, reveals: c.reveals })
  await expect.poll(async () => pick(await s!.hook<Record<string, number>>('audio.counters')), { timeout: 5000 }).toEqual(pick(base.audio))
  await s.assertNoErrors()
})

test('AI providers page: add OpenRouter with its privacy switches, make it default, remove it; unload voice models @R2 @R21 @R20', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  await s.api('PATCH', '/api/settings', { wizard: { completed: true } })
  await s.hook('go', '/settings/providers')
  await s.waitReady()
  await expect(page.getByRole('heading', { name: 'No AI service yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Add provider' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add an AI provider' })
  await dialog.getByText('OpenRouter', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(/What OpenRouter receives/)).toBeVisible()
  const noTrain = page.getByRole('switch', { name: "Only providers that don't train on prompts" })
  const zdr = page.getByRole('switch', { name: 'Zero-retention providers only' })
  await expect(noTrain).toHaveAttribute('aria-checked', 'true')
  await expect(zdr).toHaveAttribute('aria-checked', 'false')
  await zdr.click()
  await settled(s.hook, page)
  type P = { llm: { profiles: { id: string; options: { openrouterZdr: boolean } }[]; defaultProfile: string | null } }
  let st = (await s.api<P>('GET', '/api/settings')).json
  expect(st.llm.profiles).toHaveLength(1)
  expect(st.llm.profiles[0]).toMatchObject({ id: 'openrouter', options: { openrouterZdr: true } })
  expect(st.llm.defaultProfile).toBe('openrouter')
  // Advanced opens from search (the custom header lives there).
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('custom header')
  await page.getByRole('searchbox', { name: 'Search settings' }).press('Enter')
  await expect(page.getByLabel('Custom header name')).toBeVisible()
  await expectNoAxeViolations(page, 'settings/providers with a profile')
  await page.getByRole('button', { name: 'Remove OpenRouter' }).click()
  await page.getByRole('dialog', { name: /Remove/ }).getByRole('button', { name: 'Remove' }).click()
  await settled(s.hook, page)
  st = (await s.api<P>('GET', '/api/settings')).json
  expect(st.llm.profiles).toEqual([])
  expect(st.llm.defaultProfile).toBeNull()

  // About → the full licence notice stays graceful when the build doesn't ship THIRD_PARTY_NOTICES.txt.
  await s.hook('go', '/settings/about')
  await s.waitReady()
  await page.getByRole('button', { name: 'Full licence notice' }).click()
  const notice = page.getByRole('dialog', { name: 'Third-party licences' })
  await expect(notice).toContainText(/THIRD_PARTY_NOTICES\.txt/)
  await expectNoAxeViolations(page, 'about → licence notice', '[role="dialog"]')
  await page.keyboard.press('Escape')
  await expect(notice).toBeHidden()

  await s.hook('go', '/settings/performance')
  await s.waitReady()
  // Real state from GET /api/system/resources: the game-mode reason, the process table, what voice parts are loaded.
  await expect(page.getByTestId('gamemode-now')).toContainText(/^(Off|On) — /)
  await expect(page.getByTestId('resource-table').locator('tbody tr').first()).toBeVisible()
  await expect(page.getByTestId('voice-loaded')).toContainText('Speech recognition is not loaded.')
  await page.getByRole('button', { name: 'Unload voice models now' }).click()
  await expect(page.locator('.toast').filter({ hasText: /^(Unloaded |Nothing was loaded)/ })).toBeVisible()
  await s.assertNoErrors()
})

test('Quick start with the keyboard only @R3 @R22', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  const tabTo = async (name: RegExp, max = 60): Promise<void> => {
    for (let i = 0; i < max; i++) {
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return ''
        const by = el.getAttribute('aria-labelledby')
        const named = by ? by.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : ''
        return `${el.getAttribute('aria-label') ?? ''} ${named} ${(el as HTMLInputElement).labels?.[0]?.textContent ?? ''} ${el.textContent ?? ''}`
      })
      if (name.test(label)) return
      await page.keyboard.press('Tab')
    }
    throw new Error(`could not Tab to ${name}`)
  }
  await expectStep(s.hook, 'welcome')
  await tabTo(/Guided setup/)
  await page.keyboard.press('ArrowUp') // → Quick start
  await tabTo(/Start quick setup/)
  await page.keyboard.press('Enter')
  await expectStep(s.hook, 'provider')
  await tabTo(/OpenAI/)
  await page.keyboard.press('Space')
  await tabTo(/API key/)
  await page.keyboard.type(KEY)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-test-result="success"]')).toBeVisible()
  await tabTo(/^\s*Model/)
  await page.keyboard.type('mock-echo')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-test-result="success"]')).toContainText('the model answered')
  await tabTo(/Continue/)
  await page.keyboard.press('Enter')
  await expectStep(s.hook, 'finale')
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeFocused({ timeout: 20_000 })
  await page.keyboard.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).not.toBe('/setup')
  await s.assertNoErrors()
})

test('a Test that gets no answer gives up after 10 seconds with a network message @R2 @R3', async () => {
  test.setTimeout(90_000)
  s = await launchServer({ mock, login: 'desktop' })
  const page = s.page
  await expectStep(s.hook, 'welcome')
  await page.getByText('Quick start', { exact: true }).click()
  await cont(page, 'Start quick setup')
  await expectStep(s.hook, 'provider')
  // Saving the key checks it with the provider first (engine-int's key check lists the models), so the key goes in
  // while the mock answers; then the model list hangs and the Test's own 10 s limit (07 D11) has to answer for it.
  await connectOpenAI(page, KEY)
  await expect(page.locator('[data-test-result="success"]')).toBeVisible()
  mock.script({ method: 'GET', path: '/v1/models', hang: true })
  const t0 = Date.now()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.locator('[data-test-result="danger"]')).toContainText('No answer within 10 seconds', { timeout: 20_000 })
  const took = Date.now() - t0
  expect(took).toBeGreaterThan(9_000)
  expect(took).toBeLessThan(16_000)
  await expect(page.locator('[data-test-result="danger"]')).toContainText('firewall')
  await s.assertNoErrors()
})
