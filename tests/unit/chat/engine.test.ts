/**
 * The chat engine over a real socket (03 §4, 07 C2/C3/C6/C15/C16/C19, A3): turn events and persistence, the header
 * written once, stop / busy / interrupt / inflight, regenerate and edit branches, error turns, tone → speech, barge-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import type { ServerMsg } from '@shared/ws'
import { FakeSpeechService } from '../../fakes/services'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import type { WsProbe } from '../server/helpers'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start({ now: T0 })
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  h.ctx.services.speech = undefined
  h.ctx.services.memory = undefined
  h.platform.setNow(T0)
  await h.ctx.settings.patch({ chat: { autoTitle: false } })
  await h.setProfile(h.openaiProfile())
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos
const types = (events: ServerMsg[]): string[] => events.map((e) => e.t)

async function fresh(): Promise<{ uid: string; p: WsProbe }> {
  const s = await h.session()
  return { uid: s.uid, p: await h.client(s.uid) }
}

describe('a chat turn @R1 @R2', () => {
  it('streams, persists both messages, writes the header once and reaches the provider', async () => {
    const { uid, p } = await fresh()
    const other = await h.client(uid)
    const t = await h.send(p, uid, 'hello')
    expect(t.done.message).toMatchObject({ body: 'Echo: hello', status: 'complete', tag: 'ai response', provider: 'custom', model: 'mock-echo' })
    const ev = types(t.events)
    expect(ev.filter((x) => x === 'message.created')).toHaveLength(2)
    expect(ev.indexOf('reply.status')).toBeLessThan(ev.indexOf('reply.delta'))
    expect(ev).toEqual(expect.arrayContaining(['reply.delta', 'reply.timing', 'session.updated']))
    const deltas = t.events.flatMap((e) => (e.t === 'reply.delta' ? [e.text] : [])).join('')
    expect(deltas).toBe('Echo: hello')
    await waitMsg(other, (m) => m.t === 'reply.done')

    // The mock LLM saw the user's words (Phase 2 acceptance, 07 G11).
    const last = chatRequests(h.mock).at(-1)!
    const msgs = last.json.messages as { role: string; content: { type: string; text: string }[] }[]
    expect(msgs[0].role).toBe('system')
    // The epoch's opening note rides in the user turn on a custom server (no mid-conversation system role).
    expect(msgs[1].content[1].text).toBe('(Note from Vesper, not from the user: Memory is off in this conversation; the memory functions answer "memory is disabled".)')
    expect(msgs[1].content[0].text).toMatch(/^\[Now: Mon 5 Oct 2026 14:00 \(UTC\+02:00, Europe\/Berlin\)\]\nhello/)

    const s = repos().sessions.byUid(uid)!
    const [u, a] = repos().messages.tail(s.id, 2)
    expect(u).toMatchObject({ body: 'hello', tzName: 'Europe/Berlin', tzOffsetMin: 120, tsUtc: T0 })
    expect(repos().transcript.forMessage(u.id)[0].blocks[0]).toEqual({ t: 'text', text: '[Now: Mon 5 Oct 2026 14:00 (UTC+02:00, Europe/Berlin)]\nhello' })
    expect(repos().transcript.forMessage(a.id).map((r) => r.blocks)).toEqual([[{ t: 'text', text: 'Echo: hello' }]])
    const epoch = repos().epochs.current(s.id)!
    expect(epoch).toMatchObject({ startMessageId: 0n, toolMode: 'text', toolsJson: '[]' })
  })

  it('adds the gap clause after 6 h and never re-renders earlier headers (07 C2) @R7', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'first')
    const s = repos().sessions.byUid(uid)!
    const firstRow = repos().transcript.forMessage(repos().messages.tail(s.id, 2)[0].id)[0]
    h.platform.advance(5 * 86_400_000)
    await h.send(p, uid, 'second')
    const rows = repos().transcript.forEpoch(repos().epochs.current(s.id)!)
    expect(rows[0].blocks).toEqual(firstRow.blocks)
    const second = rows.find((r) => r.role === 'user' && JSON.stringify(r.blocks).includes('second'))!
    expect((second.blocks[0] as { text: string }).text).toMatch(/^\[Now: .* · 5 days since the previous message\]\nsecond$/)
    h.platform.setNow(T0)
  })

  it('strips an imitated stamp from the shown body, keeps the raw text in the transcript', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '[Now: Mon 5 Oct 2026 14:00 (UTC+02:00)] Hi there.' })
    const t = await h.send(p, uid, 'hey')
    expect(t.done.message.body).toBe('Hi there.')
    const a = repos().messages.byUid(t.done.message.uid)!
    expect((repos().transcript.forMessage(a.id)[0].blocks[0] as { text: string }).text).toBe('[Now: Mon 5 Oct 2026 14:00 (UTC+02:00)] Hi there.')
  })

  it('rejects empty, unknown-session and over-long sends with the request id', async () => {
    const { uid, p } = await fresh()
    p.send({ t: 'chat.send', id: 'e1', sessionUid: uid, text: '  ', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'e1')).toMatchObject({ error: { code: 'validation' } })
    p.send({ t: 'chat.send', id: 'e2', sessionUid: 'nope', text: 'x', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'e2')).toMatchObject({ error: { code: 'not_found' } })
    p.send({ t: 'chat.send', id: 'e3', sessionUid: uid, text: 'x'.repeat(100_001), attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'e3')).toMatchObject({ error: { code: 'validation' } })
  })

  it('without a provider the send fails before anything is stored', async () => {
    await h.ctx.settings.patch({ llm: { profiles: [], defaultProfile: null } })
    const { uid, p } = await fresh()
    p.send({ t: 'chat.send', id: 'np', sessionUid: uid, text: 'hi', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'np')).toMatchObject({ error: { code: 'provider_bad_request' } })
    expect(repos().sessions.byUid(uid)!.lastSeq).toBe(0)
    expect(h.engine.busy(uid)).toBe(false)
  })
})

describe('stop, busy, interrupt, inflight (07 C6/C16)', () => {
  it('stop keeps the partial text (stopped) and the next request is valid', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'word '.repeat(200), chunkChars: 5, delayMs: 5 })
    p.send({ t: 'chat.send', id: 's1', sessionUid: uid, text: 'long one', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.delta')

    p.send({ t: 'chat.send', id: 's2', sessionUid: uid, text: 'second', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 's2')).toMatchObject({ error: { code: 'session_busy' } })

    const late = await h.client()
    late.send({ t: 'subscribe', sessionUid: uid })
    const sub = (await waitMsg(late, (m) => m.t === 'subscribed')) as Extract<ServerMsg, { t: 'subscribed' }>
    expect(sub.inflight).toHaveLength(1)
    expect(sub.inflight[0].state).toBe('writing')
    expect(sub.inflight[0].text.length).toBeGreaterThan(0)

    p.send({ t: 'chat.stop', id: 'stop', sessionUid: uid })
    await waitMsg(p, (m) => m.t === 'ack' && m.id === 'stop')
    const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.status).toBe('stopped')
    expect(done.message.body.length).toBeGreaterThan(0)
    expect(done.message.body.length).toBeLessThan(1000)
    expect(h.engine.busy(uid)).toBe(false)
    const a = repos().messages.byUid(done.message.uid)!
    const rows = repos().transcript.forMessage(a.id)
    expect(rows).toHaveLength(1)
    expect((rows[0].blocks[0] as { text: string }).text.startsWith('word word')).toBe(true)

    const next = await h.send(p, uid, 'after stop')
    expect(next.done.message.body).toBe('Echo: after stop')
    expect(h.mock.recorder.unhandled()).toEqual([])
  })

  it('interrupt:true replaces a running reply', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'slow '.repeat(100), chunkChars: 5, delayMs: 10 })
    p.send({ t: 'chat.send', id: 'i1', sessionUid: uid, text: 'first', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.delta')
    const t = await h.send(p, uid, 'fourth', { interrupt: true })
    expect(t.done.message).toMatchObject({ body: 'Echo: fourth', status: 'complete' })
    const page = (await h.inject('GET', `/api/sessions/${uid}/messages?mode=latest`)).json() as { items: { status: string; body: string }[] }
    expect(page.items.map((m) => m.status)).toEqual(['complete', 'stopped', 'complete', 'complete'])
  })
})

describe('errors (07 C19)', () => {
  it('an upstream error ends the reply with the mapped code; nothing incomplete is stored', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 401, message: 'secret upstream text' } })
    p.send({ t: 'chat.send', id: 'x1', sessionUid: uid, text: 'hi', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
    const err = (await waitMsg(p, (m) => m.t === 'reply.error')) as Extract<ServerMsg, { t: 'reply.error' }>
    expect(err.error).toMatchObject({ code: 'provider_auth', upstreamStatus: 401, retryable: false })
    expect(JSON.stringify(err)).not.toContain('secret upstream text')
    const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message).toMatchObject({ status: 'error', error: { code: 'provider_auth' } })
    expect(repos().transcript.forMessage(repos().messages.byUid(done.message.uid)!.id)).toEqual([])
    // Retry works on the same path.
    expect((await h.send(p, uid, 'again')).done.message.body).toBe('Echo: again')
  })

  it('overloaded → one automatic retry', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 503 } })
    const t = await h.send(p, uid, 'retry me')
    expect(t.done.message).toMatchObject({ status: 'complete', body: 'Echo: retry me' })
    expect(chatRequests(h.mock)).toHaveLength(2)
  })

  it('a refusal is an error turn with the text kept', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'I would rather not.', refusal: true })
    const t = await h.send(p, uid, 'bad')
    expect(t.done.message).toMatchObject({ status: 'error', body: 'I would rather not.', error: { code: 'provider_refusal' } })
  })
})

describe('branches (07 C3)', () => {
  it('regenerate forks at the reply, emits path_changed and makes variants', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'one')
    const t2 = await h.send(p, uid, 'two')
    h.mock.llm.script({ text: 'Another take.' })
    p.send({ t: 'chat.regenerate', id: 'rg', sessionUid: uid, messageUid: t2.done.message.uid, speak: false, client: { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' } })
    const r = await h.awaitTurn(p, 'rg')
    expect(r.done.message).toMatchObject({ body: 'Another take.', seq: 4 })
    const moved = r.events.find((e) => e.t === 'session.path_changed') as Extract<ServerMsg, { t: 'session.path_changed' }>
    expect(moved).toMatchObject({ forkSeq: 4, lastSeq: 3 })
    const variants = (await h.inject('GET', `/api/sessions/${uid}/variants/4`)).json() as { branchId: number; active: boolean; preview: string }[]
    expect(variants.map((v) => [v.preview, v.active])).toEqual([
      ['Echo: two', false],
      ['Another take.', true]
    ])
    // The regenerated request repeated the history up to the user turn (prefix kept).
    const reqs = chatRequests(h.mock)
    expect(JSON.stringify((reqs.at(-1)!.json.messages as unknown[]).slice(0, 4))).toBe(JSON.stringify((reqs.at(-2)!.json.messages as unknown[]).slice(0, 4)))
    // Switching back restores the old reply.
    const sel = await h.inject('POST', `/api/sessions/${uid}/variants/4`, { branchId: variants[0].branchId })
    expect(sel.statusCode).toBe(200)
    const page = (await h.inject('GET', `/api/sessions/${uid}/messages?mode=latest`)).json() as { items: { body: string }[] }
    expect(page.items.map((m) => m.body)).toEqual(['one', 'Echo: one', 'two', 'Echo: two'])
  })

  it('regenerate > 10 min after the user turn persists a clock note (07 C2)', async () => {
    const { uid, p } = await fresh()
    const t = await h.send(p, uid, 'clock')
    h.platform.advance(11 * 60_000)
    p.send({ t: 'chat.regenerate', id: 'rg2', sessionUid: uid, messageUid: t.done.message.uid, speak: false, client: { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' } })
    const r = await h.awaitTurn(p, 'rg2')
    const a = repos().messages.byUid(r.done.message.uid)!
    expect(repos().transcript.forMessage(a.id)[0]).toMatchObject({ part: 0, role: 'system', blocks: [{ t: 'system_note', text: '[Now: Mon 5 Oct 2026 14:11 (UTC+02:00, Europe/Berlin)]' }] })
  })

  it('edit forks at the user message and answers the new text', async () => {
    const { uid, p } = await fresh()
    const t1 = await h.send(p, uid, 'original')
    await h.send(p, uid, 'later')
    p.send({ t: 'chat.edit', id: 'ed', sessionUid: uid, messageUid: t1.userUid, text: 'edited', attachments: [], speak: false, client: { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' } })
    const r = await h.awaitTurn(p, 'ed')
    expect(r.done.message.body).toBe('Echo: edited')
    expect(r.events.find((e) => e.t === 'session.path_changed')).toMatchObject({ forkSeq: 1, lastSeq: 0 })
    const page = (await h.inject('GET', `/api/sessions/${uid}/messages?mode=latest`)).json() as { items: { body: string; variant?: { index: number; count: number } }[] }
    expect(page.items.map((m) => m.body)).toEqual(['edited', 'Echo: edited'])
    expect(page.items[0].variant).toEqual({ index: 2, count: 2 })
    // The edited branch's request does not contain the old turns.
    const msgs = chatRequests(h.mock).at(-1)!.json.messages as { content: string }[]
    expect(JSON.stringify(msgs)).not.toContain('later')
  })

  it('only replies regenerate and only user messages edit', async () => {
    const { uid, p } = await fresh()
    const t = await h.send(p, uid, 'x')
    p.send({ t: 'chat.regenerate', id: 'bad1', sessionUid: uid, messageUid: t.userUid, speak: false, client: { ts: 0, tzOffset: 0, tzName: null } })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'bad1')).toMatchObject({ error: { code: 'validation' } })
    p.send({ t: 'chat.edit', id: 'bad2', sessionUid: uid, messageUid: t.done.message.uid, text: 'y', attachments: [], speak: false, client: { ts: 0, tzOffset: 0, tzName: null } })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'bad2')).toMatchObject({ error: { code: 'validation' } })
  })
})

describe('voice: tone and speech (07 A2/A3/C15) @R13', () => {
  it('the tone tag never reaches the body; speech gets the visible text and the tone', async () => {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '[tone=warm, gently teasing] Hello friend. [tone=calm] Bye.' })
    const t = await h.send(p, uid, 'speak to me', { speak: true })
    expect(t.done.message.body).toBe('Hello friend.  Bye.')
    const sink = speech.sinkFor(t.replyId)!
    expect(sink.target.clientIds).toHaveLength(1)
    expect(sink.text).toBe('Hello friend.  Bye.')
    expect(sink.tones).toEqual([
      { value: 'warm, gently teasing', at: 0 },
      { value: 'calm', at: 14 }
    ])
    expect(sink.calls.at(-1)).toEqual({ op: 'end', finalBody: 'Hello friend.  Bye.' })
    expect(sink.lateCalls).toEqual([])
    // A3: no tone in the messages table; the raw tag only in the transcript.
    const rows = h.ctx.db.prepare("SELECT count(*) AS c FROM messages WHERE body LIKE '%[tone=%'").get() as { c: number }
    expect(Number(rows.c)).toBe(0)
    const tr = h.ctx.db.prepare("SELECT count(*) AS c FROM transcript WHERE blocks LIKE '%[tone=%'").get() as { c: number }
    expect(Number(tr.c)).toBeGreaterThan(0)
    // Synced reveal: the speaking client got no text deltas (unsequenced deltas go to the others).
    expect(t.events.filter((e) => e.t === 'reply.delta')).toEqual([])
  })

  it('tone tags in other casing / spacing / separators are hidden, spoken as tones and never stored (F22/F42)', async () => {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '[Tone=happy] Sure thing, here you go. [ tone: warm ] More. [TONE = calm]' })
    const t = await h.send(p, uid, 'speak to me', { speak: true })
    expect(t.done.message.body).toBe('Sure thing, here you go.  More.')
    const sink = speech.sinkFor(t.replyId)!
    expect(sink.text).toBe('Sure thing, here you go.  More.')
    expect(sink.tones.map((x) => x.value)).toEqual(['happy', 'warm', 'calm'])
    // A3, case-insensitively and with either separator: no tone tag anywhere in the messages table.
    const rows = h.ctx.db.prepare("SELECT body FROM messages WHERE body <> ''").all() as { body: string }[]
    for (const r of rows) expect(r.body).not.toMatch(/\[\s*tone\s*[=:]/i)
  })

  it('barge-in stops the stream, marks the reply interrupted and the next turn gets a note', async () => {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'This is a long spoken answer that keeps going and going. '.repeat(20), chunkChars: 6, delayMs: 5 })
    p.send({ t: 'chat.send', id: 'b1', sessionUid: uid, text: 'talk', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: true })
    const ack = (await waitMsg(p, (m) => m.t === 'ack' && m.id === 'b1')) as Extract<ServerMsg, { t: 'ack' }>
    for (let i = 0; i < 100 && (speech.sinkFor(ack.replyId!)?.text.length ?? 0) < 60; i++) await new Promise((r) => setTimeout(r, 5))
    speech.cancel(ack.replyId!, 40)
    const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.status).toBe('stopped')
    await new Promise((r) => setTimeout(r, 20))
    const m = repos().messages.byUid(done.message.uid)!
    expect(m.interrupted).toBe(true)
    expect(m.spokenChars).toBeGreaterThan(0)
    const next = await h.send(p, uid, 'what?')
    expect(next.done.message.status).toBe('complete')
    const s = repos().sessions.byUid(uid)!
    const user = repos().messages.tail(s.id, 2)[0]
    const notes = repos().transcript.forMessage(user.id).find((r) => r.role === 'system')!
    expect(JSON.stringify(notes.blocks)).toMatch(/interrupted your previous reply after: 'This is a long/)
  })
})

describe('startup recovery (07 C6)', () => {
  it('replies left streaming by a crash become stopped / error after a restart', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'x')
    const s = repos().sessions.byUid(uid)!
    const [, a] = repos().messages.tail(s.id, 2)
    repos().messages.update(a.id, { status: 'streaming' })
    const empty = repos().messages.append({ sessionId: s.id, role: 'assistant', body: '', status: 'streaming', tsUtc: T0, tzOffsetMin: 0, tzName: null, device: null })
    await h.restart()
    await h.setProfile(h.openaiProfile())
    expect(repos().messages.byId(a.id)!.status).toBe('stopped')
    expect(repos().messages.byId(empty.id)).toMatchObject({ status: 'error', error: { code: 'internal' } })
  })
})
