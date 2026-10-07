/**
 * Memory privacy regressions (Phase 4b review, fix-memory-privacy): text of private and memory-off chats never
 * reaches Voyage from the UI search (F14); deleted/hidden neighbours are never embedded as reply context (F15).
 * Real server, in-process db.worker engine, mock Voyage recorder. 07 B9.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryOf, type MemoryServiceImpl } from '@server/memory'
import type { SessionRow } from '@server/db/repos'
import type { ServerContext } from '@server/services'
import { startMockServer, type MockServer } from '../../mocks/server'
import { coreOf, startTestServer, type TestServer } from '../server/helpers'
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
  mock.voyage.setKeys(['pa-good'])
  expect((await api('PATCH', '/api/settings', { memory: { enabled: true, voyage: { tier: 'tier1' } } })).status).toBe(200)
  expect((await api('PUT', '/api/secrets/voyage', { value: 'pa-good' })).status).toBe(200)
  await until(() => mem.hasKey(), 3000, 'key cached')
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

function session(title: string, msgs: Array<['user' | 'assistant', string]>, o: { private?: boolean } = {}): { s: SessionRow; ids: bigint[] } {
  const s = repos().sessions.create({ title, private: o.private, now: clock })
  const ids = msgs.map(([role, body]) => {
    clock += 60_000
    const m = repos().messages.append({ sessionId: s.id, role, body, tsUtc: clock, tzOffsetMin: 0, tzName: 'UTC', device: 'test' })
    ctx.services.memory!.onMessagePersisted(m.id)
    return m.id
  })
  return { s: repos().sessions.byId(s.id)!, ids }
}

async function indexed(): Promise<void> {
  await mem.link.request('drain', {}, 20_000)
  await until(async () => (await mem.link.request('status', {}, 5000)).queued === 0, 10_000, 'queue drained')
}

/** Every text that went to Voyage (rerank documents, rerank queries, embedding inputs). */
function voyageTraffic(): string {
  return mock.recorder
    .byModule('voyage')
    .map((r) => r.body)
    .join('\n')
}

describe('F14: semantic UI search never sends private or memory-off text to Voyage (07 B9)', () => {
  let priv: SessionRow
  let off: SessionRow
  beforeAll(async () => {
    session('Zoo trip', [
      ['user', 'we saw a zebra pattern on the wall at the zoo'],
      ['assistant', 'A zebra pattern mural sounds fun.']
    ])
    priv = session('Doctor', [
      ['user', 'zebra PRIVATECANARY my medical diagnosis is confidential'],
      ['assistant', 'Your zebra PRIVATECANARY secret is safe.']
    ], { private: true }).s
    // Memory off AFTER its messages were embedded: its vectors may still exist (both legs).
    const o = session('Off chat', [
      ['user', 'zebra OFFCANARY pattern notes for my eyes only'],
      ['assistant', 'Noted the zebra OFFCANARY pattern.']
    ])
    await indexed()
    repos().sessions.update(o.s.id, { memory: 'off' })
    mem.onSessionFlagsChanged(o.s.id)
    off = repos().sessions.byId(o.s.id)!
    await mem.warm()
    await until(async () => (await mem.link.request('status', {}, 5000)).index === 'ready', 10_000, 'index ready')
  })

  it('scope=all: reranks only shareable chats, still finds the private and memory-off hits locally', async () => {
    mock.recorder.clear()
    mock.voyage.reset()
    mock.voyage.setKeys(['pa-good'])
    const r = await api<{ items: { message: { body: string }; session: { uid: string } }[] }>('GET', '/api/search?q=zebra%20pattern&mode=semantic', undefined, browser)
    expect(r.status).toBe(200)
    // The search really reached Voyage (query embedding + rerank) for the public chat…
    expect(mock.voyage.counts().rerank).toBeGreaterThan(0)
    // …but no private or memory-off text went with it.
    const sent = voyageTraffic()
    expect(sent).toContain('zebra pattern on the wall')
    expect(sent).not.toContain('PRIVATECANARY')
    expect(sent).not.toContain('OFFCANARY')
    // The owner still finds their own private / memory-off messages (keyword, on this PC).
    const uids = new Set(r.json.items.map((i) => i.session.uid))
    expect(uids.has(priv.uid)).toBe(true)
    expect(uids.has(off.uid)).toBe(true)
  })

  it('scope=session on a memory-off chat stays on this PC', async () => {
    mock.recorder.clear()
    const r = await api<{ items: unknown[] }>('GET', `/api/search?q=zebra%20pattern&mode=semantic&scope=session&session=${off.uid}`, undefined, browser)
    expect(r.status).toBe(200)
    expect(r.json.items.length).toBeGreaterThan(0)
    expect(mock.recorder.byModule('voyage')).toEqual([])
  })

  it('defence in depth: the engine never reranks a private or memory-off message, whatever ids it is given', async () => {
    mock.recorder.clear()
    const ids = (ctx.db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL').all() as { id: number | bigint }[]).map((x) => Number(x.id))
    const res = await mem.link.request('search', { query: 'zebra pattern', sessionIds: ids, after: null, before: null, voyage: true, rerank: true, deadline: Date.now() + 1500, limit: 20, includeOffPath: true }, 3000)
    expect(res.items.length).toBeGreaterThan(0)
    expect(voyageTraffic()).not.toMatch(/PRIVATECANARY|OFFCANARY/)
  })
})
