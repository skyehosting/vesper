/**
 * Soak 4 (LEAK-1 row 4): Talk mode for 30 minutes on a fake microphone that keeps talking (a WAV of the fixture
 * phrase every few seconds), each utterance → scripted STT → reply → spoken by the mock voice → re-arm; then 100 Talk
 * mode open/close cycles and 100 session switches. Gates:
 *   WebGL contexts ever created ≤ 1 (getContext wrapper, 07 D5); mic tracks live ≤ 1 during, 0 after;
 *   the Star's frame scheduler never runs more rAF callbacks than the display (review F44);
 *   STT utility RSS ≤ its post-load RSS + 50 MB; renderer heap +≤ 15 MB and server heap +≤ 10 MB (flat trends);
 *   after the cycles: WS listeners/subscriptions, audio streams/ports and Talk's timers back to baseline.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { encodeWav, parseWav } from '../mocks/audio'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { AUDIO_FIXTURES } from '../e2e/stt'
import { cycles, finish, installPageCounters, pageCounters, Recorder, renderer, SCALE, server, settle, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null
let wavPath = ''

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
  if (wavPath) fs.rmSync(path.dirname(wavPath), { recursive: true, force: true })
})

/** The fixture phrase, then `gapSec` of silence, repeated for `totalSec` (16 kHz mono). */
function talkingMic(totalSec: number, gapSec: number): string {
  const hello = parseWav(fs.readFileSync(path.join(AUDIO_FIXTURES, 'hello.wav')))
  const rate = hello.sampleRate
  const unit = hello.pcm.length + Math.round(gapSec * rate)
  const reps = Math.ceil((totalSec * rate) / unit)
  const pcm = new Int16Array(unit * reps)
  for (let i = 0; i < reps; i++) pcm.set(hello.pcm, i * unit)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-soak-mic-'))
  const file = path.join(dir, 'talking.wav')
  fs.writeFileSync(file, encodeWav(pcm, rate))
  return file
}

interface MicStats {
  active: boolean
}

test('Talk mode for 30 minutes, then 100 Talk visits and 100 session switches: one context, one mic, flat memory @R19 @R15 @R17', async () => {
  const minutes = Math.max(1, Math.round(30 * SCALE))
  const visits = cycles(100, 10)
  const switches = cycles(100, 10)
  test.setTimeout((minutes + 25) * 60_000)
  const rec = new Recorder('talk-mode')
  rec.cycles('talk minutes', minutes)
  rec.cycles('talk open/close', visits)
  rec.cycles('session switches', switches)
  mock.llm.setDefault({ text: 'I hear you. Tell me more.' })
  wavPath = talkingMic(minutes * 60 + 600, 6)

  s = await launchServer({ mock, open: false, login: 'desktop', fakeMic: wavPath, env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Hello Vesper, can you hear me?' }, timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  await configureMockLlm(s.api, mock.url)
  await steady(s.api)
  expect((await s.api('PATCH', '/api/settings', { voice: { stt: { enabled: true, silenceMs: 800 }, tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })).status).toBe(200)
  expect((await s.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-soak-key' })).status).toBe(200)
  const talk = await createSession(s.api, 'Soak: talk')
  const others = [await createSession(s.api, 'Soak: a'), await createSession(s.api, 'Soak: b'), await createSession(s.api, 'Soak: c')]
  await s.page.reload()
  await s.waitReady()
  await s.waitHook('presence.surface')
  await s.hook('presence.setFocus', true)
  await s.hook('go', '/settings')
  await settle(s)
  const wsBase = await s.hook<{ listeners: number; subscriptions: number; binary: number }>('ws.stats')

  // ── 30 minutes of hands-free conversation ──
  await s.hook('go', `/talk/${talk.uid}`)
  await settle(s)
  await expect(s.page.locator('.talk__captions')).toContainText('I hear you', { timeout: 60_000 })
  const sampleMs = Math.max(30_000, Math.round((minutes * 60_000) / 10))
  const heap: number[] = [(await renderer(s.page)).heapMB]
  const first = await server(s.url)
  const srvHeap: number[] = [first.heapUsedMB]
  const sttLoad = first.stt?.process?.rssMB ?? 0
  const sttRss: number[] = [sttLoad]
  let worstCallbacksPerSec = 0
  let worstMicLive = 0
  const t0 = Date.now()
  while (Date.now() - t0 < minutes * 60_000) {
    await s.page.waitForTimeout(Math.min(sampleMs, minutes * 60_000 - (Date.now() - t0)) || 1)
    // The frame scheduler over one second against the display's own rAF rate (one loop, review F44).
    const r = await s.page.evaluate(async () => {
      const w = window as unknown as { __vesperTest: { presence: { resetFrames(): void; frames(): { callbacks: number } } } }
      let ref = 0
      let on = true
      const tick = (): void => {
        ref++
        if (on) requestAnimationFrame(tick)
      }
      w.__vesperTest.presence.resetFrames()
      requestAnimationFrame(tick)
      await new Promise((res) => setTimeout(res, 1000))
      on = false
      return { ref, callbacks: w.__vesperTest.presence.frames().callbacks }
    })
    worstCallbacksPerSec = Math.max(worstCallbacksPerSec, r.callbacks - r.ref)
    const audio = await s.hook<{ streams: number }>('audio.counters')
    worstMicLive = Math.max(worstMicLive, audio.streams)
    heap.push((await renderer(s.page)).heapMB)
    const l = await server(s.url)
    srvHeap.push(l.heapUsedMB)
    sttRss.push(l.stt?.process?.rssMB ?? 0)
  }
  const turns = (await s.api<{ items: Array<{ role: string }> }>('GET', `/api/sessions/${talk.uid}/messages?mode=latest&limit=300`)).json.items.filter((m) => m.role === 'user').length
  rec.note(`spoken turns in ${minutes} min: ${turns}${turns >= 300 ? '+' : ''}`)
  rec.atLeast('spoken turns (≥ 1 per minute)', turns, minutes)
  rec.check('scheduler rAF callbacks over the display, worst (per s)', worstCallbacksPerSec, 3)
  rec.check('mic tracks live during Talk, worst', worstMicLive, 1)
  rec.gate({ name: 'renderer heap after GC (Talk)', unit: 'MB', values: heap, threshold: 15 })
  rec.gate({ name: 'server heap after GC (Talk)', unit: 'MB', values: srvHeap, threshold: 10 })
  rec.gate({ name: 'STT utility RSS (over load)', unit: 'MB', values: sttRss, threshold: 50 })

  // ── 100 Talk visits and 100 session switches ──
  for (let i = 0; i < visits; i++) {
    await s.hook('go', `/talk/${talk.uid}`)
    await s.waitReady()
    await s.page.waitForTimeout(150)
    await s.hook('go', `/s/${talk.uid}`)
    await s.waitReady()
  }
  for (let i = 0; i < switches; i++) {
    await s.hook('go', `/s/${others[i % others.length].uid}`)
    await s.waitReady()
  }
  await s.hook('go', '/settings')
  await settle(s, 1500)
  const pc = await pageCounters(s.page)
  rec.check('WebGL contexts ever created', pc.glContexts, 1)
  const gl = await s.hook<{ live: number }>('presence.gl')
  rec.check('WebGL contexts alive', gl.live, 1)
  await expect.poll(async () => (await s!.hook<MicStats>('audio.micStats')).active, { timeout: 10_000 }).toBe(false)
  const audio = await s.hook<{ streams: number; ports: number }>('audio.counters')
  rec.check('mic streams after Talk', audio.streams, 0)
  rec.check('mic worklet ports after Talk', audio.ports, 0)
  const wsAfter = await s.hook<{ listeners: number; subscriptions: number; binary: number }>('ws.stats')
  rec.check('WS listeners over baseline', wsAfter.listeners - wsBase.listeners, 0)
  rec.check('WS subscriptions over baseline', wsAfter.subscriptions - wsBase.subscriptions, 0)
  rec.check('Talk timers left', (await s.hook<{ timers: number }>('presence.driver')).timers, 1)
  const srv = await server(s.url)
  rec.check('STT mic sessions left', (srv.stt?.mics ?? 0) + (srv.stt?.byMic ?? 0), 0)
  rec.check('server speech jobs left', srv.speech?.jobs ?? 0, 0)
  rec.note(`blob URLs made ${pc.blobsMade}, outstanding ${pc.blobs}`)
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
