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

describe('sessions', () => {
  it('create, list, get, patch, delete, trash, restore', async () => {
    const a = (await api('POST', '/api/sessions', { title: 'Alpha', systemPrompt: 'Be brief.' })).json()
    expect(a).toMatchObject({ title: 'Alpha', systemPrompt: 'Be brief.', hasPrompt: true, lastSeq: 0, messageCount: 0, temporary: false, links: [], linkedFrom: [] })
    expect(a.shortId).toMatch(/^[0-9A-Z]{6}$/)
    const b = (await api('POST', '/api/sessions', {})).json()
    const list = (await api('GET', '/api/sessions?limit=10')).json()
    expect(list.items.map((s: { uid: string }) => s.uid)).toEqual([b.uid, a.uid])

    const p = await api('PATCH', `/api/sessions/${a.uid}`, { title: 'Renamed', pinned: true, memory: 'off', voice: { provider: 'windows', voiceId: 'v1' } })
    expect(p.json()).toMatchObject({ title: 'Renamed', pinned: true, memory: 'off', voice: { provider: 'windows', voiceId: 'v1' } })
    expect((await api('PATCH', `/api/sessions/${a.uid}`, { nope: 1 })).statusCode).toBe(400)
    expect((await api('PATCH', `/api/sessions/${a.uid}`, { llmProfile: 'missing' })).statusCode).toBe(400)
    expect((await api('GET', '/api/sessions?filter=pinned')).json().items).toHaveLength(1)

    expect((await api('DELETE', `/api/sessions/${b.uid}`)).statusCode).toBe(204)
    expect((await api('GET', '/api/sessions')).json().items).toHaveLength(1)
    expect((await api('GET', '/api/sessions?filter=trash')).json().items.map((s: { uid: string }) => s.uid)).toEqual([b.uid])
    expect((await api('PATCH', `/api/sessions/${b.uid}`, { title: 'x' })).statusCode).toBe(404)
    expect((await api('POST', `/api/sessions/${b.uid}/restore`)).json().deletedUtc).toBeNull()
    expect((await api('DELETE', `/api/sessions/${b.uid}`)).statusCode).toBe(204)
    expect((await api('POST', '/api/trash/empty')).json()).toEqual({ purged: 1 })
    expect((await api('GET', `/api/sessions/${b.uid}`)).statusCode).toBe(404)
    // Temporary chats exist since Phase 3 (07 B9; engine-int tests them in tests/unit/chat/temporary.test.ts).
    expect((await api('POST', '/api/sessions', { temporary: true })).json()).toMatchObject({ temporary: true })
    expect((await api('GET', '/api/sessions/nope')).json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('links: by short id, both ways, removal, unknown targets', async () => {
    const a = (await api('POST', '/api/sessions', { title: 'A' })).json()
    const b = (await api('POST', '/api/sessions', { title: 'B' })).json()
    let r = (await api('PUT', `/api/sessions/${a.uid}/links/${b.shortId.toLowerCase()}`, { bothWays: true })).json()
    expect(r.links.map((l: { uid: string }) => l.uid)).toEqual([b.uid])
    expect(r.linkedFrom.map((l: { uid: string }) => l.uid)).toEqual([b.uid])
    expect(r.linkCount).toBe(1)
    r = (await api('DELETE', `/api/sessions/${a.uid}/links/%23${b.shortId}`)).json()
    expect(r.links).toEqual([])
    expect(r.linkedFrom.map((l: { uid: string }) => l.uid)).toEqual([b.uid])
    expect((await api('PUT', `/api/sessions/${a.uid}/links/ZZZZZZ`, {})).statusCode).toBe(404)
    expect((await api('PUT', `/api/sessions/${a.uid}/links/${a.shortId}`, {})).statusCode).toBe(400)
    const c = (await api('POST', '/api/sessions', { links: [`#${a.shortId}`, b.shortId] })).json()
    expect(c.links.map((l: { uid: string }) => l.uid).sort()).toEqual([a.uid, b.uid].sort())
    expect((await api('POST', '/api/sessions', { links: ['nope'] })).statusCode).toBe(404)
  })

  it('/continue copies settings and links and marks both sessions (07 C18)', async () => {
    const other = (await api('POST', '/api/sessions', { title: 'Other' })).json()
    const src = (await api('POST', '/api/sessions', { title: 'Trip', systemPrompt: 'Plan trips.', links: [other.shortId], private: true })).json()
    await api('PATCH', `/api/sessions/${src.uid}`, { memory: 'on', memoryScope: 'all', model: 'gpt-x' })
    const cont = (await api('POST', '/api/sessions', { continueFrom: src.uid })).json()
    expect(cont).toMatchObject({ title: 'Trip (cont.)', systemPrompt: 'Plan trips.', private: true, memory: 'on', memoryScope: 'all', model: 'gpt-x', meta: { continuedFrom: src.uid } })
    expect(cont.links.map((l: { uid: string }) => l.uid).sort()).toEqual([other.uid, src.uid].sort())
    expect((await api('GET', `/api/sessions/${src.uid}`)).json().meta.continuedIn).toBe(cont.uid)
  })
})

describe('messages and variants', () => {
  async function seeded(n: number) {
    const s = (await api('POST', '/api/sessions', { title: 'M' })).json()
    const repos = coreOf(t.server.ctx).repos
    const row = repos.sessions.byUid(s.uid)!
    for (let i = 1; i <= n; i++) repos.messages.append({ sessionId: row.id, role: i % 2 ? 'user' : 'assistant', body: `m${i}`, tsUtc: 1_700_000_000_000 + i * 60_000, tzOffsetMin: 0, tzName: 'UTC', device: null })
    return { uid: s.uid as string, id: row.id, repos }
  }

  it('pages, timeline and tombstones', async () => {
    const { uid } = await seeded(30)
    let p = (await api('GET', `/api/sessions/${uid}/messages?mode=latest&limit=10`)).json()
    expect(p).toMatchObject({ loSeq: 21, hiSeq: 30, lastSeq: 30, hasBefore: true, hasAfter: false })
    p = (await api('GET', `/api/sessions/${uid}/messages?mode=around&seq=5&limit=4`)).json()
    expect(p.items.map((m: { seq: number }) => m.seq)).toEqual([3, 4, 5, 6])
    expect((await api('GET', `/api/sessions/${uid}/messages?mode=before`)).statusCode).toBe(400)
    const victim = p.items[2]
    expect((await api('DELETE', `/api/messages/${victim.uid}`)).statusCode).toBe(204)
    p = (await api('GET', `/api/sessions/${uid}/messages?mode=around&seq=5&limit=4`)).json()
    expect(p.items[2]).toMatchObject({ uid: victim.uid, deleted: true, body: '' })
    expect((await api('POST', `/api/messages/${victim.uid}/restore`)).statusCode).toBe(204)
    p = (await api('GET', `/api/sessions/${uid}/messages?mode=around&seq=5&limit=4`)).json()
    expect(p.items[2]).toMatchObject({ body: 'm5' })
    const tl = (await api('GET', `/api/sessions/${uid}/timeline?samples=4`)).json()
    expect(tl.map((x: { seq: number }) => x.seq)).toEqual([1, 11, 20, 30])
  })

  it('variants list/select and locate', async () => {
    const { uid, id, repos } = await seeded(4)
    repos.branches.fork(id, 4, 'regenerate', Date.now())
    repos.messages.append({ sessionId: id, role: 'assistant', body: 'm4 again', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null })
    const v = (await api('GET', `/api/sessions/${uid}/variants/4`)).json()
    expect(v.map((x: { index: number; active: boolean }) => [x.index, x.active])).toEqual([
      [1, false],
      [2, true]
    ])
    const latest = (await api('GET', `/api/sessions/${uid}/messages?mode=latest`)).json()
    expect(latest.items[3]).toMatchObject({ body: 'm4 again', variant: { index: 2, count: 2 } })
    const r = await api('POST', `/api/sessions/${uid}/variants/4`, { branchId: v[0].branchId })
    expect(r.json()).toEqual({ lastSeq: 4 })
    const back = (await api('GET', `/api/sessions/${uid}/messages?mode=latest`)).json()
    expect(back.items[3]).toMatchObject({ body: 'm4', variant: { index: 1, count: 2 } })
    expect((await api('POST', `/api/sessions/${uid}/variants/4`, { branchId: 99999 })).statusCode).toBe(404)

    const offPath = latest.items[3].uid
    const loc = (await api('GET', `/api/messages/${offPath}/locate`)).json()
    expect(loc).toMatchObject({ sessionUid: uid, seq: 4, onPath: false })
    for (const step of loc.branchPath) await api('POST', `/api/sessions/${uid}/variants/${step.forkSeq}`, { branchId: step.branchId })
    expect((await api('GET', `/api/messages/${offPath}/locate`)).json().onPath).toBe(true)
  })
})

describe('bootstrap and system', () => {
  it('bootstrap describes the device and hides paths from non-desktop devices', async () => {
    const b = (await api('GET', '/api/bootstrap')).json()
    expect(b).toMatchObject({ version: '0.0.0-test', desktop: false, device: { kind: 'browser', sudo: false }, secretsSet: [], secretsInvalid: [], isTest: true, dataPaths: null })
    expect(b.memory.state).toBe('disabled')
    expect(b.network.loopback.port).toBe(t.server.port)
    const d = (await t.inject({ url: '/api/bootstrap', cookie: await t.login('desktop') })).json()
    expect(d.dataPaths.roaming).toBe(t.server.ctx.paths.roaming)
  })

  it('reports resource use', async () => {
    const r = (await api('GET', '/api/system/resources')).json()
    expect(r.processes[0]).toMatchObject({ pid: process.pid })
    expect(r.processes[0].memMB).toBeGreaterThan(10)
  })

  it('seeds sessions for e2e', async () => {
    const r = await t.inject({ method: 'POST', url: '/api/test/seed', payload: { sessions: 2, messagesPerSession: 5, bigSession: 1000 } })
    const { sessionUids } = r.json()
    expect(sessionUids).toHaveLength(3)
    const p = (await api('GET', `/api/sessions/${sessionUids[2]}/messages?mode=latest&limit=5`)).json()
    expect(p).toMatchObject({ lastSeq: 1000, hiSeq: 1000 })
  })
})
