/**
 * MemoryService + REST + WS through a real server (in-process db.worker engine) against the mock Voyage server:
 * scope clamp matrix (07 B7/B9), recall refusals, manifest, auto-recall, formatting, UI search, facts, backfill
 * consent (07 C12), forget, re-index, provider test, memory.progress. @R7 @R8 @R9 @R10
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryHit } from '@shared/types/domain'
import { memoryOf, type MemoryServiceImpl } from '@server/memory'
import { REFUSALS, resolveScope } from '@server/memory/scope'
import type { SessionRow } from '@server/db/repos'
import type { ServerContext } from '@server/services'
import { startMockServer, type MockServer } from '../../mocks/server'
import { coreOf, startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { until } from './helpers'

let mock: MockServer
let t: TestServer
let ctx: ServerContext
let mem: MemoryServiceImpl
let desktop: string
let browser: string

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  t = await startTestServer()
  ctx = t.server.ctx
  mem = memoryOf(ctx)
  desktop = await t.login('desktop')
  browser = await t.login('browser')
})
afterAll(async () => {
  await t.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})

async function api<T = unknown>(method: string, url: string, payload?: unknown, cookie = desktop): Promise<{ status: number; json: T }> {
  const r = await t.inject({ method: method as 'GET', url, payload: payload as Record<string, unknown> | undefined, cookie })
  return { status: r.statusCode, json: (r.body ? r.json() : null) as T }
}

const repos = () => coreOf(ctx).repos
let clock = Date.UTC(2026, 8, 1, 12)

function session(title: string, msgs: Array<['user' | 'assistant', string]>, o: { private?: boolean; tzName?: string; tzOffsetMin?: number } = {}): { s: SessionRow; ids: bigint[] } {
  const s = repos().sessions.create({ title, private: o.private, now: clock })
  const ids = msgs.map(([role, body]) => {
    clock += 60_000
    const m = repos().messages.append({ sessionId: s.id, role, body, tsUtc: clock, tzOffsetMin: o.tzOffsetMin ?? -240, tzName: o.tzName ?? 'America/New_York', device: 'test' })
    ctx.services.memory!.onMessagePersisted(m.id)
    return m.id
  })
  return { s: repos().sessions.byId(s.id)!, ids }
}

async function indexed(): Promise<void> {
  await mem.link.request('drain', {}, 20_000)
  await until(async () => (await mem.link.request('status', {}, 5000)).queued === 0, 10_000, 'queue drained')
}

describe('setup: memory on with a Voyage key', () => {
  it('starts disabled, keyword-only without a key, then ready', async () => {
    expect((await api<{ state: string }>('GET', '/api/memory/status')).json.state).toBe('disabled')
    expect((await api('PATCH', '/api/settings', { memory: { enabled: true, voyage: { tier: 'tier1' } } })).status).toBe(200)
    await until(() => mem.status().state === 'keyword-only', 3000, 'keyword-only')
    // A wrong key is refused on save (07 C22-style validation), a good one is kept.
    mock.voyage.setKeys(['pa-good'])
    const bad = await api<{ error: { code: string } }>('PUT', '/api/secrets/voyage', { value: 'pa-wrong' })
    expect(bad.status).toBe(500)
    expect(bad.json.error.code).toBe('provider_auth')
    expect((await api('PUT', '/api/secrets/voyage', { value: 'pa-good' })).status).toBe(200)
    await until(() => mem.hasKey(), 3000, 'key cached')
    await until(() => ['ready', 'loading'].includes(mem.status().state), 3000, 'ready')
  })

  it('the provider test maps outcomes (desktop only)', async () => {
    expect((await api<{ error: { code: string } }>('POST', '/api/providers/voyage/test', {}, browser)).json.error.code).toBe('desktop_only')
    expect((await api<{ ok: boolean }>('POST', '/api/providers/voyage/test', {})).json.ok).toBe(true)
    const wrong = await api<{ ok: boolean; kind: string; upstreamStatus: number }>('POST', '/api/providers/voyage/test', { key: 'al-nope' })
    expect(wrong.json).toMatchObject({ ok: false, kind: 'auth', upstreamStatus: 401 })
    mock.voyage.failNext(429)
    expect((await api<{ ok: boolean; kind: string }>('POST', '/api/providers/voyage/test', {})).json).toMatchObject({ ok: true, kind: 'rate' })
    expect(ctx.services.testers.voyage).toBeDefined()
  })
})

describe('scope clamp matrix (07 B7/B9) @R8', () => {
  let a: SessionRow, b: SessionRow, c: SessionRow, priv: SessionRow, off: SessionRow, gone: SessionRow
  beforeAll(() => {
    a = session('A', [['user', 'alpha session about violins']]).s
    b = session('B', [['user', 'bravo session about violins']]).s
    c = session('C', [['user', 'charlie session about violins']]).s
    priv = session('P', [['user', 'private session about violins']], { private: true }).s
    off = session('O', [['user', 'memory off session about violins']]).s
    gone = session('G', [['user', 'deleted session about violins']]).s
    repos().sessions.update(off.id, { memory: 'off' })
    repos().sessions.softDelete(gone.id, clock)
    repos().sessions.addLink(a.id, b.id, clock)
    repos().sessions.addLink(a.id, priv.id, clock)
    repos().sessions.addLink(a.id, gone.id, clock)
  })
  const ids = (sessionUid: string, requested?: 'this' | 'linked' | 'all') => resolveScope(ctx, { sessionUid, requested }, { hasKey: true })

  it.each([
    ['this', 'this'],
    ['linked', 'linked'],
    ['all', 'linked']
  ] as const)('requested %s with the default ceiling (linked) → %s', (req, eff) => {
    expect(ids(a.uid, req).scope).toBe(eff)
  })

  it('linked = self + outgoing links, never private, deleted or memory-off ones; not transitive', () => {
    repos().sessions.addLink(b.id, c.id, clock)
    expect(ids(a.uid, 'linked').sessionIds.sort()).toEqual([Number(a.id), Number(b.id)].sort())
  })

  it('all (when the session allows it) = every open session', () => {
    repos().sessions.update(a.id, { memoryScope: 'all' })
    const r = ids(a.uid, 'all')
    expect(r.scope).toBe('all')
    expect(r.sessionIds).toContain(Number(c.id))
    expect(r.sessionIds).not.toContain(Number(priv.id))
    expect(r.sessionIds).not.toContain(Number(off.id))
    expect(r.sessionIds).not.toContain(Number(gone.id))
    expect(r.voyage).toBe(true)
  })

  it('a private session searches only itself and never reaches Voyage', () => {
    const r = ids(priv.uid, 'all')
    expect(r).toMatchObject({ scope: 'this', sessionIds: [Number(priv.id)], voyage: false })
  })

  it('a temporary (unknown) session never includes itself and never reaches Voyage', () => {
    expect(ids('temporary-uid', 'this').sessionIds).toEqual([])
    expect(ids('temporary-uid', 'linked').sessionIds).toEqual([])
    expect(ids('temporary-uid').voyage).toBe(false)
  })

  it('memory off for the session refuses; a deleted session is treated as unknown', () => {
    expect(ids(off.uid).refused).toBe(REFUSALS.sessionOff)
    expect(ids(gone.uid, 'this').sessionIds).toEqual([])
  })

  it('recall refuses unlinked, private and unknown sessions with fixed text', async () => {
    repos().sessions.update(a.id, { memoryScope: 'linked' })
    expect((await mem.recall({ shortId: c.shortId }, { sessionUid: a.uid })).refused).toBe(REFUSALS.notLinked(c.shortId))
    expect((await mem.recall({ shortId: `#${priv.shortId}` }, { sessionUid: a.uid })).refused).toBe(REFUSALS.privateSession(priv.shortId))
    expect((await mem.recall({ shortId: '#ZZZZZZ' }, { sessionUid: a.uid })).refused).toBe(REFUSALS.unknownSession('ZZZZZZ'))
    const ok = await mem.recall({ shortId: b.shortId.toLowerCase() }, { sessionUid: a.uid })
    expect(ok.refused).toBeUndefined()
    expect(ok.hits.map((h) => h.body)).toEqual(['bravo session about violins'])
  })
})

describe('search, rounds, auto-recall and formatting @R7 @R10', () => {
  let trip: { s: SessionRow; ids: bigint[] }
  let now: { s: SessionRow; ids: bigint[] }
  beforeAll(async () => {
    trip = session('Moving plans', [
      ['user', "I'm thinking of moving to Denver next spring."],
      ['assistant', 'Denver has great hiking; have you looked at neighbourhoods near the mountains?'],
      ['user', 'Not yet, but my budget is tight so maybe Aurora instead.'],
      ['assistant', 'Aurora is cheaper than Denver and close to the airport.']
    ])
    now = session('Today', [
      ['user', 'Remind me what we said about moving'],
      ['assistant', 'Let me check.']
    ])
    repos().sessions.update(now.s.id, { memoryScope: 'all' })
    await indexed()
    await mem.warm()
    mock.voyage.reset()
  })

  it('returns rounds (user + AI reply) chronologically, hybrid, with the session id', async () => {
    const r = await mem.search({ query: 'moving to Denver next spring' }, { sessionUid: now.s.uid }, 1200)
    expect(r.mode).toBe('hybrid')
    const tripHits = r.hits.filter((h) => h.sessionUid === trip.s.uid)
    expect(tripHits.slice(0, 2).map((h) => h.tag)).toEqual(['user response', 'ai response'])
    expect(tripHits[0].shortId).toBe(trip.s.shortId)
    expect(r.hits.map((h) => h.tsUtc)).toEqual([...r.hits.map((h) => h.tsUtc)].sort((x, y) => x - y))
    // The asking session's own recent messages are in context already and are not repeated.
    expect(r.hits.some((h) => h.sessionUid === now.s.uid)).toBe(false)
    expect(mock.voyage.counts()).toMatchObject({ query: 1, rerank: 1 })
  })

  it('formats with absolute and relative times in the reader’s zone (07 B7)', async () => {
    const r = await mem.search({ query: 'Denver spring' }, { sessionUid: now.s.uid }, 1200)
    const text = mem.formatResult(r.hits, { query: 'Denver spring', nowUtc: Date.UTC(2026, 9, 5, 13, 12), tzName: 'America/New_York', tzOffsetMin: -240 })
    expect(text).toMatch(/^<memory_result id="r_[0-9a-f]{4}" query="Denver spring" now="Mon 5 Oct 2026 09:12 \(UTC−04:00\)">/)
    expect(text).toContain(`— #${trip.s.shortId} "Moving plans" —`)
    expect(text).toMatch(/\[Tue 1 Sep 2026 \d\d:\d\d · 4 weeks ago · user response\] I'm thinking of moving to Denver next spring\./)
  })

  it('auto-recall uses the higher threshold, no rerank, and skips what was injected in the last turns', async () => {
    mock.voyage.reset()
    const hits = await mem.autoRecall('where was I planning on moving, Denver?', { sessionUid: now.s.uid }, 400)
    expect(hits.length).toBeGreaterThan(0)
    expect(mock.voyage.counts().rerank).toBe(0)
    const reply = repos().messages.append({ sessionId: now.s.id, role: 'assistant', body: 'You mentioned Denver.', tsUtc: clock + 1000, tzOffsetMin: -240, tzName: 'America/New_York', device: null })
    mem.recordInjections(now.s.uid, reply.uid, hits)
    const again = await mem.autoRecall('where was I planning on moving, Denver?', { sessionUid: now.s.uid }, 400)
    const seen = new Set(hits.map((h: MemoryHit) => h.messageUid))
    expect(again.some((h) => seen.has(h.messageUid))).toBe(false)
  })

  it('the sessions manifest lists accessible sessions only', async () => {
    const { text } = await mem.sessions(undefined, { sessionUid: now.s.uid })
    expect(text).toContain(`#${trip.s.shortId} · Moving plans`)
    expect(text).toContain('(this conversation)')
    expect(text).not.toMatch(/ · P · |private session/)
    const filtered = await mem.sessions('moving', { sessionUid: now.s.uid })
    expect(filtered.text).toContain('#' + trip.s.shortId)
    expect(filtered.text).not.toContain('· Today')
  })

  it('recall by query, by date and the last N', async () => {
    repos().sessions.addLink(now.s.id, trip.s.id, clock)
    const last = await mem.recall({ shortId: trip.s.shortId, last: 2 }, { sessionUid: now.s.uid })
    expect(last.hits.map((h) => h.body)).toEqual(['Not yet, but my budget is tight so maybe Aurora instead.', 'Aurora is cheaper than Denver and close to the airport.'])
    const q = await mem.recall({ shortId: trip.s.shortId, query: 'airport' }, { sessionUid: now.s.uid })
    expect(q.hits.some((h) => h.body.includes('airport'))).toBe(true)
    const around = await mem.recall({ shortId: trip.s.shortId, around: '2026-09-01', last: 4 }, { sessionUid: now.s.uid })
    expect(around.hits.length).toBe(4)
  })

  it('UI search: keyword pages with a cursor, semantic hits, session scope and «» snippets', async () => {
    const kw = await api<{ items: { snippet: string; session: { uid: string }; onPath: boolean }[]; next: string | null }>('GET', '/api/search?q=Denver&limit=1', undefined, browser)
    expect(kw.status).toBe(200)
    expect(kw.json.items).toHaveLength(1)
    expect(kw.json.items[0].snippet).toContain('«Denver»')
    expect(kw.json.next).not.toBeNull()
    const page2 = await api<{ items: unknown[] }>('GET', `/api/search?q=Denver&limit=1&cursor=${kw.json.next}`, undefined, browser)
    expect(page2.json.items).toHaveLength(1)
    const sem = await api<{ items: { message: { body: string }; score: number }[] }>('GET', '/api/search?q=hiking%20mountains&mode=semantic', undefined, browser)
    expect(sem.json.items[0].message.body).toContain('hiking')
    const one = await api<{ items: { session: { uid: string } }[] }>('GET', `/api/search?q=violins&scope=session&session=${now.s.uid}`, undefined, browser)
    expect(one.json.items).toEqual([])
    expect((await api('GET', '/api/search?q=x&scope=session', undefined, browser)).status).toBe(400)
  })

  it('a private session sends nothing to Voyage, ever (07 B9)', async () => {
    mock.voyage.reset()
    const p = session('Secret', [
      ['user', 'my secret diary entry about the canary yellow submarine'],
      ['assistant', 'Your canary yellow submarine secret is safe.']
    ], { private: true })
    await indexed()
    await mem.search({ query: 'canary yellow submarine' }, { sessionUid: p.s.uid }, 1200)
    await mem.autoRecall('canary yellow submarine', { sessionUid: p.s.uid }, 400)
    expect(mock.voyage.log()).toEqual([])
    expect(mock.voyage.embeddedTexts().join(' ')).not.toContain('canary')
  })
})

describe('REST: facts, backfill, manifest, forget, index @R7', () => {
  it('facts CRUD (07 A4) with a version for the engine', async () => {
    const v0 = mem.facts.version()
    const f = await api<{ id: number; text: string }>('POST', '/api/facts', { text: '  My sister is called   Mia ' }, browser)
    expect(f.json.text).toBe('My sister is called Mia')
    expect(mem.facts.version()).not.toBe(v0)
    expect(mem.facts.note()).toContain('- My sister is called Mia')
    expect((await api<{ text: string }>('PATCH', `/api/facts/${f.json.id}`, { text: 'Sister: Mia' }, browser)).json.text).toBe('Sister: Mia')
    expect((await api<unknown[]>('GET', '/api/facts', undefined, browser)).json).toHaveLength(1)
    expect((await api('POST', '/api/facts', { text: '   ' }, browser)).status).toBe(400)
    expect((await api('DELETE', `/api/facts/${f.json.id}`, undefined, browser)).status).toBe(204)
    expect((await api('DELETE', `/api/facts/${f.json.id}`, undefined, browser)).status).toBe(404)
    expect(mem.facts.note()).toBeNull()
  })

  it('backfill: estimate history, then consent per session (07 C12)', async () => {
    // History written while memory was off (no key) is not queued automatically.
    const old = repos().sessions.create({ title: 'Old history', now: clock })
    for (let i = 0; i < 5; i++) repos().messages.append({ sessionId: old.id, role: i % 2 ? 'assistant' : 'user', body: `old history message number ${i} about gardening tomatoes`, tsUtc: clock + i, tzOffsetMin: 0, tzName: 'UTC', device: null })
    const est = await api<{ messages: number; sessions: number; estTokens: number; estUsd: number; estSeconds: number }>('GET', '/api/memory/backfill/estimate', undefined, browser)
    expect(est.json.messages).toBeGreaterThanOrEqual(5)
    expect(est.json.sessions).toBeGreaterThanOrEqual(1)
    expect(est.json.estTokens).toBeGreaterThan(0)
    const r = await api<{ queued: number }>('POST', '/api/memory/backfill', { choice: 'sessions', sessionUids: [old.uid] }, browser)
    expect(r.json.queued).toBe(5)
    expect(repos().sessions.byId(old.id)!.meta.backfill).toBe('all')
    await indexed()
    expect((await api<{ messages: number }>('GET', '/api/memory/backfill/estimate', undefined, browser)).json.messages).toBe(est.json.messages - 5)
  })

  it('manifest lists sessions with links both ways', async () => {
    const m = await api<{ sessions: { shortId: string; links: string[]; linkedFrom: string[] }[]; exportedUtc: number }>('GET', '/api/memory/manifest', undefined, browser)
    expect(m.json.sessions.length).toBeGreaterThan(3)
    const a = m.json.sessions.find((s) => s.links.length > 0)!
    expect(a.links.length).toBeGreaterThan(0)
    expect(m.json.sessions.some((s) => s.linkedFrom.includes(a.shortId))).toBe(true)
  })

  it('forget removes the vectors, bits and FTS row, and emits message.deleted', async () => {
    const f = session('Forget me', [['user', 'the purple elephant password is hunter2 maybe']])
    await indexed()
    const id = f.ids[0]
    expect(Number((ctx.db.prepare('SELECT count(*) AS c FROM vectors WHERE message_id = ?').get(id) as { c: number }).c)).toBe(1)
    const uid = repos().messages.byId(id)!.uid
    expect((await api('DELETE', `/api/memory/messages/${uid}`, undefined, browser)).status).toBe(204)
    await until(() => Number((ctx.db.prepare('SELECT count(*) AS c FROM vectors WHERE message_id = ?').get(id) as { c: number }).c) === 0, 3000, 'vectors gone')
    expect(Number((ctx.db.prepare('SELECT count(*) AS c FROM vector_bits WHERE message_id = ?').get(id) as { c: number }).c)).toBe(0)
    expect(Number((ctx.db.prepare("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'elephant'").get() as { c: number }).c)).toBe(0)
    expect((await api<{ items: unknown[] }>('GET', '/api/search?q=elephant', undefined, browser)).json.items).toEqual([])
  })

  it('re-index needs sudo; deleting the index keeps messages', async () => {
    expect((await api<{ error: { code: string } }>('POST', '/api/memory/reindex', { scope: 'missing' }, browser)).json.error.code).toBe('sudo_required')
    expect((await api<{ queued: number }>('POST', '/api/memory/reindex', { scope: 'missing' })).json.queued).toBeGreaterThanOrEqual(0)
    const before = Number((ctx.db.prepare('SELECT count(*) AS c FROM messages').get() as { c: number }).c)
    expect((await api('DELETE', '/api/memory/index')).status).toBe(204)
    expect(Number((ctx.db.prepare('SELECT count(*) AS c FROM vectors').get() as { c: number }).c)).toBe(0)
    expect(Number((ctx.db.prepare('SELECT count(*) AS c FROM messages').get() as { c: number }).c)).toBe(before)
    expect((await api<{ queued: number }>('POST', '/api/memory/reindex', { scope: 'all' })).json.queued).toBeGreaterThan(0)
  })

  it('broadcasts memory.progress when the status changes', async () => {
    const p = new WsProbe(wsUrl(t), { origin: t.origin, cookie: browser })
    await p.hello()
    session('Progress', [['user', 'a brand new message that needs indexing now']])
    const ev = await p.next('memory.progress', () => true, 5000)
    expect(ev.status).toMatchObject({ state: expect.any(String), queued: expect.any(Number) })
    p.close()
  })
})

describe('Voyage switched off (keyword memory, F37)', () => {
  beforeEach(() => mock.voyage.reset())
  it('stops queueing and calls Voyage no more; the AI memory keeps working by keywords on this PC', async () => {
    await api('PATCH', '/api/settings', { memory: { enabled: false } })
    const s = session('After off', [['user', 'nothing here should be embedded at all today']])
    const asking = session('Asking', [['user', 'a later chat']])
    repos().sessions.update(asking.s.id, { memoryScope: 'all' })
    const r = await mem.search({ query: 'embedded' }, { sessionUid: asking.s.uid }, 1200)
    expect(r.refused).toBeUndefined()
    expect(r.mode).toBe('keyword')
    expect(r.hits.map((h) => h.body)).toContain('nothing here should be embedded at all today')
    expect((await mem.recall({ shortId: s.s.shortId }, { sessionUid: s.s.uid })).refused).toBeUndefined()
    // A chat's own switch still turns it off.
    repos().sessions.update(asking.s.id, { memory: 'off' })
    expect((await mem.search({ query: 'embedded' }, { sessionUid: asking.s.uid }, 1200)).refused).toBe(REFUSALS.sessionOff)
    expect(mock.voyage.log()).toEqual([])
    expect(Number((ctx.db.prepare('SELECT count(*) AS c FROM embed_queue WHERE message_id = ?').get(s.ids[0]) as { c: number }).c)).toBe(0)
    await until(() => mem.status().state === 'disabled', 3000, 'disabled')
    // Keyword search in the UI keeps working.
    expect((await api<{ items: unknown[] }>('GET', '/api/search?q=embedded', undefined, browser)).json.items).toHaveLength(1)
  })
})
