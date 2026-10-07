/** db.worker bulk jobs (07 C9): content's export/import (one implementation, platform-int), purge, backup, checkpoint, optimize, cancellation. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../fakes/temp'
import { addSession, count, enqueueAll, harness, memDb, type Harness, type MemDb } from './helpers'

let m: MemDb
let h: Harness

beforeEach(async () => {
  m = memDb()
  h = await harness(m, { baseUrl: 'http://127.0.0.1:9/v1', key: null })
})
afterEach(async () => {
  await h.link.close()
  m.db.close()
  removeTempDir(m.dir)
})

describe('bulk jobs', () => {
  const exportSpec = (o: { format: 'json' | 'md'; sessionUid?: string }) => ({
    kind: 'export' as const,
    ...o,
    dir: path.join(m.dir, 'exports'),
    appVersion: '0.0.0-test',
    names: { user: 'Raven', assistant: 'Vesper', clock: '24h' as const },
    attachmentsRoot: path.join(m.dir, 'attachments'),
    nowUtc: Date.UTC(2026, 9, 5, 12)
  })

  it("exports with content's runExport inside the worker: no hidden, deleted or transcript data (07 A3), progress phases", async () => {
    const a = addSession(m, 'Trip', [
      ['user', 'plan the Lisbon trip'],
      ['assistant', 'Sure, here is a plan.'],
      ['user', 'a deleted message']
    ])
    m.repos.messages.softDelete(a.messages[2].id)
    m.repos.transcript.append({ sessionId: a.session.id, messageId: a.messages[1].id, part: 0, role: 'assistant', blocks: [{ t: 'text', text: '[tone=warm] Sure' }], provider: 'mock', model: 'm', createdUtc: 1 })
    addSession(m, 'Second', [['user', 'second session text']])
    const progress: Array<[number, number, string | undefined]> = []
    const one = await h.link.job(exportSpec({ format: 'json', sessionUid: a.session.uid }))
    if (one.kind !== 'export') throw new Error('kind')
    expect(one.out).toMatchObject({ sessions: 1, messages: 2, mime: 'application/json' })
    const doc = JSON.parse(fs.readFileSync(one.out.file, 'utf8'))
    expect(doc).toMatchObject({ format: 'vesper-export', version: 1 })
    // The server's clock reaches the worker (test clocks too) and runs on at real speed.
    expect(doc.exportedUtc - Date.UTC(2026, 9, 5, 12)).toBeGreaterThanOrEqual(0)
    expect(doc.exportedUtc - Date.UTC(2026, 9, 5, 12)).toBeLessThan(10_000)
    expect(doc.sessions[0].messages.map((x: { role: string; body: string }) => [x.role, x.body])).toEqual([
      ['user', 'plan the Lisbon trip'],
      ['assistant', 'Sure, here is a plan.']
    ])
    expect(fs.readFileSync(one.out.file, 'utf8')).not.toContain('[tone=')
    const md = await h.link.job(exportSpec({ format: 'md', sessionUid: a.session.uid }))
    if (md.kind !== 'export') throw new Error('kind')
    const text = fs.readFileSync(md.out.file, 'utf8')
    expect(text).toContain('# Trip')
    expect(text).toContain('### Vesper · ')
    expect(text).not.toContain('deleted message')
    const all = await h.link.job(exportSpec({ format: 'json' }), { onProgress: (d, t, phase) => progress.push([d, t, phase]) })
    if (all.kind !== 'export') throw new Error('kind')
    expect(all.out).toMatchObject({ sessions: 2, messages: 3, mime: 'application/zip' })
    expect(progress.at(-1)).toEqual([2, 2, 'export'])
    expect(fs.readdirSync(path.join(m.dir, 'exports')).some((f) => f.endsWith('.part'))).toBe(false)
  })

  it("imports with content's runImport inside the worker, in ≤ 500-row transactions (A4)", async () => {
    const T = Date.UTC(2024, 0, 1)
    const messages = Array.from({ length: 1203 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', body: `imported message ${i}`, tsUtc: T + i * 1000, tzOffsetMin: 60, tzName: 'Europe/Berlin', attachments: [] as unknown[] }))
    const file = path.join(m.dir, 'in.json')
    fs.writeFileSync(file, JSON.stringify({ format: 'vesper-export', version: 1, app: 't', exportedUtc: T, sessions: [{ uid: 'old-uid', shortId: 'ABC123', title: 'From before', createdUtc: T, messages, links: [] }], prompts: [{ name: 'Brief', body: 'Be brief.' }], facts: [] }))
    const calls: string[] = []
    const r = await h.link.job(
      { kind: 'import', file, zone: 'Europe/Berlin', maxAttachmentBytes: 1024 * 1024, tempDir: path.join(m.dir, 'tmp'), nowUtc: Date.UTC(2026, 9, 5) },
      { calls: { ingestFile: async (f) => (calls.push(f.name), null) } }
    )
    if (r.kind !== 'import') throw new Error('kind')
    expect(r.result).toMatchObject({ source: 'vesper', sessions: 1, messages: 1203, skipped: 0 })
    const s = m.repos.sessions.list({ q: 'From before', limit: 1 }).items[0]
    const row = m.repos.sessions.byUid(s.uid)!
    expect(row).toMatchObject({ lastSeq: 1203, messageCount: 1203 })
    expect(row.meta).toMatchObject({ imported: { source: 'vesper', key: 'vesper:old-uid' } })
    expect((row.meta as { imported: { utc: number } }).imported.utc - Date.UTC(2026, 9, 5)).toBeLessThan(10_000)
    const page = m.repos.messages.page(row.id, { mode: 'latest', limit: 2 })
    expect(page.items.map((x) => [x.seq, x.body, x.device])).toEqual([
      [1202, 'imported message 1201', 'import'],
      [1203, 'imported message 1202', 'import']
    ])
    // FTS triggers ran; nothing is queued for embedding without consent (07 C12); the library came along.
    expect(count(m.db, `SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH '"imported"'`)).toBe(1203)
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(0)
    expect(m.repos.prompts.list().map((p) => p.name)).toEqual(['Brief'])
    expect(calls).toEqual([])
    expect(h.link.sizes).toEqual({ pending: 0, jobs: 0 })
  })

  it('a job call into the main process: Claude export text files are ingested through it', async () => {
    const T = Date.UTC(2024, 5, 1)
    const claude = [
      {
        uuid: 'c-1',
        name: 'With a file',
        created_at: new Date(T).toISOString(),
        updated_at: new Date(T + 60_000).toISOString(),
        chat_messages: [
          { uuid: 'm1', sender: 'human', text: 'see the notes', created_at: new Date(T).toISOString(), attachments: [{ file_name: 'notes.txt', extracted_content: 'NOTE-CONTENT' }], files: [] },
          { uuid: 'm2', sender: 'assistant', text: 'Got it.', created_at: new Date(T + 1000).toISOString(), attachments: [], files: [] }
        ]
      }
    ]
    const file = path.join(m.dir, 'conversations.json')
    fs.writeFileSync(file, JSON.stringify(claude))
    const seen: Array<{ name: string; size: number; text: string }> = []
    const r = await h.link.job(
      { kind: 'import', file, zone: 'UTC', maxAttachmentBytes: 1024 * 1024, tempDir: path.join(m.dir, 'tmp'), nowUtc: T },
      {
        calls: {
          ingestFile: async (f) => {
            seen.push({ name: f.name, size: f.size, text: fs.readFileSync(f.path, 'utf8') })
            return { sha: f.sha, name: f.name, mime: 'text/plain', size: f.size, kind: 'text' }
          }
        }
      }
    )
    if (r.kind !== 'import') throw new Error('kind')
    expect(r.result).toMatchObject({ source: 'claude', sessions: 1, messages: 2 })
    expect(seen).toEqual([{ name: 'notes.txt', size: 12, text: 'NOTE-CONTENT' }])
    const s = m.repos.sessions.list({ q: 'With a file', limit: 1 }).items[0]
    expect(m.repos.messages.range(m.repos.sessions.byUid(s.uid)!.id, 1, 1)[0].attachments).toMatchObject([{ name: 'notes.txt', kind: 'text' }])
    // Leak check: no job or pending main-process call is left on either side.
    expect(h.link.sizes).toEqual({ pending: 0, jobs: 0 })
    const engine = (h.link as unknown as { inproc: { engine: { jobSizes(): { jobs: number; calls: number } } } }).inproc.engine
    expect(engine.jobSizes()).toEqual({ jobs: 0, calls: 0 })
    // A call whose handler fails becomes a job error (not a hang), and still leaves nothing behind.
    fs.writeFileSync(file, JSON.stringify([{ ...claude[0], uuid: 'c-2', name: 'Second' }]))
    await expect(
      h.link.job({ kind: 'import', file, zone: 'UTC', maxAttachmentBytes: 1024 * 1024, tempDir: path.join(m.dir, 'tmp'), nowUtc: T }, { calls: { ingestFile: async () => Promise.reject(new Error('store broke')) } })
    ).rejects.toMatchObject({ info: { code: 'internal' } })
    expect(h.link.sizes).toEqual({ pending: 0, jobs: 0 })
    expect(engine.jobSizes()).toEqual({ jobs: 0, calls: 0 })
  })

  it('purges deleted sessions and their whole tree, and clears deleted message bodies (07 B9)', async () => {
    const keep = addSession(m, 'Keep', [
      ['user', 'keep this'],
      ['user', 'canary-delete-me body']
    ])
    m.repos.messages.softDelete(keep.messages[1].id, 1000)
    const gone = addSession(m, 'Gone', [['user', 'canary-session text']])
    enqueueAll(m, gone.messages)
    m.repos.sessions.addLink(keep.session.id, gone.session.id, 1)
    m.repos.sessions.softDelete(gone.session.id, 1000)
    const r = await h.link.job({ kind: 'purge', deletedBeforeUtc: 2000, clearDeletedBodies: true })
    expect(r).toMatchObject({ kind: 'purge', sessions: 1, messages: 1 })
    expect(m.repos.sessions.byId(gone.session.id)).toBeNull()
    expect(count(m.db, 'SELECT count(*) AS c FROM session_links')).toBe(0)
    expect(count(m.db, 'SELECT count(*) AS c FROM embed_queue')).toBe(0)
    expect(count(m.db, 'SELECT count(*) AS c FROM branches WHERE session_id = ?', gone.session.id)).toBe(0)
    expect(m.repos.messages.byId(keep.messages[1].id)!.body).toBe('')
    expect(count(m.db, "SELECT count(*) AS c FROM messages WHERE body LIKE '%canary%'")).toBe(0)
  })

  it('backs up to a consistent copy and checkpoints', async () => {
    addSession(m, 'Backup', [['user', 'backed up text']])
    const file = path.join(m.dir, 'backup.db')
    const r = await h.link.job({ kind: 'backup', file })
    expect(r.kind).toBe('backup')
    const copy = new DatabaseSync(file, { readOnly: true })
    expect(Number((copy.prepare('SELECT count(*) AS c FROM messages').get() as { c: number }).c)).toBe(1)
    copy.close()
    expect((await h.link.job({ kind: 'checkpoint', mode: 'TRUNCATE' })).kind).toBe('checkpoint')
    expect((await h.link.job({ kind: 'optimize' })).kind).toBe('optimize')
  })

  it('a cancelled job stops with a conflict error and leaves nothing pending', async () => {
    const ctl = new AbortController()
    const sessions = Array.from({ length: 20 }, (_, i) => ({ uid: `u${i}`, title: `S${i}`, createdUtc: 1, links: [], messages: Array.from({ length: 600 }, (_, k) => ({ role: 'user', body: `m ${k}`, tsUtc: k + 1, tzOffsetMin: 0, tzName: null, attachments: [] })) }))
    const file = path.join(m.dir, 'many.json')
    fs.writeFileSync(file, JSON.stringify({ format: 'vesper-export', version: 1, app: 't', exportedUtc: 1, sessions, prompts: [], facts: [] }))
    const p = h.link.job({ kind: 'import', file, zone: 'UTC', maxAttachmentBytes: 1024, tempDir: path.join(m.dir, 'tmp'), nowUtc: 1 }, { signal: ctl.signal, onProgress: () => ctl.abort() })
    await expect(p).rejects.toMatchObject({ info: { code: 'conflict' } })
    expect(h.link.sizes).toEqual({ pending: 0, jobs: 0 })
    // The half-written conversation is removed; at most the finished ones stay.
    expect(count(m.db, 'SELECT count(*) AS c FROM sessions')).toBeLessThan(20)
    expect(count(m.db, 'SELECT count(*) AS c FROM sessions s WHERE (SELECT count(*) FROM messages WHERE session_id = s.id) <> 600')).toBe(0)
  })
})

describe('migration 3 (memory)', () => {
  it('stores vectors in a rowid table: 1 KiB vectors stay inline, no overflow pages', async () => {
    const sql = (m.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'vectors'").get() as { sql: string }).sql
    expect(sql).not.toMatch(/WITHOUT ROWID/i)
    const ins = m.db.prepare('INSERT INTO vectors (message_id, chunk, gen, model, dim, v) VALUES (?, 0, 1, ?, 1024, ?)')
    for (let i = 1; i <= 200; i++) ins.run(BigInt(i), 'voyage-4-lite', new Uint8Array(1024).fill(i % 127))
    const ovf = m.db.prepare("SELECT count(*) AS c FROM dbstat WHERE name = 'vectors' AND pagetype = 'overflow'").get() as { c: number }
    expect(Number(ovf.c)).toBe(0)
    expect(() => ins.run(1n, 'x', new Uint8Array(4))).toThrow(/UNIQUE/)
  })
})
