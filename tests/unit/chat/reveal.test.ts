/**
 * Synced reveal end to end with the REAL speech service against the mock TTS (R14, 07 C14/C16, BLD-5): the speaking
 * client gets no reply.delta — its text arrives as SpeechChunkHeader.text with each chunk's audio, and the chunk texts
 * rebuild the stored body exactly — while a second (non-speaking) client gets deltas. When speech for the speaker
 * fails, degrades (backpressure) or is interrupted, the speaker gets ONE targeted reply.snapshot with the text so far
 * and then ordinary deltas. Also reply.status 'preparing-voice' / 'speaking', Talk mode (fast voice model, 300 ms
 * auto-recall cap) and tts.prewarm (07 D6). @R14 @R13 @R19
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeBinary, type ServerMsg, type SpeechChunkHeader } from '@shared/ws'
import type { WsClient } from '@server/services'
import { speechOf } from '@server/speech'
import { FakeMemoryService } from '../../fakes/services'
import { startMockServer, type MockServer } from '../../mocks/server'
import { WsProbe } from '../server/helpers'
import { ChatHarness, chatRequests, waitMsg } from './harness'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
let mock: MockServer
let h: ChatHarness

class SpeechProbe extends WsProbe {
  readonly frames: SpeechChunkHeader[] = []
  constructor() {
    super(`ws://${h.host}/ws`, { origin: h.origin, cookie: h.cookie })
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.frames.push(decodeBinary(data as Buffer).header as SpeechChunkHeader)
    })
  }
}

async function probe(uid: string): Promise<SpeechProbe> {
  const p = new SpeechProbe()
  await p.hello()
  p.send({ t: 'subscribe', sessionUid: uid })
  await p.next('subscribed', (m) => m.sessionUid === uid)
  return p
}

/** The server-side client of the newest socket. */
function newestClient(): WsClient {
  const all = [...h.ctx.hub.clients()]
  return all[all.length - 1]
}

function sendSpoken(p: WsProbe, uid: string, id: string, text: string, extra: Record<string, unknown> = {}): void {
  p.send({ t: 'chat.send', id, sessionUid: uid, text, attachments: [], client: { ts: T0, tzOffset: 0, tzName: 'UTC' }, speak: true, ...extra })
}

const deltas = (msgs: ServerMsg[], replyId: string): string => msgs.flatMap((m) => (m.t === 'reply.delta' && m.replyId === replyId ? [m.text] : [])).join('')
const chunkText = (frames: SpeechChunkHeader[], replyId: string): string =>
  frames
    .filter((f) => f.replyId === replyId)
    .sort((a, b) => a.index - b.index)
    .map((f) => f.text)
    .join('')

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  h = await ChatHarness.start({ mock, now: T0 })
})
afterAll(async () => {
  await h.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})
beforeEach(async () => {
  h.mock.reset()
  h.ctx.services.memory = undefined
  await h.ctx.settings.patch({ chat: { autoTitle: false }, voice: { tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', reveal: 'synced', perDevice: 'sender', toneMode: 'reply', fastModelInTalk: true } } })
  await h.ctx.secrets.set('tts:elevenlabs', 'xi-good-key', 'https://api.elevenlabs.io')
  await h.setProfile(h.openaiProfile())
})

const REPLY = '[tone=warm] Hello there, my friend.   It is good to hear from you again today.\n\n\n\n- First point to remember, said slowly.\n- Second point, also spoken.\n\nFinally a closing sentence that ends it.   '

describe('synced reveal with the mock TTS (BLD-5) @R14', () => {
  it('the speaker gets chunk texts (no deltas) that rebuild the body; another client gets deltas', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const other = await probe(s.uid)
    h.mock.llm.script({ text: REPLY, chunkChars: 7 })
    sendSpoken(speaker, s.uid, 'sr1', 'say something')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'sr1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    await waitMsg(speaker, (m) => m.t === 'speech.end' && m.replyId === replyId, 15_000)
    const body = done.message.body
    expect(body).not.toContain('[tone=')
    expect(body.startsWith('Hello there')).toBe(true)
    expect(body.endsWith('ends it.')).toBe(true)
    // Speaker: no deltas; the chunk texts tile the final clean body exactly (SpeechChunkHeader.text, R14).
    expect(speaker.msgs.filter((m) => m.t === 'reply.delta')).toEqual([])
    const frames = speaker.frames.filter((f) => f.replyId === replyId)
    expect(frames.length).toBeGreaterThan(1)
    expect(chunkText(frames, replyId)).toBe(body)
    for (const f of frames) expect(body.slice(f.src[0], f.src[1])).toBe(f.text)
    // The other client: deltas that also equal the body (streamed tidy), and no audio.
    await waitMsg(other, (m) => m.t === 'reply.done' && m.replyId === replyId)
    expect(deltas(other.msgs, replyId)).toBe(body)
    expect(other.frames).toEqual([])
    // Status while voice was opening (07 D6 / 03): preparing-voice before done.
    const states = speaker.msgs.flatMap((m) => (m.t === 'reply.status' && m.replyId === replyId ? [m.state] : []))
    expect(states).toContain('preparing-voice')
    expect(states).not.toContain('writing')
    speaker.close()
    other.close()
  })

  it("reply.status 'speaking' once the first audio is sent while the reply still streams", async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    h.mock.llm.script({ text: 'One short sentence to start with, then more. ' + 'And it keeps going on. '.repeat(30), chunkChars: 6, delayMs: 8 })
    sendSpoken(speaker, s.uid, 'sp1', 'talk to me')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'sp1')) as Extract<ServerMsg, { t: 'ack' }>
    await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === ack.replyId, 20_000)
    const states = speaker.msgs.flatMap((m) => (m.t === 'reply.status' && m.replyId === ack.replyId ? [m.state] : []))
    expect(states.indexOf('preparing-voice')).toBeGreaterThanOrEqual(0)
    expect(states.indexOf('speaking')).toBeGreaterThan(states.indexOf('preparing-voice'))
    expect(states.at(-1)).toBe('done')
    await waitMsg(speaker, (m) => m.t === 'speech.end', 20_000)
    speaker.close()
  })

  it('speech failure → one targeted reply.snapshot, then deltas; snapshot + deltas = body', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const other = await probe(s.uid)
    h.mock.tts.failNext(500, 20)
    h.mock.llm.script({ text: 'First sentence that is long enough to be a chunk. ' + 'More text follows here. '.repeat(25), chunkChars: 6, delayMs: 6 })
    sendSpoken(speaker, s.uid, 'sf1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'sf1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const err = (await waitMsg(speaker, (m) => m.t === 'speech.error' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'speech.error' }>
    expect(err.index).toBe(0)
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    const snaps = speaker.msgs.filter((m): m is Extract<ServerMsg, { t: 'reply.snapshot' }> => m.t === 'reply.snapshot')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].evSeq).toBe(0) // targeted (07 G1)
    expect(snaps[0].reply).toMatchObject({ replyId, messageUid: done.message.uid, speakingDeviceId: null })
    const after = speaker.msgs.slice(speaker.msgs.indexOf(snaps[0]))
    expect(snaps[0].reply.text + deltas(after, replyId)).toBe(done.message.body)
    expect(deltas(after, replyId).length).toBeGreaterThan(0)
    // Nobody else got a snapshot.
    await waitMsg(other, (m) => m.t === 'reply.done' && m.replyId === replyId)
    expect(other.msgs.some((m) => m.t === 'reply.snapshot')).toBe(false)
    expect(deltas(other.msgs, replyId)).toBe(done.message.body)
    speaker.close()
    other.close()
  })

  it('backpressure → targeted speech.degraded, then the snapshot and deltas', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const server = newestClient()
    // The socket is "over 1 MiB behind" (07 C16): audio frames are refused for it.
    Object.defineProperty(server, 'sendSpeech', { value: () => false, configurable: true })
    h.mock.llm.script({ text: 'A first sentence that makes the first chunk close. ' + 'Then a lot more words arrive. '.repeat(25), chunkChars: 6, delayMs: 6 })
    sendSpoken(speaker, s.uid, 'bp1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'bp1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const deg = (await waitMsg(speaker, (m) => m.t === 'speech.degraded' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'speech.degraded' }>
    expect(deg.reason).toBe('backpressure')
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    const snap = speaker.msgs.find((m): m is Extract<ServerMsg, { t: 'reply.snapshot' }> => m.t === 'reply.snapshot')!
    expect(snap).toBeDefined()
    const after = speaker.msgs.slice(speaker.msgs.indexOf(snap))
    expect(snap.reply.text + deltas(after, replyId)).toBe(done.message.body)
    speaker.close()
  })

  it('barge-in (speech.cancel) → snapshot with the text so far; the reply is stopped and interrupted (07 C15)', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    h.mock.llm.script({ text: 'This is the opening sentence of a long answer. ' + 'It goes on and on for a while. '.repeat(60), chunkChars: 6, delayMs: 8 })
    sendSpoken(speaker, s.uid, 'bi1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'bi1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const until = Date.now() + 15_000
    while (!speaker.frames.some((f) => f.replyId === replyId && !f.instant) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    speaker.send({ t: 'speech.cancel', id: 'cx', replyId, spokenChars: 10 })
    const snap = (await waitMsg(speaker, (m) => m.t === 'reply.snapshot', 10_000)) as Extract<ServerMsg, { t: 'reply.snapshot' }>
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.status).toBe('stopped')
    expect(done.message.body.startsWith(snap.reply.text)).toBe(true)
    expect(snap.reply.text.length).toBeGreaterThan(10)
    const updated = (await waitMsg(speaker, (m) => m.t === 'message.updated' && m.message.uid === done.message.uid, 5000)) as Extract<ServerMsg, { t: 'message.updated' }>
    expect(updated.message).toMatchObject({ interrupted: true, spokenChars: 10 })
    speaker.close()
  })
})

describe('synced reveal with several speaking clients (Phase 4) @R14', () => {
  it('every speaker gets chunk texts and no deltas; a degraded speaker alone gets the snapshot; a silent client gets deltas', async () => {
    await h.ctx.settings.patch({ voice: { tts: { perDevice: 'all' } } })
    try {
      const s = await h.session()
      const a = await probe(s.uid)
      const b = await probe(s.uid)
      const bServer = newestClient()
      const c = await probe(s.uid)
      for (const p of [a, b]) p.send({ t: 'client.state', client: { visible: true, focused: true, audioUnlocked: true } })
      await new Promise((r) => setTimeout(r, 50))
      h.mock.llm.script({ text: REPLY, chunkChars: 7 })
      sendSpoken(a, s.uid, 'ms1', 'say something')
      const ack = (await waitMsg(a, (m) => m.t === 'ack' && m.id === 'ms1')) as Extract<ServerMsg, { t: 'ack' }>
      const replyId = ack.replyId!
      const done = (await waitMsg(a, (m) => m.t === 'reply.done' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'reply.done' }>
      await waitMsg(a, (m) => m.t === 'speech.end' && m.replyId === replyId, 15_000)
      await waitMsg(b, (m) => m.t === 'speech.end' && m.replyId === replyId, 15_000)
      await waitMsg(c, (m) => m.t === 'reply.done' && m.replyId === replyId)
      const body = done.message.body
      for (const p of [a, b]) {
        expect(p.msgs.filter((m) => m.t === 'reply.delta')).toEqual([])
        expect(p.msgs.some((m) => m.t === 'reply.snapshot')).toBe(false)
        expect(chunkText(p.frames, replyId)).toBe(body)
      }
      expect(deltas(c.msgs, replyId)).toBe(body)
      expect(c.frames).toEqual([])

      // Now speaker b falls behind (backpressure): only b is handed the text so far, then deltas; a stays synced.
      Object.defineProperty(bServer, 'sendSpeech', { value: () => false, configurable: true })
      h.mock.llm.script({ text: 'A first sentence that makes the first chunk close. ' + 'Then a lot more words arrive. '.repeat(25), chunkChars: 6, delayMs: 6 })
      sendSpoken(a, s.uid, 'ms2', 'again')
      const ack2 = (await waitMsg(a, (m) => m.t === 'ack' && m.id === 'ms2')) as Extract<ServerMsg, { t: 'ack' }>
      const r2 = ack2.replyId!
      const done2 = (await waitMsg(a, (m) => m.t === 'reply.done' && m.replyId === r2, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
      await waitMsg(a, (m) => m.t === 'speech.end' && m.replyId === r2, 20_000)
      await waitMsg(b, (m) => m.t === 'reply.done' && m.replyId === r2, 20_000)
      const snap = b.msgs.find((m): m is Extract<ServerMsg, { t: 'reply.snapshot' }> => m.t === 'reply.snapshot' && m.reply.replyId === r2)!
      expect(snap).toBeDefined()
      expect(snap.reply.text + deltas(b.msgs.slice(b.msgs.indexOf(snap)), r2)).toBe(done2.message.body)
      expect(a.msgs.some((m) => m.t === 'reply.snapshot')).toBe(false)
      expect(deltas(a.msgs, r2)).toBe('')
      expect(chunkText(a.frames, r2)).toBe(done2.message.body)
      for (const p of [a, b, c]) p.close()
    } finally {
      await h.ctx.settings.patch({ voice: { tts: { perDevice: 'sender' } } })
    }
  })
})

describe('barge-in bookkeeping, text-first on request, timing marks (07 C14/C15/C16, D6) @R14', () => {
  it('a barge-in after synthesis completed (audio still playing) marks the reply interrupted; the others stop too; the next turn gets the note', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const other = await probe(s.uid)
    h.mock.llm.script({ text: 'A short spoken answer about the sea. It has two sentences in it.' })
    sendSpoken(speaker, s.uid, 'pf1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'pf1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 15_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    await waitMsg(speaker, (m) => m.t === 'speech.end' && m.replyId === replyId, 15_000)
    // Every chunk is synthesized and sent: the job is gone, but the client is still playing the audio.
    expect(speechOf(h.ctx)!.job(replyId)).toBeUndefined()
    expect(speechOf(h.ctx)!.stats().recent).toBeGreaterThan(0)
    speaker.send({ t: 'speech.cancel', id: 'pc1', replyId, spokenChars: 12 })
    const upd = (await waitMsg(other, (m) => m.t === 'message.updated' && m.message.uid === done.message.uid, 5000)) as Extract<ServerMsg, { t: 'message.updated' }>
    expect(upd.message).toMatchObject({ interrupted: true, spokenChars: 12 })
    // speech.cancel from any device stops speech everywhere (07 C16): the others are told, the canceller is not.
    await waitMsg(other, (m) => m.t === 'speech.stopped' && m.replyId === replyId, 5000)
    await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'pc1')
    expect(speaker.msgs.some((m) => m.t === 'speech.stopped')).toBe(false)
    // The next turn carries "(The user interrupted your previous reply after: '…')" (07 C15).
    const next = await h.send(speaker, s.uid, 'sorry, go on')
    expect(next.done.message.status).toBe('complete')
    expect(JSON.stringify(chatRequests(h.mock).at(-1)!.json)).toMatch(/interrupted your previous reply after: 'A short spo/)
    speaker.close()
    other.close()
  })

  it('F31: speech.cancel before any audio stops speech but the reply finishes as text (not a barge-in)', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const other = await probe(s.uid)
    h.mock.tts.setDelay(4_000)
    try {
      const text = 'This is the opening sentence of a long answer. ' + 'It goes on and on for a while. '.repeat(30)
      h.mock.llm.script({ text, chunkChars: 6, delayMs: 8 })
      sendSpoken(speaker, s.uid, 'pa1', 'go')
      const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'pa1')) as Extract<ServerMsg, { t: 'ack' }>
      const replyId = ack.replyId!
      // Typing right after sending: nothing has been heard (no frame yet).
      expect(speaker.frames).toEqual([])
      speaker.send({ t: 'speech.cancel', id: 'pa2', replyId, spokenChars: 0 })
      const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
      expect(done.message.status).toBe('complete')
      expect(done.message.body).toBe(text.trim())
      expect(done.message.interrupted ?? false).toBe(false)
      // The speaker is handed the text: one targeted snapshot, then deltas.
      const snaps = speaker.msgs.filter((m): m is Extract<ServerMsg, { t: 'reply.snapshot' }> => m.t === 'reply.snapshot')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].reply.text + deltas(speaker.msgs.slice(speaker.msgs.indexOf(snaps[0])), replyId)).toBe(done.message.body)
      expect(speaker.frames.filter((f) => f.replyId === replyId && !f.instant)).toEqual([])
      // Speech still stops everywhere (07 C16), and nothing is recorded as interrupted.
      await waitMsg(other, (m) => m.t === 'speech.stopped' && m.replyId === replyId, 5000)
      await new Promise((r) => setTimeout(r, 50))
      for (const p of [speaker, other]) expect(p.msgs.some((m) => m.t === 'message.updated' && m.message.interrupted)).toBe(false)
      expect(h.ctx.services.speech && speechOf(h.ctx)!.job(replyId)).toBeFalsy()
    } finally {
      h.mock.tts.setDelay(0)
    }
    speaker.close()
    other.close()
  })

  it('F31: speech.cancel {beforeAudio} from the only speaker after audio was sent still keeps the reply', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const text = 'This is the opening sentence of a long answer. ' + 'It goes on and on for a while. '.repeat(40)
    h.mock.llm.script({ text, chunkChars: 6, delayMs: 8 })
    sendSpoken(speaker, s.uid, 'pb1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'pb1')) as Extract<ServerMsg, { t: 'ack' }>
    const replyId = ack.replyId!
    const until = Date.now() + 15_000
    while (!speaker.frames.some((f) => f.replyId === replyId && !f.instant) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    speaker.send({ t: 'speech.cancel', id: 'pb2', replyId, spokenChars: 0, beforeAudio: true })
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.status).toBe('complete')
    expect(done.message.body).toBe(text.trim())
    expect(done.message.interrupted ?? false).toBe(false)
    speaker.close()
  })

  it('a barge-in after everything was heard records nothing', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    h.mock.llm.script({ text: 'Done and dusted, every word of it.' })
    sendSpoken(speaker, s.uid, 'ph1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'ph1')) as Extract<ServerMsg, { t: 'ack' }>
    const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === ack.replyId, 15_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    await waitMsg(speaker, (m) => m.t === 'speech.end' && m.replyId === ack.replyId, 15_000)
    speaker.send({ t: 'speech.cancel', id: 'ph2', replyId: ack.replyId!, spokenChars: done.message.body.length })
    await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'ph2')
    await new Promise((r) => setTimeout(r, 50))
    expect(speaker.msgs.some((m) => m.t === 'message.updated' && m.message.uid === done.message.uid && m.message.interrupted)).toBe(false)
    speaker.close()
  })

  it('speech.textFirst: the client that gave up on audio gets one targeted snapshot, then deltas; the others are untouched', async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    const other = await probe(s.uid)
    h.mock.tts.setDelay(4_000)
    try {
      h.mock.llm.script({ text: 'The first sentence takes a while to be voiced. ' + 'Then the story keeps on going for a bit. '.repeat(20), chunkChars: 6, delayMs: 10 })
      sendSpoken(speaker, s.uid, 'tf1', 'go')
      const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'tf1')) as Extract<ServerMsg, { t: 'ack' }>
      const replyId = ack.replyId!
      // (polled, not waitMsg: waitMsg consumes the message it matched)
      await expect.poll(() => other.msgs.some((m) => m.t === 'reply.delta' && m.replyId === replyId), { timeout: 10_000 }).toBe(true)
      expect(speaker.msgs.some((m) => m.t === 'reply.delta')).toBe(false)
      speaker.send({ t: 'speech.textFirst', replyId })
      const done = (await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === replyId, 20_000)) as Extract<ServerMsg, { t: 'reply.done' }>
      const snaps = speaker.msgs.filter((m): m is Extract<ServerMsg, { t: 'reply.snapshot' }> => m.t === 'reply.snapshot')
      expect(snaps).toHaveLength(1)
      const after = speaker.msgs.slice(speaker.msgs.indexOf(snaps[0]))
      expect(snaps[0].evSeq).toBe(0)
      expect(snaps[0].reply.text.length).toBeGreaterThan(0)
      expect(deltas(after, replyId).length).toBeGreaterThan(0)
      expect(snaps[0].reply.text + deltas(after, replyId)).toBe(done.message.body)
      // It was the only speaker: synthesis stops and no audio reaches it any more.
      await waitMsg(speaker, (m) => m.t === 'speech.end' && m.replyId === replyId, 10_000)
      expect(speaker.frames.filter((f) => f.replyId === replyId && !f.instant)).toEqual([])
      expect(other.msgs.some((m) => m.t === 'reply.snapshot')).toBe(false)
      await waitMsg(other, (m) => m.t === 'reply.done' && m.replyId === replyId)
      expect(deltas(other.msgs, replyId)).toBe(done.message.body)
      // The reply itself is complete, not interrupted.
      expect(done.message.status).toBe('complete')
      expect(done.message.interrupted ?? false).toBe(false)
    } finally {
      h.mock.tts.setDelay(0)
    }
    speaker.close()
    other.close()
  })

  it("reply.timing: the speech job's marks share the engine's origin (ms since the turn was received)", async () => {
    const s = await h.session()
    const speaker = await probe(s.uid)
    h.mock.llm.script({ text: 'Timing matters. This sentence is spoken.' })
    sendSpoken(speaker, s.uid, 'tm1', 'go')
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'tm1')) as Extract<ServerMsg, { t: 'ack' }>
    await waitMsg(speaker, (m) => m.t === 'speech.end' && m.replyId === ack.replyId, 15_000)
    await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === ack.replyId, 15_000)
    const marks: Record<string, number> = {}
    for (const m of speaker.msgs) if (m.t === 'reply.timing' && m.replyId === ack.replyId) Object.assign(marks, m.marks)
    expect(marks.speechOpen).toBeGreaterThanOrEqual(0)
    expect(marks.speechOpen).toBeLessThan(10_000)
    expect(marks.firstAudioSent).toBeGreaterThanOrEqual(marks.speechOpen)
    expect(marks.firstAudioSent).toBeLessThan(15_000)
    expect(marks.done).toBeGreaterThanOrEqual(0)
    speaker.close()
  })
})

describe('Talk mode and prewarm (07 D6) @R19 @R13', () => {
  it('chat.send.talk speaks with the fast voice model and caps auto-recall at 300 ms', async () => {
    const memory = new FakeMemoryService()
    memory.delayMs = 5_000
    h.ctx.services.memory = memory
    await h.ctx.settings.patch({ memory: { enabled: true, autoRecall: true } })
    const s = await h.session()
    const speaker = await probe(s.uid)
    h.mock.llm.script({ text: 'Quick answer for talk mode, spoken fast.' })
    const t0 = Date.now()
    sendSpoken(speaker, s.uid, 'tk1', 'what did we plan for the weekend', { talk: true })
    const ack = (await waitMsg(speaker, (m) => m.t === 'ack' && m.id === 'tk1')) as Extract<ServerMsg, { t: 'ack' }>
    await waitMsg(speaker, (m) => m.t === 'reply.done' && m.replyId === ack.replyId, 10_000)
    // The slow memory did not hold the reply beyond the Talk-mode cap.
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(memory.callsOf('autoRecall')[0].args[2]).toBe(300)
    await waitMsg(speaker, (m) => m.t === 'speech.end', 10_000)
    const models = h.mock.tts.synthTexts().map((x) => x.model)
    expect(models.length).toBeGreaterThan(0)
    expect(new Set(models)).toEqual(new Set(['eleven_flash_v2_5']))
    await h.ctx.settings.patch({ memory: { enabled: false } })
    speaker.close()
  })

  it('tts.prewarm opens a connection to the provider (throttled) and never answers with an error', async () => {
    const p = await h.client()
    const before = h.mock.recorder.all().length
    p.send({ t: 'tts.prewarm' })
    await expect.poll(() => h.mock.recorder.all().slice(before).some((r) => r.method === 'GET' && r.path === '/'), { timeout: 5000 }).toBe(true)
    const n = h.mock.recorder.all().length
    p.send({ t: 'tts.prewarm' })
    await new Promise((r) => setTimeout(r, 200))
    expect(h.mock.recorder.all().slice(n).filter((r) => r.path === '/')).toEqual([])
    expect(p.msgs.filter((m) => m.t === 'error')).toEqual([])
    expect(speechOf(h.ctx)!.stats().prewarming).toBe(0)
  })
})
