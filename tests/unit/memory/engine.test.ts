/**
 * db.worker engine against a real migrated DB and the mock Voyage server (07 C9–C11, B9): embed queue, vectors + bits,
 * hybrid search with fusion and rerank, scope and privacy, deletes, generations, rate limits, failures, leaks.
 * @R7 @R8
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { signBits } from '@server/memory/engine/bitIndex'
import type { SearchArgs, WorkerStatus } from '@server/memory/engine/protocol'
import { rrf } from '@server/memory/engine/search'
import { startMockServer, type MockServer } from '../../mocks/server'
import { removeTempDir } from '../../fakes/temp'
import { addSession, count, DAY, enqueueAll, harness, memDb, until, type Harness, type MemDb } from './helpers'

let mock: MockServer
let m: MemDb
let h: Harness | null = null

beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => {
  mock.reset()
  m = memDb()
})
afterEach(async () => {
  await h?.link.close()
  h = null
  m.db.close()
  removeTempDir(m.dir)
})

const voyageUrl = () => `${mock.url}/voyage/v1`
const search = (a: Partial<SearchArgs> & { query: string }) =>
  h!.link.request('search', { sessionIds: null, after: null, before: null, voyage: true, rerank: true, deadline: Date.now() + 2000, limit: 10, ...a }, 5000)
const drain = () => h!.link.request('drain', {}, 20_000)
const status = () => h!.link.request('status', {}, 5000)

function seedTrip() {
  const trip = addSession(m, 'Travel', [
    ['user', 'We should plan a trip to Lisbon in the spring with the kids'],
    ['assistant', 'Lisbon in spring is lovely: trams, pastel de nata and mild weather for the kids.'],
    ['user', 'Book the hotel near the castle please and check the tram schedule'],
    ['assistant', 'Noted: a hotel near the castle and the tram schedule for your Lisbon trip.']
  ])
  const food = addSession(m, 'Baking', [
    ['user', 'My sourdough starter died again this week, what went wrong'],
    ['assistant', 'Sourdough starters usually die from heat or skipped feedings; keep it cooler.']
  ])
  return { trip, food }
}

describe('embed queue → vectors + bits @R7', () => {
  it('embeds queued messages as int8 vectors with matching sign bits, tagged, without control tags', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(4)
    expect(count(m.db, 'SELECT count(*) AS c FROM vector_bits')).toBe(4)
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(0)
    const row = m.db.prepare('SELECT v.v AS v, b.bits AS bits, b.session_id AS sid, b.ts_utc AS ts FROM vectors v JOIN vector_bits b USING (message_id, chunk, gen) WHERE message_id = ?').get(trip.messages[1].id) as {
      v: Uint8Array
      bits: Uint8Array
      sid: number
      ts: number
    }
    expect(row.v.byteLength).toBe(1024)
    expect(Array.from(row.bits)).toEqual(Array.from(signBits(new Int8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength))))
    // The record carries the session and the sender's timestamp (R7).
    expect(Number(row.sid)).toBe(Number(trip.session.id))
    expect(Number(row.ts)).toBe(trip.messages[1].tsUtc)
    const texts = mock.voyage.embeddedTexts()
    expect(texts[0]).toMatch(/^(In reply to: .*\n)?(user|ai) response: /)
    expect(mock.voyage.counts()).toMatchObject({ document: 1, query: 0 })
    const s = await status()
    expect(s).toMatchObject({ queued: 0, model: 'voyage-4-lite', dim: 1024, activeGen: 1 })
  })

  it('skips what must not be embedded and keeps streaming messages for later', async () => {
    const ok = addSession(m, 'Ok', [['user', 'tell me about the northern lights in winter']])
    const priv = addSession(m, 'Private', [['user', 'my private medical results came back today']], { private: true })
    const off = addSession(m, 'Off', [['user', 'this session has memory switched off entirely']])
    m.repos.sessions.update(off.session.id, { memory: 'off' })
    const misc = addSession(m, 'Misc', [
      ['user', 'ok 👍'],
      ['user', 'a message that will be deleted soon enough'],
      ['user', 'a hidden continuation opener message here']
    ])
    m.repos.messages.softDelete(misc.messages[1].id)
    m.db.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').run(misc.messages[2].id)
    const streaming = m.repos.messages.append({ sessionId: ok.session.id, role: 'assistant', body: 'the aurora is best seen far north', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null, status: 'streaming' })
    enqueueAll(m, [...ok.messages, ...priv.messages, ...off.messages, ...misc.messages, streaming])
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    const texts = mock.voyage.embeddedTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('northern lights')
    expect(texts.join('\n')).not.toMatch(/medical|switched off|deleted soon|hidden continuation|👍/)
    // Only the streaming reply waits in the queue.
    expect((m.db.prepare('SELECT message_id FROM embed_queue').all() as { message_id: number }[]).map((r) => Number(r.message_id))).toEqual([Number(streaming.id)])
  })

  it('retries after a 5xx with backoff and resumes', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    mock.voyage.failNext(503, 1)
    h = await harness(m, { baseUrl: voyageUrl() }, { random: () => 0 })
    await drain()
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vectors') === 4, 5000, 'vectors after retry')
    expect(mock.voyage.counts()).toMatchObject({ document: 1, rejected: 1 })
    expect((await status()).problem).toBeNull()
  })

  it('splits a batch on 400 until the bad input is isolated and skipped', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    mock.voyage.failNext(400, 3)
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(3)
    expect(count(m.db, "SELECT count(*) AS c FROM embed_queue WHERE last_error = 'skip'")).toBe(1)
    expect((await status()).errors).toBe(1)
  })

  it('stops on 401 and resumes when the key changes', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    mock.voyage.setKeys(['pa-good'])
    h = await harness(m, { baseUrl: voyageUrl(), key: 'pa-bad' })
    await drain()
    expect((await status()).problem?.code).toBe('provider_auth')
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(4)
    h.reconfigure({ key: 'pa-good' })
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vectors') === 4, 5000, 'vectors after the key change')
  })
})

describe('search pipeline (research 02 §5.3) @R8', () => {
  async function indexed() {
    const seeded = seedTrip()
    enqueueAll(m, [...seeded.trip.messages, ...seeded.food.messages])
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    await h.link.request('loadIndex', {}, 5000)
    mock.voyage.reset()
    return seeded
  }

  it('fuses keyword and vector legs, reranks, and returns the best match first', async () => {
    const { trip } = await indexed()
    const r = await search({ query: 'Lisbon trip in spring' })
    expect(r.mode).toBe('hybrid')
    expect(r.degraded).toBeUndefined()
    expect(r.items[0].id).toBe(Number(trip.messages[0].id))
    expect(r.items[0].via.rerank).toBeGreaterThan(0.5)
    expect(r.items[0].via.vector).toBeGreaterThan(0.3)
    expect(r.items.map((i) => i.score)).toEqual([...r.items.map((i) => i.score)].sort((a, b) => b - a))
    expect(mock.voyage.counts()).toMatchObject({ query: 1, rerank: 1, document: 0 })
    expect(mock.voyage.rerankQueries()[0]).toContain('Query: Lisbon trip in spring')
  })

  it('RRF adds the reciprocal ranks of every list', () => {
    const fused = rrf([
      [1, 2, 3],
      [3, 1]
    ])
    expect(fused.map((f) => f.id)).toEqual([1, 3, 2])
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62)
  })

  it('without Voyage it is keyword-only and sends nothing', async () => {
    const { food } = await indexed()
    h!.reconfigure({ key: null })
    const r = await search({ query: 'sourdough starter' })
    expect(r.mode).toBe('keyword')
    expect(r.degraded).toBe('no-key')
    expect(r.items[0].id).toBe(Number(food.messages[0].id))
    expect(mock.voyage.counts()).toMatchObject({ query: 0, rerank: 0 })
  })

  it('a scope that may not reach Voyage (private) sends nothing (07 B9)', async () => {
    await indexed()
    const r = await search({ query: 'Lisbon', voyage: false })
    expect(r.mode).toBe('keyword')
    expect(r.degraded).toBe('not-allowed')
    expect(mock.voyage.log()).toEqual([])
  })

  it('degrades to keyword-only when the query embedding misses its budget', async () => {
    await indexed()
    mock.voyage.setDelay(800)
    const t0 = Date.now()
    const r = await search({ query: 'Lisbon tram', deadline: Date.now() + 300 })
    expect(Date.now() - t0).toBeLessThan(700)
    expect(r.mode).toBe('keyword')
    expect(r.degraded).toBe('budget')
    expect(r.items.length).toBeGreaterThan(0)
  })

  it('clamps to the allowed sessions and the time window', async () => {
    const { trip, food } = await indexed()
    const onlyFood = await search({ query: 'Lisbon sourdough', sessionIds: [Number(food.session.id)] })
    expect(onlyFood.items.every((i) => food.messages.some((x) => Number(x.id) === i.id))).toBe(true)
    const t1 = trip.messages[1].tsUtc
    const window = await search({ query: 'Lisbon', after: t1, before: t1 + 120_000, sessionIds: [Number(trip.session.id)] })
    const inWindow = trip.messages.filter((x) => x.tsUtc >= t1 && x.tsUtc < t1 + 120_000).map((x) => Number(x.id))
    expect(window.items.length).toBeGreaterThan(0)
    expect(window.items.every((i) => inWindow.includes(i.id))).toBe(true)
    expect(window.items.map((i) => i.id)).toContain(Number(trip.messages[1].id))
    const none = await search({ query: 'Lisbon', after: Date.now() + DAY })
    expect(none.items).toEqual([])
  })

  it('finds an old message of a small scope among thousands of newer matches (id-range bound)', async () => {
    const old = addSession(m, 'Old', [['user', 'the zebra crossing near the old harbour market']])
    const noise: Array<['user', string]> = Array.from({ length: 2500 }, (_, i) => ['user', `zebra stripes number ${i} in the zoo today`])
    addSession(m, 'Noise', noise)
    h = await harness(m, { baseUrl: voyageUrl(), key: null })
    const r = await search({ query: 'zebra harbour', sessionIds: [Number(old.session.id)] })
    expect(r.items.map((i) => i.id)).toEqual([Number(old.messages[0].id)])
  })

  it('a delete removes vectors, bits and queue rows at once, and the hit disappears', async () => {
    const { trip } = await indexed()
    const victim = trip.messages[0]
    m.repos.messages.softDelete(victim.id) // FTS row goes through the trigger (main connection)
    h!.link.send({ t: 'messagesDeleted', ids: [Number(victim.id)] })
    await until(async () => count(m.db, 'SELECT count(*) AS c FROM vectors WHERE message_id = ?', victim.id) === 0, 3000, 'vector delete')
    expect(count(m.db, 'SELECT count(*) AS c FROM vector_bits WHERE message_id = ?', victim.id)).toBe(0)
    expect(count(m.db, "SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'kids' AND rowid = ?", victim.id)).toBe(0)
    const r = await search({ query: 'Lisbon trip in spring with the kids' })
    expect(r.items.map((i) => i.id)).not.toContain(Number(victim.id))
  })

  it('turning a session private deletes its vectors, bits and queue rows (07 B9)', async () => {
    const { trip } = await indexed()
    m.repos.sessions.update(trip.session.id, { private: true })
    enqueueAll(m, trip.messages)
    h!.link.send({ t: 'sessionFlagged', sessionId: Number(trip.session.id) })
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vector_bits WHERE session_id = ?', trip.session.id) === 0, 3000, 'private purge')
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors v JOIN messages x ON x.id = v.message_id WHERE x.session_id = ?', trip.session.id)).toBe(0)
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(0)
    expect((await status()).indexed).toBe(2)
  })

  it('a variant switch flags off-path rows and enqueues the newly on-path ones', async () => {
    const { trip } = await indexed()
    // Regenerate the last reply: the old one goes off-path, the new one is on-path but not embedded.
    m.repos.branches.fork(trip.session.id, 4, 'regenerate', Date.now())
    const fresh = m.repos.messages.append({ sessionId: trip.session.id, role: 'assistant', body: 'A different answer about castles and trams in Lisbon.', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null })
    h!.link.send({ t: 'pathChanged', sessionId: Number(trip.session.id) })
    await until(() => count(m.db, 'SELECT count(*) AS c FROM embed_queue WHERE message_id = ?', fresh.id) === 1 || count(m.db, 'SELECT count(*) AS c FROM vectors WHERE message_id = ?', fresh.id) === 1, 3000, 'enqueue')
    const r = await search({ query: 'hotel near the castle tram schedule Lisbon trip' })
    expect(r.items.map((i) => i.id)).not.toContain(Number(trip.messages[3].id))
  })
})

describe('generations (07 C10)', () => {
  it('a model change within the voyage-4 family keeps the generation', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    h.reconfigure({ embedModel: 'voyage-4-large' })
    await until(async () => (await status()).model === 'voyage-4-large', 3000, 'model update')
    expect(count(m.db, 'SELECT count(*) AS c FROM memory_generations')).toBe(1)
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(0)
  })

  it('a dimension change builds a new generation, swaps at 100 % and clears the old one', async () => {
    const { trip, food } = seedTrip()
    enqueueAll(m, [...trip.messages, ...food.messages])
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    await h.link.request('loadIndex', {}, 5000)
    h.reconfigure({ dim: 512 })
    await until(async () => (await status()).reindex !== null, 3000, 'building gen')
    const building = await status()
    expect(building.reindex).toMatchObject({ gen: 2, total: 6 })
    // While building, searches still use the active 1024-d generation.
    expect(building.activeGen).toBe(1)
    await drain()
    await until(async () => (await status()).activeGen === 2, 5000, 'swap')
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vectors WHERE gen = 1') === 0, 5000, 'old gen cleared')
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors WHERE gen = 2 AND dim = 512')).toBe(6)
    expect((m.db.prepare('SELECT gen, dim, state FROM memory_generations').all() as { gen: number; dim: number; state: string }[]).map((g) => [Number(g.gen), Number(g.dim), g.state])).toEqual([[2, 512, 'active']])
    await until(async () => (await status()).index === 'ready', 5000, 'index reload')
    mock.voyage.reset()
    const r = await search({ query: 'sourdough starter died' })
    expect(r.mode).toBe('hybrid')
    expect(r.items[0].id).toBe(Number(food.messages[0].id))
    expect(mock.voyage.log().find((e) => e.inputType === 'query')?.dim).toBe(512)
  })
  it('"delete index" while a batch is in flight discards that batch (gen numbers are reused)', async () => {
    const { trip } = seedTrip()
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    enqueueAll(m, trip.messages)
    // The batch reaches the mock, then waits there while the whole index is deleted and gen 1 is created anew.
    mock.voyage.setDelay(400)
    const pass = drain()
    await until(async () => (await h!.link.request('stats', {}, 5000)).sizes.inflight > 0, 3000, 'batch in flight')
    const r = await h.link.job({ kind: 'deleteIndex' })
    expect(r.kind).toBe('deleteIndex')
    await pass
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(0)
    expect(count(m.db, 'SELECT count(*) AS c FROM vector_bits')).toBe(0)
    expect((m.db.prepare('SELECT gen FROM memory_generations').all() as { gen: number }[]).map((g) => Number(g.gen))).toEqual([1])
    expect(mock.voyage.counts().document).toBeGreaterThan(0)
  })
})

describe('free-trial rate limits (07 C11)', () => {
  it('the background lane leaves a request for the foreground and reports the backlog', async () => {
    const long = 'a long message about mountains rivers forests and lakes. '.repeat(70)
    const s = addSession(
      m,
      'Bulk',
      Array.from({ length: 40 }, (_, i) => ['user', `${i} ${long}`] as ['user', string])
    )
    enqueueAll(m, s.messages)
    mock.voyage.mode('free-trial')
    h = await harness(m, { baseUrl: voyageUrl(), tier: 'auto' })
    await drain()
    // One batch fits the 8K-token cap; the next must wait for the 60 s window.
    const st = await status()
    expect(st.tier).toBe('free')
    expect(st.rpmUsed).toBe(1)
    expect(st.queued).toBeGreaterThan(0)
    expect(st.queueEtaSec).toBeGreaterThan(120)
    expect(mock.voyage.counts()).toMatchObject({ document: 1, rejected: 0 })
    // The foreground still gets its query embedding within budget.
    await h.link.request('loadIndex', {}, 5000)
    const r = await search({ query: 'mountains rivers' })
    expect(r.mode).toBe('hybrid')
    // Free trial: no rerank (07 C11).
    expect(mock.voyage.counts()).toMatchObject({ query: 1, rerank: 0, rejected: 0 })
  })

  it('a 429 steps auto back to the free trial and surfaces voyage_backlog', async () => {
    const long = 'notes about history art music and travel plans. '.repeat(80)
    const s = addSession(
      m,
      'Bulk',
      Array.from({ length: 60 }, (_, i) => ['user', `${i} ${long}`] as ['user', string])
    )
    enqueueAll(m, s.messages)
    mock.voyage.failNext(429, 1)
    h = await harness(m, { baseUrl: voyageUrl(), tier: 'auto' })
    await drain()
    const st = await status()
    expect(st.problem?.code).toBe('voyage_backlog')
    expect(st.tier).toBe('free')
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(0)
  })
})

describe('resource hygiene @R17', () => {
  it('no growth in worker maps over 10k queued items; nothing left in flight', async () => {
    const make = (n: number, base: number) =>
      addSession(
        m,
        `Leak ${base}`,
        Array.from({ length: n }, (_, i) => [i % 2 ? 'assistant' : 'user', `item ${base + i} talks about topic ${(base + i) % 97} and colour ${(base + i) % 13}`] as ['user' | 'assistant', string])
      )
    h = await harness(m, { baseUrl: voyageUrl(), dim: 256 })
    await h.link.request('loadIndex', {}, 5000)
    const round = async (base: number) => {
      const s = make(5000, base)
      enqueueAll(m, s.messages)
      h!.link.send({ t: 'enqueued', count: s.messages.length })
      await drain()
      await until(async () => (await status()).queued === 0, 20_000, 'queue drained')
      return h!.link.request('stats', { gc: true }, 5000)
    }
    const first = await round(0)
    const second = await round(5000)
    expect(count(m.db, 'SELECT count(*) AS c FROM vector_bits')).toBe(10_000)
    for (const k of ['inflight', 'jobs', 'countCache', 'statements', 'schedulerWindow'] as const) expect(second.sizes[k], k).toBeLessThanOrEqual(Math.max(first.sizes[k], k === 'schedulerWindow' ? 20 : 0))
    expect(second.sizes.inflight).toBe(0)
    expect(second.sizes.jobs).toBe(0)
    expect(second.sizes.index).toBe(10_000)
    expect(h.link.sizes).toEqual({ pending: 0, jobs: 0 })
    const st: WorkerStatus = await status()
    expect(st.indexed).toBe(10_000)
  }, 60_000)
})

describe('pausing (game mode, low disk)', () => {
  it('holds the background lane while paused and resumes after', async () => {
    const { trip } = seedTrip()
    enqueueAll(m, trip.messages)
    h = await harness(m, { baseUrl: voyageUrl(), paused: true })
    await drain()
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(0)
    expect(mock.voyage.counts().document).toBe(0)
    h.reconfigure({ paused: false })
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vectors') === 4, 5000, 'resumed')
  })
})

describe('F15: deleted and hidden neighbours are never embedded as context (07 B9)', () => {
  it('a reply queued after its user message was forgotten is embedded without "In reply to:" the deleted text', async () => {
    const s = addSession(m, 'Pin', [
      ['user', 'my FORGOTCANARY bank pin is something private'],
      ['assistant', 'Okay, I will not mention that again to anyone at all.']
    ])
    m.repos.messages.softDelete(s.messages[0].id)
    m.repos.embedQueue.enqueue(s.messages[1].id)
    h = await harness(m, { baseUrl: voyageUrl() })
    h.link.send({ t: 'messagesDeleted', ids: [Number(s.messages[0].id)] })
    await drain()
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(1)
    expect(mock.voyage.embeddedTexts().join('\n')).not.toContain('FORGOTCANARY')
  })

  it('a hidden message is never context either', async () => {
    const s = m.repos.sessions.create({ title: 'Hidden', now: Date.UTC(2026, 8, 1) })
    m.repos.messages.append({ sessionId: s.id, role: 'user', body: 'HIDDENCANARY hidden opener text here', tsUtc: Date.UTC(2026, 8, 1), tzOffsetMin: 0, tzName: 'UTC', device: null, hidden: true })
    const reply = m.repos.messages.append({ sessionId: s.id, role: 'assistant', body: 'Welcome back, let us continue where we left off.', tsUtc: Date.UTC(2026, 8, 1, 0, 1), tzOffsetMin: 0, tzName: 'UTC', device: null })
    m.repos.embedQueue.enqueue(reply.id)
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(1)
    expect(mock.voyage.embeddedTexts().join('\n')).not.toContain('HIDDENCANARY')
  })

  it('deleting a message re-embeds the next one, so no stored vector still encodes the deleted text', async () => {
    const s = addSession(m, 'Pin 2', [
      ['user', 'the SECONDCANARY door code is written down here'],
      ['assistant', 'Got it, I have noted the door code for you now.']
    ])
    enqueueAll(m, s.messages)
    h = await harness(m, { baseUrl: voyageUrl() })
    await drain()
    expect(mock.voyage.embeddedTexts().join('\n')).toContain('In reply to: the SECONDCANARY')
    mock.voyage.reset()
    m.repos.messages.softDelete(s.messages[0].id)
    h.link.send({ t: 'messagesDeleted', ids: [Number(s.messages[0].id)] })
    await until(() => mock.voyage.embeddedTexts().length > 0, 5000, 'reply re-embedded')
    await drain()
    expect(mock.voyage.embeddedTexts()).toEqual(['ai response: Got it, I have noted the door code for you now.'])
    expect(count(m.db, `SELECT count(*) AS c FROM vectors WHERE message_id = ${Number(s.messages[1].id)}`)).toBe(1)
    expect(count(m.db, `SELECT count(*) AS c FROM vectors WHERE message_id = ${Number(s.messages[0].id)}`)).toBe(0)
  })
})
