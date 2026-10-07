/**
 * voice-client: Settings → Voice out / Voice in and the wizard steps 4–5, through the built standalone server and a
 * real Chromium with the mock providers. @R12 @R13 @R19 @R20
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { pageApi, type TestServer } from '../launch'
import { expectAxeClean, HELLO_WAV, shots, voiceServer } from '../voice'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  mock.reset()
})
test.afterAll(async () => {
  await mock?.close()
})

test('saving an ElevenLabs key fills the voices dropdown by itself; sample plays; tone placement explained @R12 @R13 @R20', async () => {
  const v = await voiceServer(mock, { tts: false })
  s = v.s
  const api = pageApi(s.page)
  expect((await api('PATCH', '/api/settings', { voice: { tts: { provider: 'elevenlabs', voiceId: null } } })).status).toBe(200)
  await s.hook('go', '/settings/voice-out')
  await s.waitReady()
  const page = s.page
  await expect(page.getByRole('heading', { name: 'Voice out', level: 1 })).toBeVisible()
  const voice = page.locator('#vs-tts-voice')
  await expect(voice).toBeDisabled()
  await expect(voice).toHaveAttribute('placeholder', 'Save your key to load the voices')
  await shots(page, 'settings-voice-out-nokey')

  // Paste the key and save: no other click — the list arrives over the WebSocket (tts.voices).
  await page.locator('#vs-tts-key').fill('xi-e2e-key')
  await page.locator('#vs-tts-key').press('Enter')
  await expect(page.getByText('3 voices available.')).toBeVisible()
  await expect.poll(async () => (await api<{ voice: { tts: { voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts.voiceId).toBe('mock-aria')
  await expect(voice).toBeEnabled()
  await expect(voice).toHaveValue(/Aria/i)

  // The searchable list shows every voice; picking one saves it.
  await voice.click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(3)
  await voice.fill('row')
  await expect(options).toHaveCount(1)
  await options.first().click()
  await expect.poll(async () => (await api<{ voice: { tts: { voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts.voiceId).toBe('mock-rowan')

  // Play sample → POST /api/tts/sample (audio element, muted in tests).
  const sample = page.waitForResponse((r) => r.url().endsWith('/api/tts/sample') && r.request().method() === 'POST')
  await page.getByTestId('vs-play-sample').click()
  expect((await sample).status()).toBe(200)
  expect(mock.tts.synthTexts().some((t) => /This is how I'll sound/.test(t.text))).toBe(true)
  // The sample's player and object URL are released when it ends (or on Stop).
  await expect.poll(async () => (await s!.hook<{ players: { players: number; urls: number } }>('voice.stats')).players, { timeout: 15_000 }).toEqual({ players: 0, urls: 0 })

  // Tone placement: start is the default and the reason is spelled out (07 A2).
  await expect(page.getByText('The voice can’t start in the right tone if the tone arrives at the end')).toBeVisible()
  await page.getByRole('radio', { name: 'At the end' }).click()
  await expect(page.getByText('Short replies wait for the tone at the end.')).toBeVisible()
  await expect.poll(async () => (await api<{ voice: { tts: { tonePlacement: string } } }>('GET', '/api/settings')).json.voice.tts.tonePlacement).toBe('end')

  // Voice tones (H-v11-tone): right under the voice, one sentence per mode; Off disables the placement.
  const modes = page.locator('#vs-tts-tone-mode')
  await expect(modes.getByRole('radio', { name: 'Follow the conversation' })).toBeChecked()
  await expect(page.getByTestId('vs-tone-support')).toContainText('ElevenLabs follows the tone')
  await modes.getByRole('radio', { name: 'Off' }).click()
  await expect(modes.getByText('The voice keeps one even tone and the AI writes no tone tags.')).toBeVisible()
  await expect.poll(async () => (await api<{ voice: { tts: { toneMode: string } } }>('GET', '/api/settings')).json.voice.tts.toneMode).toBe('off')
  await expect(page.getByRole('radio', { name: 'At the end' })).toBeDisabled()
  await modes.getByRole('radio', { name: 'Follow the conversation' }).click()
  await expect.poll(async () => (await api<{ voice: { tts: { toneMode: string } } }>('GET', '/api/settings')).json.voice.tts.toneMode).toBe('conversation')

  await expectAxeClean(page)
  await page.locator(':focus').blur().catch(() => undefined)
  await shots(page, 'settings-voice-out', { scroll: '.settings__body' })
  await s.assertNoErrors()
})

test('F20: an OpenAI-compatible voice server gets its own privacy text — local on this PC, unknown elsewhere, never OpenAI’s @R21 @R12', async () => {
  const v = await voiceServer(mock, { tts: false })
  s = v.s
  const api = pageApi(s.page)
  // The voice list is answered here, so no request ever leaves the machine for the "elsewhere" address.
  await s.page.route('**/api/tts/voices**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ voices: [], models: [] }) }))
  expect((await api('PATCH', '/api/settings', { voice: { tts: { provider: 'openai-compatible', baseUrl: `${mock.url}/v1` } } })).status).toBe(200)
  await s.hook('go', '/settings/voice-out')
  await s.waitReady()
  const note = s.page.locator('.vs-privacy')
  await expect(note).toContainText('Stays on this PC')
  // H-v11-tone: a server without a gpt-4o model can't use tones — the page says so (and the AI isn't asked for tags).
  await expect(s.page.getByTestId('vs-tone-support')).toHaveAttribute('data-supported', 'false')
  await expect(s.page.getByTestId('vs-tone-support')).toContainText('can’t change its tone')
  await expect(note).toContainText('unless that server itself passes it on')
  await expect(note).not.toContainText('OpenAI')
  expect((await api('PATCH', '/api/settings', { voice: { tts: { baseUrl: 'https://tts.vesper.invalid/v1' } } })).status).toBe(200)
  await expect(note).toContainText('What tts.vesper.invalid receives')
  await expect(note).toContainText("can't tell what this voice server does")
  await expect(note).not.toContainText('not used for training')
  await expect(note.getByRole('link', { name: 'Their privacy terms' })).toHaveCount(0)
  // Settings → Privacy says the same (once voice is on).
  expect((await api('PATCH', '/api/settings', { voice: { tts: { enabled: true } } })).status).toBe(200)
  await s.hook('go', '/settings/privacy')
  await s.waitReady()
  await expect(s.page.getByText("can't tell what this voice server does").first()).toBeVisible()
  await s.assertNoErrors()
})

test('voice in: model download with progress, cancel, use and delete; silence slider; mic test; echo test; barge-in rules @R19 @R20 @R17', async () => {
  const catalog = path.join(os.tmpdir(), `vesper-vc-catalog-${process.pid}.json`)
  fs.writeFileSync(catalog, JSON.stringify([mock.models.catalogEntry({ id: 'mock-model' })]))
  try {
    const v = await voiceServer(mock, { tts: false, fakeMic: HELLO_WAV, env: { VESPER_STT_TEST_CATALOG: catalog } })
    s = v.s
    await s.hook('go', '/settings/voice-in')
    await s.waitReady()
    const page = s.page
    const api = pageApi(page)
    await expect(page.getByRole('heading', { name: 'Voice in', level: 1 })).toBeVisible()
    // Local recognition is the default, with Parakeet recommended.
    await expect(page.getByTestId('stt-model-parakeet-tdt-0.6b-v3-int8')).toContainText('487 MB download')

    // Download (throttled) → progress → cancel → download again → use → delete.
    const row = page.getByTestId('stt-model-mock-model')
    mock.models.throttle(1500)
    await row.getByRole('button', { name: 'Download' }).click()
    await expect(row.getByRole('progressbar')).toBeVisible()
    await row.getByRole('button', { name: 'Cancel' }).click()
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 15_000 })
    mock.models.throttle(0)
    await row.getByRole('button', { name: 'Download' }).click()
    await expect(row.getByText('Downloaded')).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: 'Use this model' }).click()
    await expect(row.getByText('In use')).toBeVisible()
    await expect.poll(async () => (await api<{ voice: { stt: { model: string } } }>('GET', '/api/settings')).json.voice.stt.model).toBe('mock-model')
    await row.getByRole('button', { name: 'Delete Mock model (tests)' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 15_000 })

    // Voice barge-in needs headphones or a passed echo test (07 C15).
    await expect(page.getByRole('radio', { name: /Just start talking/ })).toBeDisabled()
    await page.getByRole('switch', { name: /I use headphones/ }).click()
    await expect(page.getByRole('radio', { name: /Just start talking/ })).toBeEnabled()
    // The silence slider: 300–5000 ms, default 1.2 s.
    const slider = page.getByRole('slider', { name: 'Pause before sending' })
    await expect(slider).toHaveAttribute('aria-valuenow', '1200')
    await slider.focus()
    await slider.press('ArrowRight')
    await expect.poll(async () => (await api<{ voice: { stt: { silenceMs: number } } }>('GET', '/api/settings')).json.voice.stt.silenceMs).toBe(1300)

    // Mic test: the fake microphone moves the meter; stopping releases the capture.
    const test1 = page.getByTestId('mic-test')
    await test1.getByRole('button', { name: 'Test microphone' }).click()
    await expect(test1.getByText('Your microphone works.')).toBeVisible({ timeout: 15_000 })
    await test1.getByRole('button', { name: 'Stop test' }).click()
    await expect.poll(async () => (await s!.hook<{ streams: number }>('audio.counters')).streams).toBe(0)

    // Echo test: plays the sweep through the engine while listening and stores a verdict for this device.
    const echo = page.getByTestId('echo-test')
    await echo.getByRole('button', { name: 'Run echo test' }).click()
    await expect(echo.getByRole('status')).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await s!.hook<{ streams: number; replies: number }>('audio.counters')).streams).toBe(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vesper.device.voice.v1') ?? '{}').echoTest?.at > 0)).toBe(true)

    await page.locator(':focus').blur().catch(() => undefined)
    await expectAxeClean(page)
    await shots(page, 'settings-voice-in', { scroll: '.settings__body' })
    await s.assertNoErrors()
  } finally {
    fs.rmSync(catalog, { force: true })
  }
})

test('wizard steps 4 and 5 render, pass axe, and step 4 enables voice once a voice is chosen @R3 @R12 @R19', async () => {
  const v = await voiceServer(mock)
  s = v.s
  await s.hook('go', '/voice-lab?view=wizard-out')
  await s.waitReady()
  const page = s.page
  await expect(page.getByRole('heading', { name: /Give .* a voice/ })).toBeVisible()
  await expect(page.getByText('3 voices available.')).toBeVisible()
  // The wizard's one navigation bar (StepPreview on the lab page): Continue reads "Use this voice" on this step.
  await expect(page.getByRole('button', { name: 'Use this voice' })).toBeEnabled()
  // H-v11-tone: the voice tones choice is on this step too, with its sentence and the placement under it.
  const modes = page.locator('#vs-tts-tone-mode')
  await expect(modes.getByRole('radio', { name: 'Follow the conversation' })).toBeChecked()
  await expect(modes.getByRole('radio', { name: 'Off' })).toBeVisible()
  await expect(modes.getByRole('radio', { name: 'Every reply' })).toBeVisible()
  await expect(page.locator('#vs-tts-tone-placement')).toBeVisible()
  await expectAxeClean(page)
  await shots(page, 'wizard-voice-out', { scroll: '.vlab--wizard' })

  await s.hook('go', '/voice-lab?view=wizard-in')
  await s.waitReady()
  await expect(page.getByRole('heading', { name: /Talk to/ })).toBeVisible()
  await expect(page.getByTestId('mic-test')).toBeVisible()
  await expectAxeClean(page)
  await shots(page, 'wizard-voice-in', { scroll: '.vlab--wizard' })
  await s.assertNoErrors()
})
