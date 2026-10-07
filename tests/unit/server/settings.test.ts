import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSettingsStore, salvageSettings } from '@server/settings/store'
import { createSecretsService } from '@server/settings/secrets'
import { onSecret } from '@server/settings/secretHooks'
import { VesperError } from '@shared/errors'
import { leafPaths } from '@server/settings/rules'
import { createLog } from '@server/log'
import type { SecretStore } from '@server/platform'
import { startTestServer, type TestServer } from './helpers'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-settings-'))
const log = createLog({ dir: path.join(os.tmpdir(), 'vesper-settings-log') })

function memStore(o: { broken?: string[]; available?: boolean } = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    list: async () => [...data.keys(), ...(o.broken ?? [])],
    get: async (n) => {
      if (o.broken?.includes(n)) throw new Error('decrypt failed')
      return data.get(n) ?? null
    },
    set: async (n, v) => void data.set(n, v),
    delete: async (n) => void data.delete(n),
    available: () => o.available ?? true
  }
}

describe('settings store', () => {
  it('starts from defaults, writes atomically, drops unknown keys', async () => {
    const dir = tmp()
    const file = path.join(dir, 'settings.json')
    const s = await createSettingsStore(file, log)
    expect(s.get().chat.pageSize).toBe(100)
    await s.patch({ chat: { pageSize: 150 }, bogus: 1 } as never)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.chat.pageSize).toBe(150)
    expect(onDisk.bogus).toBeUndefined()
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const again = await createSettingsStore(file, log)
    expect(again.get().chat.pageSize).toBe(150)
  })

  it('rejects invalid patches with field errors and keeps the old value', async () => {
    const s = await createSettingsStore(path.join(tmp(), 'settings.json'), log)
    await expect(s.patch({ chat: { pageSize: 5 } })).rejects.toMatchObject({ info: { code: 'validation', fields: { 'chat.pageSize': expect.any(String) } } })
    expect(s.get().chat.pageSize).toBe(100)
  })

  it('salvages a damaged file leaf by leaf', async () => {
    const r = salvageSettings({ chat: { pageSize: 99999, fontSize: 18 }, voice: { stt: { silenceMs: 'x' } }, llm: { profiles: [{ id: 'a' }] } })
    expect(r.settings.chat.pageSize).toBe(100)
    expect(r.settings.chat.fontSize).toBe(18)
    expect(r.settings.voice.stt.silenceMs).toBe(1200)
    expect(r.dropped.length).toBeGreaterThan(0)
    const dir = tmp()
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{ not json')
    expect((await createSettingsStore(file, log)).get().chat.pageSize).toBe(100)
  })

  it('subscribe(path) fires only when that subtree changed', async () => {
    const s = await createSettingsStore(path.join(tmp(), 'settings.json'), log)
    const seen: string[] = []
    s.subscribe('voice.tts', () => seen.push('voice.tts'))
    s.subscribe('voice', () => seen.push('voice'))
    s.subscribe('access', () => seen.push('access'))
    await s.patch({ voice: { stt: { silenceMs: 2000 } } })
    expect(seen).toEqual(['voice'])
    seen.length = 0
    await s.patch({ voice: { tts: { speed: 1.1 } } })
    expect(seen.sort()).toEqual(['voice', 'voice.tts'])
    seen.length = 0
    await s.patch({ voice: { tts: { speed: 1.1 } } }) // no change
    expect(seen).toEqual([])
  })

  it('leafPaths flattens a patch body', () => {
    expect(leafPaths({ a: { b: 1, c: { d: true } }, e: [1], f: {} }).sort()).toEqual(['a.b', 'a.c.d', 'e', 'f'])
  })
})

describe('secrets service (07 B1)', () => {
  it('binds keys to an origin', async () => {
    const svc = createSecretsService(memStore(), log)
    await svc.set('llm:main', 'sk-abc', 'https://api.openai.com/v1')
    expect(await svc.getFor('llm:main', 'https://api.openai.com/v1/chat/completions')).toBe('sk-abc')
    await expect(svc.getFor('llm:main', 'https://evil.example/v1')).rejects.toMatchObject({ info: { code: 'key_origin_mismatch' } })
    await expect(svc.getFor('llm:main', 'http://api.openai.com/v1')).rejects.toMatchObject({ info: { code: 'key_origin_mismatch' } })
    expect(await svc.getFor('voyage', 'https://api.voyageai.com/v1')).toBeNull()
    expect(await svc.list()).toEqual(['llm:main'])
  })

  it('rebind keeps same-origin keys and clears moved ones', async () => {
    const svc = createSecretsService(memStore(), log)
    await svc.set('llm:a', 'k', 'https://api.example.com/v1')
    expect(await svc.rebind('llm:a', 'https://api.example.com/v2')).toBe('kept')
    expect(await svc.rebind('llm:a', 'https://other.example.com/v1')).toBe('cleared')
    expect(await svc.rebind('llm:a', 'https://other.example.com/v1')).toBe('absent')
    expect(await svc.list()).toEqual([])
  })

  it('lists undecryptable entries as invalid and refuses to save without encryption', async () => {
    const store = memStore({ broken: ['voyage'] })
    const svc = createSecretsService(store, log)
    await svc.set('llm:a', 'k', 'https://a.example')
    expect(await svc.list()).toEqual(['llm:a'])
    expect(await svc.invalid()).toEqual(['voyage'])
    await expect(svc.getFor('voyage', 'https://api.voyageai.com')).rejects.toMatchObject({ info: { code: 'secret_unreadable' } })
    const none = createSecretsService(memStore({ available: false }), log)
    await expect(none.set('llm:a', 'k', 'https://a.example')).rejects.toMatchObject({ info: { code: 'secret_unreadable' } })
  })
})

describe('PATCH /api/settings rules (07 B2)', () => {
  let t: TestServer
  let browser: string
  let desktop: string
  beforeAll(async () => {
    t = await startTestServer()
    browser = await t.login('browser')
    desktop = await t.login('desktop')
  })
  afterAll(() => t.close())

  const patch = (cookie: string, payload: unknown) => t.inject({ method: 'PATCH', url: '/api/settings', payload: payload as object, cookie })

  it('remote devices may change nothing until the desktop allows it, then only the allow-list', async () => {
    let r = await patch(browser, { appearance: { theme: 'light' } })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('desktop_only')
    expect((await patch(browser, { access: { remoteMayChangeSettings: true } })).statusCode).toBe(403)
    expect((await patch(desktop, { access: { remoteMayChangeSettings: true } })).statusCode).toBe(200)
    r = await patch(browser, { appearance: { theme: 'light', star: { quality: 'low' } }, voice: { stt: { silenceMs: 900 } } })
    expect(r.statusCode).toBe(200)
    expect(r.json().appearance.theme).toBe('light')
    r = await patch(browser, { appearance: { theme: 'dark' }, llm: { defaultProfile: 'x' } })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.fields).toEqual({ 'llm.defaultProfile': 'desktop only' })
    expect((await patch(browser, { voice: { stt: { model: 'other' } } })).statusCode).toBe(403)
    expect((await patch(browser, { access: { remoteMayChangeSettings: false } })).statusCode).toBe(403)
  })

  it('validates base URLs', async () => {
    const prof = (baseUrl: string) => ({ llm: { profiles: [{ id: 'main', label: 'Main', preset: 'custom', adapter: 'openai', baseUrl, model: 'm' }] } })
    let r = await patch(desktop, prof('http://192.168.1.20:8000/v1'))
    expect(r.statusCode).toBe(400)
    expect(r.json().error.fields['llm.profiles.0.baseUrl']).toMatch(/https/)
    expect((await patch(desktop, prof('https://u:p@api.example.com/v1'))).statusCode).toBe(400)
    expect((await patch(desktop, prof('http://localhost:11434/v1'))).statusCode).toBe(200)
    r = await patch(desktop, { memory: { voyage: { baseUrl: 'https://evil.example/v1' } } })
    expect(r.json().error.fields['memory.voyage.baseUrl']).toMatch(/Voyage/)
    expect((await patch(desktop, { memory: { voyage: { baseUrl: 'https://ai.mongodb.com/v1' } } })).statusCode).toBe(200)
    expect((await patch(desktop, { memory: { voyage: { baseUrl: 'https://evil.example/v1', customEndpoint: true } } })).statusCode).toBe(200)
    expect((await patch(desktop, { voice: { tts: { baseUrl: 'ftp://x' } } })).statusCode).toBe(400)
    expect((await patch(desktop, [])).statusCode).toBe(400)
  })

  it('moving a profile to another origin clears its key in the same request; removing it deletes the key', async () => {
    const prof = (id: string, baseUrl: string) => ({ id, label: id, preset: 'custom', adapter: 'openai', baseUrl, model: 'm' })
    expect((await patch(desktop, { llm: { profiles: [prof('a', 'https://a.example/v1'), prof('b', 'https://b.example/v1')] } })).statusCode).toBe(200)
    const put = (name: string, cookie = desktop) => t.inject({ method: 'PUT', url: `/api/secrets/${name}`, payload: { value: 'sk-test-secret-value-1234' }, cookie })
    expect((await put('llm:a', browser)).statusCode).toBe(403)
    expect((await put('llm:a')).statusCode).toBe(200)
    expect((await put('llm:b')).statusCode).toBe(200)
    expect((await t.inject({ method: 'PUT', url: '/api/secrets/bogus', payload: { value: 'x' }, cookie: desktop })).statusCode).toBe(400)
    const secretsSet = async () => (await t.inject({ url: '/api/bootstrap', cookie: desktop })).json().secretsSet
    expect(await secretsSet()).toEqual(['llm:a', 'llm:b'])

    // Same origin, new path: kept. Other origin: cleared.
    await patch(desktop, { llm: { profiles: [prof('a', 'https://a.example/v2'), prof('b', 'https://b2.example/v1')] } })
    expect(await secretsSet()).toEqual(['llm:a'])
    await expect(t.server.ctx.secrets.getFor('llm:a', 'https://a.example/v2/chat')).resolves.toBe('sk-test-secret-value-1234')
    // Profile removed: its key goes too.
    await patch(desktop, { llm: { profiles: [prof('b', 'https://b2.example/v1')] } })
    expect(await secretsSet()).toEqual([])
  })

  it('never returns key material', async () => {
    await t.inject({ method: 'PUT', url: '/api/secrets/voyage', payload: { value: 'pa-supersecretvoyagekey' }, cookie: desktop })
    for (const url of ['/api/settings', '/api/bootstrap']) {
      const body = (await t.inject({ url, cookie: desktop })).body
      expect(body).not.toContain('pa-supersecretvoyagekey')
    }
    expect((await t.inject({ method: 'DELETE', url: '/api/secrets/voyage', cookie: desktop })).statusCode).toBe(204)
  })

  it('runs owner hooks: validate can refuse a key before it is stored; saved/deleted run after (07 C22)', async () => {
    const calls: string[] = []
    const off = onSecret(t.server.ctx, {
      match: (n) => n === 'voyage',
      validate: async (_n, value) => {
        calls.push('validate')
        if (value === 'pa-bad') throw new VesperError('provider_auth')
      },
      saved: () => void calls.push('saved'),
      deleted: () => {
        calls.push('deleted')
        throw new Error('hook failures are logged, not fatal')
      }
    })
    try {
      const put = (value: string) => t.inject({ method: 'PUT', url: '/api/secrets/voyage', payload: { value }, cookie: desktop })
      expect((await put('pa-bad')).statusCode).toBeGreaterThanOrEqual(400)
      expect((await t.inject({ url: '/api/bootstrap', cookie: desktop })).json().secretsSet).not.toContain('voyage')
      expect((await put('pa-good-key-123')).statusCode).toBe(200)
      expect((await t.inject({ method: 'DELETE', url: '/api/secrets/voyage', cookie: desktop })).statusCode).toBe(204)
      expect(calls).toEqual(['validate', 'validate', 'saved', 'deleted'])
    } finally {
      off()
    }
  })
})
