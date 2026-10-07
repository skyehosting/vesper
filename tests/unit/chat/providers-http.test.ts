/** LLM provider endpoints (03 §3, 07 B1/B2/D11/C19): presets, model lists, Test connection (desktop only). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PRESETS } from '@shared/presets'
import { ChatHarness } from './harness'

let h: ChatHarness
beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(() => h.mock.reset())

describe('GET /api/providers/presets', () => {
  it('lists every preset', async () => {
    const r = await h.inject('GET', '/api/providers/presets')
    expect(r.statusCode).toBe(200)
    expect((r.json() as { id: string }[]).map((p) => p.id)).toEqual(PRESETS.map((p) => p.id))
  })
})

describe('GET /api/providers/llm/models @R3', () => {
  it('lists the models of a saved profile (OpenAI-style and Anthropic with capabilities)', async () => {
    h.mock.llm.setModels(['m-2', 'm-1'])
    await h.setProfile(h.openaiProfile(''))
    const r = await h.inject('GET', '/api/providers/llm/models?profile=mock')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([{ id: 'm-1' }, { id: 'm-2' }])

    await h.setProfile(h.anthropicProfile(''), 'sk-ant-test-0123456789')
    const a = await h.inject('GET', '/api/providers/llm/models?profile=claude')
    expect((a.json() as { id: string; caps?: unknown }[])[0]).toMatchObject({ id: 'claude-mock-5', caps: { vision: true, pdf: true, tools: true } })
  })

  it('maps provider failures; unknown profiles are 404', async () => {
    await h.setProfile(h.openaiProfile())
    h.mock.llm.requireKey('the-right-key')
    const r = await h.inject('GET', '/api/providers/llm/models?profile=mock')
    expect(r.json()).toMatchObject({ error: { code: 'provider_auth', upstreamStatus: 401 } })
    expect(r.body).not.toContain('Incorrect API key')
    expect((await h.inject('GET', '/api/providers/llm/models?profile=nope')).statusCode).toBe(404)
  })

  it('a key bound to another origin is never sent (07 B1)', async () => {
    await h.setProfile(h.anthropicProfile())
    await h.ctx.secrets.set('llm:claude', 'sk-ant-test-0123456789', 'https://api.anthropic.com')
    const r = await h.inject('GET', '/api/providers/llm/models?profile=claude')
    expect(r.json()).toMatchObject({ error: { code: 'key_origin_mismatch' } })
    expect(h.mock.recorder.all().filter((x) => x.headers['x-api-key'])).toEqual([])
  })
})

describe('POST /api/providers/llm/test (desktop) @R3', () => {
  it('lists models and runs a tiny chat with a typed key', async () => {
    h.mock.llm.requireKey('sk-typed-0123456789')
    const r = await h.inject('POST', '/api/providers/llm/test', { preset: 'anthropic', baseUrl: `${h.mock.url}/anthropic`, model: 'claude-mock-5', key: 'sk-typed-0123456789' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, models: [{ id: 'claude-mock-5' }, { id: 'claude-mock-legacy' }] })
    const chat = h.mock.recorder.last((x) => x.path.endsWith('/v1/messages'))!
    expect((chat.json as { max_tokens: number }).max_tokens).toBe(16)
  })

  it('classifies failures: bad key, bad URL, unknown model, unreachable server', async () => {
    h.mock.llm.requireKey('good-key-0123456789')
    const bad = (await h.inject('POST', '/api/providers/llm/test', { preset: 'openai', baseUrl: `${h.mock.url}/v1`, key: 'wrong-key-0123456789' })).json()
    expect(bad).toMatchObject({ ok: false, kind: 'auth', upstreamStatus: 401 })
    const url = (await h.inject('POST', '/api/providers/llm/test', { preset: 'custom', baseUrl: 'http://example.com/v1' })).json()
    expect(url).toMatchObject({ ok: false, kind: 'url' })
    h.mock.llm.requireKey(null)
    h.mock.llm.script({ error: { status: 404 } })
    const model = (await h.inject('POST', '/api/providers/llm/test', { preset: 'custom', baseUrl: `${h.mock.url}/v1`, model: 'nope' })).json()
    expect(model).toMatchObject({ ok: false, kind: 'model' })
    const down = (await h.inject('POST', '/api/providers/llm/test', { preset: 'ollama', baseUrl: 'http://127.0.0.1:9/v1' })).json()
    expect(down).toMatchObject({ ok: false, kind: 'network' })
  })

  it('without a typed key a new profile reports the missing key', async () => {
    const r = (await h.inject('POST', '/api/providers/llm/test', { preset: 'openai', baseUrl: `${h.mock.url}/v1` })).json()
    expect(r).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('is desktop-only', async () => {
    const r = await h.server.ctx.app!.inject({ method: 'POST', url: '/api/test/login-as', headers: { host: h.host, origin: h.origin, 'x-vesper': '1' }, payload: { kind: 'browser' } })
    const c = (r.json() as { cookie: { name: string; value: string } }).cookie
    const res = await h.server.ctx.app!.inject({
      method: 'POST',
      url: '/api/providers/llm/test',
      headers: { host: h.host, origin: h.origin, 'x-vesper': '1', cookie: `${c.name}=${c.value}` },
      payload: { preset: 'openai', baseUrl: `${h.mock.url}/v1` }
    })
    expect(res.statusCode).toBe(403)
  })

  it('registers the wizard tester (ctx.services.testers.llm)', () => {
    expect(h.ctx.services.testers.llm).toBeDefined()
  })
})
