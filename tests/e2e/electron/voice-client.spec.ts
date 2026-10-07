/**
 * voice-client in the desktop window @R19 @R14: the mic button captures through Electron's permission handler (audio
 * `media` only for our origin, 07 B11/G5) with the fake microphone, the utility-process recognizer transcribes it into
 * the composer, and a spoken reply plays through the window's AudioEngine (muted in test mode).
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import { HELLO_TEXT, HELLO_WAV } from '../voice'

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

test('desktop: dictate with the mic button, then hear a spoken reply @R19 @R14', async () => {
  t = await launchApp({ mock, fakeMic: HELLO_WAV, env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: HELLO_TEXT } })
  await configureMockLlm(t.api, mock.url)
  expect((await t.api('PATCH', '/api/settings', { voice: { stt: { enabled: true, silenceMs: 800 }, tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })).status).toBe(200)
  expect((await t.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const session = await createSession(t.api, 'Desktop voice')
  await t.page.reload()
  await t.waitReady()
  await t.hook('go', `/voice-lab?view=composer&session=${session.uid}&mode=dictate`)
  await t.waitReady()
  const page = t.page
  await page.getByRole('button', { name: 'Dictate' }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(HELLO_TEXT, { timeout: 25_000 })
  mock.llm.script({ text: 'Yes, loud and clear from the desktop.' })
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('lab-reply')).toHaveAttribute('data-speech', 'done', { timeout: 30_000 })
  await expect(page.getByTestId('lab-reply-text')).toHaveText('Yes, loud and clear from the desktop.')
  const counters = await t.hook<{ streams: number; ports: number }>('audio.counters')
  expect(counters).toMatchObject({ streams: 0, ports: 0 })
  await t.assertNoErrors()
})
