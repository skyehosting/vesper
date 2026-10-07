/**
 * Voice input, server half (07 C17, D6) @R19: a browser device streams a speech fixture as mic frames over its
 * WebSocket; the standalone server's STT process (VESPER_STT_FAKE: real Silero VAD, scripted recognizer) endpoints
 * it after the silence setting and answers stt.final. A cloud provider (mock OpenAI) gets the utterance as a WAV.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, type TestServer } from '../launch'
import { fixturePcm, speechEndMs, wsDictation } from '../stt'

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

test('dictation over the WebSocket ends after the silence setting and returns the transcript @R19 @R20', async () => {
  s = await launchServer({ mock, env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Hello Vesper, can you hear me?' } })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  expect((await desktop.api('PATCH', '/api/settings', { voice: { stt: { silenceMs: 1000 } } })).status).toBe(200)

  const r = await wsDictation(s.page, fixturePcm('hello', { before: 300, after: 2500 }), { mode: 'conversation' })
  expect(r.final).toMatchObject({ text: 'Hello Vesper, can you hear me?', autoSend: true })
  expect(r.states.slice(0, 2)).toEqual(['warming-up', 'listening'])
  expect(r.states).toContain('transcribing')
  expect(r.events).toContain('stt.vad')
  // 07 D6: speech end → stt.final ≤ silence + 250 ms (audio clock; frames are paced in real time).
  const end = 300 + speechEndMs('hello')
  expect(r.audioMsAtFinal).toBeGreaterThanOrEqual(end + 1000 - 150)
  expect(r.audioMsAtFinal).toBeLessThanOrEqual(end + 1000 + 250)
  await s.assertNoErrors()
})

test('a cloud provider receives the utterance as WAV and its text comes back @R19', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  expect((await desktop.api('PATCH', '/api/settings', { voice: { stt: { provider: 'openai', model: 'gpt-4o-transcribe', silenceMs: 800 } } })).status).toBe(200)
  expect((await desktop.api('PUT', '/api/secrets/stt:openai', { value: 'sk-test-e2e-0000000000', forUrl: mock.url })).status).toBe(200)
  mock.stt.script('this came from the cloud')

  const r = await wsDictation(s.page, fixturePcm('search'), { mode: 'dictate' })
  expect(r.final).toMatchObject({ text: 'this came from the cloud', autoSend: false })
  const rec = mock.stt.received()
  expect(rec).toHaveLength(1)
  expect(rec[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-transcribe' })
  expect(rec[0].durationMs).toBeGreaterThan(speechEndMs('search') - 500)
  expect(mock.recorder.find('/v1/audio/transcriptions')[0]?.headers.authorization).toBe('Bearer sk-test-e2e-0000000000')
  await s.assertNoErrors()
})
