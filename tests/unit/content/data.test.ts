/**
 * Export / import (03 §3, 07 A3/A4/B6/C9/C20): Markdown and JSON exports, the export → import round trip between two
 * servers, ChatGPT and Claude exports (synthetic fixtures in the real formats), dedupe on re-import, refusals and
 * inflated-size caps, sudo/desktop levels, job progress. @R7 @R18 @R20
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportResult } from '@shared/api'
import { JobLock } from '@server/data/jobs'
import { memoryOf } from '@server/memory/service'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'
import { buildWorkers, jpeg, multipart, removeWorkers, upload } from './helpers'

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'import')

let a: TestServer
let b: TestServer
let aDesk: string
let aBrowser: string
let bDesk: string

beforeAll(async () => {
  const workersDir = buildWorkers()
  a = await startTestServer({ opts: { workersDir } })
  b = await startTestServer({ opts: { workersDir } })
  aDesk = await a.login('desktop')
  aBrowser = await a.login('browser')
  bDesk = await b.login('desktop')
})
afterAll(async () => {
  await a.close()
  await b.close()
  removeWorkers()
})

const T0 = Date.UTC(2026, 8, 1, 10, 0)

/** A session with: a system prompt, 6 visible messages, one deleted, one hidden, an attachment and a transcript row. */
async function seed(t: TestServer, cookie: string, title: string): Promise<{ uid: string; shortId: string; sha: string }> {
  const ctx = t.server.ctx
  const att = (await t.inject({ method: 'POST', url: '/api/attachments', cookie, ...upload(jpeg(64, 48), 'photo.jpg') })).json()
  const s = (await t.inject({ method: 'POST', url: '/api/sessions', cookie, payload: { title, systemPrompt: 'Be kind.\nAnd brief.' } })).json()
  const row = ctx.repos.sessions.byUid(s.uid)!
  const add = (role: 'user' | 'assistant', body: string, i: number, extra: object = {}) =>
    ctx.repos.messages.append({ sessionId: row.id, role, body, tsUtc: T0 + i * 60_000, tzOffsetMin: 120, tzName: 'Europe/Berlin', device: 'd1', ...extra })
  add('user', 'Hello there', 1, { attachments: [att] })
  const reply = add('assistant', 'Hi! How can I help?', 2)
  ctx.repos.transcript.append({ sessionId: row.id, messageId: reply.id, part: 0, role: 'assistant', blocks: [{ t: 'text', text: '[tone=warm] Hi! How can I help?' }], provider: 'mock', model: 'm', createdUtc: T0 })
  const gone = add('user', 'DELETED-CANARY', 3)
  ctx.repos.messages.softDelete(gone.id)
  add('assistant', 'Noted.', 4)
  add('user', 'HIDDEN-CANARY', 5, { hidden: true })
  add('assistant', 'Welcome back.', 6)
  add('user', 'Tell me a joke', 7)
  add('assistant', 'Why did the scarecrow win an award? He was outstanding in his field.', 8)
  return { uid: s.uid, shortId: s.shortId, sha: att.sha }
}

const exportReq = (t: TestServer, cookie: string, q: string) => t.inject({ method: 'GET', url: `/api/export?${q}`, cookie })
const importReq = (t: TestServer, cookie: string, data: Buffer | string, name: string) => t.inject({ method: 'POST', url: '/api/import', cookie, ...upload(data, name) })

describe('export', () => {
  let s: { uid: string; shortId: string; sha: string }
  beforeAll(async () => {
    s = await seed(a, aDesk, 'Joke night')
  })

  it('Markdown of one session: visible path only, no transcript, file removed after the download @R7', async () => {
    const r = await exportReq(a, aDesk, `format=md&session=${s.uid}`)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(String(r.headers['content-disposition'])).toContain(`Joke night ${s.shortId}.md`)
    const md = r.body
    expect(md).toContain('# Joke night')
    expect(md).toContain(`#${s.shortId}`)
    expect(md).toContain('> Be kind.\n> And brief.')
    expect(md).toMatch(/### You · Tue 1 Sep 2026 12:01 \(UTC\+02:00\)\n\nHello there/)
    expect(md).toContain('### Vesper · ')
    expect(md).toContain('- Attachment: photo.jpg (image/jpeg')
    expect(md).not.toContain('DELETED-CANARY')
    expect(md).not.toContain('HIDDEN-CANARY')
    expect(md).not.toContain('[tone=')
    await new Promise((res) => setTimeout(res, 100))
    expect(fs.readdirSync(a.server.ctx.paths.exports)).toEqual([])
  })

  it('JSON of one session and the full JSON archive with attachments; trash excluded', async () => {
    const one = (await exportReq(a, aDesk, `format=json&session=${s.uid}`)).json()
    expect(one).toMatchObject({ format: 'vesper-export', version: 1, sessions: [{ uid: s.uid, title: 'Joke night', systemPrompt: 'Be kind.\nAnd brief.' }] })
    expect(one.sessions[0].messages.map((m: { body: string }) => m.body)).toEqual(['Hello there', 'Hi! How can I help?', 'Noted.', 'Welcome back.', 'Tell me a joke', expect.stringContaining('scarecrow')])
    expect(JSON.stringify(one)).not.toMatch(/CANARY|\[tone=/)

    const trash = (await a.inject({ method: 'POST', url: '/api/sessions', cookie: aDesk, payload: { title: 'In the trash' } })).json()
    await a.inject({ method: 'DELETE', url: `/api/sessions/${trash.uid}`, cookie: aDesk })
    const r = await exportReq(a, aDesk, 'format=json')
    expect(r.headers['content-type']).toBe('application/zip')
    const files = unzipSync(new Uint8Array(r.rawPayload))
    expect(Object.keys(files).sort()).toEqual([`attachments/${s.sha}`, 'vesper-export.json'])
    expect(createHash('sha256').update(files[`attachments/${s.sha}`]).digest('hex')).toBe(s.sha)
    const doc = JSON.parse(Buffer.from(files['vesper-export.json']).toString('utf8'))
    expect(doc.sessions.map((x: { title: string }) => x.title)).not.toContain('In the trash')
    expect(doc.prompts).toEqual([])

    const md = unzipSync(new Uint8Array((await exportReq(a, aDesk, 'format=md')).rawPayload))
    expect(Object.keys(md)).toContain(`Joke night ${s.shortId}.md`)
  })

  it('levels: export/import/backups need sudo; restore needs the desktop', async () => {
    expect((await exportReq(a, aBrowser, 'format=md')).json().error.code).toBe('sudo_required')
    expect((await importReq(a, aBrowser, '[]', 'x.json')).json().error.code).toBe('sudo_required')
    expect((await a.inject({ method: 'POST', url: '/api/backup', cookie: aBrowser })).json().error.code).toBe('sudo_required')
    expect((await a.inject({ method: 'GET', url: '/api/backups', cookie: aBrowser })).json().error.code).toBe('sudo_required')
    expect((await a.inject({ method: 'POST', url: '/api/backups/restore', cookie: aBrowser, payload: { file: 'x' } })).json().error.code).toBe('desktop_only')
    expect((await exportReq(a, aDesk, 'format=pdf')).statusCode).toBe(400)
    expect((await exportReq(a, aDesk, 'format=md&session=nope')).statusCode).toBe(404)
  })
})

describe('import', () => {
  it('Vesper round trip: export everything on A, import on B — new ids, same content, links, library @R7', async () => {
    const ctxA = a.server.ctx
    const x = await seed(a, aDesk, 'Round trip')
    const y = (await a.inject({ method: 'POST', url: '/api/sessions', cookie: aDesk, payload: { title: 'Linked', links: [x.shortId], private: true } })).json()
    ctxA.repos.messages.append({ sessionId: ctxA.repos.sessions.byUid(y.uid)!.id, role: 'user', body: 'private note', tsUtc: T0, tzOffsetMin: -300, tzName: 'America/New_York', device: null })
    await a.inject({ method: 'POST', url: '/api/prompts', cookie: aDesk, payload: { name: 'Coach', body: 'Push me.' } })
    ctxA.repos.facts.create('Likes tea', T0)

    const zip = (await exportReq(a, aDesk, 'format=json')).rawPayload
    const r = await importReq(b, bDesk, zip, 'vesper-export.zip')
    expect(r.statusCode).toBe(200)
    const res = r.json() as ImportResult
    expect(res).toMatchObject({ source: 'vesper', skipped: 0 })
    expect(res.sessions).toBeGreaterThanOrEqual(3)
    expect(res.attachments).toBe(1)

    const repB = b.server.ctx.repos
    const list = repB.sessions.list({ limit: 100 }).items
    const rt = list.find((s) => s.title === 'Round trip')!
    expect(rt.uid).not.toBe(x.uid)
    expect(rt.shortId).not.toBe(x.shortId)
    expect(rt.meta.imported).toMatchObject({ source: 'vesper', key: `vesper:${x.uid}` })
    const msgs = repB.messages.range(rt.id, 1, 100)
    expect(msgs.map((m) => [m.role, m.body, m.tsUtc, m.tzOffsetMin, m.tzName, m.device])).toEqual([
      ['user', 'Hello there', T0 + 60_000, 120, 'Europe/Berlin', 'import'],
      ['assistant', 'Hi! How can I help?', T0 + 120_000, 120, 'Europe/Berlin', 'import'],
      ['assistant', 'Noted.', T0 + 240_000, 120, 'Europe/Berlin', 'import'],
      ['assistant', 'Welcome back.', T0 + 360_000, 120, 'Europe/Berlin', 'import'],
      ['user', 'Tell me a joke', T0 + 420_000, 120, 'Europe/Berlin', 'import'],
      ['assistant', expect.stringContaining('scarecrow'), T0 + 480_000, 120, 'Europe/Berlin', 'import']
    ])
    expect(msgs[0].attachments).toEqual([expect.objectContaining({ sha: x.sha, name: 'photo.jpg', kind: 'image' })])
    expect((await b.inject({ url: `/api/attachments/${x.sha}`, cookie: bDesk })).statusCode).toBe(200)
    expect(rt.systemPrompt).toBe('Be kind.\nAnd brief.')
    expect(rt.createdUtc).toBe(ctxA.repos.sessions.byUid(x.uid)!.createdUtc)
    const linked = list.find((s) => s.title === 'Linked')!
    expect(linked.private).toBe(true)
    expect(repB.sessions.links(linked.id).map((s) => s.id)).toEqual([rt.id])
    expect(repB.prompts.list().map((p) => p.name)).toContain('Coach')
    expect(repB.facts.list().map((f) => f.text)).toContain('Likes tea')
    // Nothing of the import reaches the transcript or the embed queue (backfill consent decides, 07 C12).
    expect((b.server.ctx.db.prepare('SELECT count(*) AS c FROM transcript').get() as { c: number }).c).toBe(0)
    expect((b.server.ctx.db.prepare('SELECT count(*) AS c FROM embed_queue').get() as { c: number }).c).toBe(0)

    const again = (await importReq(b, bDesk, zip, 'vesper-export.zip')).json() as ImportResult
    expect(again).toMatchObject({ sessions: 0, messages: 0 })
    expect(again.skipped).toBe(res.sessions)
    // Back into the Vesper it came from: the originals are still there.
    expect(((await importReq(a, aDesk, zip, 'vesper-export.zip')).json() as ImportResult).sessions).toBe(0)
  })

  it('ChatGPT conversations.json: current branch only, tool/hidden turns dropped, original times @R7 @R10', async () => {
    const ws = new WsProbe(wsUrl(b), { host: b.host, origin: b.origin, cookie: bDesk })
    await ws.hello()
    try {
      const json = fs.readFileSync(path.join(FIXTURES, 'chatgpt-conversations.json'))
      const r = (await importReq(b, bDesk, json, 'conversations.json')).json()
      expect(r).toEqual({ sessions: 2, messages: 6, attachments: 0, skipped: 1, source: 'chatgpt' })
      const p = await ws.next('job.progress', (m) => m.job === 'import' && m.done === m.total)
      expect(p).toMatchObject({ done: 3, total: 3 })
      await ws.next('sessions.changed')
    } finally {
      ws.close()
    }
    const repB = b.server.ctx.repos
    const lisbon = repB.sessions.list({ q: 'Lisbon', limit: 5 }).items.find((s) => s.title === 'Trip to Lisbon')!
    expect(lisbon.createdUtc).toBe(1714560000123)
    const msgs = repB.messages.range(lisbon.id, 1, 100)
    expect(msgs.map((m) => [m.role, m.body])).toEqual([
      ['user', 'Plan three days in Lisbon for me.'],
      ['assistant', 'Day 1: Alfama and the castle. Day 2: Belém. Day 3: Sintra.'],
      ['user', '[image]\nHow much is a tram ticket? Here is a photo of the machine.'],
      ['assistant', 'A single tram ride costs about 3 euros on board.\n\nA Viva Viagem card is cheaper.']
    ])
    expect(msgs.map((m) => m.tsUtc)).toEqual([1714560010000, 1714560020000, 1714560200000, 1714560230000])
    expect(msgs[1]).toMatchObject({ model: 'gpt-4o', device: 'import', tag: 'ai response' })
    const all = JSON.stringify(b.server.ctx.db.prepare('SELECT body FROM messages').all())
    expect(all).not.toMatch(/IGNORE PREVIOUS|first version|I live in Berlin|search\(/)
    expect(lisbon.updatedUtc).toBe(1714560230000)
    // The same file again: everything is skipped.
    expect((await importReq(b, bDesk, fs.readFileSync(path.join(FIXTURES, 'chatgpt-conversations.json')), 'conversations.json')).json()).toMatchObject({ sessions: 0, skipped: 3 })
  })

  it('Claude export: the branch the user ended on, text blocks only, extracted files become attachments', async () => {
    const zip = Buffer.from(zipSync({ 'conversations.json': fs.readFileSync(path.join(FIXTURES, 'claude-conversations.json')), 'users.json': strToU8('[]') }))
    const r = (await importReq(b, bDesk, zip, 'data-2024-03-11.zip')).json()
    expect(r).toEqual({ sessions: 2, messages: 6, attachments: 1, skipped: 1, source: 'claude' })
    const repB = b.server.ctx.repos
    const garden = repB.sessions.list({ q: 'Garden', limit: 5 }).items.find((s) => s.title === 'Garden planning')!
    const msgs = repB.messages.range(garden.id, 1, 100)
    expect(msgs.map((m) => [m.role, m.body])).toEqual([
      ['user', 'Which vegetables can I plant in March?'],
      ['assistant', 'Peas, spinach and radishes are good choices for March.'],
      ['user', 'Can I start tomatoes indoors now?\n\n[Attached file: seedlings.jpg]'],
      ['assistant', 'Yes, start them indoors about 6 to 8 weeks before the last frost.']
    ])
    expect(msgs[0].tsUtc).toBe(Date.parse('2024-03-10T09:00:05Z'))
    expect(msgs[0].attachments).toEqual([expect.objectContaining({ name: 'beds.csv', kind: 'text', mime: 'text/csv', textChars: 29 })])
    expect(b.server.ctx.services.content!.attachmentText(msgs[0].attachments[0].sha)?.text).toContain('north,2x1')
    const haiku = repB.sessions.list({ q: 'Imported Claude chat', limit: 5 }).items[0]
    expect(repB.messages.range(haiku.id, 1, 10).map((m) => m.body)).toEqual(['Write a haiku about rain.', 'Soft rain on the roof\nthe kettle hums its answer\nevening settles in'])
    expect(JSON.stringify(b.server.ctx.db.prepare('SELECT body FROM messages').all())).not.toMatch(/IGNORE ALL|original question|temperate climate/)
  })

  it('refuses files that are not exports, and archives that inflate past the caps (07 B6)', async () => {
    const bad = await importReq(b, bDesk, 'definitely not json', 'x.json')
    expect(bad.statusCode).toBe(415)
    expect(bad.json().error.code).toBe('unsupported_type')
    expect((await importReq(b, bDesk, '[1,2,3]', 'x.json')).json().error.code).toBe('unsupported_type')
    expect((await importReq(b, bDesk, JSON.stringify({ format: 'vesper-export', version: 99, sessions: [] }), 'x.json')).json().error.code).toBe('validation')
    expect((await importReq(b, bDesk, Buffer.from(zipSync({ 'readme.txt': strToU8('hi') })), 'x.zip')).json().error.code).toBe('unsupported_type')
    expect((await b.inject({ method: 'POST', url: '/api/import', cookie: bDesk, ...multipart([{ name: 'meta', data: '{}' }]) })).json().error.code).toBe('validation')

    await b.server.ctx.settings.patch({ chat: { attachments: { maxFileMb: 1 } } })
    try {
      const big = new Uint8Array(3 * 1024 * 1024)
      const sha = createHash('sha256').update(big).digest('hex')
      const bomb = Buffer.from(zipSync({ 'vesper-export.json': strToU8(JSON.stringify({ format: 'vesper-export', version: 1, sessions: [] })), [`attachments/${sha}`]: big }, { level: 9 }))
      expect(bomb.length).toBeLessThan(64 * 1024)
      const r = await importReq(b, bDesk, bomb, 'bomb.zip')
      expect(r.statusCode).toBe(413)
      expect(r.json().error.code).toBe('payload_too_large')
    } finally {
      await b.server.ctx.settings.patch({ chat: { attachments: { maxFileMb: 25 } } })
    }
    expect(fs.readdirSync(path.join(b.server.ctx.paths.attachments, '.tmp'))).toEqual([])
  })

  it('a tampered archive cannot alias files: content must match its name', async () => {
    const fake = 'a'.repeat(64)
    const doc = { format: 'vesper-export', version: 1, sessions: [{ uid: 'tamper-1', title: 'Tampered', createdUtc: T0, messages: [{ role: 'user', body: 'see', tsUtc: T0, tzOffsetMin: 0, tzName: null, attachments: [{ sha: fake, name: 'x.png', mime: 'image/png', size: 3, kind: 'image' }] }] }] }
    const zip = Buffer.from(zipSync({ 'vesper-export.json': strToU8(JSON.stringify(doc)), [`attachments/${fake}`]: strToU8('not the right content') }))
    const r = (await importReq(b, bDesk, zip, 'x.zip')).json()
    expect(r).toMatchObject({ sessions: 1, attachments: 0 })
    const s = b.server.ctx.repos.sessions.list({ q: 'Tampered', limit: 1 }).items[0]
    expect(b.server.ctx.repos.messages.range(s.id, 1, 5)[0].attachments).toEqual([])
  })
})

/**
 * Worst main-thread stall while `fn` runs: a setImmediate chain keeps the loop from sleeping, so the gaps are real
 * blocking time (a setInterval probe would mostly measure Windows' 15.6 ms timer tick while the main thread idles).
 */
async function worstStall<T>(fn: () => Promise<T>): Promise<{ result: T; worst: number }> {
  let worst = 0
  let last = performance.now()
  let stop = false
  const tick = () => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
    if (!stop) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    return { result: await fn(), worst }
  } finally {
    stop = true
  }
}

describe('bulk jobs stay responsive (07 C9)', () => {
  it('exporting and importing 30k messages run on the db.worker thread; main-thread stalls stay short', async () => {
    const seeded = await a.inject({ method: 'POST', url: '/api/test/seed', payload: { sessions: 1, messagesPerSession: 30_000 } })
    const uid = (seeded.json() as { sessionUids: string[] }).sessionUids[0]
    const ex = await worstStall(() => exportReq(a, aDesk, `format=json&session=${uid}`))
    const r = ex.result
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).sessions[0].messages).toHaveLength(30_000)
    // The export ran on the db.worker THREAD (not the in-process fallback): the main loop only streamed the file.
    expect(memoryOf(a.server.ctx).link.inProcess).toBe(false)
    const im = await worstStall(() => importReq(b, bDesk, r.rawPayload, 'one.json'))
    expect(im.result.json() as ImportResult).toMatchObject({ sessions: 1, messages: 30_000 })
    expect(memoryOf(b.server.ctx).link.inProcess).toBe(false)
    // Measured on this PC (platform-int): export 2.4 ms worst on the worker vs 4.4–6.2 ms in-process before.
    if (process.env.VESPER_REPORT_STALL) console.log('WORST_STALL_MS', { export: ex.worst.toFixed(1), import: im.worst.toFixed(1) })
    // ~3–7 ms when the machine is quiet; a full parallel test run can stretch a single slice past 50 ms. 150 ms still
    // fails a bulk job that runs as one main-thread block (a 30k-message export takes seconds).
    expect(ex.worst).toBeLessThan(150)
    expect(im.worst).toBeLessThan(150)
  })
})

describe('job lock', () => {
  it('one bulk job at a time', async () => {
    const lock = new JobLock()
    let release!: () => void
    const first = lock.run('an import', () => new Promise<void>((r) => (release = r)))
    await expect(lock.run('an export', async () => 1)).rejects.toMatchObject({ info: { code: 'conflict' } })
    release()
    await first
    expect(await lock.run('an export', async () => 2)).toBe(2)
  })
})
