/**
 * audio-core in the desktop window (07 B11, G5, spike S6): the AudioWorklet loads under the app's CSP, the mic goes
 * through Electron's permission handlers (audio-only `media` for our origin, no fake-UI switch) fed by VESPER_FAKE_MIC,
 * and speech chunks play through the engine with the window muted (test mode).
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeWav, synthSpeech } from '../../mocks/audio'
import { launchApp, removeDirs, type TestApp } from '../launch'

let t: TestApp | null = null
let wavDir = ''

test.afterEach(async () => {
  await t?.close()
  t = null
  if (wavDir) removeDirs([wavDir])
})

test('desktop window: speech plays gapless and the fake mic yields 16 kHz frames @R14 @R19', async () => {
  wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-mic-'))
  const wav = path.join(wavDir, 'mic.wav')
  fs.writeFileSync(wav, encodeWav(synthSpeech(Array.from({ length: 8 }, () => 'hello from the desktop window').join(' '), { sampleRate: 48000, amplitude: 0.5 }).pcm, 48000))
  t = await launchApp({ fakeMic: wav })
  await t.hook('go', '/gallery')
  await t.waitReady()
  await t.page.getByTestId('audio-unlock').click()
  await expect.poll(() => t?.hook<boolean>('audio.unlocked')).toBe(true)
  await t.hook('audio.clearEvents')

  const replyId = await t.hook<string>('audioGallery.playSpeech', { chunks: 4, charMs: 25 })
  await expect
    .poll(async () => ((await t?.hook<Array<{ type: string; replyId: string }>>('audio.events')) ?? []).some((e) => e.replyId === replyId && e.type === 'replyEnd'), { timeout: 20_000 })
    .toBe(true)
  const evs = (await t.hook<Array<{ type: string; replyId: string }>>('audio.events')).filter((e) => e.replyId === replyId)
  expect(evs.filter((e) => e.type === 'chunkStart')).toHaveLength(4)
  expect(evs.filter((e) => e.type === 'underrun')).toHaveLength(0)

  expect(await t.hook<string>('audioGallery.startMic')).toBe('ok')
  await expect.poll(async () => (await t?.hook<{ frames: number }>('audio.micStats'))?.frames ?? 0, { timeout: 10_000 }).toBeGreaterThan(40)
  const st = await t.hook<{ frames: number; firstFrameAt: number; lastFrameAt: number; frameSamples: number }>('audio.micStats')
  expect(st.frameSamples).toBe(512)
  const fps = ((st.frames - 1) * 1000) / (st.lastFrameAt - st.firstFrameAt)
  expect(fps).toBeGreaterThan(28)
  expect(fps).toBeLessThan(34.5)
  await t.hook('audioGallery.stopMic')
  const c = await t.hook<{ streams: number; ports: number }>('audio.counters')
  expect(c.streams).toBe(0)
  expect(c.ports).toBe(0)
  await t.assertNoErrors()
})
