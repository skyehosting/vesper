/**
 * audio-core acceptance (BLD-13, 07 E4/C14/C15/D4) on /gallery in headless Chromium with the fake microphone:
 * gapless scheduling, output levels, 16 kHz mic frames at real-time rate, the synced reveal landing on the audio end,
 * barge-in freezing the reveal, idle suspend/resume, and every resource counter back to baseline after many cycles.
 *
 * Audio is muted twice over in test mode (Chromium --mute-audio and the engine's gain 0); scheduling, the audio clock
 * and the analyser (before the gain) are unaffected.
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeWav, synthSpeech } from '../../mocks/audio'
import { launchServer, removeDirs, type TestServer } from '../launch'

interface Ev {
  type: 'chunkStart' | 'chunkEnd' | 'replyEnd' | 'underrun'
  replyId: string
  index?: number
  at?: number
  /** Engine clock (what is heard now) at dispatch. */
  wall: number
  /** AudioContext.currentTime (render clock, ahead of the heard clock by the output latency) at dispatch. */
  render: number
  interrupted?: boolean
}

interface Counters {
  nodes: number
  sources: number
  buffers: number
  contexts: number
  ports: number
  streams: number
  timers: number
  replies: number
  reveals: number
}

interface RevealLog {
  replyId: string
  status: 'done' | 'frozen' | 'finished'
  at: number
  audioEndAt: number | null
  chars: number
}

let s: TestServer
let wavDir = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-mic-'))
  const wav = path.join(wavDir, 'mic.wav')
  // ~12 s of word bursts at 48 kHz: longer than any capture in this file (the fake device stops at the end: %noloop).
  const text = Array.from({ length: 14 }, () => 'speak to me about the stars tonight').join(' ')
  const speech = synthSpeech(text, { sampleRate: 48000, amplitude: 0.5 })
  fs.writeFileSync(wav, encodeWav(speech.pcm, 48000))
  s = await launchServer({ fakeMic: wav })
  await s.hook('go', '/gallery')
  await s.waitReady()
  await expect(s.page.getByTestId('audio-gallery')).toBeVisible()
  // A real click is the user gesture browsers require before audio may start (research 07 §2.5).
  await s.page.getByTestId('audio-unlock').click()
  await expect.poll(() => s.hook<boolean>('audio.unlocked')).toBe(true)
  await s.hook('audio.clearEvents')
})

test.afterAll(async () => {
  await s?.close()
  if (wavDir) removeDirs([wavDir])
})

async function events(replyId?: string): Promise<Ev[]> {
  const all = await s.hook<Ev[]>('audio.events')
  return replyId ? all.filter((e) => e.replyId === replyId) : all
}

async function waitReplyEnd(replyId: string, timeout = 20_000): Promise<Ev> {
  await expect.poll(async () => (await events(replyId)).some((e) => e.type === 'replyEnd'), { timeout }).toBe(true)
  return (await events(replyId)).find((e) => e.type === 'replyEnd') as Ev
}

/** Counters, with `timers` excluding the host's idle-suspend timer (armed or not depending on the last activity). */
async function counters(): Promise<Counters> {
  const c = await s.hook<Counters>('audio.counters')
  if (await s.hook<boolean>('audio.idleArmed')) c.timers--
  return c
}

/** Ranges in the shared `vesper-unrevealed` highlight (0 when no reply is hidden or frozen). */
const unrevealedRanges = (): Promise<number> =>
  // The e2e tsconfig has no DOM.Iterable, so the maplike HighlightRegistry is read through a Map view.
  s.page.evaluate(() => (CSS.highlights as unknown as Map<string, { size: number }>).get('vesper-unrevealed')?.size ?? 0)

/** Steady-state counters: no reply, source, buffer, stream or port alive (timers: at most the idle-suspend one). */
async function settled(): Promise<Counters> {
  await expect
    .poll(async () => {
      const c = await counters()
      return c.replies + c.sources + c.buffers + c.ports + c.streams
    })
    .toBe(0)
  return counters()
}

for (const format of ['wav', 'l16'] as const) {
  test(`plays 10 ${format} chunks back to back with no underrun @R14 @R12`, async () => {
    const replyId = await s.hook<string>('audioGallery.playSpeech', { chunks: 10, format, charMs: 25 })
    const end = await waitReplyEnd(replyId)
    expect(end.interrupted).toBe(false)
    const ev = await events(replyId)
    const starts = ev.filter((e) => e.type === 'chunkStart')
    const ends = ev.filter((e) => e.type === 'chunkEnd')
    expect(starts.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ends.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ev.filter((e) => e.type === 'underrun')).toEqual([])
    // Gapless: every chunk starts where the previous one ended on the audio clock (BLD-13: gap < 5 ms).
    for (let k = 1; k < 10; k++) expect(Math.abs((starts[k].at as number) - (ends[k - 1].at as number))).toBeLessThan(5)
    // Events are delivered close to the audio they describe.
    for (const e of starts) expect(Math.abs(e.wall - (e.at as number))).toBeLessThan(60)
    // chunkEnd reports the scheduled end; the render clock had reached it when the event was delivered.
    for (const e of ends) expect(e.render).toBeGreaterThanOrEqual((e.at as number) - 5)
    await s.assertNoErrors()
  })
}

test('output levels move while speech plays and decay after @R15', async () => {
  await s.hook('audioGallery.resetPeaks')
  const replyId = await s.hook<string>('audioGallery.playSpeech', { chunks: 4 })
  await waitReplyEnd(replyId)
  const peaks = await s.hook<{ output: number; outputOnset: number }>('audioGallery.peaks')
  expect(peaks.output).toBeGreaterThan(0.3)
  expect(peaks.outputOnset).toBeGreaterThan(0.5)
  // Nothing plays: the envelope releases (250 ms) to ~0.
  await expect.poll(async () => (await s.hook<{ rms: number }>('audio.readOutput')).rms, { timeout: 5000 }).toBeLessThan(0.02)
})

test('fake microphone delivers 512-sample 16 kHz frames at real-time rate @R19', async () => {
  const before = await settled()
  await s.hook('audioGallery.resetPeaks')
  expect(await s.hook<string>('audioGallery.startMic')).toBe('ok')
  await expect.poll(async () => (await s.hook<{ frames: number }>('audio.micStats')).frames).toBeGreaterThan(5)
  await s.page.waitForTimeout(3000)
  const st = await s.hook<{ active: boolean; frames: number; firstFrameAt: number; lastFrameAt: number; frameSamples: number; settings: { echoCancellation?: boolean } }>('audio.micStats')
  expect(st.active).toBe(true)
  expect(st.frameSamples).toBe(512)
  const fps = ((st.frames - 1) * 1000) / (st.lastFrameAt - st.firstFrameAt)
  // 16000 / 512 = 31.25 frames per second.
  expect(fps).toBeGreaterThan(28)
  expect(fps).toBeLessThan(34.5)
  expect(st.settings.echoCancellation).toBe(true)
  expect((await s.hook<{ input: number }>('audioGallery.peaks')).input).toBeGreaterThan(0.2)
  const during = await counters()
  expect(during.streams).toBe(before.streams + 1)
  expect(during.ports).toBe(before.ports + 1)
  await s.hook('audioGallery.stopMic')
  const after = await settled()
  expect(after.nodes).toBe(before.nodes)
  expect((await s.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)
})

test('synced reveal: text hidden until its audio, last letter within 50 ms of the audio end @R14', async () => {
  const replyId = await s.hook<string>('audioGallery.revealDemo')
  // Held: nothing revealed before the first chunk's audio starts.
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBeLessThan(0.05)
  expect(await s.page.getByTestId('reveal-demo').getAttribute('aria-busy')).toBe('true')
  await expect.poll(() => s.hook<number>('audio.revealProgress', replyId)).toBeGreaterThan(0.3)
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBeLessThan(1)
  const end = await waitReplyEnd(replyId)
  await expect.poll(async () => (await s.hook<RevealLog[]>('audio.revealLog')).some((l) => l.replyId === replyId)).toBe(true)
  const log = (await s.hook<RevealLog[]>('audio.revealLog')).find((l) => l.replyId === replyId) as RevealLog
  expect(log.status).toBe('done')
  expect(log.audioEndAt).not.toBeNull()
  // The reveal runs on the heard clock (output timestamp): its last letter lands on the final chunk's end.
  expect(Math.abs(log.at - (log.audioEndAt as number))).toBeLessThanOrEqual(50)
  // And that end is real: the render thread finished the last source right then (onended → replyEnd).
  expect(end.render - (log.audioEndAt as number)).toBeGreaterThanOrEqual(-5)
  expect(end.render - (log.audioEndAt as number)).toBeLessThanOrEqual(50)
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBe(1)
  // Highlights are gone and the root is back to normal.
  expect(await unrevealedRanges()).toBe(0)
  expect(await s.page.getByTestId('reveal-demo').getAttribute('aria-busy')).toBeNull()
  await s.assertNoErrors()
})

test('barge-in stops the audio with a fade and freezes the reveal; finish shows the rest @R14 @R19', async () => {
  const replyId = await s.hook<string>('audioGallery.revealDemo')
  await expect.poll(() => s.hook<number>('audio.revealProgress', replyId)).toBeGreaterThan(0.2)
  await s.hook('audio.stop', replyId)
  const end = await waitReplyEnd(replyId)
  expect(end.interrupted).toBe(true)
  expect(await s.hook<string>('audio.revealState', replyId)).toBe('frozen')
  const frozen = await s.hook<number>('audio.revealProgress', replyId)
  expect(frozen).toBeGreaterThan(0.2)
  expect(frozen).toBeLessThan(1)
  await s.page.waitForTimeout(400)
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBe(frozen)
  expect(await unrevealedRanges()).toBe(1)
  await s.page.getByRole('button', { name: 'Show rest' }).click()
  expect(await s.hook<number>('audio.revealProgress', replyId)).toBe(1)
  expect(await unrevealedRanges()).toBe(0)
  await settled()
})

test('idle context suspends and resumes on the next chunk @R15', async () => {
  await settled()
  await s.hook('audio.setIdleMs', 300)
  await expect.poll(() => s.hook<string>('audio.contextState')).toBe('suspended')
  const replyId = await s.hook<string>('audioGallery.playSpeech', { chunks: 2, charMs: 25 })
  const end = await waitReplyEnd(replyId)
  expect(end.interrupted).toBe(false)
  expect((await events(replyId)).filter((e) => e.type === 'chunkStart')).toHaveLength(2)
  await s.hook('audio.setIdleMs', 30_000)
})

test('no node, buffer, source or timer leak after 20 play/stop cycles and 200 replies @R15', async () => {
  test.setTimeout(180_000)
  const base = await settled()
  for (let i = 0; i < 20; i++) {
    const replyId = await s.hook<string>('audioGallery.playSpeech', { chunks: 3, format: i % 2 ? 'l16' : 'wav' })
    await expect.poll(async () => (await events(replyId)).some((e) => e.type === 'chunkStart'), { timeout: 5000 }).toBe(true)
    await s.hook('audio.stop', replyId)
    await waitReplyEnd(replyId)
  }
  for (let i = 0; i < 5; i++) {
    expect(await s.hook<string>('audioGallery.startMic')).toBe('ok')
    await s.hook('audioGallery.stopMic')
  }
  expect(await s.hook<number>('audioGallery.playMany', 200)).toBe(200)
  const after = await settled()
  await expect.poll(async () => (await counters()).nodes).toBe(base.nodes)
  expect(after.contexts).toBe(1)
  expect(after.timers).toBe(base.timers)
  expect(after.reveals).toBeLessThanOrEqual(base.reveals)
  await s.assertNoErrors()
})
