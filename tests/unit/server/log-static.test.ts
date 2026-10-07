import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createLog, redact, redactString } from '@server/log'
import { createNodePlatform } from '@server/nodePlatform'
import { startTestServer } from './helpers'

describe('log (07 B10)', () => {
  it('redacts headers, cookies and key-shaped strings', () => {
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    expect(redactString('key sk-proj-abcdefghijk123 and pa-1234567890abc')).toBe('key sk-[redacted] and pa-[redacted]')
    expect(redactString('cookie __Host-vesper_sid=tokenvalue123; other=1')).toBe('cookie __Host-vesper_sid=[redacted]; other=1')
    const r = redact({ headers: { authorization: 'x', 'xi-api-key': 'y', cookie: 'z', accept: 'json' }, nested: [{ password: 'p' }], msg: 'gsk_x gsk-abcdefghijkl' }) as Record<string, unknown>
    expect(JSON.stringify(r)).not.toMatch(/"x"|"y"|"z"|"p"|abcdefghijkl/)
    expect((r.headers as Record<string, string>).accept).toBe('json')
  })

  it('redacts the real key formats of every wired provider (F06)', () => {
    const el = 'sk_0123456789abcdef0123456789abcdef0123456789abcdef' // ElevenLabs
    const groq = 'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn' // Groq
    const dg = '0123456789abcdef0123456789abcdef01234567' // Deepgram (sent as "Token <key>")
    expect(redactString(`upstream said: invalid key ${el}`)).toBe('upstream said: invalid key sk_[redacted]')
    expect(redactString(`key=${groq}.`)).toBe('key=gsk_[redacted].')
    expect(redactString(`Authorization: Token ${dg}`)).toBe('Authorization: Token [redacted]')
    expect(redactString(`authorization: Bearer ${dg}`)).toBe('authorization: Bearer [redacted]')
    for (const s of [el, groq, `Token ${dg}`]) expect(JSON.stringify(redact({ msg: `x ${s}`, error: new Error(`bad ${s}`) }))).not.toContain(s.slice(8, 24))

    // Ordinary prose and identifiers stay readable.
    expect(redactString('Invalid token received from the provider')).toBe('Invalid token received from the provider')
    expect(redactString('task_scheduler_running and desk-abcdefghijk')).toBe('task_scheduler_running and desk-abcdefghijk')
  })

  it('writes JSON lines and rotates at the size limit, keeping 3 files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-log-'))
    const log = createLog({ dir, maxBytes: 2000, files: 3 })
    for (let i = 0; i < 100; i++) log.child('t').info(`line ${i} with sk-abcdefghijklmnop`, { i })
    log.close()
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['vesper.1.log', 'vesper.2.log', 'vesper.log'])
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(2000)
    const last = fs.readFileSync(path.join(dir, 'vesper.log'), 'utf8').trim().split('\n').pop()!
    const entry = JSON.parse(last)
    expect(entry).toMatchObject({ level: 'info', scope: 't', data: { i: 99 } })
    expect(entry.msg).toContain('sk-[redacted]')
  })
})

describe('web client serving', () => {
  it('serves hashed assets immutable, index.html no-cache, and falls back to the SPA for HTML navigations', async () => {
    const t = await startTestServer()
    try {
      const web = path.join(t.dir, 'web')
      fs.mkdirSync(path.join(web, 'assets'), { recursive: true })
      fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Vesper</title>')
      fs.writeFileSync(path.join(web, 'assets', 'index-AbC123xyZ9.js'), 'console.log(1)')
      fs.writeFileSync(path.join(web, 'manifest.webmanifest'), '{}')
      fs.writeFileSync(path.join(t.dir, 'secret.txt'), 'nope')

      const asset = await t.inject({ url: '/assets/index-AbC123xyZ9.js' })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      const root = await t.inject({ url: '/', headers: { accept: 'text/html' } })
      expect(root.body).toContain('<title>Vesper</title>')
      expect(root.headers['cache-control']).toBe('no-cache')
      expect(String(root.headers['content-security-policy'])).toContain("default-src 'self'")
      const spa = await t.inject({ url: '/s/abc?x=1', headers: { accept: 'text/html,application/xhtml+xml' } })
      expect(spa.statusCode).toBe(200)
      expect(spa.body).toContain('Vesper')
      expect((await t.inject({ url: '/manifest.webmanifest' })).headers['cache-control']).toBe('no-cache')
      expect((await t.inject({ url: '/assets/missing.js' })).statusCode).toBe(404)
      expect((await t.inject({ url: '/api/nope', headers: { accept: 'text/html' } })).json()).toMatchObject({ error: { code: 'not_found' } })
      expect((await t.inject({ url: '/..%2fsecret.txt' })).statusCode).toBe(404)
      expect((await t.inject({ url: '/%2e%2e/secret.txt' })).body).not.toContain('nope')
    } finally {
      await t.close()
    }
  })

  it('in dev forwards pages and the HMR socket to Vite (07 E3)', async () => {
    const vite = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'vite' })
      res.end(`vite:${req.url}:${req.headers.host}`)
    })
    const hmr = new WebSocketServer({ noServer: true })
    vite.on('upgrade', (req, socket, head) => hmr.handleUpgrade(req, socket, head, (ws) => ws.on('message', (d) => ws.send(`echo:${d.toString()}`))))
    await new Promise<void>((r) => vite.listen(0, '127.0.0.1', () => r()))
    const vitePort = (vite.address() as { port: number }).port
    const t = await startTestServer({ opts: { devRendererUrl: `http://127.0.0.1:${vitePort}` } })
    try {
      const r = await fetch(`${t.origin}/src/main.tsx?v=1`)
      expect(await r.text()).toBe(`vite:/src/main.tsx?v=1:127.0.0.1:${vitePort}`)
      expect(r.headers.get('x-from')).toBe('vite')
      const csp = r.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("'unsafe-inline'")
      expect(csp).toContain('ws:')
      // /api is never proxied.
      expect((await fetch(`${t.origin}/api/auth/state`)).headers.get('x-from')).toBeNull()

      const ws = new WebSocket(`ws://${t.host}/`, { headers: { origin: t.origin } })
      const reply = await new Promise<string>((resolve, reject) => {
        ws.on('open', () => ws.send('ping'))
        ws.on('message', (d) => resolve(d.toString()))
        ws.on('error', reject)
      })
      expect(reply).toBe('echo:ping')
      ws.close()
      const bad = new WebSocket(`ws://${t.host}/`, { headers: { origin: 'http://evil.example' } })
      const status = await new Promise<number>((resolve) => bad.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0)))
      expect(status).toBe(403)
    } finally {
      await t.close()
      hmr.close()
      vite.closeAllConnections()
      await new Promise((r) => vite.close(r))
    }
  })
})

describe('NodePlatform', () => {
  it('keeps plaintext secrets only in test mode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-np-'))
    const p = createNodePlatform({ appDir: dir, version: '1', dataDir: dir })
    expect(p.secrets.available()).toBe(true)
    await p.secrets.set('a', 'b')
    expect(await p.secrets.get('a')).toBe('b')
    process.env.VESPER_TEST = '0'
    try {
      const q = createNodePlatform({ appDir: dir, version: '1', dataDir: dir })
      expect(q.secrets.available()).toBe(false)
      expect(await q.secrets.list()).toEqual([])
      await expect(q.secrets.set('a', 'b')).rejects.toThrow()
    } finally {
      process.env.VESPER_TEST = '1'
    }
  })
})
