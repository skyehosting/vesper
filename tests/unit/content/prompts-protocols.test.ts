/** Prompt library CRUD (R11) and the protocols file with validation warnings (R9, 07 C1/B2). */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PROTOCOLS_TEXT, protocolsHash, validateProtocols } from '@server/protocols/protocols'
import { startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'

let t: TestServer
let browser: string
let desktop: string

beforeAll(async () => {
  t = await startTestServer()
  browser = await t.login('browser')
  desktop = await t.login('desktop')
})
afterAll(() => t.close())

const api = (method: string, url: string, payload?: unknown, cookie = browser) => t.inject({ method: method as 'GET', url, cookie, payload: payload as object })

describe('prompts @R11', () => {
  it('create, list (by name), patch, delete; every change announces prompts.changed', async () => {
    const ws = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie: desktop })
    await ws.hello()
    try {
      const a = (await api('POST', '/api/prompts', { name: '  Tutor ', body: 'Explain step by step.' })).json()
      expect(a).toMatchObject({ name: 'Tutor', body: 'Explain step by step.' })
      await ws.next('prompts.changed')
      const b = (await api('POST', '/api/prompts', { name: 'Editor', body: 'Fix my prose.' })).json()
      expect((await api('GET', '/api/prompts')).json().map((p: { name: string }) => p.name)).toEqual(['Editor', 'Tutor'])
      const p = (await api('PATCH', `/api/prompts/${a.id}`, { body: 'Explain like I am five.' })).json()
      expect(p).toMatchObject({ id: a.id, name: 'Tutor', body: 'Explain like I am five.' })
      expect(p.updatedUtc).toBeGreaterThanOrEqual(a.updatedUtc)
      expect((await api('DELETE', `/api/prompts/${b.id}`)).statusCode).toBe(204)
      expect((await api('GET', '/api/prompts')).json()).toHaveLength(1)
      for (let i = 0; i < 3; i++) await ws.next('prompts.changed')
    } finally {
      ws.close()
    }
  })

  it('validation, conflicts and 404s', async () => {
    expect((await api('POST', '/api/prompts', { name: 'Dup', body: 'x' })).statusCode).toBe(200)
    const dup = await api('POST', '/api/prompts', { name: 'Dup', body: 'y' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('conflict')
    expect((await api('POST', '/api/prompts', { name: '   ', body: 'x' })).json().error.fields.name).toBeDefined()
    expect((await api('POST', '/api/prompts', { name: 'x'.repeat(81), body: 'x' })).statusCode).toBe(400)
    expect((await api('POST', '/api/prompts', { name: 'Big', body: 'x'.repeat(100_001) })).statusCode).toBe(400)
    expect((await api('POST', '/api/prompts', { name: 'Extra', body: 'x', admin: true })).statusCode).toBe(400)
    expect((await api('PATCH', '/api/prompts/99999', { body: 'x' })).statusCode).toBe(404)
    expect((await api('DELETE', '/api/prompts/99999')).statusCode).toBe(404)
    expect((await api('DELETE', '/api/prompts/abc')).statusCode).toBe(400)
  })

  it('deleting a prompt keeps the sessions’ own copy of the text and clears the link', async () => {
    const p = (await api('POST', '/api/prompts', { name: 'Pirate', body: 'Talk like a pirate.' })).json()
    const s = (await api('POST', '/api/sessions', { promptId: p.id })).json()
    expect(s).toMatchObject({ promptId: p.id, systemPrompt: 'Talk like a pirate.' })
    await api('DELETE', `/api/prompts/${p.id}`)
    expect((await api('GET', `/api/sessions/${s.uid}`)).json()).toMatchObject({ promptId: null, systemPrompt: 'Talk like a pirate.' })
  })
})

describe('protocols @R9', () => {
  it('the shipped default has no warnings', () => {
    expect(validateProtocols(DEFAULT_PROTOCOLS_TEXT)).toEqual([])
  })

  it('warns about broken placeholders, blocks and missing function docs', () => {
    const w = validateProtocols('Hello {{assistant_nme}} and {user_name}. {{#voice_mode}}x{{/voice_mode}} {{#text_mode}} unclosed {{ dangling')
    expect(w.join('\n')).toMatch(/Unknown placeholder \{\{assistant_nme\}\}/)
    expect(w.join('\n')).toMatch(/\{user_name\} needs double braces/)
    expect(w.join('\n')).toMatch(/Unknown block \{\{#voice_mode\}\}/)
    expect(w.join('\n')).toMatch(/\{\{#text_mode\}\} is never closed/)
    expect(w.join('\n')).toMatch(/has no partner/)
    expect(w.join('\n')).toMatch(/\[memory_search\] and \[memory_recall\] are not documented/)
    expect(w.join('\n')).toMatch(/\{\{tone_instruction\}\} is missing/)
    expect(validateProtocols('{{#native_mode}}{{#text_mode}}{{/text_mode}}{{/native_mode}}').join('\n')).toMatch(/can't be nested/)
    expect(validateProtocols('{{/text_mode}}').join('\n')).toMatch(/closes a block that isn't open/)
    // Docs placed in the wrong mode block don't count.
    expect(validateProtocols('{{#native_mode}}{{text_function_docs}}{{/native_mode}}{{tone_instruction}}').join('\n')).toMatch(/not documented for text mode/)
    // Hand-written docs are fine.
    expect(validateProtocols('Use [memory_search query="…"] and [memory_recall session="#ID"]. {{tone_instruction}}')).toEqual([])
  })

  it('GET (any device), PUT/reset (desktop only), file in the roaming dir, hash = sha256 @R4', async () => {
    const g = (await api('GET', '/api/protocols')).json()
    expect(g).toMatchObject({ isDefault: true, warnings: [], hash: protocolsHash(DEFAULT_PROTOCOLS_TEXT) })
    expect(g.text).toBe(DEFAULT_PROTOCOLS_TEXT)

    expect((await api('PUT', '/api/protocols', { text: 'mine' })).json().error.code).toBe('desktop_only')
    expect((await api('POST', '/api/protocols/reset')).json().error.code).toBe('desktop_only')

    const custom = `${DEFAULT_PROTOCOLS_TEXT}\n\nAlways greet {{user_name}} warmly. {{favourite_colour}}\r\n`
    const put = (await api('PUT', '/api/protocols', { text: custom }, desktop)).json()
    expect(put.warnings).toEqual(['Unknown placeholder {{favourite_colour}}: it will be sent to the AI exactly as written.'])
    const file = path.join(t.server.ctx.paths.roaming, 'protocols.md')
    expect(fs.readFileSync(file, 'utf8')).toBe(custom.replace(/\r\n/g, '\n'))
    expect(put.hash).toBe(protocolsHash(custom.replace(/\r\n/g, '\n')))
    const after = (await api('GET', '/api/protocols')).json()
    expect(after).toMatchObject({ isDefault: false, hash: put.hash, warnings: put.warnings })
    expect(t.server.ctx.services.content!.protocols()).toMatchObject({ hash: put.hash, isDefault: false })

    expect((await api('PUT', '/api/protocols', { text: '   \n ' }, desktop)).statusCode).toBe(400)
    expect((await api('PUT', '/api/protocols', { text: 'x'.repeat(200_001) }, desktop)).statusCode).toBe(400)

    const reset = (await api('POST', '/api/protocols/reset', undefined, desktop)).json()
    expect(reset.hash).toBe(g.hash)
    expect(fs.existsSync(file)).toBe(false)
    expect((await api('GET', '/api/protocols')).json().isDefault).toBe(true)
  })

  it('a running reader keeps the text it got: PUT replaces the file atomically and returns a new state', async () => {
    const svc = t.server.ctx.services.content!
    const before = svc.protocols()
    await api('PUT', '/api/protocols', { text: 'Edited {{tone_instruction}} [memory_search] [memory_recall]' }, desktop)
    expect(before.text).toBe(DEFAULT_PROTOCOLS_TEXT)
    expect(svc.protocols().text).toBe('Edited {{tone_instruction}} [memory_search] [memory_recall]')
    // An edit made outside Vesper (Notepad) is picked up too.
    fs.writeFileSync(path.join(t.server.ctx.paths.roaming, 'protocols.md'), 'Edited in Notepad, longer text')
    expect(svc.protocols().text).toBe('Edited in Notepad, longer text')
    await api('POST', '/api/protocols/reset', undefined, desktop)
  })
})
