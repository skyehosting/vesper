/**
 * Attachments over REST (03 §3, 07 B5/B6/B9/C8): the upload/serve matrix — sniffed type wins over the declared one,
 * html/svg never inline, nosniff + sandbox CSP everywhere, caps → payload_too_large, unsupported_type — plus dedupe,
 * thumbnails, extraction into attachment_text/FTS, crash isolation, temporary chats and GC. @R18
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contentOf } from '@server/attachments'
import { startTestServer, type TestServer } from '../server/helpers'
import { buildWorkers, docx, jpeg, multipart, pdf, png, removeWorkers, upload, webp } from './helpers'

let t: TestServer
let cookie: string

beforeAll(async () => {
  t = await startTestServer({ opts: { workersDir: buildWorkers() } })
  cookie = await t.login('browser')
})
afterAll(async () => {
  await t.close()
  removeWorkers()
})

type Up = ReturnType<typeof upload>
const post = (u: Up, query = '', c: string | undefined = cookie) => t.inject({ method: 'POST', url: `/api/attachments${query}`, cookie: c, payload: u.payload, headers: u.headers })
const get = (url: string) => t.inject({ method: 'GET', url, cookie })

function expectSafeHeaders(h: Record<string, unknown>): void {
  expect(h['x-content-type-options']).toBe('nosniff')
  expect(h['content-security-policy']).toBe("default-src 'none'; sandbox")
  expect(h['cross-origin-resource-policy']).toBe('same-origin')
  expect(h['cache-control']).toBe('private, no-store')
}

const tmpLeft = () => fs.readdirSync(path.join(t.server.ctx.paths.attachments, '.tmp')).length

describe('upload and serve matrix (07 B5)', () => {
  it('a PNG declared as text/html named evil.html is stored and served as image/png, inline', async () => {
    const r = await post(upload(png(800, 600), 'evil.html', { type: 'text/html' }))
    expect(r.statusCode).toBe(200)
    const ref = r.json()
    expect(ref).toMatchObject({ name: 'evil.html', mime: 'image/png', kind: 'image', width: 800, height: 600 })
    expect(ref.sha).toMatch(/^[0-9a-f]{64}$/)
    const g = await get(`/api/attachments/${ref.sha}`)
    expect(g.statusCode).toBe(200)
    expect(g.headers['content-type']).toBe('image/png')
    expect(String(g.headers['content-disposition'])).toMatch(/^inline; filename="evil.html"; filename\*=UTF-8''evil.html$/)
    expectSafeHeaders(g.headers)
    expect(g.rawPayload.equals(png(800, 600))).toBe(true)
    const d = await get(`/api/attachments/${ref.sha}?download=1`)
    expect(d.headers['content-type']).toBe('application/octet-stream')
    expect(String(d.headers['content-disposition'])).toMatch(/^attachment;/)
  })

  it.each([
    ['jpeg', jpeg(1568, 1045), 'image/jpeg'],
    ['webp', webp(300, 200), 'image/webp']
  ])('%s is inline with its sniffed type', async (_n, bytes, mime) => {
    const ref = (await post(upload(bytes, `photo.bin`))).json()
    expect(ref.mime).toBe(mime)
    const g = await get(`/api/attachments/${ref.sha}`)
    expect(g.headers['content-type']).toBe(mime)
    expect(String(g.headers['content-disposition'])).toMatch(/^inline;/)
  })

  it('SVG with a script and HTML are never inline (even when declared as images)', async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
    for (const [data, name, declared, mime] of [
      [svg, 'pic.svg', 'image/svg+xml', 'image/svg+xml'],
      ['<!doctype html><html><script>fetch("/api/secrets")</script></html>', 'page.png', 'image/png', 'text/html']
    ] as const) {
      const ref = (await post(upload(data, name, { type: declared }))).json()
      expect(ref).toMatchObject({ kind: 'text', mime })
      const g = await get(`/api/attachments/${ref.sha}`)
      expect(g.statusCode).toBe(200)
      expect(g.headers['content-type']).toBe('application/octet-stream')
      expect(String(g.headers['content-disposition'])).toMatch(/^attachment;/)
      expectSafeHeaders(g.headers)
      // ?thumb=1 must not become a way to get it inline.
      expect((await get(`/api/attachments/${ref.sha}?thumb=1`)).statusCode).toBe(404)
    }
  })

  it('PDF and DOCX: downloads, text extracted once into attachment_text + FTS (07 C8)', async () => {
    const p = (await post(upload(pdf(['The quarterly zebra report']), 'report.pdf', { type: 'application/pdf' }))).json()
    expect(p).toMatchObject({ kind: 'pdf', mime: 'application/pdf', textState: 'ok' })
    expect(p.textChars).toBeGreaterThan(10)
    const g = await get(`/api/attachments/${p.sha}`)
    expect(g.headers['content-type']).toBe('application/octet-stream')
    const text = (await get(`/api/attachments/${p.sha}/text`)).json()
    expect(text).toMatchObject({ truncated: false })
    expect(text.text).toContain('quarterly zebra report')

    const d = (await post(upload(docx(['Minutes of the walrus meeting']), 'minutes.docx'))).json()
    expect(d).toMatchObject({ kind: 'docx', textState: 'ok' })
    const db = t.server.ctx.db
    const hits = db.prepare("SELECT t.sha FROM attachment_fts f JOIN attachment_text t ON t.id = f.rowid WHERE attachment_fts MATCH 'walrus OR zebra'").all() as { sha: string }[]
    expect(hits.map((h) => h.sha).sort()).toEqual([p.sha, d.sha].sort())
    expect((db.prepare('SELECT extractor FROM attachment_text WHERE sha = ?').get(d.sha) as { extractor: string }).extractor).toBe('mammoth')
  })

  it('text files with odd encodings, file names with paths and control characters', async () => {
    const r = (await post(upload(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), '..\\..\\Windows\\notes\u0007.txt'))).json()
    expect(r).toMatchObject({ kind: 'text', mime: 'text/plain', name: 'notes.txt', textChars: 5 })
    expect((await get(`/api/attachments/${r.sha}/text`)).json().text).toBe('café\n')
    const md = (await post(upload('# Title', 'readme.md', { meta: { name: 'Pasted text.md' } }))).json()
    expect(md).toMatchObject({ mime: 'text/markdown', name: 'Pasted text.md' })
    const g = await get(`/api/attachments/${md.sha}`)
    expect(String(g.headers['content-disposition'])).toBe(`attachment; filename="Pasted text.md"; filename*=UTF-8''Pasted%20text.md`)
  })

  it('refuses unsupported types, empty files, oversized images and malformed requests', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0), Buffer.from([7, 8, 9])])
    const r1 = await post(upload(exe, 'setup.exe'))
    expect(r1.statusCode).toBe(415)
    expect(r1.json().error.code).toBe('unsupported_type')
    const r2 = await post(upload(png(10_000, 10_000), 'big.png'))
    expect(r2.statusCode).toBe(413)
    expect(r2.json().error.code).toBe('payload_too_large')
    expect((await post(upload('', 'empty.txt'))).json().error.code).toBe('validation')
    expect((await t.inject({ method: 'POST', url: '/api/attachments', cookie, payload: { not: 'multipart' } })).json().error.code).toBe('validation')
    const twoFiles = multipart([
      { name: 'file', filename: 'a.txt', data: 'a' },
      { name: 'file', filename: 'b.txt', data: 'b' }
    ])
    expect((await post(twoFiles)).json().error.code).toBe('validation')
    const cut = upload('truncated upload body', 'cut.txt')
    const truncated = await post({ payload: cut.payload.subarray(0, cut.payload.length - 30), headers: cut.headers })
    expect(truncated.statusCode).toBe(400)
    expect(truncated.json().error.code).toBe('validation')
    expect((await post(upload(png(10, 10), 'x.png'), '', '')).statusCode).toBe(401)
    expect((await get('/api/attachments/nothex')).statusCode).toBe(400)
    expect((await get(`/api/attachments/${'0'.repeat(64)}`)).statusCode).toBe(404)
    expect(tmpLeft()).toBe(0)
  })

  it('the per-file cap comes from Settings (1–100 MB) and nothing is left in the temp dir', async () => {
    await t.server.ctx.settings.patch({ chat: { attachments: { maxFileMb: 1 } } })
    try {
      const r = await post(upload(Buffer.alloc(1024 * 1024 + 10, 0x61), 'big.txt'))
      expect(r.statusCode).toBe(413)
      expect(r.json().error).toMatchObject({ code: 'payload_too_large', message: 'That file is too large.' })
      expect(tmpLeft()).toBe(0)
      expect((await post(upload(Buffer.alloc(1024 * 1024 - 10, 0x62), 'fits.txt'))).statusCode).toBe(200)
    } finally {
      await t.server.ctx.settings.patch({ chat: { attachments: { maxFileMb: 25 } } })
    }
  })
})

describe('store behaviour', () => {
  it('content-addressed dedupe: same bytes, one file and one row; each upload keeps its own name', async () => {
    const bytes = jpeg(640, 480)
    const a = (await post(upload(bytes, 'first.jpg'))).json()
    const b = (await post(upload(bytes, 'second.jpg'))).json()
    expect(b.sha).toBe(a.sha)
    expect([a.name, b.name]).toEqual(['first.jpg', 'second.jpg'])
    const dir = path.join(t.server.ctx.paths.attachments, a.sha.slice(0, 2))
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(a.sha))).toEqual([a.sha])
    expect((t.server.ctx.db.prepare('SELECT count(*) AS c FROM attachments WHERE sha = ?').get(a.sha) as { c: number }).c).toBe(1)
  })

  it('client-made thumbnails: validated, served inline; images without one fall back to the original', async () => {
    const thumb = jpeg(320, 240)
    const ref = (await post(upload(png(1568, 1176), 'shot.png', { thumb, meta: { width: 1568, height: 1176 } }))).json()
    const g = await get(`/api/attachments/${ref.sha}?thumb=1`)
    expect(g.headers['content-type']).toBe('image/jpeg')
    expect(g.rawPayload.equals(thumb)).toBe(true)
    expectSafeHeaders(g.headers)
    const bad = await post(upload(png(1600, 1200, 99), 'big-thumb.png', { thumb: jpeg(2000, 1500) }))
    expect(bad.json().error.code).toBe('validation')
    const plain = (await post(upload(png(50, 50, 3), 'nothumb.png'))).json()
    expect((await get(`/api/attachments/${plain.sha}?thumb=1`)).headers['content-type']).toBe('image/png')
    expect(tmpLeft()).toBe(0)
  })

  it('an extract-process crash marks the attachment failed — the server keeps going (07 B6)', async () => {
    const r = await post(upload('__vesper_test_crash__ boom', 'crash.txt'))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ kind: 'text', textState: 'failed' })
    expect(r.json().textChars).toBeUndefined()
    expect((await get(`/api/attachments/${r.json().sha}/text`)).statusCode).toBe(404)
    expect((await get(`/api/attachments/${r.json().sha}`)).statusCode).toBe(200)
    expect((await t.inject({ url: '/api/sessions', cookie })).statusCode).toBe(200)
    const next = (await post(upload('healthy text', 'ok.txt'))).json()
    expect(next).toMatchObject({ textState: 'ok', textChars: 12 })
    expect((t.server.ctx.db.prepare('SELECT text_error FROM attachments WHERE sha = ?').get(r.json().sha) as { text_error: string }).text_error).toBe('crashed')
  })

  it('a DOCX bomb is stored but its text is refused from the central directory (07 B6)', async () => {
    const r = (await post(upload(docx(['tiny'], { pad: 8 * 1024 * 1024 }), 'bomb.docx'))).json()
    expect(r).toMatchObject({ kind: 'docx', textState: 'failed' })
    expect((t.server.ctx.db.prepare('SELECT text_error FROM attachments WHERE sha = ?').get(r.sha) as { text_error: string }).text_error).toBe('archive_refused')
  })

  it('leak check: 30 uploads leave no temp files, one extract process, no temporary entries @R17', async () => {
    const c = contentOf(t.server.ctx)
    const spawnedBefore = c.extractor.counters.spawned
    for (let i = 0; i < 30; i++) {
      const r = await post(upload(`leak check ${i % 10}`, `leak-${i}.txt`))
      expect(r.statusCode).toBe(200)
    }
    expect(tmpLeft()).toBe(0)
    expect(c.store.temporaryCount).toBe(0)
    expect(c.extractor.pending).toBe(0)
    expect(c.extractor.counters.spawned - spawnedBefore).toBeLessThanOrEqual(1)
  })

  it('ContentService gives the chat engine metadata, bytes and text', async () => {
    const ref = (await post(upload('For the engine', 'engine.txt'))).json()
    const svc = t.server.ctx.services.content!
    expect(svc.attachment(ref.sha)).toMatchObject({ sha: ref.sha, kind: 'text', textState: 'ok' })
    expect((await svc.readAttachment(ref.sha)).toString()).toBe('For the engine')
    expect(svc.attachmentText(ref.sha)).toEqual({ text: 'For the engine', chars: 14, truncated: false })
    expect(svc.attachment('f'.repeat(64))).toBeNull()
    await expect(svc.readAttachment('f'.repeat(64))).rejects.toMatchObject({ info: { code: 'not_found' } })
  })

  it('temporary chats: bytes in the temp dir, nothing in SQLite, forgotten on request (07 B9)', async () => {
    const canary = `temporary canary ${Date.now()}`
    const ref = (await post(upload(canary, 'secret.txt'), '?temporary=1')).json()
    expect(ref).toMatchObject({ kind: 'text', textState: 'ok' })
    const db = t.server.ctx.db
    expect(db.prepare('SELECT 1 FROM attachments WHERE sha = ?').get(ref.sha)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM attachment_text WHERE sha = ?').get(ref.sha)).toBeUndefined()
    expect(fs.existsSync(path.join(t.server.ctx.paths.temp, 'attachments', ref.sha))).toBe(true)
    expect(fs.existsSync(path.join(t.server.ctx.paths.attachments, ref.sha.slice(0, 2), ref.sha))).toBe(false)
    expect((await get(`/api/attachments/${ref.sha}/text`)).json().text).toBe(canary)
    t.server.ctx.services.content!.forgetTemporary([ref.sha])
    expect((await get(`/api/attachments/${ref.sha}`)).statusCode).toBe(404)
    expect(fs.existsSync(path.join(t.server.ctx.paths.temp, 'attachments', ref.sha))).toBe(false)
  })

  it('garbage collection keeps referenced attachments and removes the rest after the grace period', async () => {
    const keep = (await post(upload('kept by a message', 'keep.txt'))).json()
    const drop = (await post(upload('nobody refers to me', 'drop.txt'))).json()
    const ctx = t.server.ctx
    const s = ctx.repos.sessions.create({ title: 'gc', now: Date.now() })
    ctx.repos.messages.append({ sessionId: s.id, role: 'user', body: 'see file', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null, attachments: [keep] })
    const store = contentOf(ctx).store
    expect((await store.collectGarbage(Date.now() - 60_000)).removed).toBe(0)
    await store.collectGarbage(Date.now() + 1000)
    expect(store.get(keep.sha)).not.toBeNull()
    expect(store.get(drop.sha)).toBeNull()
    expect(fs.existsSync(path.join(ctx.paths.attachments, drop.sha.slice(0, 2), drop.sha))).toBe(false)
    expect(ctx.db.prepare('SELECT 1 FROM attachment_text WHERE sha = ?').get(drop.sha)).toBeUndefined()
  })
})
