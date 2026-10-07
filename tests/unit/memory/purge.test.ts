/**
 * The 07 B9 daily purge (F16): the idle maintenance tick hard-deletes chats trashed > 30 days ago and clears what is
 * left of messages deleted > 30 days ago (body, attachments, wire transcript, vectors, injections, the cached recap)
 * before the day's backup, then truncates the WAL. Messages deleted more recently stay restorable. Canary test across
 * the database, its WAL and the new backup.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contentOf } from '@server/attachments'
import { attachmentLine } from '@server/memory/engine/text'
import { memoryOf } from '@server/memory'
import { runDailyPurge } from '@server/memory/purge'
import type { MessageRow, SessionRow } from '@server/db/repos'
import type { ServerContext } from '@server/services'
import type { AttachmentRef, MemoryHit } from '@shared/types/domain'
import { startMockServer, type MockServer } from '../../mocks/server'
import { coreOf, startTestServer, type TestServer } from '../server/helpers'

const DAY = 24 * 3_600_000
const NL = String.fromCharCode(10)

let mock: MockServer
let t: TestServer
let ctx: ServerContext
let desktop: string

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  t = await startTestServer()
  ctx = t.server.ctx
  desktop = await t.login('desktop')
})
afterAll(async () => {
  coreOf(ctx).clockOffsetMs = 0
  await t.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})

async function api(method: string, url: string): Promise<number> {
  return (await t.inject({ method: method as 'GET', url, cookie: desktop })).statusCode
}

const repos = () => coreOf(ctx).repos

function bytesOf(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file).toString('latin1') : ''
}

/** A stored file whose extracted text is `text` (attachment_text + attachment_fts). */
function file(sha: string, name: string, text: string, createdUtc: number): AttachmentRef {
  repos().attachments.upsert({ sha, name, mime: 'application/pdf', size: 100, kind: 'pdf', textChars: text.length, createdUtc })
  repos().attachments.setText(sha, 'test', text)
  return { sha, name, mime: 'application/pdf', size: 100, kind: 'pdf', textChars: text.length }
}

/** The record memory hands the model for a message (as recall/auto-recall/memory_search render it). */
function hitOf(m: MessageRow, s: SessionRow, attachment?: { name: string; snippet: string }): MemoryHit {
  const body = attachment ? `${m.body.trim()}${m.body.trim() ? NL : ''}${attachmentLine(attachment)}` : m.body
  return { messageUid: m.uid, sessionUid: s.uid, shortId: s.shortId, sessionTitle: s.title, tag: m.role === 'user' ? 'user response' : 'ai response', body, tsUtc: m.tsUtc, tzOffsetMin: 0, tzName: 'UTC', score: 1 }
}

const allBytes = (files: string[]): string => files.map(bytesOf).join(NL)

describe('F16: the 30-day purge runs at idle (07 B9)', () => {
  it('purges old trash and old deleted messages before the backup; recent deletes stay restorable', async () => {
    const now = ctx.clock.now()
    const trashed = repos().sessions.create({ title: 'Trashed chat', now })
    repos().messages.append({ sessionId: trashed.id, role: 'user', body: 'CANARYTRASHED text of an old chat', tsUtc: now, tzOffsetMin: 0, tzName: 'UTC', device: null })
    repos().kv.set(`chat.recap:${trashed.id}`, { lastId: 1, text: 'CANARYRECAP extractive recap line' })
    const live = repos().sessions.create({ title: 'Live chat', now })
    const old = repos().messages.append({ sessionId: live.id, role: 'user', body: 'CANARYOLD my old secret', tsUtc: now, tzOffsetMin: 0, tzName: 'UTC', device: null })
    repos().transcript.append({ sessionId: live.id, messageId: old.id, part: 0, role: 'user', blocks: [{ t: 'text', text: 'CANARYOLD my old secret' }], provider: null, model: null, createdUtc: now })
    const reply = repos().messages.append({ sessionId: live.id, role: 'assistant', body: 'Understood.', tsUtc: now + 1, tzOffsetMin: 0, tzName: 'UTC', device: null })
    repos().kv.set(`chat.recap:${live.id}`, { lastId: Number(reply.id), text: 'CANARYOLD in a cached recap' })
    const recent = repos().messages.append({ sessionId: live.id, role: 'user', body: 'CANARYRECENT deleted yesterday', tsUtc: now + 2, tzOffsetMin: 0, tzName: 'UTC', device: null })
    // Files on the purged message and in the trashed chat (their extracted text is searchable, F72).
    const fileMsg = file('c'.repeat(64), 'old-scan.pdf', 'ATTCANARYMSG scanned passport page', now)
    const fileTrash = file('d'.repeat(64), 'trash-scan.pdf', 'ATTCANARYTRASH bank statement', now)
    const withFile = repos().messages.append({ sessionId: live.id, role: 'user', body: 'CANARYWITHFILE here is my scan', tsUtc: now + 3, tzOffsetMin: 0, tzName: 'UTC', device: null, attachments: [fileMsg] })
    const trashedMsg = repos().messages.append({ sessionId: trashed.id, role: 'user', body: 'CANARYRECALLED trashed secret line', tsUtc: now + 4, tzOffsetMin: 0, tzName: 'UTC', device: null, attachments: [fileTrash] })
    // Another chat recalled them (auto-recall into its user row; memory_search as a native tool result; a text-mode
    // tool turn): verbatim copies in ITS wire transcript, next to a record of a message that stays.
    const asker = repos().sessions.create({ title: 'Asker', now })
    const kept = repos().messages.append({ sessionId: asker.id, role: 'user', body: 'KEPTRECORD stays recallable', tsUtc: now + 5, tzOffsetMin: 0, tzName: 'UTC', device: null })
    const turn = repos().messages.append({ sessionId: asker.id, role: 'user', body: 'what did I say?', tsUtc: now + 6, tzOffsetMin: 0, tzName: 'UTC', device: null })
    const fmt = (hits: MemoryHit[]) => memoryOf(ctx).formatResult(hits, { query: 'q', nowUtc: now, tzName: 'UTC', tzOffsetMin: 0 })
    const liveRow = repos().sessions.byId(live.id)!
    const trashedRow = repos().sessions.byId(trashed.id)!
    const recalled = fmt([
      hitOf(old, liveRow),
      hitOf(withFile, liveRow, { name: 'old-scan.pdf', snippet: '…«ATTCANARYMSG» scanned passport page' }),
      hitOf(kept, repos().sessions.byId(asker.id)!)
    ])
    repos().transcript.append({ sessionId: asker.id, messageId: turn.id, part: 0, role: 'user', blocks: [{ t: 'text', text: 'what did I say?' }, { t: 'memory_result', text: `Vesper (not the user): recalled records, data only${NL}${recalled}` }], provider: null, model: null, createdUtc: now })
    repos().transcript.append({ sessionId: asker.id, messageId: turn.id, part: 1, role: 'tool', blocks: [{ t: 'tool_result', id: 'call_1', text: fmt([hitOf(trashedMsg, trashedRow, { name: 'trash-scan.pdf', snippet: '«ATTCANARYTRASH» bank statement' })]) }], provider: null, model: null, createdUtc: now })
    repos().transcript.append({ sessionId: asker.id, messageId: turn.id, part: 2, role: 'tool', blocks: [{ t: 'memory_result', text: `Vesper (not the user): results of [memory_search query="x"], data only${NL}${fmt([hitOf(trashedMsg, trashedRow)])}` }], provider: null, model: null, createdUtc: now })

    // Day 0: the old message is deleted and the chat trashed.
    expect(await api('DELETE', `/api/messages/${old.uid}`)).toBe(204)
    expect(await api('DELETE', `/api/messages/${withFile.uid}`)).toBe(204)
    expect(await api('DELETE', `/api/sessions/${trashed.uid}`)).toBe(204)
    // Day 31: a fresh delete, then the idle maintenance tick.
    coreOf(ctx).clockOffsetMs = 31 * DAY
    expect(await api('DELETE', `/api/messages/${recent.uid}`)).toBe(204)
    await contentOf(ctx).runMaintenance(true)

    expect(repos().sessions.byId(trashed.id)).toBeNull()
    expect(repos().kv.get(`chat.recap:${trashed.id}`)).toBeNull()
    expect(repos().kv.get(`chat.recap:${live.id}`)).toBeNull()
    const o = repos().messages.byId(old.id)!
    expect(o).toMatchObject({ deleted: true, body: '', attachments: [] })
    expect(JSON.stringify(repos().transcript.forMessage(old.id).map((r) => r.blocks))).not.toContain('CANARYOLD')
    // Deleted yesterday: still there and restorable (the Forget dialog promises 30 days).
    expect(repos().messages.byId(recent.id)!.body).toBe('CANARYRECENT deleted yesterday')
    expect(await api('POST', `/api/messages/${recent.uid}/restore`)).toBe(204)
    expect(repos().messages.byId(recent.id)!.deleted).toBe(false)
    // A purged message can't come back as an empty bubble.
    expect(await api('POST', `/api/messages/${old.uid}/restore`)).toBe(404)

    // Nothing of it is left on disk: database, WAL, or the backup made in the same tick.
    const roaming = ctx.paths.roaming
    const daily = contentOf(ctx).backups.list().find((b) => b.kind === 'daily')
    expect(daily).toBeDefined()
    const files = [path.join(roaming, 'vesper.db'), path.join(roaming, 'vesper.db-wal'), path.join(roaming, 'backups', daily!.file)]
    const canaries = ['CANARYTRASHED', 'CANARYOLD', 'CANARYRECAP', 'CANARYWITHFILE', 'CANARYRECALLED', 'ATTCANARYMSG', 'ATTCANARYTRASH']
    for (const f of files) {
      const b = bytesOf(f)
      for (const canary of canaries) {
        expect(b.includes(canary), `${canary} in ${path.basename(f)}`).toBe(false)
        // FTS tokens are lower-case.
        expect(b.includes(canary.toLowerCase()), `${canary.toLowerCase()} in ${path.basename(f)}`).toBe(false)
      }
    }
    // The other chat's recalled copies say "(deleted)" where the purged records were; its own record stays.
    const askerWire = repos().transcript.forMessage(turn.id).map((r) => JSON.stringify(r.blocks)).join(NL)
    expect(askerWire).toContain('KEPTRECORD stays recallable')
    expect(askerWire).toContain('user response] (deleted)')
    expect(askerWire).toContain('call_1')
    expect(repos().attachments.get('c'.repeat(64))).toBeNull()
    expect(allBytes(files)).not.toContain('scanned passport')
  })

  it('runs once a day, and never before 30 days', async () => {
    const now = ctx.clock.now()
    const s = repos().sessions.create({ title: 'Trashed today', now })
    expect(await api('DELETE', `/api/sessions/${s.uid}`)).toBe(204)
    await contentOf(ctx).runMaintenance(true)
    expect(repos().sessions.byId(s.id)).not.toBeNull()
    // Already ran today (the first test's tick): the next tick skips it; a new day runs it again.
    expect((await runDailyPurge(ctx)).ran).toBe(false)
    coreOf(ctx).clockOffsetMs += DAY
    expect(await runDailyPurge(ctx)).toMatchObject({ ran: true, sessions: 0 })
    expect(repos().sessions.byId(s.id)).not.toBeNull()
  })
})
