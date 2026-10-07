/**
 * Soak 5 (LEAK-1 row 5): 10,000 WebSocket connect/disconnect cycles against the built server — plain ones, ones that
 * leave in the middle of a streaming reply (every 20th) and ones that leave in the middle of speech recognition
 * (every 50th, fake recognizer + the real Silero VAD). Gates: server heap after GC +≤ 10 MB with a flat trend;
 * active handles back to the post-warm-up baseline; hub clients/subscriptions, engine replies, STT mic sessions and
 * speech jobs all back to 0; hub rings bounded by the sessions used.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import WebSocket from 'ws'
import { parseWav } from '../mocks/audio'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { AUDIO_FIXTURES } from '../e2e/stt'
import { cycles, finish, handles, Recorder, server, type ServerLeaks, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

const HELLO = parseWav(fs.readFileSync(path.join(AUDIO_FIXTURES, 'hello.wav'))).pcm

/** A binary mic frame (kind 2): [2][u32 BE header length][JSON header][PCM16]. */
function micFrame(seq: number, pcm: Int16Array): Buffer {
  const h = Buffer.from(JSON.stringify({ seq }))
  const head = Buffer.alloc(5)
  head[0] = 2
  head.writeUInt32BE(h.length, 1)
  return Buffer.concat([head, h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
}

type Kind = 'plain' | 'reply' | 'stt'

/** One connection: hello → ready, then (reply) subscribe + chat.send and leave at the first delta, or (stt) stt.start
 *  + a few frames and leave mid-utterance. Resolves when the socket is closed. */
function cycle(url: string, cookie: string, kind: Kind, sessionUid: string, n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`, { headers: { origin: url, cookie } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`cycle ${n} (${kind}) timed out`))
    }, 20_000)
    const send = (m: Record<string, unknown>): void => ws.send(JSON.stringify(m))
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      ws.close()
    }
    ws.on('open', () => send({ t: 'hello', protocol: 1, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: false, audioUnlocked: false }, deviceName: 'soak' }))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const m = JSON.parse(String(data)) as { t: string; id?: string; ts?: number; sessionUid?: string }
      if (m.t === 'ping') send({ t: 'pong', ts: m.ts })
      else if (m.t === 'ready') {
        if (kind === 'plain') leave()
        else if (kind === 'reply') send({ t: 'subscribe', id: `sub${n}`, sessionUid })
        else send({ t: 'stt.start', id: `stt${n}`, sessionUid: null, mode: 'dictate', sampleRate: 16000, ttsActive: false })
      } else if (m.t === 'subscribed' && kind === 'reply')
        send({ t: 'chat.send', id: `send${n}`, sessionUid, text: `storm ${n}`, attachments: [], client: { ts: Date.now(), tzOffset: 0, tzName: 'UTC' }, speak: false })
      else if (kind === 'reply' && (m.t === 'reply.delta' || m.t === 'reply.done' || m.t === 'error' || m.t === 'reply.error')) leave()
      else if (kind === 'stt' && m.t === 'ack' && m.id === `stt${n}`) {
        // ~0.6 s of speech, then gone in the middle of the utterance.
        for (let i = 0; i < 20; i++) ws.send(micFrame(i, HELLO.subarray(8000 + i * 512, 8000 + (i + 1) * 512)))
        setTimeout(leave, 50)
      } else if (kind === 'stt' && m.t === 'error') leave()
    })
    ws.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

test('10,000 WebSocket connects and disconnects (mid-reply, mid-STT): server heap, handles and maps back to baseline @R17', async () => {
  const total = cycles(10_000, 200)
  test.setTimeout(30 * 60_000)
  const rec = new Recorder('ws-storm')
  rec.cycles('connections', total)
  rec.cycles('mid-reply leaves', Math.floor(total / 20))
  rec.cycles('mid-STT leaves', Math.floor(total / 50))
  mock.llm.setDefault({ text: 'A slow reply that streams for a while. '.repeat(12), chunkChars: 12, delayMs: 10 })

  s = await launchServer({ mock, open: false, login: 'desktop', env: { VESPER_STT_FAKE: '1' }, timeoutMs: 60_000 })
  await configureMockLlm(s.api, mock.url)
  await steady(s.api)
  expect((await s.api('PATCH', '/api/settings', { voice: { stt: { enabled: true } } })).status).toBe(200)
  const { cookie } = await s.login('browser')
  const sessions: string[] = []
  for (let i = 0; i < 25; i++) sessions.push((await createSession(s.api, `Storm ${i}`)).uid)
  const url = s.url

  const kindOf = (i: number): Kind => (i % 50 === 49 ? 'stt' : i % 20 === 19 ? 'reply' : 'plain')
  const run = async (from: number, to: number): Promise<void> => {
    const CONCURRENCY = 10
    let next = from
    const worker = async (): Promise<void> => {
      while (next < to) {
        const i = next++
        await cycle(url, cookie, kindOf(i), sessions[i % sessions.length], i)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }
  /** Wait for in-flight replies and sessions to wind down, then read the server. */
  const quiet = async (): Promise<ServerLeaks> => {
    let l = await server(url)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && ((l.engine?.active ?? 0) > 0 || (l.hub?.clients ?? 0) > 0 || (l.stt?.mics ?? 0) > 0 || (l.speech?.jobs ?? 0) > 0)) {
      await new Promise((r) => setTimeout(r, 500))
      l = await server(url)
    }
    // Let closed sockets and their timers finish (TIME_WAIT is the OS's, not ours).
    await new Promise((r) => setTimeout(r, 1500))
    return server(url)
  }

  const warm = Math.max(100, Math.round(total / 20))
  await run(0, warm)
  const base = await quiet()
  const heap: number[] = [base.heapUsedMB]
  const handleCounts: number[] = [handles(base)]
  const steps = 10
  const per = Math.ceil((total - warm) / steps)
  for (let k = 0; k < steps; k++) {
    const from = warm + k * per
    await run(from, Math.min(total, from + per))
    const l = await quiet()
    heap.push(l.heapUsedMB)
    handleCounts.push(handles(l))
  }
  const end = await quiet()
  rec.gate({ name: 'server heap after GC', unit: 'MB', values: heap, threshold: 10 })
  rec.check('active handles over baseline', handles(end) - handles(base), 2)
  rec.note(`active handles: baseline ${JSON.stringify(base.resources)} → end ${JSON.stringify(end.resources)}`)
  rec.check('hub clients', end.hub?.clients ?? -1, 0)
  rec.check('hub subscriptions', end.hub?.subscriptions ?? -1, 0)
  rec.check('hub rings (≤ sessions used)', end.hub?.rings ?? -1, sessions.length)
  rec.check('engine replies / controllers', (end.engine?.active ?? 0) + (end.engine?.controllers ?? 0) + (end.engine?.starting ?? 0), 0)
  rec.check('STT mic sessions', (end.stt?.mics ?? 0) + (end.stt?.byMic ?? 0) + (end.stt?.earlyFrames ?? 0), 0)
  rec.check('STT recognizer sessions', end.stt?.process?.sessions ?? 0, 0)
  rec.check('speech jobs', end.speech?.jobs ?? 0, 0)
  rec.check('auth limiter buckets', end.auth?.limiterBuckets ?? 0, 50)
  rec.note(`rss ${end.rssMB} MB; engine ${JSON.stringify(end.engine)}; stt ${JSON.stringify(end.stt)}`)
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
