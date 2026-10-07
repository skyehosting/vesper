/**
 * Voice input through the real server @R19: WebSocket `stt.start` + binary kind-2 frames → `stt.final`, the model
 * routes with their auth levels (07 B2), download progress over WS, unload, and the 'stt' provider test.
 * Runs with VESPER_STT_FAKE=1 (real Silero VAD, scripted recognizer) and the mock provider/GitHub server.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BIN_KIND, encodeBinary } from '../../../src/shared/ws'
import type { SttModelInfo } from '../../../src/shared/models'
import { sttImpl } from '../../../src/server/providers/stt'
import { removeTempDirs, tempDir } from '../../fakes'
import { startMockServer, type MockServer } from '../../mocks/server'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { buildSttWorker, concat, fixture, frames, REPO, silence, waitFor } from './helpers'

let t: TestServer
let mock: MockServer
let browser: string
let desktop: string
const ENV = ['VESPER_STT_FAKE', 'VESPER_STT_FAKE_TEXT', 'VESPER_MOCK_BASE', 'VESPER_STT_TEST_CATALOG', 'NODE_PATH', 'VESPER_STT_MODEL_DIR'] as const
const saved: Partial<Record<(typeof ENV)[number], string>> = {}

beforeAll(async () => {
  const script = await buildSttWorker()
  mock = await startMockServer()
  const catalog = path.join(tempDir(), 'catalog.json')
  fs.writeFileSync(catalog, JSON.stringify([mock.models.catalogEntry({ id: 'mock-model' })]))
  for (const k of ENV) if (process.env[k] !== undefined) saved[k] = process.env[k]
  Object.assign(process.env, {
    // Real models from the research phase (when configured) would count as installed: this suite wants none.
    VESPER_STT_MODEL_DIR: '',
    VESPER_STT_FAKE: '1',
    VESPER_STT_FAKE_TEXT: 'testing one two three',
    VESPER_MOCK_BASE: mock.url,
    VESPER_STT_TEST_CATALOG: catalog,
    NODE_PATH: path.join(REPO, 'node_modules')
  })
  t = await startTestServer({ opts: { workersDir: path.dirname(script) }, platform: (p) => ({ ...p, resourcesDir: path.join(REPO, 'resources') }) })
  browser = await t.login('browser')
  desktop = await t.login('desktop')
  await t.inject({ method: 'PATCH', url: '/api/settings', cookie: desktop, payload: { voice: { stt: { provider: 'local', model: 'moonshine-base-en-2026-02-27', silenceMs: 900 } } } })
})

afterAll(async () => {
  await t?.close()
  await mock?.close()
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  removeTempDirs()
})

function sendPcm(p: WsProbe, pcm: Int16Array): void {
  let seq = 0
  for (const f of frames(pcm)) p.ws.send(encodeBinary(BIN_KIND.micPcm, { seq: seq++ }, new Uint8Array(f.buffer, f.byteOffset, f.byteLength)))
}

describe('WebSocket mic session @R19', () => {
  it('stt.start → ack → frames → stt.vad / stt.final {autoSend} → stt.stop → idle', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    p.send({ t: 'stt.start', id: 's1', sessionUid: null, mode: 'conversation', sampleRate: 16000, ttsActive: false })
    await p.next('ack', (m) => m.id === 's1')
    // Slow enough for the hub's token bucket (60 msgs/s): two batches with a pause.
    const pcm = concat(silence(300), fixture('hello').pcm, silence(1200))
    const half = Math.floor(pcm.length / 2 / 512) * 512
    sendPcm(p, pcm.subarray(0, half))
    await new Promise((r) => setTimeout(r, 1500))
    sendPcm(p, pcm.subarray(half))
    const final = await p.next('stt.final', () => true, 15_000)
    expect(final).toMatchObject({ text: 'testing one two three', autoSend: true })
    expect(await p.next('stt.vad', (m) => m.speaking)).toBeTruthy()
    p.send({ t: 'stt.stop', reason: 'released' })
    await p.next('stt.state', (m) => m.state === 'idle', 5000)
    p.close()
    await waitFor(async () => (await sttImpl(t.server.ctx)!.stats()).mics === 0)
  })

  it('a closed socket ends its session', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    p.send({ t: 'stt.start', id: 's2', sessionUid: null, mode: 'dictate', sampleRate: 16000, ttsActive: false })
    await p.next('ack')
    expect((await sttImpl(t.server.ctx)!.stats()).mics).toBe(1)
    p.close()
    await waitFor(async () => (await sttImpl(t.server.ctx)!.stats()).mics === 0)
  })

  it('a bad sample rate is refused with the request id', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    p.send({ t: 'stt.start', id: 'bad', sessionUid: null, mode: 'dictate', sampleRate: 48000, ttsActive: false })
    const err = await p.next('error', (m) => m.id === 'bad')
    expect(err.error.code).toBe('validation')
    p.close()
  })
})

describe('model routes (07 B2, B12) @R19', () => {
  it('lists the catalogue to any device; downloads and deletes are desktop-only', async () => {
    const r = await t.inject({ url: '/api/stt/models', cookie: browser })
    expect(r.statusCode).toBe(200)
    const list = r.json() as SttModelInfo[]
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(['parakeet-tdt-0.6b-v3-int8', 'moonshine-base-en-2026-02-27', 'mock-model']))
    expect(list.find((m) => m.id === 'moonshine-base-en-2026-02-27')?.active).toBe(true)
    expect((await t.inject({ method: 'POST', url: '/api/stt/models/mock-model/download', cookie: browser })).statusCode).toBe(403)
    expect((await t.inject({ method: 'DELETE', url: '/api/stt/models/mock-model', cookie: browser })).statusCode).toBe(403)
    expect((await t.inject({ method: 'POST', url: '/api/stt/models/nope/download', cookie: desktop })).statusCode).toBe(404)
  })

  it('downloads in the background with stt.model.progress events, then deletes', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    const r = await t.inject({ method: 'POST', url: '/api/stt/models/mock-model/download', cookie: desktop })
    expect(r.statusCode).toBe(204)
    const ready = await p.next('stt.model.progress', (m) => m.id === 'mock-model' && m.state === 'ready', 15_000)
    expect(ready.bytes).toBe(ready.total)
    const list = (await t.inject({ url: '/api/stt/models', cookie: browser })).json() as SttModelInfo[]
    expect(list.find((m) => m.id === 'mock-model')).toMatchObject({ state: 'installed' })
    expect((await t.inject({ method: 'DELETE', url: '/api/stt/models/mock-model', cookie: desktop })).statusCode).toBe(204)
    const after = (await t.inject({ url: '/api/stt/models', cookie: browser })).json() as SttModelInfo[]
    expect(after.find((m) => m.id === 'mock-model')?.state).toBe('not-installed')
    p.close()
  })

  it('stt.prewarm loads the model ahead of time; POST /api/stt/unload stops the speech process', async () => {
    const svc = sttImpl(t.server.ctx)!
    await svc.unload()
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    p.send({ t: 'stt.prewarm' })
    await waitFor(() => svc.proc.alive && svc.proc.loaded !== null)
    p.close()
    expect(svc.proc.alive).toBe(true)
    expect((await t.inject({ method: 'POST', url: '/api/stt/unload', cookie: browser })).statusCode).toBe(204)
    expect(svc.proc.alive).toBe(false)
  })
})

describe('POST /api/providers/stt/test @R19', () => {
  it('cloud: accepts a working key, maps a rejected one, never stores the key', async () => {
    const ok = await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: desktop, payload: { provider: 'openai', key: 'sk-test-1234567890' } })
    expect(ok.json()).toMatchObject({ ok: true })
    expect(mock.stt.received().at(-1)?.model).toBe('gpt-4o-mini-transcribe')
    mock.stt.failNext(401)
    const bad = await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: desktop, payload: { provider: 'groq', key: 'gsk-test-1234567890' } })
    expect(bad.json()).toMatchObject({ ok: false, kind: 'auth', upstreamStatus: 401 })
    const dg = await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: desktop, payload: { provider: 'deepgram', key: 'dg-key' } })
    expect(dg.json()).toMatchObject({ ok: true })
    expect(mock.stt.received().at(-1)?.query?.mip_opt_out).toBe('true')
    expect(await t.server.ctx.secrets.list()).not.toContain('stt:openai')
    const none = await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: desktop, payload: { provider: 'elevenlabs' } })
    expect(none.json()).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('local: reports whether the model is installed; desktop only', async () => {
    const r = await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: desktop, payload: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8' } })
    expect(r.json()).toMatchObject({ ok: false, kind: 'model' })
    expect((await t.inject({ method: 'POST', url: '/api/providers/stt/test', cookie: browser, payload: { provider: 'local' } })).statusCode).toBe(403)
  })
})
