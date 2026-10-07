/**
 * Phase 4 integration (int-server): `Session.tokens` on GET /api/sessions/:uid — the sum of the session's AI reply
 * usage, kept on the session row by migration 9's triggers (O(1) per read, 07 C9) — and the optional server-side
 * filters of GET /api/search (`role`, `from`, `to`), keyword and semantic, with paging. @R7 @R10
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchHit, Session } from '@shared/types/domain'
import { migrate, openDb } from '@server/db/sqlite'
import { MIGRATIONS } from '@server/db/migrations'
import { m009SessionTokens } from '@server/db/migrations/009_session_tokens'
import { createRepos } from '@server/db/repos/index'
import { coreOf, startTestServer, type TestServer } from './helpers'

let t: TestServer
let cookie: string

beforeAll(async () => {
  t = await startTestServer()
  cookie = await t.login('desktop')
})
afterAll(() => t.close())

const repos = () => coreOf(t.server.ctx).repos
const T0 = Date.UTC(2026, 8, 1, 12)

async function newSession(title: string): Promise<{ uid: string; id: bigint }> {
  const r = await t.inject({ method: 'POST', url: '/api/sessions', payload: { title }, cookie })
  const uid = (r.json() as Session).uid
  return { uid, id: repos().sessions.byUid(uid)!.id }
}

const getSession = async (uid: string) => (await t.inject({ method: 'GET', url: `/api/sessions/${uid}`, cookie })).json() as Session

describe('Session.tokens', () => {
  it('sums the usage of every AI reply (variants included), tracks updates, null when nothing was reported', async () => {
    const s = await newSession('Tokens')
    expect((await getSession(s.uid)).tokens).toBeNull()
    const add = (role: 'user' | 'assistant', i: number) => repos().messages.append({ sessionId: s.id, role, body: `m${i}`, tsUtc: T0 + i, tzOffsetMin: 0, tzName: 'UTC', device: 'd' })
    add('user', 1)
    const a = add('assistant', 2)
    repos().messages.update(a.id, { usage: { in: 100, out: 20, cacheRead: 50 } })
    add('user', 3)
    const b = add('assistant', 4)
    repos().messages.update(b.id, { usage: { in: 300, out: 40 } })
    expect((await getSession(s.uid)).tokens).toEqual({ in: 400, out: 60, cacheRead: 50 })
    // A usage rewrite replaces, it does not add (delta trigger); clearing it subtracts.
    repos().messages.update(b.id, { usage: { in: 310, out: 41 } })
    expect((await getSession(s.uid)).tokens).toEqual({ in: 410, out: 61, cacheRead: 50 })
    repos().messages.update(a.id, { usage: null })
    expect((await getSession(s.uid)).tokens).toEqual({ in: 310, out: 41 })
    // Other sessions are untouched.
    const other = await newSession('Other')
    expect((await getSession(other.uid)).tokens).toBeNull()
  })

  it('migration 9 backfills existing sessions and tolerates malformed usage JSON', () => {
    const db = openDb(':memory:')
    try {
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version < 9)
      )
      const r = createRepos(db)
      const s = r.sessions.create({ title: 'old', now: T0 })
      const m1 = r.messages.append({ sessionId: s.id, role: 'assistant', body: 'a', tsUtc: T0, tzOffsetMin: 0, tzName: null, device: null })
      const m2 = r.messages.append({ sessionId: s.id, role: 'assistant', body: 'b', tsUtc: T0 + 1, tzOffsetMin: 0, tzName: null, device: null })
      r.messages.update(m1.id, { usage: { in: 7, out: 3 } })
      db.prepare('UPDATE messages SET usage = ? WHERE id = ?').run('{not json', m2.id)
      migrate(db, [m009SessionTokens])
      expect(db.prepare('SELECT tokens_in AS i, tokens_out AS o FROM sessions WHERE id = ?').get(s.id)).toEqual({ i: 7, o: 3 })
      // A malformed value never fails a write.
      db.prepare('UPDATE messages SET usage = ? WHERE id = ?').run('{"in": 5, "out": 1}', m2.id)
      expect(db.prepare('SELECT tokens_in AS i, tokens_out AS o FROM sessions WHERE id = ?').get(s.id)).toEqual({ i: 12, o: 4 })
      // Idempotent.
      m009SessionTokens.up(db)
      expect(db.prepare('SELECT tokens_in AS i FROM sessions WHERE id = ?').get(s.id)).toEqual({ i: 12 })
    } finally {
      db.close()
    }
  })
})

describe('GET /api/search filters (role, from, to)', () => {
  it('filters keyword results by role and time window on the server, across pages', async () => {
    const s = await newSession('Filters')
    for (let i = 0; i < 40; i++) {
      repos().messages.append({ sessionId: s.id, role: i % 2 ? 'assistant' : 'user', body: `kumquat number ${i}`, tsUtc: T0 + i * 3600_000, tzOffsetMin: 0, tzName: 'UTC', device: 'd' })
    }
    const search = async (qs: string) => (await t.inject({ method: 'GET', url: `/api/search?q=kumquat&${qs}`, cookie })).json() as { items: SearchHit[]; next: string | null }
    const all = await search('limit=100')
    expect(all.items).toHaveLength(40)
    const users = await search('role=user&limit=100')
    expect(users.items).toHaveLength(20)
    expect(users.items.every((h) => h.message.role === 'user')).toBe(true)
    const from = T0 + 10 * 3600_000
    const to = T0 + 20 * 3600_000
    const window = await search(`from=${from}&to=${to}&limit=100`)
    expect(window.items.map((h) => h.message.tsUtc).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => from + i * 3600_000))
    // Combined with paging: pages of 3 assistant replies in the window, no overlap, nothing outside.
    const seen: number[] = []
    let cursor: string | null = null
    for (let n = 0; n < 10; n++) {
      const p = await search(`role=assistant&from=${from}&to=${to}&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...p.items.map((h) => h.message.tsUtc))
      expect(p.items.every((h) => h.message.role === 'assistant')).toBe(true)
      cursor = p.next
      if (!cursor) break
    }
    expect(seen.sort((a, b) => a - b)).toEqual([11, 13, 15, 17, 19].map((i) => T0 + i * 3600_000))
    // Relevance order honours the filters too.
    const rel = await search('order=relevance&role=user&limit=100')
    expect(rel.items).toHaveLength(20)
    // Bad values are validation errors.
    expect((await t.inject({ method: 'GET', url: '/api/search?q=kumquat&role=robot', cookie })).statusCode).toBe(400)
  })
})
