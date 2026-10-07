/**
 * Temporary chats (07 B9, 03 POST /api/sessions {temporary}): an in-memory store per chat behind the same repos, so
 * chat turns, paging and variants work — while nothing reaches vesper.db (row counts + a canary string in the DB and
 * WAL files), nothing reaches Voyage (mock recorder), the list shows it only to devices that have it open, and it
 * ends on close / no subscriber / restart with `session.ended`, dropping its temp attachments. @R3 @R9
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CSRF_HEADER } from '@shared/api'
import type { ServerMsg } from '@shared/ws'
import { contentOf } from '@server/attachments'
import { temporaryChatsOf, UPLOAD_IDLE_MS, UPLOAD_ORPHAN_GRACE_MS } from '@server/chat/temporary'
import { startMockServer, type MockServer } from '../../mocks/server'
import { png, upload } from '../content/helpers'
import { ChatHarness, chatRequests, waitMsg } from './harness'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
const CANARY = 'zebracanary7781'
let mock: MockServer
let h: ChatHarness

beforeAll(async () => {
  mock = await startMockServer()
  // Voyage requests go to the mock (the "nothing reaches Voyage" check needs a working Voyage setup).
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
  h.platform.setNow(T0)
  await h.ctx.settings.patch({ chat: { autoTitle: true }, memory: { enabled: false } })
  await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { vision: true } }))
})

/** Row counts of every table a chat could write to in vesper.db. */
function mainCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of ['sessions', 'messages', 'transcript', 'epochs', 'branches', 'branch_choices', 'messages_fts', 'attachments', 'attachment_text', 'memory_injections', 'embed_queue', 'session_links']) {
    out[t] = Number((h.ctx.db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c)
  }
  return out
}

async function as(cookie: string, method: string, url: string, payload?: unknown): Promise<{ statusCode: number; json(): unknown; body: string }> {
  const headers: Record<string, string> = { host: h.host, cookie }
  if (method !== 'GET') {
    headers.origin = h.origin
    headers[CSRF_HEADER] = '1'
  }
  return h.server.ctx.app!.inject({ method: method as 'GET', url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
}

async function otherDevice(): Promise<string> {
  const r = await h.inject('POST', '/api/test/login-as', { kind: 'browser' })
  const body = r.json() as { cookie: { name: string; value: string } }
  return `${body.cookie.name}=${body.cookie.value}`
}

async function uploadTemp(data: Buffer, name: string): Promise<string> {
  const u = upload(data, name, { type: 'image/png' })
  const r = await h.server.ctx.app!.inject({ method: 'POST', url: '/api/attachments?temporary=1', headers: { host: h.host, origin: h.origin, [CSRF_HEADER]: '1', cookie: h.cookie, ...u.headers }, payload: u.payload })
  expect(r.statusCode).toBe(200)
  return (r.json() as { sha: string }).sha
}

describe('temporary chats (07 B9) @R3', () => {
  it('chat turns run through the same engine; nothing reaches vesper.db (rows + canary in DB/WAL) @R9', async () => {
    const before = mainCounts()
    const s = await h.session({ temporary: true, title: 'Off the record' })
    expect(s).toMatchObject({ temporary: true, title: 'Off the record', links: [] })
    const p = await h.client(s.uid)
    const sha = await uploadTemp(png(8, 8), 'pic.png')
    const t1 = await h.send(p, s.uid, `my secret is ${CANARY}`, { attachments: [sha] })
    expect(t1.done.message).toMatchObject({ status: 'complete', body: `Echo: my secret is ${CANARY}` })
    // The image was read through content-server's temp store and rendered for the provider.
    const req1 = JSON.stringify(chatRequests(h.mock).at(-1)!.json)
    expect(req1).toContain(png(8, 8).toString('base64'))
    const t2 = await h.send(p, s.uid, 'and another one')
    expect(t2.done.message.body).toBe('Echo: and another one')

    // Paging, variants (regenerate) and the session itself are served from the temporary store.
    const page = (await h.inject('GET', `/api/sessions/${s.uid}/messages?mode=latest`)).json() as { items: { body: string; role: string }[]; lastSeq: number }
    expect(page.items.map((m) => m.body)).toEqual([`my secret is ${CANARY}`, `Echo: my secret is ${CANARY}`, 'and another one', 'Echo: and another one'])
    const id = 'rg1'
    p.send({ t: 'chat.regenerate', id, sessionUid: s.uid, messageUid: t2.done.message.uid, speak: false, client: { ts: T0, tzOffset: 0, tzName: null } })
    await h.awaitTurn(p, id)
    const v = (await h.inject('GET', `/api/sessions/${s.uid}/variants/4`)).json() as unknown[]
    expect(v).toHaveLength(2)
    const got = (await h.inject('GET', `/api/sessions/${s.uid}`)).json() as { temporary: boolean; messageCount: number; title: string }
    expect(got).toMatchObject({ temporary: true, messageCount: 4 })
    const patched = (await h.inject('PATCH', `/api/sessions/${s.uid}`, { title: 'Renamed' })).json() as { title: string; temporary: boolean }
    expect(patched).toMatchObject({ title: 'Renamed', temporary: true })
    // Never LLM-titled (07 B9): the only utility requests are none.
    expect(chatRequests(h.mock).filter((r) => JSON.stringify(r.json).includes('You name conversations'))).toEqual([])

    // vesper.db is untouched: same row counts, and the canary is in neither the DB file nor its WAL.
    expect(mainCounts()).toEqual(before)
    h.ctx.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    const dbFile = path.join(h.ctx.paths.roaming, 'vesper.db')
    for (const f of [dbFile, `${dbFile}-wal`]) if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(CANARY)).toBe(false)
    // The upload lives in the temp dir only, never in the roaming attachments store.
    expect(fs.existsSync(path.join(h.ctx.paths.attachments, sha.slice(0, 2), sha))).toBe(false)
    const tempFile = contentOf(h.ctx).store.filePath(sha, true)
    expect(fs.existsSync(tempFile)).toBe(true)

    // Explicit end: session.ended, the store and its files are gone.
    const end = await h.inject('DELETE', `/api/sessions/${s.uid}`)
    expect(end.statusCode).toBe(204)
    await waitMsg(p, (m) => m.t === 'session.ended' && m.sessionUid === s.uid)
    expect((await h.inject('GET', `/api/sessions/${s.uid}`)).statusCode).toBe(404)
    expect((await h.inject('GET', `/api/sessions/${s.uid}/messages`)).statusCode).toBe(404)
    expect(contentOf(h.ctx).attachment(sha)).toBeNull()
    expect(fs.existsSync(tempFile)).toBe(false)
    expect(temporaryChatsOf(h.ctx).stats()).toEqual({ chats: 0, ending: 0, timer: false, uploads: 0 })
    expect(mainCounts()).toEqual(before)
  })

  it('nothing reaches Voyage, even with memory on and a key (mock recorder) @R9', async () => {
    await h.ctx.settings.patch({ memory: { enabled: true, autoRecall: true, scopeDefault: 'all', voyage: { tier: 'tier1' } } })
    await h.ctx.secrets.set('voyage', 'pa-test-key', 'https://api.voyageai.com/v1')
    h.mock.voyage.reset()
    const s = await h.session({ temporary: true })
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'tell me about my holiday plans in the mountains')
    await h.send(p, s.uid, 'and what about the budget for the trip')
    await new Promise((r) => setTimeout(r, 300))
    expect(h.mock.voyage.counts()).toEqual({ query: 0, document: 0, rerank: 0, rejected: 0 })
    expect(h.mock.recorder.all().filter((r) => /voyage|embeddings|rerank/.test(r.path))).toEqual([])

    // Control: the same turn in a stored session does reach Voyage (the setup works).
    const n = await h.session()
    const q = await h.client(n.uid)
    await h.send(q, n.uid, 'tell me about my holiday plans in the mountains')
    await expect.poll(() => h.mock.voyage.counts().query + h.mock.voyage.counts().document, { timeout: 5000 }).toBeGreaterThan(0)
    await h.inject('DELETE', `/api/sessions/${s.uid}`)
    await h.ctx.secrets.delete('voyage')
  })

  it('is listed only for devices that have it open; another device sees it once subscribed', async () => {
    const s = await h.session({ temporary: true, title: 'Mine only' })
    const listed = async (cookie: string): Promise<string[]> => ((await as(cookie, 'GET', '/api/sessions')).json() as { items: { uid: string }[] }).items.map((x) => x.uid)
    expect(await listed(h.cookie)).toContain(s.uid)
    const other = await otherDevice()
    expect(await listed(other)).not.toContain(s.uid)
    expect(((await as(h.cookie, 'GET', '/api/sessions?filter=trash')).json() as { items: { uid: string }[] }).items.map((x) => x.uid)).not.toContain(s.uid)
    // A subscribed client makes it visible to its device (it has the chat open).
    const { WsProbe } = await import('../server/helpers')
    const probe = new WsProbe(`ws://${h.host}/ws`, { origin: h.origin, cookie: other })
    await probe.hello()
    probe.send({ t: 'subscribe', sessionUid: s.uid })
    await probe.next('subscribed', (m) => m.sessionUid === s.uid)
    expect(await listed(other)).toContain(s.uid)
    // Can't be linked or continued; links to it are refused.
    expect((await h.inject('PUT', `/api/sessions/${s.uid}/links/${s.shortId}`, {})).statusCode).toBe(400)
    expect((await h.inject('POST', '/api/sessions', { temporary: true, links: [s.shortId] })).statusCode).toBe(400)
    probe.close()
    await h.inject('DELETE', `/api/sessions/${s.uid}`)
  })

  it('ends after the no-subscriber time and at restart; session.ended reaches clients', async () => {
    const temps = temporaryChatsOf(h.ctx)
    const s = await h.session({ temporary: true })
    const watcher = await h.client()
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'hello there')
    // Subscribed: a sweep long after keeps it.
    temps.sweep(h.ctx.clock.now() + 60 * 60_000)
    expect(temps.has(s.uid)).toBe(true)
    p.send({ t: 'unsubscribe', sessionUid: s.uid })
    await new Promise((r) => setTimeout(r, 50))
    temps.sweep(h.ctx.clock.now())
    expect(temps.has(s.uid)).toBe(true)
    temps.sweep(h.ctx.clock.now() + 10 * 60_000 + 1)
    const ended = (await waitMsg(watcher, (m) => m.t === 'session.ended' && m.sessionUid === s.uid)) as Extract<ServerMsg, { t: 'session.ended' }>
    expect(ended.sessionUid).toBe(s.uid)
    expect(temps.has(s.uid)).toBe(false)

    // Restart = gone (it was never on disk).
    const s2 = await h.session({ temporary: true })
    await h.restart()
    expect((await h.inject('GET', `/api/sessions/${s2.uid}`)).statusCode).toBe(404)
    await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { vision: true } }))
  })

  it('ending while a reply streams stops the turn first; the client sees no crash @R3', async () => {
    const s = await h.session({ temporary: true })
    const p = await h.client(s.uid)
    h.mock.llm.script({ text: 'slow '.repeat(200), chunkChars: 5, delayMs: 5 })
    p.send({ t: 'chat.send', id: 'slow1', sessionUid: s.uid, text: 'go on', attachments: [], client: { ts: T0, tzOffset: 0, tzName: null }, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.delta')
    const r = await h.inject('DELETE', `/api/sessions/${s.uid}`)
    expect(r.statusCode).toBe(204)
    const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.status).toBe('stopped')
    await waitMsg(p, (m) => m.t === 'session.ended')
    expect(h.engine.stats()).toMatchObject({ active: 0, starting: 0, temporaryChats: 0 })
  })

  it('a stored session may not use a temporary upload; 10 attachments per message at most (07 B6)', async () => {
    const sha = await uploadTemp(png(4, 4), 'tmp.png')
    const n = await h.session()
    const p = await h.client(n.uid)
    p.send({ t: 'chat.send', id: 'tmpref', sessionUid: n.uid, text: 'x', attachments: [sha], client: { ts: T0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'tmpref')).toMatchObject({ error: { code: 'not_found' } })
    p.send({ t: 'chat.send', id: 'eleven', sessionUid: n.uid, text: 'x', attachments: Array.from({ length: 11 }, () => sha), client: { ts: T0, tzOffset: 0, tzName: null }, speak: false })
    expect(await waitMsg(p, (m) => m.t === 'error' && m.id === 'eleven')).toMatchObject({ error: { code: 'validation' } })
    contentOf(h.ctx).forgetTemporary([sha])
  })

  it('no leftovers after 100 temporary chats (stores, sent and unsent files, hub rings, engine counters) @R3 @R17', async () => {
    const temps = temporaryChatsOf(h.ctx)
    const content = contentOf(h.ctx)
    const baseFiles = content.store.temporaryCount
    const baseDisk = tempFiles()
    const hub = h.server.ctx.hub as unknown as { stats(): { rings: number; subscriptions: number } }
    const base = hub.stats()
    for (let i = 0; i < 100; i++) {
      const s = await h.session({ temporary: true })
      const p = await h.client(s.uid)
      const sha = await uploadTemp(png(4 + (i % 7), 4 + (i % 3)), `p${i}.png`)
      await h.send(p, s.uid, `turn ${i}`, { attachments: [sha] })
      // Every other chat also has a file that was attached but never sent.
      if (i % 2) await uploadTemp(png(20 + (i % 11), 9), `unsent${i}.png`)
      await h.inject('DELETE', `/api/sessions/${s.uid}`)
      p.close()
    }
    expect(temps.stats()).toEqual({ chats: 0, ending: 0, timer: false, uploads: 0 })
    expect(content.store.temporaryCount).toBe(baseFiles)
    expect(tempFiles()).toEqual(baseDisk)
    expect(hub.stats()).toMatchObject({ rings: base.rings })
    expect(h.engine.stats()).toMatchObject({ active: 0, starting: 0, controllers: 0, linkedListeners: 0, temporaryChats: 0 })
  })

  it('unsent temporary uploads go after a grace without a live chat, and after an idle time with one (Phase 4)', async () => {
    const temps = temporaryChatsOf(h.ctx)
    const content = contentOf(h.ctx)
    const baseFiles = content.store.temporaryCount
    // No temporary chat of this device: kept through the grace (the chat may still be being created), then dropped.
    await uploadTemp(png(33, 5), 'orphan.png')
    expect(temps.stats()).toMatchObject({ uploads: 1, timer: true })
    temps.sweep(T0 + UPLOAD_ORPHAN_GRACE_MS - 1)
    expect(content.store.temporaryCount).toBe(baseFiles + 1)
    temps.sweep(T0 + UPLOAD_ORPHAN_GRACE_MS)
    expect(content.store.temporaryCount).toBe(baseFiles)
    expect(temps.stats()).toMatchObject({ uploads: 0, timer: false })
    // With a live chat open on this device: kept until the idle time, then dropped while the chat lives on.
    const s = await h.session({ temporary: true })
    const p = await h.client(s.uid)
    await uploadTemp(png(34, 5), 'later.png')
    temps.sweep(T0 + UPLOAD_ORPHAN_GRACE_MS * 2)
    expect(content.store.temporaryCount).toBe(baseFiles + 1)
    temps.sweep(T0 + UPLOAD_IDLE_MS)
    expect(content.store.temporaryCount).toBe(baseFiles)
    expect(temps.stats()).toMatchObject({ chats: 1, uploads: 0 })
    await h.inject('DELETE', `/api/sessions/${s.uid}`)
    p.close()
    expect(temps.stats()).toEqual({ chats: 0, ending: 0, timer: false, uploads: 0 })
  })
})

/** Files under the temporary chats' attachment folder (07 B9: %TEMP%\Vesper-<pid>\attachments). */
function tempFiles(): string[] {
  const dir = path.join(h.ctx.paths.temp, 'attachments')
  try {
    return fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
      .sort()
  } catch {
    return []
  }
}
