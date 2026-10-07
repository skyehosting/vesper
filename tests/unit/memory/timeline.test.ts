/**
 * The memory viewer's server parts (memory-ui, Phase 3): GET /api/memory/timeline (R7: tagged, machine-timestamped
 * messages with session ids, newest first, filters, keyset paging), GET /api/data/usage, and SessionSummary.imported.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TimelineEntry } from '@shared/types/domain'
import { startTestServer, type TestServer } from '../server/helpers'

let t: TestServer
let cookie: string
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0)

beforeAll(async () => {
  t = await startTestServer()
  cookie = await t.login('browser')
})
afterAll(() => t.close())

const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
  const r = await t.inject({ method: 'GET', url, cookie })
  return { status: r.statusCode, body: r.json() as T }
}
type Page = { items: TimelineEntry[]; next: string | null }

describe('memory timeline @R7', () => {
  let a: { uid: string; id: bigint; shortId: string }
  let b: { uid: string; id: bigint }

  beforeAll(() => {
    const { repos } = t.server.ctx
    const sa = repos.sessions.create({ title: 'Garden', now: T0 })
    const sb = repos.sessions.create({ title: 'Trip', now: T0, private: true })
    a = { uid: sa.uid, id: sa.id, shortId: sa.shortId }
    b = { uid: sb.uid, id: sb.id }
    // Interleaved in time: a1 (t+1), b1 (t+2), a2 (t+3), b2 (t+4) …, plus one hidden and one forgotten message.
    for (let i = 0; i < 6; i++) {
      const sid = i % 2 === 0 ? sa.id : sb.id
      repos.messages.append({
        sessionId: sid,
        role: i % 4 < 2 ? 'user' : 'assistant',
        body: `m${i}`,
        tsUtc: T0 + (i + 1) * 60_000,
        tzOffsetMin: -240,
        tzName: 'America/New_York',
        device: 'test'
      })
    }
    repos.messages.append({
      sessionId: sa.id,
      role: 'user',
      body: 'hidden opener',
      tsUtc: T0 + 100 * 60_000,
      tzOffsetMin: 0,
      tzName: null,
      device: 'test',
      hidden: true
    })
    const gone = repos.messages.append({
      sessionId: sb.id,
      role: 'user',
      body: 'forget me',
      tsUtc: T0 + 101 * 60_000,
      tzOffsetMin: 0,
      tzName: null,
      device: 'test'
    })
    repos.messages.softDelete(gone.id)
    // An imported conversation keeps its original (older) timestamps although it is inserted last.
    const old = repos.sessions.create({ title: 'From ChatGPT', now: T0, meta: { imported: { source: 'chatgpt', key: 'k1', utc: T0 } } })
    repos.messages.append({ sessionId: old.id, role: 'user', body: 'ancient', tsUtc: T0 - 365 * 86_400_000, tzOffsetMin: 0, tzName: null, device: 'import' })
  })

  it('lists visible on-path messages across sessions, newest machine time first, with tag, zone and session id', async () => {
    const r = await get<Page>('/api/memory/timeline')
    expect(r.status).toBe(200)
    expect(r.body.items.map((e) => e.message.body)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1', 'm0', 'ancient'])
    const first = r.body.items.find((e) => e.message.body === 'm0')!
    expect(first.message.tag).toBe('user response')
    expect(first.message.tzName).toBe('America/New_York')
    expect(first.session).toEqual({ uid: a.uid, shortId: a.shortId, title: 'Garden', private: false })
    expect(r.body.items.find((e) => e.message.body === 'm1')!.session.private).toBe(true)
    expect(r.body.items.find((e) => e.message.body === 'm2')!.message.tag).toBe('ai response')
    expect(r.body.next).toBeNull()
  })

  it('pages with an opaque cursor and never repeats or skips', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const page: { status: number; body: Page } = await get<Page>(`/api/memory/timeline?limit=2${q}`)
      expect(page.body.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.body.items.map((e) => e.message.body))
      cursor = page.body.next
    } while (cursor)
    expect(seen).toEqual(['m5', 'm4', 'm3', 'm2', 'm1', 'm0', 'ancient'])
  })

  it('filters by session (session order), role and date range', async () => {
    const one = await get<Page>(`/api/memory/timeline?session=${a.uid}&limit=2`)
    expect(one.body.items.map((e) => e.message.body)).toEqual(['m4', 'm2'])
    expect(one.body.next).toMatch(/^s\d+$/)
    const rest = await get<Page>(`/api/memory/timeline?session=${a.uid}&cursor=${one.body.next}`)
    expect(rest.body.items.map((e) => e.message.body)).toEqual(['m0'])

    const users = await get<Page>('/api/memory/timeline?role=user')
    expect(users.body.items.every((e) => e.message.role === 'user')).toBe(true)
    expect(users.body.items.map((e) => e.message.body)).toEqual(['m5', 'm4', 'm1', 'm0', 'ancient'])

    const range = await get<Page>(`/api/memory/timeline?fromUtc=${T0 + 2 * 60_000}&toUtc=${T0 + 4 * 60_000}`)
    expect(range.body.items.map((e) => e.message.body)).toEqual(['m3', 'm2', 'm1'])
  })

  it('leaves out trashed sessions; rejects bad cursors and unknown sessions', async () => {
    const { repos } = t.server.ctx
    repos.sessions.softDelete(b.id, T0)
    const r = await get<Page>('/api/memory/timeline')
    expect(r.body.items.map((e) => e.message.body)).toEqual(['m4', 'm2', 'm0', 'ancient'])
    repos.sessions.restore(b.id)
    expect((await get('/api/memory/timeline?cursor=nope')).status).toBe(400)
    expect((await get(`/api/memory/timeline?session=${a.uid}&cursor=t1:1`)).status).toBe(400)
    expect((await get('/api/memory/timeline?session=missing')).status).toBe(404)
  })

  it('marks imported sessions in summaries', async () => {
    const list = await get<{ items: { title: string; imported?: string }[] }>('/api/sessions')
    expect(list.body.items.find((s) => s.title === 'From ChatGPT')?.imported).toBe('chatgpt')
    expect(list.body.items.find((s) => s.title === 'Garden')?.imported).toBeUndefined()
  })
})

describe('data usage', () => {
  it('reports database, attachments, backups, exports, models and logs sizes', async () => {
    const p = t.server.ctx.paths
    fs.mkdirSync(p.exports, { recursive: true })
    fs.writeFileSync(path.join(p.exports, 'x.zip'), Buffer.alloc(1234))
    fs.mkdirSync(p.models, { recursive: true })
    fs.writeFileSync(path.join(p.models, 'm.onnx'), Buffer.alloc(4321))
    // The reader caches for a few seconds; this is the first read in this process.
    const r = await get<Record<string, number | null>>('/api/data/usage')
    expect(r.status).toBe(200)
    expect(r.body.database).toBeGreaterThan(0)
    expect(r.body.exports).toBe(1234)
    expect(r.body.models).toBe(4321)
    for (const k of ['wal', 'attachments', 'attachmentCount', 'backups', 'backupCount', 'logs']) expect(typeof r.body[k]).toBe('number')
    expect(r.body.freeDisk === null || (r.body.freeDisk as number) > 0).toBe(true)
  })
})
