/**
 * voice-out-server end to end on a real server (REST + WS) against the mock providers: voices on key save (07 C22),
 * the voices/preview/sample/test endpoints with their auth levels, speech frames over the WebSocket, barge-in
 * persistence (07 C15), "speak again" with the transcript's tone (07 A3), and no leftovers after 100 replies.
 * @R12 @R13 @R14
 */
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeBinary, type SpeechChunkHeader } from '@shared/ws'
import type { WsClient } from '@server/services'
import { speechOf } from '@server/speech'
import { readWav } from '@server/speech/audio'
import { startMockServer, type MockServer } from '../../mocks/server'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'

let mock: MockServer
let t: TestServer
let desktop: string
let browser: string

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  t = await startTestServer({ platform: (p) => ({ ...p, resourcesDir: path.resolve('resources') }) })
  desktop = await t.login('desktop')
  browser = await t.login('browser')
})
afterAll(async () => {
  await t.close()
  delete process.env.VESPER_MOCK_BASE
  await mock.close()
})
beforeEach(() => mock.reset())

const api = (method: string, url: string, cookie: string, payload?: unknown) => t.inject({ method: method as 'GET', url, cookie, ...(payload !== undefined ? { payload: payload as object } : {}) })
const ctx = () => t.server.ctx
const speech = () => speechOf(ctx())!

class SpeechProbe extends WsProbe {
  readonly frames: Array<{ header: SpeechChunkHeader; payload: Uint8Array }> = []
  constructor(cookie: string) {
    super(wsUrl(t), { origin: t.origin, cookie })
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      const f = decodeBinary(data as Buffer)
      this.frames.push({ header: f.header as SpeechChunkHeader, payload: new Uint8Array(f.payload) })
    })
  }
  /** The server-side client behind this socket (the newest one). */
  serverClient(): WsClient {
    const all = [...ctx().hub.clients()]
    return all[all.length - 1]
  }
}

async function setTts(patch: Record<string, unknown>): Promise<void> {
  await ctx().settings.patch({ voice: { tts: patch } })
}

function session(): { uid: string; id: bigint } {
  const s = ctx().repos.sessions.create({ title: 'voice', now: Date.now() })
  return { uid: s.uid, id: s.id }
}

describe('voices on key save (07 C22) @R12', () => {
  it('a saved key is validated, voices + models are cached and broadcast, the first premade voice is selected', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: null, model: null })
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    const r = await api('PUT', '/api/secrets/tts:elevenlabs', desktop, { value: 'xi-good-key' })
    expect(r.statusCode).toBe(200)
    const ev = await p.next('tts.voices')
    expect(ev.provider).toBe('elevenlabs')
    expect(ev.voices.map((v) => v.id)).toEqual(['mock-aria', 'mock-rowan', 'mock-clone'])
    expect(ev.models.map((m) => m.id)).toContain('eleven_v4')
    expect(ev.quota).toEqual({ used: 1234, limit: 100_000 })
    expect(JSON.stringify(ev)).not.toMatch(/preview_url|\/preview\/|xi-good-key/)
    await p.next('settings.changed', (m) => m.settings.voice.tts.voiceId === 'mock-aria')
    expect(ctx().settings.get().voice.tts.voiceId).toBe('mock-aria')
    expect(mock.recorder.all().find((x) => x.path === '/v1/user/subscription')!.headers['xi-api-key']).toBe('xi-good-key')
    p.close()

    // Served from the 24 h cache; refresh=1 asks the provider again.
    const before = mock.recorder.count()
    const g = await api('GET', '/api/tts/voices?provider=elevenlabs', browser)
    expect(g.statusCode).toBe(200)
    expect(g.json().voices).toHaveLength(3)
    expect(mock.recorder.count()).toBe(before)
    await api('GET', '/api/tts/voices?provider=elevenlabs&refresh=1', browser)
    expect(mock.recorder.count()).toBeGreaterThan(before)
  })

  it('an invalid key is refused and not stored', async () => {
    mock.tts.mode('unauthorized')
    const r = await api('PUT', '/api/secrets/tts:elevenlabs', desktop, { value: 'xi-bad' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    expect(JSON.stringify(r.json())).not.toMatch(/Invalid API key/)
    mock.tts.mode('ok')
    expect(await ctx().secrets.getFor('tts:elevenlabs', 'https://api.elevenlabs.io')).toBe('xi-good-key')
  })

  it("a key that can't list voices is kept, and the desktop is told why", async () => {
    mock.tts.mode('no-voice-permission')
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: desktop })
    await p.hello()
    const r = await api('PUT', '/api/secrets/tts:elevenlabs', desktop, { value: 'xi-scoped' })
    expect(r.statusCode).toBe(200)
    expect((await p.next('toast')).text).toMatch(/Voices: read/)
    const g = await api('GET', '/api/tts/voices?provider=elevenlabs', browser)
    expect(g.json().error).toMatchObject({ code: 'provider_auth' })
    mock.tts.mode('ok')
    await api('PUT', '/api/secrets/tts:elevenlabs', desktop, { value: 'xi-good-key' })
    p.close()
  })

  it('deleting the key clears the dropdown', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    await api('DELETE', '/api/secrets/tts:openai', desktop)
    expect(await p.next('tts.voices', (m) => m.provider === 'openai')).toMatchObject({ voices: [], models: [] })
    p.close()
  })
})

describe('setup endpoints @R12', () => {
  it('preview proxies the provider preview same-origin; only voices the provider listed', async () => {
    const r = await api('GET', '/api/tts/preview/elevenlabs/mock-aria', browser)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('audio/wav')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(readWav(new Uint8Array(r.rawPayload))).not.toBeNull()
    expect((await api('GET', '/api/tts/preview/elevenlabs/not-a-voice', browser)).statusCode).toBe(404)
    expect((await api('GET', '/api/tts/preview/kokoro/x', browser)).statusCode).toBe(400)
    expect((await t.inject({ method: 'GET', url: '/api/tts/preview/elevenlabs/mock-aria' })).statusCode).toBe(401)
  })

  it('sample speaks a short line with the current voice; hidden tags never reach the provider @R13', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: 'mock-rowan', model: 'eleven_flash_v2_5' })
    const r = await api('POST', '/api/tts/sample', browser, { text: '[tone=warm] Hi, I am your voice. https://x.example' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('audio/wav')
    expect(mock.tts.synthTexts()).toEqual([{ provider: 'elevenlabs', voice: 'mock-rowan', model: 'eleven_flash_v2_5', text: 'Hi, I am your voice. link', tone: null }])
    const other = await api('POST', '/api/tts/sample', browser, { provider: 'elevenlabs', voiceId: 'mock-aria', text: 'Another voice.' })
    expect(other.statusCode).toBe(200)
    expect(mock.tts.synthTexts()[1].voice).toBe('mock-aria')
    expect((await api('POST', '/api/tts/sample', browser, { text: '   ' })).statusCode).toBe(400)
  })

  it('provider test (desktop only): voices, models and quota for an unsaved key; mapped failures', async () => {
    const ok = await api('POST', '/api/providers/tts/test', desktop, { provider: 'elevenlabs', key: 'xi-unsaved' })
    expect(ok.json()).toMatchObject({ ok: true, quota: { used: 1234, limit: 100_000 } })
    expect(ok.json().voices).toHaveLength(3)
    expect(mock.recorder.all().every((x) => !x.headers['xi-api-key'] || x.headers['xi-api-key'] === 'xi-unsaved')).toBe(true)
    mock.tts.mode('unauthorized')
    expect((await api('POST', '/api/providers/tts/test', desktop, { provider: 'elevenlabs', key: 'xi-bad' })).json()).toMatchObject({ ok: false, kind: 'auth', upstreamStatus: 401 })
    mock.tts.mode('no-voice-permission')
    expect((await api('POST', '/api/providers/tts/test', desktop, { provider: 'elevenlabs', key: 'xi-scoped' })).json()).toMatchObject({ ok: false, kind: 'permission' })
    mock.tts.mode('ok')
    expect((await api('POST', '/api/providers/tts/test', desktop, { provider: 'nope' })).json()).toMatchObject({ ok: false })
    expect((await api('POST', '/api/providers/tts/test', browser, { provider: 'elevenlabs', key: 'k' })).statusCode).toBe(403)
  })

  it.skipIf(process.platform !== 'win32')('Windows voices: listed from the local host, previewable for free', async () => {
    const v = await api('GET', '/api/tts/voices?provider=windows', browser)
    expect(v.statusCode).toBe(200)
    const voices = v.json().voices as Array<{ id: string; previewable: boolean }>
    if (!voices.length) return
    expect(voices[0].previewable).toBe(true)
    const p = await api('GET', `/api/tts/preview/windows/${encodeURIComponent(voices[0].id)}`, browser)
    expect(p.statusCode).toBe(200)
    expect(readWav(new Uint8Array(p.rawPayload))!.sampleRate).toBeGreaterThan(0)
  })
})

describe('speech over the WebSocket @R14', () => {
  const REPLY = 'Hello again! It has been three weeks since we last talked, and I missed you. **Tell me** everything that happened.\n\n```js\nconsole.log(1)\n```\n\nI am listening.'

  it('chunks arrive as binary frames in order, with audio and timelines, then speech.end', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' })
    const s = session()
    const p = new SpeechProbe(browser)
    await p.hello()
    p.send({ t: 'subscribe', id: 'sub', sessionUid: s.uid })
    await p.next('subscribed')
    const sink = ctx().services.speech!.open({ replyId: 'r_ws1', sessionUid: s.uid, clientIds: [p.serverClient().id] }, { talkMode: false })
    sink.tone('warm', 0)
    for (let i = 0; i < REPLY.length; i += 11) sink.push(REPLY.slice(i, i + 11))
    sink.end(REPLY)
    const done = await sink.done
    await p.next('speech.end', (m) => m.replyId === 'r_ws1')
    expect(done).toMatchObject({ interrupted: false, failed: false, spokenChars: REPLY.length })
    const f = p.frames
    expect(f.length).toBe(done.chunks)
    expect(f.map((x) => x.header.index)).toEqual(f.map((_, i) => i))
    expect(f.map((x) => REPLY.slice(...x.header.src)).join('')).toBe(REPLY)
    expect(f.at(-1)!.header.final).toBe(true)
    for (const x of f) {
      if (x.header.instant) {
        expect(x.payload.length).toBe(0)
        continue
      }
      const wav = readWav(x.payload)!
      expect(x.header.durationMs).toBeCloseTo(wav.durationMs, 0)
      expect(x.header.timeline!.startsMs).toHaveLength(x.header.spoken.length)
    }
    // The tone reached ElevenLabs v4 as an audio tag on every chunk; the shown/spoken text never has it.
    expect(mock.tts.synthTexts().every((x) => x.text.startsWith('[warm] '))).toBe(true)
    expect(f.every((x) => !x.header.spoken.includes('warm'))).toBe(true)
    p.close()
  })

  it('speech.cancel (barge-in) from another device stops speech everywhere and records spoken chars (07 C15)', async () => {
    const s = session()
    const msg = ctx().repos.messages.append({ sessionId: s.id, role: 'assistant', body: '', status: 'streaming', tsUtc: Date.now(), tzOffsetMin: 0, tzName: null, device: null })
    const speaker = new SpeechProbe(browser)
    await speaker.hello()
    const speakerId = speaker.serverClient().id
    speaker.send({ t: 'subscribe', sessionUid: s.uid })
    await speaker.next('subscribed')
    const other = new WsProbe(wsUrl(t), { origin: t.origin, cookie: desktop })
    await other.hello()
    other.send({ t: 'subscribe', sessionUid: s.uid })
    await other.next('subscribed')
    const sink = ctx().services.speech!.open({ replyId: 'r_barge', sessionUid: s.uid, clientIds: [speakerId], messageUid: msg.uid }, { talkMode: false })
    sink.push(REPLY)
    // The first audio reached the speaker (it may be heard): a cancel now is a real barge-in (F31).
    await expect.poll(() => speaker.frames.length, { timeout: 10_000 }).toBeGreaterThan(0)
    mock.tts.setDelay(5000)
    const heard = speaker.frames.length
    other.send({ t: 'speech.cancel', id: 'c1', replyId: 'r_barge', spokenChars: 42 })
    await other.next('ack', (m) => m.id === 'c1')
    expect(await sink.done).toMatchObject({ interrupted: true, spokenChars: 42 })
    await speaker.next('speech.end', (m) => m.replyId === 'r_barge')
    await other.next('speech.end', (m) => m.replyId === 'r_barge')
    const row = ctx().repos.messages.byUid(msg.uid)!
    expect(row.spokenChars).toBe(42)
    expect(row.interrupted).toBe(true)
    expect(speaker.frames).toHaveLength(heard)
    mock.tts.setDelay(0)
    speaker.close()
    other.close()
  })

  it('speech.replay re-speaks a stored reply with the tone found in its transcript (07 A3) @R13', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' })
    const s = session()
    const body = 'Of course I remember. We talked about the lighthouse.'
    const m = ctx().repos.messages.append({ sessionId: s.id, role: 'assistant', body, tsUtc: Date.now(), tzOffsetMin: 0, tzName: null, device: null })
    ctx().repos.transcript.append({ sessionId: s.id, messageId: m.id, part: 0, role: 'assistant', blocks: [{ t: 'text', text: `[tone=nostalgic, soft] ${body}` }], provider: 'mock', model: 'mock', createdUtc: Date.now() })
    const p = new SpeechProbe(browser)
    await p.hello()
    p.send({ t: 'subscribe', sessionUid: s.uid })
    await p.next('subscribed')
    p.send({ t: 'speech.replay', id: 'rp', messageUid: m.uid })
    const ack = await p.next('ack', (x) => x.id === 'rp')
    expect(ack.replyId).toMatch(/^rp_/)
    await p.next('speech.end', (x) => x.replyId === ack.replyId)
    expect(p.frames.map((f) => f.header.replyId).every((id) => id === ack.replyId)).toBe(true)
    expect(p.frames.map((f) => body.slice(...f.header.src)).join('')).toBe(body)
    expect(mock.tts.synthTexts().every((x) => x.text.startsWith('[nostalgic, soft] '))).toBe(true)
    p.send({ t: 'speech.replay', id: 'bad', messageUid: 'nope' })
    expect(await p.next('error', (x) => x.id === 'bad')).toMatchObject({ error: { code: 'not_found' } })
    p.close()
  })

  it('a provider failure reaches the client as speech.error (catalogue shape) then speech.end @R12', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' })
    const s = session()
    const p = new SpeechProbe(browser)
    await p.hello()
    p.send({ t: 'subscribe', sessionUid: s.uid })
    await p.next('subscribed')
    mock.tts.mode('quota')
    const sink = ctx().services.speech!.open({ replyId: 'r_fail', sessionUid: s.uid, clientIds: [p.serverClient().id] }, { talkMode: false })
    sink.push('This reply will not be spoken, because the quota is used up.')
    sink.end('This reply will not be spoken, because the quota is used up.')
    const err = await p.next('speech.error', (m) => m.replyId === 'r_fail')
    expect(err.error).toEqual({ code: 'tts_quota', message: 'The voice service quota is used up.', retryable: false, upstreamStatus: 401 })
    await p.next('speech.end', (m) => m.replyId === 'r_fail')
    expect(await sink.done).toMatchObject({ failed: true })
    p.close()
  })

  it('Talk mode uses the fast model when "fast voice in Talk mode" is on (07 D6)', async () => {
    await setTts({ provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', fastModelInTalk: true })
    const s = session()
    const p = new SpeechProbe(browser)
    await p.hello()
    const sink = ctx().services.speech!.open({ replyId: 'r_talk', sessionUid: s.uid, clientIds: [p.serverClient().id] }, { talkMode: true })
    sink.push('Quick answer for you.')
    sink.end('Quick answer for you.')
    await sink.done
    expect(mock.tts.synthTexts()[0].model).toBe('eleven_flash_v2_5')
    p.close()
  })

  it('100 replies leave no jobs, timers or list calls behind', async () => {
    await setTts({ provider: 'openai', voiceId: 'alloy', model: 'tts-1' })
    await api('PUT', '/api/secrets/tts:openai', desktop, { value: 'sk-test-key-123' })
    const s = session()
    const p = new SpeechProbe(browser)
    await p.hello()
    const id = p.serverClient().id
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
    const before = timers()
    for (let i = 0; i < 100; i++) {
      const sink = ctx().services.speech!.open({ replyId: `r_leak_${i}`, sessionUid: s.uid, clientIds: [id] }, { talkMode: false })
      sink.push('Short reply number one. And a second sentence here.')
      if (i % 4 === 0) ctx().services.speech!.cancel(`r_leak_${i}`, 3)
      else sink.end('Short reply number one. And a second sentence here.')
      await sink.done
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(speech().stats()).toEqual({ jobs: 0, sessionTones: expect.any(Number), listsInFlight: 0, samples: 0, prewarming: 0, recent: 0 })
    expect(timers()).toBeLessThanOrEqual(before)
    p.close()
  })
})
