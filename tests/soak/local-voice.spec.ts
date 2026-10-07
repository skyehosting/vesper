/**
 * Soak 8 (LEAK-1 row 7): 200 replies spoken by the Windows voice (the WinRT host, free and offline; Kokoro is not
 * shipped, 07 E7, so its row does not apply). Gate: the voice host's private working set ≤ its post-load value
 * + 30 MB, one host process for the whole run (no respawn churn), nothing left queued. Skipped where Windows has no
 * voice (not Windows, or the WinRT voices are missing).
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { cycles, finish, installPageCounters, privateWorkingSets, Recorder, renderer, server, settle, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

test('200 replies in the Windows voice: the voice host stays one process and its memory flat @R12 @R17', async () => {
  test.skip(process.platform !== 'win32', 'the Windows voice exists only on Windows')
  const total = cycles(200, 12)
  test.setTimeout(10 * 60_000 + total * 10_000)
  const rec = new Recorder('local-voice')
  rec.cycles('windows-voice replies', total)
  let n = 0
  const lines = ['Good evening.', 'The kettle is on.', 'Rain again, but softer now.', 'I remember that one.']
  mock.llm.setDefault(() => ({ text: lines[n++ % lines.length] }))

  s = await launchServer({ mock, open: false, login: 'desktop', timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  await configureMockLlm(s.api, mock.url)
  await steady(s.api)
  const voices = await s.api<{ voices: Array<{ id: string }> }>('GET', '/api/tts/voices?provider=windows')
  test.skip(voices.status !== 200 || !voices.json?.voices?.length, `no Windows voice here (${voices.status})`)
  expect((await s.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, autoSpeak: true, provider: 'windows', voiceId: voices.json.voices[0].id, perDevice: 'sender', reveal: 'synced' } } })).status).toBe(200)
  const sess = await createSession(s.api, 'Soak: windows voice')
  await s.page.reload()
  await s.waitReady()
  await s.hook('go', `/s/${sess.uid}`)
  await settle(s)
  await s.hook('audio.unlock')
  const input = s.page.getByTestId('composer-input')
  const known = new Set<string>()
  const turn = async (i: number): Promise<void> => {
    await input.fill(`Say something short, ${i}`)
    await input.press('Enter')
    let id = ''
    await expect.poll(async () => (id = (await s!.hook<string[]>('voice.speechIds')).find((x) => !known.has(x)) ?? ''), { timeout: 30_000 }).not.toBe('')
    known.add(id)
    await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', id))?.state, { timeout: 60_000 }).toMatch(/^(done|failed)$/)
    await expect.poll(async () => (await s!.hook<{ playing: number }>('audio.stats')).playing, { timeout: 15_000 }).toBe(0)
  }
  const hostRss = async (): Promise<{ pid: number; mb: number; spawned: number; pending: number }> => {
    const l = await server(s!.url)
    const pid = l.wintts?.pid ?? 0
    const mb = pid ? (privateWorkingSets([pid])[pid] ?? 0) : 0
    return { pid, mb: Math.round(mb * 10) / 10, spawned: l.wintts?.spawned ?? 0, pending: l.wintts?.pending ?? 0 }
  }

  const warm = Math.max(4, Math.round(total / 10))
  for (let i = 0; i < warm; i++) await turn(i)
  const first = await hostRss()
  test.skip(!first.pid, 'the Windows voice host did not start (no WinRT voice available)')
  const rss: number[] = [first.mb]
  const heap: number[] = [(await renderer(s.page)).heapMB]
  const every = Math.max(1, Math.round((total - warm) / 10))
  for (let i = warm; i < total; i++) {
    await turn(i)
    if ((i - warm + 1) % every === 0) {
      rss.push((await hostRss()).mb)
      heap.push((await renderer(s.page)).heapMB)
    }
  }
  const end = await hostRss()
  const failed = (await s.hook<Array<{ replyId: string }>>('voice.failures')).length
  rec.gate({ name: 'Windows voice host private working set', unit: 'MB', values: rss, threshold: 30 })
  rec.gate({ name: 'renderer heap after GC', unit: 'MB', values: heap, threshold: 15 })
  rec.check('voice host processes spawned', end.spawned, 1)
  rec.check('voice host requests pending', end.pending, 0)
  rec.check('replies that fell back to text', failed, 0)
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
