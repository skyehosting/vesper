/** GET /api/messages/:uid/recalled — the "Remembered" chip's rounds (07 A4; chat-ui's additive endpoint). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreOf, startTestServer, type TestServer } from './helpers'

let t: TestServer
let cookie: string

beforeAll(async () => {
  t = await startTestServer()
  cookie = await t.login('browser')
})
afterAll(() => t.close())

const api = (method: string, url: string, payload?: unknown) => t.inject({ method: method as 'GET', url, cookie, payload: payload as object })

describe('recalled memories of a reply @R7 @R10', () => {
  it('lists recalled messages oldest first with their session; forgotten and deleted ones drop out', async () => {
    const ctx = t.server.ctx
    const repos = coreOf(ctx).repos
    const src = (await api('POST', '/api/sessions', { title: 'Trip planning' })).json()
    const cur = (await api('POST', '/api/sessions', { title: 'Now' })).json()
    const srcRow = repos.sessions.byUid(src.uid)!
    const curRow = repos.sessions.byUid(cur.uid)!
    const add = (sessionId: typeof srcRow.id, role: 'user' | 'assistant', body: string, ts: number) =>
      repos.messages.append({ sessionId, role, body, tsUtc: ts, tzOffsetMin: -240, tzName: 'America/New_York', device: null })
    const a = add(srcRow.id, 'user', 'We should go to Lisbon', 1_700_000_100_000)
    const b = add(srcRow.id, 'assistant', 'Lisbon in spring sounds lovely', 1_700_000_000_000)
    const c = add(srcRow.id, 'user', 'and see the castle', 1_700_000_200_000)
    add(curRow.id, 'user', 'What trip?', 1_800_000_000_000)
    const reply = add(curRow.id, 'assistant', 'Lisbon!', 1_800_000_000_100)
    const ins = ctx.db.prepare('INSERT INTO memory_injections (session_id, message_id, turn_message_id) VALUES (?, ?, ?)')
    for (const m of [a, b, c, a]) ins.run(curRow.id, m.id, reply.id)

    const r = await api('GET', `/api/messages/${reply.uid}/recalled`)
    expect(r.statusCode).toBe(200)
    const hits = r.json() as Array<{ messageUid: string; sessionUid: string; shortId: string; sessionTitle: string; tag: string; tsUtc: number; tzName: string; score: number }>
    expect(hits.map((h) => h.messageUid)).toEqual([b.uid, a.uid, c.uid])
    expect(hits[0]).toMatchObject({ sessionUid: src.uid, shortId: src.shortId, sessionTitle: 'Trip planning', tag: 'ai response', tsUtc: 1_700_000_000_000, tzName: 'America/New_York' })

    // Forget = delete: it no longer shows.
    expect((await api('DELETE', `/api/memory/messages/${a.uid}`)).statusCode).toBe(204)
    expect((await api('GET', `/api/messages/${reply.uid}/recalled`)).json().map((h: { messageUid: string }) => h.messageUid)).toEqual([b.uid, c.uid])
    expect((await api('DELETE', `/api/messages/${c.uid}`)).statusCode).toBe(204)
    expect((await api('GET', `/api/messages/${reply.uid}/recalled`)).json()).toHaveLength(1)

    expect((await api('GET', '/api/messages/nope/recalled')).statusCode).toBe(404)
    expect((await t.inject({ method: 'GET', url: `/api/messages/${reply.uid}/recalled` })).statusCode).toBe(401)
  })
})
