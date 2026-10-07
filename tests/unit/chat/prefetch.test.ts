/**
 * Talk-mode recall prefetch (07 D6): the first ≥ 4-word stt.partial of a voice-first mic starts the Voyage query
 * embedding in db.worker; the final transcript is prefetched too, and the auto-recall of the turn it becomes finds
 * its embedding cached (one query request in total). Dictation, short partials, temporary chats and the free tier
 * prefetch nothing. Real memory service (in-process worker) against the mock Voyage. @R19 @R7
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import { memoryOf } from '@server/memory/service'
import { sttImpl } from '@server/providers/stt'
import type { TranscriptEvent } from '@server/providers/stt/service'
import { startMockServer, type MockServer } from '../../mocks/server'
import { ChatHarness } from './harness'

let mock: MockServer
let h: ChatHarness
let sessionUid = ''

/** Emit a transcript as the STT service does when it sends stt.partial / stt.final to a client. */
function transcript(e: Omit<TranscriptEvent, 'clientId'> & { clientId?: string }): void {
  // The emitter is private to the STT service (its listeners are what this test is about).
  const svc = sttImpl(h.ctx) as unknown as { transcript(mic: { client: { id: string }; sessionUid: string | null; mode: string }, kind: string, text: string): void }
  svc.transcript({ client: { id: e.clientId ?? 'c_test' }, sessionUid: e.sessionUid, mode: e.mode }, e.kind, e.text)
}

const queries = (): number => mock.voyage.counts().query

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  h = await ChatHarness.start({ mock })
  await h.ctx.settings.patch({ chat: { autoTitle: false }, memory: { enabled: true, autoRecall: true, scopeDefault: 'linked', voyage: { tier: 'tier1' } } })
  const r = await h.inject('PUT', '/api/secrets/voyage', { value: 'pa-test-key' })
  expect(r.statusCode).toBe(200)
  await h.setProfile(h.openaiProfile())
  // A stored conversation with something to remember, embedded and loaded.
  const s = await h.session({ title: 'Plans' })
  sessionUid = s.uid
  const repos = coreOf(h.ctx).repos
  const row = repos.sessions.byUid(s.uid)!
  for (const [role, body] of [
    ['user', 'We are planning a hiking trip to the Dolomites in July.'],
    ['assistant', 'The Dolomites in July are beautiful; book the huts early.']
  ] as const) {
    const m = repos.messages.append({ sessionId: row.id, role, body, tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: 'test' })
    memoryOf(h.ctx).onMessagePersisted(m.id)
  }
  const mem = memoryOf(h.ctx)
  await mem.link.request('drain', {}, 20_000)
  await mem.warm()
})
afterAll(async () => {
  await h.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})
beforeEach(() => mock.voyage.reset())

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150))
}

describe('Talk-mode recall prefetch (07 D6) @R19', () => {
  it('the first ≥ 4-word partial starts the query embedding; the turn reuses the prefetched final', async () => {
    const text = 'what did we plan for the summer hiking trip'
    transcript({ sessionUid, mode: 'conversation', kind: 'partial', text: 'what did we' })
    await settle()
    expect(queries()).toBe(0)
    transcript({ sessionUid, mode: 'conversation', kind: 'partial', text: 'what did we plan for' })
    await expect.poll(queries, { timeout: 5000 }).toBe(1)
    transcript({ sessionUid, mode: 'conversation', kind: 'final', text })
    await expect.poll(queries, { timeout: 5000 }).toBe(2)
    // The turn's auto-recall embeds the same text: served from the worker's cache, no third request.
    const p = await h.client(sessionUid)
    const t = await h.send(p, sessionUid, text)
    expect(t.done.message.status).toBe('complete')
    expect(t.events.some((e) => e.t === 'reply.tool' && e.kind === 'auto')).toBe(true)
    await settle()
    expect(queries()).toBe(2)
    // Control: a text nobody prefetched costs its own query embedding.
    await h.send(p, sessionUid, 'and which huts did we want to book')
    await expect.poll(queries, { timeout: 5000 }).toBe(3)
    const stats = await memoryOf(h.ctx).link.request('stats', {}, 5000)
    expect(stats.sizes.queryInflight).toBe(0)
    expect(stats.sizes.queryCache).toBeLessThanOrEqual(16)
  })

  it('throttles partials and ignores dictation, short finals, unknown and temporary sessions', async () => {
    for (let i = 0; i < 6; i++) transcript({ sessionUid, mode: 'ptt', kind: 'partial', text: `one two three four ${'five '.repeat(i)}`, clientId: 'c_thr' })
    await expect.poll(queries, { timeout: 5000 }).toBe(1)
    await settle()
    expect(queries()).toBe(1)
    mock.voyage.reset()
    transcript({ sessionUid, mode: 'dictate', kind: 'final', text: 'remind me about the hiking trip please' })
    transcript({ sessionUid, mode: 'conversation', kind: 'final', text: 'ok then' })
    transcript({ sessionUid: null, mode: 'conversation', kind: 'final', text: 'no session given for this one' })
    const temp = (await h.inject('POST', '/api/sessions', { temporary: true })).json() as { uid: string }
    transcript({ sessionUid: temp.uid, mode: 'conversation', kind: 'final', text: 'a temporary chat never reaches voyage' })
    await settle()
    expect(queries()).toBe(0)
    await h.inject('DELETE', `/api/sessions/${temp.uid}`)
  })

  it('the free tier prefetches nothing (its requests are kept for real searches)', async () => {
    await h.ctx.settings.patch({ memory: { voyage: { tier: 'free' } } })
    await expect.poll(async () => (await memoryOf(h.ctx).link.request('status', {}, 5000)).tier, { timeout: 5000 }).toBe('free')
    expect(await memoryOf(h.ctx).prefetchQuery('what about the hiking trip in july', { sessionUid })).toBe(false)
    expect(queries()).toBe(0)
    await h.ctx.settings.patch({ memory: { voyage: { tier: 'tier1' } } })
  })
})
