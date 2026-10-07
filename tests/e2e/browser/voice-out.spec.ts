/**
 * voice-out-server through the built standalone server and a real Chromium (07 C14/C22): saving a TTS key fills every
 * device's voices list over the WebSocket, the preview proxy serves audio Chromium can decode, and "speak again"
 * streams binary speech chunks whose audio and timelines match their headers. Protocol-level until the Phase 3 UI.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, createSession, latestMessages, wsTurn } from '../helpers'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

interface VoicesEvent {
  provider: string
  voices: Array<{ id: string; previewable: boolean }>
  models: Array<{ id: string }>
}

test('saving an ElevenLabs key fills the voices list on other devices; previews play in the browser @R12', async () => {
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  expect((await desktop.api('PATCH', '/api/settings', { voice: { tts: { provider: 'elevenlabs', voiceId: null } } })).status).toBe(200)

  // The browser listens on its own socket before the key is saved on the desktop.
  await s.page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const w = window as unknown as { __voices?: unknown[] }
        w.__voices = []
        const ws = new WebSocket(`ws://${location.host}/ws`)
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, tz: null, tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: false } }))
        ws.onmessage = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data)) as { t: string; ts?: number }
          if (m.t === 'ready') resolve()
          if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: m.ts }))
          if (m.t === 'tts.voices') w.__voices!.push(m)
        }
        ws.onerror = () => reject(new Error('ws error'))
      })
  )
  const put = await desktop.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })
  expect(put.status, put.text).toBe(200)
  await s.page.waitForFunction(() => ((window as unknown as { __voices?: unknown[] }).__voices ?? []).length > 0)
  const ev = (await s.page.evaluate(() => (window as unknown as { __voices: unknown[] }).__voices[0])) as VoicesEvent
  expect(ev.provider).toBe('elevenlabs')
  expect(ev.voices.map((v) => v.id)).toEqual(['mock-aria', 'mock-rowan', 'mock-clone'])
  expect(ev.models.map((m) => m.id)).toContain('eleven_v4')
  await expect.poll(async () => (await desktop.api<{ voice: { tts: { voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts.voiceId).toBe('mock-aria')

  const page = pageApi(s.page)
  const voices = await page<{ voices: unknown[] }>('GET', '/api/tts/voices?provider=elevenlabs')
  expect(voices.status).toBe(200)
  expect(voices.text).not.toMatch(/preview_url|xi-e2e-key/)

  const preview = await s.page.evaluate(async () => {
    const r = await fetch('/api/tts/preview/elevenlabs/mock-aria')
    const bytes = await r.arrayBuffer()
    const ac = new OfflineAudioContext(1, 1, 22050)
    const buf = await ac.decodeAudioData(bytes)
    return { status: r.status, type: r.headers.get('content-type'), seconds: buf.duration }
  })
  expect(preview).toMatchObject({ status: 200, type: 'audio/wav' })
  expect(preview.seconds).toBeGreaterThan(0.3)
  await s.assertNoErrors()
})

interface FrameInfo {
  index: number
  src: [number, number]
  spoken: string
  instant: boolean
  final: boolean
  durationMs: number
  decodedMs: number
  timelineLen: number
}

test('"speak again" streams speech chunks the browser can decode, timed to their headers @R13 @R14', async () => {
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  await desktop.api('PATCH', '/api/settings', { voice: { tts: { provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })
  expect((await desktop.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const page = pageApi(s.page)
  const session = await createSession(page, 'Voice e2e')
  const text = 'Tell me about the lighthouse we talked about, and the storm that night. It was a long story!'
  const turn = await wsTurn(s.page, session.uid, text)
  const reply = (await latestMessages(page, session.uid)).find((m) => m.role === 'assistant')!
  expect(reply.body).toBe(turn.body)

  const result = await s.page.evaluate(
    ({ sessionUid, messageUid }) =>
      new Promise<{ frames: FrameInfo[]; events: string[] }>((resolve, reject) => {
        const frames: FrameInfo[] = []
        const events: string[] = []
        const decodes: Promise<void>[] = []
        const ws = new WebSocket(`ws://${location.host}/ws`)
        ws.binaryType = 'arraybuffer'
        const timer = setTimeout(() => reject(new Error(`timeout; events ${events.join(',')}`)), 30_000)
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, tz: null, tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: true } }))
        ws.onmessage = (ev: MessageEvent) => {
          if (ev.data instanceof ArrayBuffer) {
            const view = new DataView(ev.data)
            const hl = view.getUint32(1, false)
            const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5, hl))) as Omit<FrameInfo, 'decodedMs' | 'timelineLen'> & { timeline: { startsMs: number[] } | null }
            const audio = ev.data.slice(5 + hl)
            const info: FrameInfo = { index: header.index, src: header.src, spoken: header.spoken, instant: header.instant, final: header.final, durationMs: header.durationMs, decodedMs: 0, timelineLen: header.timeline?.startsMs.length ?? -1 }
            frames.push(info)
            if (audio.byteLength)
              decodes.push(
                new OfflineAudioContext(1, 1, 22050).decodeAudioData(audio).then((b) => {
                  info.decodedMs = b.duration * 1000
                })
              )
            return
          }
          const m = JSON.parse(String(ev.data)) as { t: string; id?: string; ts?: number }
          events.push(m.t)
          if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: m.ts }))
          if (m.t === 'ready') ws.send(JSON.stringify({ t: 'subscribe', id: 'sub', sessionUid }))
          if (m.t === 'subscribed') ws.send(JSON.stringify({ t: 'speech.replay', id: 'again', messageUid }))
          if (m.t === 'speech.error') reject(new Error(JSON.stringify(m)))
          if (m.t === 'speech.end')
            void Promise.all(decodes).then(() => {
              clearTimeout(timer)
              ws.close()
              resolve({ frames, events })
            })
        }
      }),
    { sessionUid: session.uid, messageUid: reply.uid }
  )
  expect(result.events).toContain('ack')
  const f = result.frames
  expect(f.length).toBeGreaterThan(0)
  expect(f.map((x) => x.index)).toEqual(f.map((_, i) => i))
  expect(f.map((x) => reply.body.slice(x.src[0], x.src[1])).join('')).toBe(reply.body)
  expect(f.at(-1)!.final).toBe(true)
  for (const x of f) {
    if (x.instant) continue
    expect(x.timelineLen).toBe(x.spoken.length)
    expect(Math.abs(x.decodedMs - x.durationMs)).toBeLessThan(5)
    expect(x.spoken).not.toMatch(/\[tone=/)
  }
  // The first chunk is the short latency chunk (07 C14).
  if (f.length > 1) expect(f[0].spoken.length).toBeLessThanOrEqual(150)
  await s.assertNoErrors()
})
