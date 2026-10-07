/**
 * Soak 3 (LEAK-1 row 3): 200 spoken replies (mock ElevenLabs with alignment, synced reveal) of which 50 are interrupted
 * by the composer's Stop (barge-in). At rest after the run: no scheduled AudioBufferSourceNode, one AudioContext at
 * most, the audio core's nodes / buffers / reply queues / reveals back to the warmed-up baseline, CSS.highlights empty;
 * renderer heap after GC +≤ 15 MB; the server's speech jobs drained.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { cycles, finish, installPageCounters, Recorder, renderer, server, settle, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

const LINES = [
  'The harbour lights came on one by one. Then the ferry sounded its horn.',
  'Tea is ready, and the rain has finally stopped over the hills.',
  'Once upon a time a lighthouse keeper counted the ships that passed her rock every night, and she never lost one of them.',
  'The cello sounds warmest in the evening, when the room is quiet.'
]

interface AudioCounters {
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

test('200 spoken replies with 50 barge-ins: audio nodes, contexts, highlights and heap back to rest @R14 @R17', async () => {
  const total = cycles(200, 12)
  const bargeEvery = 4
  test.setTimeout(20 * 60_000 + total * 15_000)
  const rec = new Recorder('voice-replies')
  rec.cycles('spoken replies', total)
  rec.cycles('barge-ins', Math.floor(total / bargeEvery))
  let n = 0
  mock.llm.setDefault(() => ({ text: LINES[n++ % LINES.length] }))

  s = await launchServer({ mock, open: false, login: 'desktop', timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  await configureMockLlm(s.api, mock.url)
  await steady(s.api)
  expect((await s.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, autoSpeak: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', perDevice: 'sender', reveal: 'synced' } } })).status).toBe(200)
  expect((await s.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-soak-key' })).status).toBe(200)
  const sess = await createSession(s.api, 'Soak: voice')
  await s.page.reload()
  await s.waitReady()
  await s.hook('go', `/s/${sess.uid}`)
  await settle(s)
  await s.hook('audio.unlock')
  const input = s.page.getByTestId('composer-input')
  const known = new Set<string>()

  const turn = async (i: number): Promise<void> => {
    await input.fill(`Say something, ${i}`)
    await input.press('Enter')
    let id = ''
    await expect.poll(async () => (id = (await s!.hook<string[]>('voice.speechIds')).find((x) => !known.has(x)) ?? ''), { timeout: 20_000 }).not.toBe('')
    known.add(id)
    if ((i + 1) % bargeEvery === 0) {
      await expect.poll(() => s!.hook<number>('audio.revealProgress', id), { timeout: 20_000 }).toBeGreaterThan(0.1)
      await s!.page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', id))?.state, { timeout: 15_000 }).toBe('interrupted')
    } else {
      await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', id))?.state, { timeout: 60_000 }).toBe('done')
    }
    await expect.poll(async () => (await s!.hook<{ playing: number }>('audio.stats')).playing, { timeout: 15_000 }).toBe(0)
    await s!.waitReady()
  }

  const warm = Math.max(4, Math.round(total / 10))
  for (let i = 0; i < warm; i++) await turn(i)
  await s.page.waitForTimeout(500)
  const audioBase = await s.hook<AudioCounters>('audio.counters')
  const heap: number[] = [(await renderer(s.page)).heapMB]
  const srvHeap: number[] = [(await server(s.url)).heapUsedMB]
  const every = Math.max(1, Math.round((total - warm) / 10))
  for (let i = warm; i < total; i++) {
    await turn(i)
    if ((i - warm + 1) % every === 0) {
      heap.push((await renderer(s.page)).heapMB)
      srvHeap.push((await server(s.url)).heapUsedMB)
    }
  }
  await s.page.waitForTimeout(1000)
  // Rows on screen keep their reveal binding (the text stays painted); leaving the chat must release all of them.
  const mounted = await s.hook<AudioCounters>('audio.counters')
  rec.note(`reveal bindings while the chat is open: ${mounted.reveals}`)
  const empty = await createSession(s.api, 'Soak: elsewhere')
  await s.hook('go', `/s/${empty.uid}`)
  await settle(s, 800)
  const audio = await s.hook<AudioCounters>('audio.counters')
  // The reveal paints with a fixed set of shared highlights (07 C14); what must not stay is any Range in them.
  const highlights = await s.page.evaluate(() => {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return { names: 0, ranges: 0 }
    const reg = (CSS as unknown as { highlights: Map<string, Set<unknown>> }).highlights
    let ranges = 0
    reg.forEach((h) => (ranges += h.size))
    return { names: reg.size, ranges }
  })
  rec.check('AudioBufferSourceNodes live at rest', audio.sources, 0)
  rec.check('AudioContexts', audio.contexts, 1)
  rec.check('audio nodes over baseline', audio.nodes - audioBase.nodes, 0)
  rec.check('decoded buffers held', audio.buffers, 0)
  rec.check('reply queues / reveal bindings (chat left)', audio.replies + audio.reveals, 0)
  rec.check('CSS.highlights ranges at rest', highlights.ranges, 0)
  rec.note(`CSS.highlights registry: ${highlights.names} shared highlights`)
  rec.note(`audio counters at rest: ${JSON.stringify(audio)} (baseline ${JSON.stringify(audioBase)})`)
  const speechEntries = (await s.hook<string[]>('voice.speechIds')).length
  // The speech tracker keeps the last 64 finished replies (MAX_FINISHED) for "Speak again" and late chunks.
  rec.check('client speech records (≤ 64 finished + live)', speechEntries, 66)
  rec.gate({ name: 'renderer heap after GC', unit: 'MB', values: heap, threshold: 15 })
  rec.gate({ name: 'server heap after GC', unit: 'MB', values: srvHeap, threshold: 10 })
  const srv = await server(s.url)
  rec.check('server speech jobs in flight', srv.speech?.jobs ?? 0, 0)
  rec.check('engine replies left', (srv.engine?.active ?? 0) + (srv.engine?.controllers ?? 0), 0)
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
