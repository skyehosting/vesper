/**
 * SttService against the real (bundled) STT process with the fake recognizer and the real Silero VAD @R19:
 * mic sessions, autoSend rules, lazy load, idle unload (the process exits), crash → restart with backoff, cloud
 * providers against the mock server, and a 100-session leak check @R17.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { STT_MODELS } from '../../../src/shared/models'
import type { WsClient } from '../../../src/server/services'
import { ModelManager } from '../../../src/server/models/manager'
import { FAKE_DEFAULT_TEXT } from '../../../src/server/providers/stt/engine'
import { SttServiceImpl } from '../../../src/server/providers/stt/service'
import { createSecretsService } from '../../../src/server/settings/secrets'
import { createSettingsStore, type SettingsStoreImpl } from '../../../src/server/settings/store'
import { fakeLog, fakePlatform, FakeWsClient, removeTempDirs, tempDir } from '../../fakes'
import { startMockServer, type MockServer } from '../../mocks/server'
import { buildSttWorker, concat, fixture, frames, silence, sleep, VAD_MODEL, waitFor, workerForker, type ForkedWorkers } from './helpers'

let script: string
let mock: MockServer
const live: { svc: SttServiceImpl; forker: ForkedWorkers; settings: SettingsStoreImpl }[] = []

beforeAll(async () => {
  script = await buildSttWorker()
  mock = await startMockServer()
  process.env.VESPER_TEST = '1'
  process.env.VESPER_MOCK_BASE = mock.url
})

afterEach(async () => {
  for (const l of live.splice(0)) {
    await l.svc.close()
    await l.settings.flush()
    l.forker.killAll()
  }
  mock.reset()
})

afterAll(async () => {
  delete process.env.VESPER_MOCK_BASE
  await mock.close()
  removeTempDirs()
})

async function setup(o: { fakeTexts?: string[]; fake?: boolean; idleUnloadMs?: number; backoffMs?: number[]; cloudRetryMs?: number } = {}) {
  const dir = tempDir()
  const log = fakeLog()
  const settings = await createSettingsStore(path.join(dir, 'settings.json'), log)
  await settings.patch({ voice: { stt: { provider: 'local', model: 'moonshine-base-en-2026-02-27' } } })
  const platform = fakePlatform(dir)
  const secrets = createSecretsService(platform.secrets, log)
  const manager = new ModelManager({ dir: path.join(dir, 'models'), catalogue: STT_MODELS, log, emit: () => undefined })
  const forker = workerForker(script)
  const svc = new SttServiceImpl({
    settings,
    secrets,
    log,
    now: () => Date.now(),
    manager,
    fork: () => forker.fork(),
    vadModel: VAD_MODEL,
    fake: o.fake === false ? null : { texts: o.fakeTexts },
    idleUnloadMs: o.idleUnloadMs ?? 60_000,
    backoffMs: o.backoffMs ?? [50, 100, 200],
    cloudRetryMs: o.cloudRetryMs ?? 20
  })
  live.push({ svc, forker, settings })
  return { svc, settings, secrets, forker, log, dir }
}

type Svc = Awaited<ReturnType<typeof setup>>['svc']

function startMsg(mode: 'dictate' | 'ptt' | 'conversation' = 'dictate', ttsActive = false) {
  return { t: 'stt.start' as const, id: 'r1', sessionUid: null, mode, sampleRate: 16000 as const, ttsActive }
}

/** Push PCM as 32 ms frames, encoded the way the WS delivers them (bytes at an odd offset included). */
function send(svc: Svc, client: WsClient, pcm: Int16Array): void {
  for (const f of frames(pcm)) {
    const raw = new Uint8Array(f.byteLength + 1)
    raw.set(new Uint8Array(f.buffer, f.byteOffset, f.byteLength), 1)
    svc.frame(client, raw.subarray(1))
  }
}

const utterance = () => concat(silence(300), fixture('hello').pcm, silence(1500))

describe('mic sessions @R19', () => {
  it('warming-up → listening → transcribing → final (dictate: no auto-send) → idle', async () => {
    const { svc } = await setup()
    const c = new FakeWsClient('c1')
    await svc.start(c, startMsg())
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.final').length > 0)
    expect(c.of('stt.final')[0]).toMatchObject({ text: FAKE_DEFAULT_TEXT, autoSend: false })
    expect(c.of('stt.final')[0].durationMs).toBeGreaterThan(1000)
    svc.stop(c, 'released')
    await waitFor(() => c.of('stt.state').at(-1)?.state === 'idle')
    const states = c.of('stt.state').map((s) => s.state)
    expect(states.slice(0, 2)).toEqual(['warming-up', 'listening'])
    expect(states).toContain('transcribing')
    expect(states.at(-1)).toBe('idle')
    const vad = c.of('stt.vad')
    expect(vad.map((v) => v.speaking)).toEqual([true, false])
    expect(vad[1].endpointInMs).toBe(800)
    expect((await svc.stats()).mics).toBe(0)
  })

  it('auto-sends in conversation and push-to-talk, and in dictation when stopped with "send"', async () => {
    const { svc } = await setup()
    const conv = new FakeWsClient('conv')
    await svc.start(conv, startMsg('conversation'))
    send(svc, conv, utterance())
    await waitFor(() => conv.of('stt.final').length > 0)
    expect(conv.of('stt.final')[0].autoSend).toBe(true)
    svc.cancel(conv)

    const ptt = new FakeWsClient('ptt')
    await svc.start(ptt, startMsg('ptt'))
    send(svc, ptt, concat(silence(300), fixture('hello').pcm.subarray(0, 16 * 1600), silence(2000)))
    await sleep(300)
    expect(ptt.of('stt.final')).toHaveLength(0) // push-to-talk never ends on silence
    svc.stop(ptt, 'released')
    await waitFor(() => ptt.of('stt.final').length > 0)
    expect(ptt.of('stt.final')[0].autoSend).toBe(true)

    const dict = new FakeWsClient('dict')
    await svc.start(dict, startMsg('dictate'))
    send(svc, dict, concat(silence(300), fixture('hello').pcm.subarray(0, 16 * 1600)))
    svc.stop(dict, 'send')
    await waitFor(() => dict.of('stt.final').length > 0)
    expect(dict.of('stt.final')[0].autoSend).toBe(true)
  })

  it('reports which devices stream mic audio (07 B17 tray dot)', async () => {
    const { svc } = await setup()
    const seen: string[][] = []
    const off = svc.onMicActivity((d) => seen.push(d))
    const a = new FakeWsClient('a', { deviceId: 'phone' })
    const b = new FakeWsClient('b', { deviceId: 'pc' })
    await svc.start(a, startMsg())
    await svc.start(b, startMsg())
    svc.cancel(a)
    svc.disconnect(b)
    off()
    expect(seen).toEqual([['phone'], ['phone', 'pc'], ['pc'], []])
  })

  it('frames sent while the model loads are kept; frames without a session are ignored', async () => {
    const { svc } = await setup()
    const stray = new FakeWsClient('stray')
    send(svc, stray, utterance())
    expect((await svc.stats()).alive).toBe(false)
    const c = new FakeWsClient('early')
    await svc.start(c, startMsg())
    send(svc, c, utterance()) // the process is still starting
    await waitFor(() => c.of('stt.final').length > 0)
    expect(c.of('stt.final')).toHaveLength(1)
  })

  it('ignores the mic while TTS plays unless voice barge-in is on', async () => {
    const { svc } = await setup()
    const c = new FakeWsClient('tts')
    await svc.start(c, startMsg('conversation', true))
    send(svc, c, utterance())
    await sleep(800)
    expect(c.of('stt.vad')).toHaveLength(0)
    expect(c.of('stt.final')).toHaveLength(0)
    svc.ttsActive(c, false)
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.final').length > 0)
  })

  it('refuses a local model that is not installed (outside fake mode)', async () => {
    const { svc } = await setup({ fake: false })
    await expect(svc.start(new FakeWsClient(), startMsg())).rejects.toMatchObject({ info: { code: 'stt_model_missing' } })
  })

  it('unloads after the idle time: the process exits and frees its memory (07 D2)', async () => {
    const { svc, forker } = await setup({ idleUnloadMs: 300 })
    const c = new FakeWsClient('idle')
    await svc.start(c, startMsg())
    await waitFor(() => c.of('stt.state').some((s) => s.state === 'listening'))
    const pid = svc.proc.pid
    expect(pid).toBeTypeOf('number')
    svc.stop(c, 'released')
    // Idle (300 ms) → unload, killed after 2 s at the latest; generous bounds so a loaded machine (a full parallel
    // test run) cannot fail it — the assertion is that it exits at all, not how fast.
    await waitFor(() => !svc.proc.alive, 15_000)
    await waitFor(() => forker.alive().length === 0, 15_000)
    expect(() => process.kill(pid as number, 0)).toThrow()
    // and comes back on the next start
    await svc.start(c, startMsg())
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.final').length > 0)
    expect(svc.proc.spawned).toBe(2)
  })

  it('a crash fails open sessions with stt_crashed and restarts the process with backoff (07 C17)', async () => {
    const { svc, forker } = await setup()
    const c = new FakeWsClient('crash')
    await svc.start(c, startMsg())
    await waitFor(() => c.of('stt.state').some((s) => s.state === 'listening'))
    process.kill(svc.proc.pid as number)
    await waitFor(() => c.of('stt.state').some((s) => s.state === 'error'))
    expect(c.of('stt.state').find((s) => s.state === 'error')?.error?.code).toBe('stt_crashed')
    await waitFor(() => svc.proc.alive && svc.proc.loaded !== null, 5000)
    expect(svc.proc.spawned).toBe(2)
    const c2 = new FakeWsClient('after')
    await svc.start(c2, startMsg())
    send(svc, c2, utterance())
    await waitFor(() => c2.of('stt.final').length > 0)
    expect(forker.pids()).toHaveLength(2)
  })

  it('100 mic sessions leave no sessions, buffers or extra processes behind @R17', async () => {
    const { svc, forker } = await setup()
    const c = new FakeWsClient('leak')
    const chunk = concat(silence(200), fixture('hello').pcm.subarray(0, 16 * 600))
    for (let i = 0; i < 100; i++) {
      await svc.start(c, startMsg())
      send(svc, c, chunk)
      if (i % 3 === 0) svc.cancel(c)
      else if (i % 3 === 1) svc.stop(c, 'released')
      else svc.disconnect(c)
    }
    await waitFor(async () => (await svc.stats()).process?.sessions === 0, 10_000)
    const st = await svc.stats()
    expect(st).toMatchObject({ mics: 0, byMic: 0, earlyFrames: 0, cloudJobs: 0, spawned: 1 })
    expect(st.process).toMatchObject({ sessions: 0, bufferedSamples: 0, decodesQueued: 0 })
    expect(st.process!.vads).toBeLessThanOrEqual(4)
    expect(forker.alive()).toHaveLength(1)
    expect(c.sent.length).toBeGreaterThan(0)
  })
})

describe('cloud providers against the mock @R19', () => {
  async function cloud(provider: 'openai' | 'groq' | 'deepgram' | 'elevenlabs', model = '') {
    const s = await setup({ fake: false })
    await s.settings.patch({ voice: { stt: { provider, model: model || 'moonshine-base-en-2026-02-27' } } })
    await s.secrets.set(`stt:${provider}`, `test-key-${provider}`, mock.url)
    return s
  }

  it.each([
    ['openai', 'gpt-4o-mini-transcribe'],
    ['groq', 'whisper-large-v3-turbo'],
    ['deepgram', 'nova-3'],
    ['elevenlabs', 'scribe_v2']
  ] as const)('%s: the utterance WAV is uploaded and its text becomes stt.final', async (provider, model) => {
    const { svc } = await cloud(provider)
    mock.stt.script(`transcribed by ${provider}`)
    const c = new FakeWsClient(provider)
    await svc.start(c, startMsg('conversation'))
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.final').length > 0)
    expect(c.of('stt.final')[0]).toMatchObject({ text: `transcribed by ${provider}`, autoSend: true })
    const rec = mock.stt.received()
    expect(rec).toHaveLength(1)
    expect(rec[0].model).toBe(model)
    expect(rec[0].durationMs).toBeGreaterThan(1500)
    if (provider === 'deepgram') expect(rec[0].query).toMatchObject({ mip_opt_out: 'true', model: 'nova-3' })
    expect(c.of('stt.partial')).toHaveLength(0)
  })

  it('maps a rejected key to provider_auth without leaking the upstream body', async () => {
    const { svc, log } = await cloud('openai', 'whisper-1')
    mock.stt.failNext(401)
    const c = new FakeWsClient('bad')
    await svc.start(c, startMsg())
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.state').some((s) => s.state === 'error'))
    const err = c.of('stt.state').find((s) => s.state === 'error')!.error!
    expect(err).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    expect(JSON.stringify(err)).not.toContain('Mock failure')
    expect(log.text()).not.toContain('test-key-openai')
    expect(mock.stt.received().length).toBe(0)
  })

  it('F35: a transient upstream failure (500) is retried once and the utterance still becomes stt.final', async () => {
    const { svc } = await cloud('openai', 'whisper-1')
    mock.stt.failNext(500)
    mock.stt.script('said despite a hiccup')
    const c = new FakeWsClient('retry')
    await svc.start(c, startMsg('conversation'))
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.final').length > 0)
    expect(c.of('stt.final')[0]).toMatchObject({ text: 'said despite a hiccup' })
    expect(c.of('stt.state').some((x) => x.state === 'error')).toBe(false)
    expect(mock.stt.received()).toHaveLength(1)
    expect((await svc.stats()).mics).toBe(1)
  })

  it('F35: a failure that persists ends the mic session cleanly with the error (no phantom session, idle unload armed)', async () => {
    const { svc } = await cloud('openai', 'whisper-1')
    mock.stt.failNext(500, 2)
    const c = new FakeWsClient('fails')
    await svc.start(c, startMsg('conversation'))
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.state').some((x) => x.state === 'error'))
    await sleep(100)
    const states = c.of('stt.state').map((x) => x.state)
    // The error is the last word: no contradictory 'listening' after it.
    expect(states.at(-1)).toBe('error')
    expect(c.of('stt.state').at(-1)!.error).toMatchObject({ code: 'provider_overloaded', upstreamStatus: 500 })
    expect(c.of('stt.final')).toHaveLength(0)
    expect(await svc.stats()).toMatchObject({ mics: 0, byMic: 0, cloudJobs: 0, idleTimer: true })
    expect(svc.streamingDevices()).toEqual([])
  })

  it('F35: a rejected key is not retried', async () => {
    const { svc } = await cloud('groq')
    mock.stt.failNext(401, 2)
    const c = new FakeWsClient('auth')
    await svc.start(c, startMsg('conversation'))
    send(svc, c, utterance())
    await waitFor(() => c.of('stt.state').some((x) => x.state === 'error'))
    await sleep(100)
    expect(c.of('stt.state').at(-1)).toMatchObject({ state: 'error', error: { code: 'provider_auth' } })
    expect((await svc.stats()).mics).toBe(0)
    // The second scripted failure was never consumed: one upload only.
    mock.stt.script('next')
    const c2 = new FakeWsClient('auth2')
    await svc.start(c2, startMsg('conversation'))
    send(svc, c2, utterance())
    await waitFor(() => c2.of('stt.state').some((x) => x.state === 'error'))
  })

  it('refuses to start without a key', async () => {
    const { svc, secrets } = await cloud('groq')
    await secrets.delete('stt:groq')
    await expect(svc.start(new FakeWsClient(), startMsg())).rejects.toMatchObject({ info: { code: 'key_missing' } })
  })
})

it('the fixtures stay small (< 300 KB together)', () => {
  const dir = path.join(__dirname, '..', '..', 'fixtures', 'audio')
  const total = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
  expect(total).toBeLessThan(300_000)
})

describe('session ownership', () => {
  it('a second stt.start from the same client replaces the first; racing starts leave one session', async () => {
    const { svc } = await setup()
    const c = new FakeWsClient('twice')
    await Promise.all([svc.start(c, startMsg()), svc.start(c, startMsg()), svc.start(c, startMsg())])
    const st = await svc.stats()
    expect(st.mics).toBe(1)
    expect(st.byMic).toBe(1)
    svc.cancel(c)
    expect((await svc.stats()).byMic).toBe(0)
  })
})
