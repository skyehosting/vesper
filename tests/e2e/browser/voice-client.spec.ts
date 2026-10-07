/**
 * voice-client end to end (browser project; mock LLM + mock ElevenLabs + VESPER_STT_FAKE with the real Silero VAD and
 * the Chromium fake microphone playing tests/fixtures/audio/hello.wav):
 *   synced reveal + barge-in (typing stops the voice, the revealed text stays), the 6 s rule, dictation,
 *   push-to-talk, conversation (auto-send, re-arm after the voice), the countdown cancelled by typing, the "needs HTTPS"
 *   state, the latency overlay, and leak counters back to baseline after 20 voice turns. @R14 @R17 @R19
 */
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { latestMessages } from '../helpers'
import { pageApi, type TestServer } from '../launch'
import { speechEndMs } from '../stt'
import { expectAxeClean, goLab, HELLO_TEXT, HELLO_WAV, SHOT_DIR, shots, voiceServer } from '../voice'

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

const STORY =
  'Once upon a time there was a lighthouse keeper who loved the storms. Every night she climbed the hundred steps and lit the lamp. ' +
  'The ships passed safely, and the sea sang to her in a low and patient voice. One winter a small boat came too close to the rocks.'

const STT_ENV = { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: HELLO_TEXT }

interface VoiceStateLite {
  stt: string
  partial: string
  micMode: string | null
  micHeld: boolean
  countdown: { endsAt: number; totalMs: number } | null
  speakingReplyId: string | null
  ttsActive: boolean
}

async function voiceState(s: TestServer): Promise<VoiceStateLite> {
  return s.hook<VoiceStateLite>('voice.state')
}

async function labSend(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

function reply(page: Page) {
  return page.getByTestId('lab-reply')
}

test('synced reveal speaks the reply; typing in the composer barges in and keeps the revealed text @R14 @R13', async () => {
  const v = await voiceServer(mock)
  s = v.s
  mock.llm.script({ text: STORY, chunkChars: 24 })
  await goLab(s, `view=composer&session=${v.sessionUid}`)
  const page = s.page
  await s.hook('voice.latency', true)
  await labSend(page, 'Tell me a story')
  await expect(reply(page)).toHaveAttribute('data-speech', 'speaking', { timeout: 15_000 })
  const text = page.getByTestId('lab-reply-text')
  // The held text arrives with its audio (no reply.delta to the speaker) and is revealed in time with it.
  await expect(text).not.toBeEmpty()
  await page.waitForTimeout(900)
  const replyId = (await s.hook<string[]>('voice.speechIds'))[0]
  expect(await s.hook('audio.revealState', replyId)).toBe('revealing')

  // Barge-in by typing (07 C15): the voice stops at once, what was revealed stays, the rest is one click away.
  await page.getByRole('textbox', { name: 'Message' }).pressSequentially('w')
  await expect(reply(page)).toHaveAttribute('data-speech', 'interrupted')
  expect(await s.hook('audio.revealState', replyId)).toBe('frozen')
  expect(((await s.hook<{ playing: number }>('audio.stats')).playing)).toBe(0)
  // Part of the reply is revealed and stays revealed; the rest stays hidden until "show rest".
  const progress = await s.hook<number>('audio.revealProgress', replyId)
  expect(progress).toBeGreaterThan(0)
  expect(progress).toBeLessThan(1)
  await page.waitForTimeout(400)
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBe(progress)
  expect(STORY.startsWith(((await text.textContent()) ?? '').trim().slice(0, 40))).toBe(true)
  // speech.cancel told the server how far the voice got (an offset into the reply, inside what was revealed).
  const cancels = await s.hook<Array<{ replyId: string; spokenChars: number }>>('voice.cancels')
  expect(cancels).toHaveLength(1)
  expect(cancels[0].replyId).toBe(replyId)
  expect(cancels[0].spokenChars).toBeGreaterThan(0)
  expect(cancels[0].spokenChars).toBeLessThan(STORY.length)
  await page.getByRole('button', { name: '— interrupted · show rest' }).click()
  await expect.poll(() => s!.hook('audio.revealState', replyId)).toBe('done')

  // The latency overlay (test builds, 07 D6) shows the client's marks for the reply.
  await expect(page.getByTestId('latency-overlay')).toBeVisible()
  const rows = await s.hook<Array<{ replyId: string; client: Record<string, number> }>>('voice.latencyRows')
  expect(rows.find((r) => r.replyId === replyId)?.client.firstAudio).toBeGreaterThan(0)
  await shots(page, 'lab-interrupted')
  await s.assertNoErrors()
})

test('a chunk not ready within 6 s fails the reply to text-first with a "Voice unavailable" toast @R14', async () => {
  const v = await voiceServer(mock)
  s = v.s
  mock.llm.script({ text: 'This reply has to wait for a very slow voice. It should still be readable as text.' })
  mock.tts.setDelay(8000)
  await goLab(s, `view=composer&session=${v.sessionUid}`)
  const page = s.page
  await labSend(page, 'Say something slowly')
  await expect(reply(page)).toHaveAttribute('data-speech', 'waiting')
  await expect(reply(page)).toHaveAttribute('data-speech', 'failed', { timeout: 12_000 })
  await expect(page.getByText(/Voice unavailable/)).toBeVisible()
  expect((await s.hook<Array<{ reason: string }>>('voice.failures'))[0]?.reason).toBe('timeout')
  // Text-first: the whole reply is readable.
  await expect(page.getByTestId('lab-reply-text')).toHaveText(/should still be readable as text/)
  await shots(page, 'lab-voice-unavailable', { sizes: [{ w: 1138, h: 608 }] })
  mock.tts.setDelay(0)
  await s.assertNoErrors()
})

test('dictation: the fake mic is transcribed into the composer; the mic shows listening, then releases everything @R19', async () => {
  const v = await voiceServer(mock, { tts: false, fakeMic: HELLO_WAV, env: STT_ENV, stt: { enabled: true, silenceMs: 900 } })
  s = v.s
  await goLab(s, `view=composer&session=${v.sessionUid}&mode=dictate`)
  const page = s.page
  const mic = page.getByRole('button', { name: 'Dictate' })
  await expect(mic).toBeVisible()
  await mic.click()
  await expect.poll(async () => (await voiceState(s!)).stt, { timeout: 10_000 }).toMatch(/warming-up|listening|transcribing/)
  await expect(page.getByTestId('mic-bubble')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(HELLO_TEXT, { timeout: 20_000 })
  await expect.poll(async () => (await s!.hook<{ mic: { active: boolean; capture: boolean; listeners: number; timers: number } }>('voice.stats')).mic).toMatchObject({ active: false, capture: false, listeners: 0, timers: 0 })
  // Dictation never sends by itself (autoSendDictation is off).
  expect((await latestMessages(pageApi(page), v.sessionUid)).length).toBe(0)
  await s.assertNoErrors()
})

test('typing during the silence countdown cancels the auto-send: the words go to the composer instead @R19', async () => {
  const v = await voiceServer(mock, { tts: false, fakeMic: HELLO_WAV, env: STT_ENV, stt: { enabled: true, silenceMs: 2500, autoSendDictation: true } })
  s = v.s
  await goLab(s, `view=composer&session=${v.sessionUid}&mode=dictate`)
  const page = s.page
  await page.getByRole('button', { name: 'Dictate' }).click()
  // The countdown ring appears when the speech pauses (stt.vad endpointInMs); the fixture has a short pause mid-
  // sentence too, so wait for the one after its last word.
  await expect.poll(async () => (await voiceState(s!)).stt, { timeout: 10_000 }).toBe('listening')
  await page.waitForTimeout(speechEndMs('hello'))
  await expect.poll(async () => (await voiceState(s!)).countdown !== null, { timeout: 20_000 }).toBe(true)
  await expect(page.locator('.mic__ring')).toBeVisible()
  await expect(page.getByTestId('mic-bubble')).toContainText('Sending soon')
  await shots(page, 'lab-countdown', { sizes: [{ w: 1138, h: 608 }] })
  await page.locator('[data-testid=mic-control]').screenshot({ path: path.join(SHOT_DIR, 'mic-countdown-detail.png') })
  await page.getByRole('textbox', { name: 'Message' }).pressSequentially('Also: ')
  await expect.poll(async () => (await voiceState(s!)).countdown).toBeNull()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(`Also:  ${HELLO_TEXT}`, { timeout: 15_000 })
  expect((await latestMessages(pageApi(page), v.sessionUid)).length).toBe(0)
  await s.assertNoErrors()
})

test('push-to-talk: hold the mic while talking, release sends @R19', async () => {
  const v = await voiceServer(mock, { tts: false, fakeMic: HELLO_WAV, env: STT_ENV, stt: { enabled: true } })
  s = v.s
  await goLab(s, `view=composer&session=${v.sessionUid}&mode=ptt`)
  const page = s.page
  const mic = page.getByRole('button', { name: 'Hold to talk' })
  const box = await mic.boundingBox()
  if (!box) throw new Error('no mic')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect.poll(async () => (await voiceState(s!)).micMode).toBe('ptt')
  await page.waitForTimeout(speechEndMs('hello') + 900)
  await page.mouse.up()
  await expect(page.locator('.vlab__user')).toHaveText(HELLO_TEXT, { timeout: 15_000 })
  await expect.poll(async () => (await latestMessages(pageApi(page), v.sessionUid)).find((m) => m.role === 'user')?.body).toBe(HELLO_TEXT)
  await expect.poll(async () => (await voiceState(s!)).micMode).toBeNull()

  // Keyboard only: Space held on the focused mic button talks, releasing sends.
  await mic.focus()
  await page.keyboard.down(' ')
  await expect.poll(async () => (await voiceState(s!)).micMode).toBe('ptt')
  await page.waitForTimeout(speechEndMs('hello') + 900)
  await page.keyboard.up(' ')
  await expect(page.locator('.vlab__user')).toHaveCount(2, { timeout: 15_000 })
  await expect.poll(async () => (await latestMessages(pageApi(page), v.sessionUid)).filter((m) => m.role === 'user').length).toBe(2)
  await s.assertNoErrors()
})

test('"Speak again" replays a stored reply with its own synced speech @R14 @R12', async () => {
  const v = await voiceServer(mock)
  s = v.s
  mock.llm.script({ text: 'The tide comes in twice a day. The moon pulls the water, and the sea follows.' })
  await goLab(s, `view=composer&session=${v.sessionUid}`)
  const page = s.page
  await labSend(page, 'Why are there tides?')
  await expect(reply(page)).toHaveAttribute('data-speech', 'done', { timeout: 20_000 })
  const msg = (await latestMessages(pageApi(page), v.sessionUid)).find((m) => m.role === 'assistant')
  if (!msg) throw new Error('no reply')
  const replay = await s.hook<string | null>('voice.speakAgain', msg.uid)
  expect(replay).toMatch(/^rp_/)
  expect((await s.hook<Record<string, string>>('voice.replays'))[msg.uid]).toBe(replay)
  await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', replay))?.state, { timeout: 15_000 }).toMatch(/speaking|done/)
  await expect.poll(async () => (await s!.hook<{ state: string; heldText: string } | null>('voice.speech', replay))?.state, { timeout: 20_000 }).toBe('done')
  expect((await s.hook<{ heldText: string }>('voice.speech', replay)).heldText).toBe(msg.body)
  await s.assertNoErrors()
})

test('"Speak again" with a stalled voice still gets the 6 s first-chunk deadline (speech.preparing beats the ack) @R14', async () => {
  const v = await voiceServer(mock)
  s = v.s
  mock.llm.script({ text: 'Rain falls when the clouds get heavy. The drops grow until the air cannot hold them.' })
  await goLab(s, `view=composer&session=${v.sessionUid}`)
  const page = s.page
  await labSend(page, 'Why does it rain?')
  await expect(reply(page)).toHaveAttribute('data-speech', 'done', { timeout: 20_000 })
  const msg = (await latestMessages(pageApi(page), v.sessionUid)).find((m) => m.role === 'assistant')
  if (!msg) throw new Error('no reply')
  // The replay's synthesis starts before the server acks speech.replay; the TTS then stalls for longer than 6 s.
  mock.tts.setDelay(9000)
  const replay = await s.hook<string | null>('voice.speakAgain', msg.uid)
  expect(replay).toMatch(/^rp_/)
  expect((await s.hook<{ state: string }>('voice.speech', replay)).state).toBe('waiting')
  await expect.poll(async () => (await s!.hook<Array<{ replyId: string; reason: string }>>('voice.failures')).find((f) => f.replyId === replay)?.reason, { timeout: 8_500 }).toBe('timeout')
  await expect(page.getByText(/Voice unavailable/)).toBeVisible()
  mock.tts.setDelay(0)
  await s.assertNoErrors()
})

test('conversation: hands-free send, the reply is spoken, the mic is held during the voice and re-arms after it @R19 @R14', async () => {
  const v = await voiceServer(mock, { fakeMic: HELLO_WAV, env: STT_ENV, stt: { enabled: true, silenceMs: 800 } })
  s = v.s
  mock.llm.script({ text: 'Yes, I can hear you clearly. How are you today?' })
  await goLab(s, `view=composer&session=${v.sessionUid}&mode=conversation`)
  const page = s.page
  await page.getByRole('button', { name: 'Start conversation' }).click()
  // The utterance is sent by itself (chat.send from the mic session).
  await expect.poll(async () => (await latestMessages(pageApi(page), v.sessionUid)).find((m) => m.role === 'user')?.body, { timeout: 20_000 }).toBe(HELLO_TEXT)
  // While the reply is pending and spoken, frames are held back (07 D6).
  await expect.poll(async () => (await voiceState(s!)).micHeld, { timeout: 10_000 }).toBe(true)
  await expect.poll(async () => (await voiceState(s!)).speakingReplyId !== null, { timeout: 15_000 }).toBe(true)
  // …and 250 ms after the voice ends, it listens again — still in conversation mode.
  await expect.poll(async () => (await voiceState(s!)).speakingReplyId, { timeout: 20_000 }).toBeNull()
  await expect.poll(async () => (await s!.hook<{ mic: { sent: number } }>('voice.stats')).mic.sent > 0).toBe(true)
  const sentBefore = (await s.hook<{ mic: { sent: number } }>('voice.stats')).mic.sent
  await expect.poll(async () => (await s!.hook<{ mic: { sent: number } }>('voice.stats')).mic.sent, { timeout: 5_000 }).toBeGreaterThan(sentBefore)
  const st = await voiceState(s)
  expect(st.micMode).toBe('conversation')
  expect(st.micHeld).toBe(false)
  await page.getByRole('button', { name: 'End conversation' }).click()
  await expect.poll(async () => (await voiceState(s!)).micMode).toBeNull()
  await s.assertNoErrors()
})

test('an insecure origin shows "needs HTTPS" with clear help instead of a dead mic @R19 @R1', async () => {
  const v = await voiceServer(mock, { tts: false, stt: { enabled: true } })
  s = v.s
  await s.hook('voice.simulateInsecure', true)
  await goLab(s, `view=composer&session=${v.sessionUid}`)
  const page = s.page
  const mic = page.getByRole('button', { name: 'Voice input needs HTTPS' })
  await expect(mic).toBeVisible()
  await mic.click()
  const dialog = page.getByRole('dialog', { name: 'Voice input needs HTTPS' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Local network (HTTPS)')
  await expectAxeClean(page)
  await shots(page, 'lab-needs-https', {
    prepare: async () => {
      if (!(await dialog.isVisible())) await mic.click()
    }
  })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await s.hook('go', '/settings/voice-in')
  await s.waitReady()
  await expect(page.getByText('Voice input needs HTTPS')).toBeVisible()
  await s.hook('voice.simulateInsecure', false)
  await s.assertNoErrors()
})

interface Counters {
  speech: { listeners: number; timers: number; live: number; records: number }
  mic: { active: boolean; listeners: number; timers: number; capture: boolean; early: number }
  prefsListeners: number
  earconNodes: number
}

test('leak counters return to baseline after 20 voice turns (mic + spoken reply) @R17 @R19 @R14', async () => {
  test.setTimeout(420_000)
  const v = await voiceServer(mock, { fakeMic: HELLO_WAV, env: STT_ENV, stt: { enabled: true, silenceMs: 600 } })
  s = v.s
  const page = s.page
  await goLab(s, `view=composer&session=${v.sessionUid}&mode=dictate`)
  // Warm-up turn so lazily created singletons (AudioContext, engine graph, worklet module) exist in the baseline.
  await page.getByRole('button', { name: 'Dictate' }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(HELLO_TEXT, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(reply(page)).toHaveAttribute('data-speech', 'done', { timeout: 30_000 })
  await s.hook('go', '/settings/voice-out')
  await s.waitReady()
  const audio0 = await s.hook<Record<string, number>>('audio.counters')
  const ws0 = await s.hook<Record<string, number>>('ws.stats')
  const v0 = await s.hook<Counters>('voice.stats')

  for (let i = 0; i < 20; i++) {
    await goLab(s, `view=composer&session=${v.sessionUid}&mode=dictate`)
    await page.getByRole('button', { name: 'Dictate' }).click()
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(HELLO_TEXT, { timeout: 20_000 })
    mock.llm.script({ text: `Turn ${i + 1}: I heard you. Here is a short spoken answer.` })
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(reply(page)).toHaveAttribute('data-speech', /done|failed/, { timeout: 30_000 })
    await s.hook('go', '/settings/voice-out')
    await s.waitReady()
  }
  await expect.poll(async () => (await s!.hook<Counters>('voice.stats')).speech.live, { timeout: 10_000 }).toBe(0)
  await page.waitForTimeout(600)
  const audio1 = await s.hook<Record<string, number>>('audio.counters')
  const ws1 = await s.hook<Record<string, number>>('ws.stats')
  const v1 = await s.hook<Counters>('voice.stats')
  for (const k of ['nodes', 'sources', 'buffers', 'ports', 'streams', 'replies', 'reveals']) expect(audio1[k], `audio.${k}`).toBe(audio0[k])
  expect(ws1.listeners).toBe(ws0.listeners)
  expect(ws1.binary).toBe(ws0.binary)
  expect(v1.mic).toMatchObject({ active: false, listeners: 0, timers: 0, capture: false, early: 0 })
  expect(v1.speech.timers).toBe(0)
  expect(v1.speech.listeners).toBe(v0.speech.listeners)
  expect(v1.speech.records).toBeLessThanOrEqual(64)
  expect(v1.prefsListeners).toBe(v0.prefsListeners)
  expect(v1.earconNodes).toBe(0)
  expect((await latestMessages(pageApi(page), v.sessionUid, 100)).filter((m) => m.role === 'user')).toHaveLength(21)
  await s.assertNoErrors()
})
