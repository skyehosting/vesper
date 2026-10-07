/**
 * Words inside attachments are searchable (07 C8 "attachment_fts for search", F72): the search page (keyword, both
 * orders, and semantic) and memory_search find the message that carries the file, scope-clamped like message hits;
 * deleted messages and other chats outside the scope don't surface. Real server, in-process worker, no Voyage key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryOf, type MemoryServiceImpl } from '@server/memory'
import { backfillMessageAttachments } from '@server/db/migrations/010_message_attachments'
import type { SessionRow } from '@server/db/repos'
import type { ServerContext } from '@server/services'
import type { AttachmentRef } from '@shared/types/domain'
import { startMockServer, type MockServer } from '../../mocks/server'
import { coreOf, startTestServer, type TestServer } from '../server/helpers'

let mock: MockServer
let t: TestServer
let ctx: ServerContext
let mem: MemoryServiceImpl
let browser: string

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  t = await startTestServer()
  ctx = t.server.ctx
  mem = memoryOf(ctx)
  browser = await t.login('browser')
})
afterAll(async () => {
  await t.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})

const repos = () => coreOf(ctx).repos

async function search<T>(q: string): Promise<T> {
  const r = await t.inject({ method: 'GET', url: `/api/search?${q}`, cookie: browser })
  expect(r.statusCode).toBe(200)
  return r.json() as T
}

function file(sha: string, name: string, text: string): AttachmentRef {
  repos().attachments.upsert({ sha, name, mime: 'application/pdf', size: 100, kind: 'pdf', textChars: text.length, createdUtc: Date.now() })
  repos().attachments.setText(sha, 'test', text)
  return { sha, name, mime: 'application/pdf', size: 100, kind: 'pdf', textChars: text.length }
}

describe('F72: text inside attachments is searchable', () => {
  let contract: SessionRow
  let asker: SessionRow
  let msgUid = ''
  beforeAll(() => {
    const ref = file('a'.repeat(64), 'tenancy-contract.pdf', 'Clause 9. The notice period is ninety days, given in writing to the landlord.')
    contract = repos().sessions.create({ title: 'Flat contract', now: Date.now() })
    const m = repos().messages.append({ sessionId: contract.id, role: 'user', body: 'Here is the contract, can you check it?', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null, attachments: [ref] })
    msgUid = m.uid
    repos().messages.append({ sessionId: contract.id, role: 'assistant', body: 'I read it; it looks standard.', tsUtc: Date.now() + 1, tzOffsetMin: 0, tzName: 'UTC', device: null })
    asker = repos().sessions.create({ title: 'Moving out', now: Date.now() })
    repos().sessions.update(asker.id, { memoryScope: 'all' })
    repos().messages.append({ sessionId: asker.id, role: 'user', body: 'When must I tell the landlord?', tsUtc: Date.now() + 2, tzOffsetMin: 0, tzName: 'UTC', device: null })
  })

  it('the search page finds the message that carries the file, newest first and by relevance', async () => {
    for (const order of ['recent', 'relevance']) {
      const r = await search<{ items: { message: { uid: string }; snippet: string }[] }>(`q=ninety&order=${order}`)
      expect(r.items.map((i) => i.message.uid)).toEqual([msgUid])
      expect(r.items[0].snippet).toContain('tenancy-contract.pdf')
      expect(r.items[0].snippet).toContain('«ninety»')
    }
    const sem = await search<{ items: { message: { uid: string }; snippet: string }[] }>('q=notice%20period&mode=semantic')
    expect(sem.items.map((i) => i.message.uid)).toContain(msgUid)
  })

  it('memory_search finds it for the AI, with the words from the file', async () => {
    const r = await mem.search({ query: 'notice period landlord' }, { sessionUid: asker.uid }, 1200)
    const hit = r.hits.find((h) => h.messageUid === msgUid)
    expect(hit).toBeDefined()
    expect(hit!.body).toContain('notice period is ninety days')
    expect(hit!.body).toContain('tenancy-contract.pdf')
  })

  it('stays inside the scope, and a deleted message no longer surfaces', async () => {
    repos().sessions.update(asker.id, { memoryScope: 'this' })
    expect((await mem.search({ query: 'notice period landlord' }, { sessionUid: asker.uid }, 1200)).hits.some((h) => h.messageUid === msgUid)).toBe(false)
    repos().sessions.update(asker.id, { memoryScope: 'all' })
    repos().messages.softDelete(repos().messages.byUid(msgUid)!.id)
    expect((await search<{ items: unknown[] }>('q=ninety')).items).toEqual([])
    expect((await mem.search({ query: 'notice period landlord' }, { sessionUid: asker.uid }, 1200)).hits.some((h) => h.messageUid === msgUid)).toBe(false)
  })

  it('the migration indexes messages written before it (backfill) and follows later edits', () => {
    const m = repos().messages.byUid(msgUid)!
    ctx.db.prepare('DELETE FROM message_attachments').run()
    backfillMessageAttachments(ctx.db)
    expect(ctx.db.prepare('SELECT sha FROM message_attachments WHERE message_id = ?').all(m.id)).toEqual([{ sha: 'a'.repeat(64) }])
    repos().messages.update(m.id, { attachments: [] })
    expect(ctx.db.prepare('SELECT sha FROM message_attachments WHERE message_id = ?').all(m.id)).toEqual([])
  })
})
