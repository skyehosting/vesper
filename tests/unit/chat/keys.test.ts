/**
 * Key checks on save (Phase 3 engine-int; 07 C22 pattern): PUT /api/secrets/llm:* and stt:* make one cheap request
 * with the new key and refuse only a definite 401/403 (`provider_auth`, 400) — outages, unknown answers and scoped
 * keys that may not read the checked endpoint are kept. Everything goes to the mock server. @R18 @R19
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LlmProfile } from '@shared/settings'
import { startMockServer, type MockServer } from '../../mocks/server'
import { startTestServer, type TestServer } from '../server/helpers'

let mock: MockServer
let t: TestServer
let desktop: string

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  t = await startTestServer()
  desktop = await t.login('desktop')
  const profiles = [
    { id: 'oa', label: 'OpenAI', preset: 'openai', adapter: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-mock' },
    { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' }
  ] as LlmProfile[]
  await t.server.ctx.settings.patch({ llm: { profiles, defaultProfile: 'oa' } })
})
afterAll(async () => {
  await t.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})
beforeEach(() => {
  mock.reset()
  mock.llm.requireKey(null)
})

const put = (name: string, value: string) => t.inject({ method: 'PUT', url: `/api/secrets/${name}`, cookie: desktop, payload: { value } })
const saved = async (name: string): Promise<boolean> => (await t.server.ctx.secrets.list()).includes(name)

describe('llm:* keys are checked with a models list @R18', () => {
  it('a refused key (401) is not stored; the right one is', async () => {
    mock.llm.requireKey('sk-good-000000000')
    const bad = await put('llm:oa', 'sk-wrong-00000000')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    expect(await saved('llm:oa')).toBe(false)
    expect((await put('llm:oa', 'sk-good-000000000')).statusCode).toBe(200)
    expect(await saved('llm:oa')).toBe(true)
    const listed = mock.recorder.all().filter((r) => r.method === 'GET' && r.path.endsWith('/models'))
    expect(listed.length).toBe(2)
  })

  it('check: false stores the key without a request (the client tests it right after)', async () => {
    mock.llm.requireKey('sk-good-000000000')
    const r = await t.inject({ method: 'PUT', url: '/api/secrets/llm:oa', cookie: desktop, payload: { value: 'sk-wrong-11111111', check: false } })
    expect(r.statusCode).toBe(200)
    expect(await saved('llm:oa')).toBe(true)
    expect(mock.recorder.all().filter((x) => x.path.endsWith('/models'))).toEqual([])
    await t.server.ctx.secrets.delete('llm:oa')
  })

  it('Anthropic keys too (x-api-key on /v1/models)', async () => {
    mock.llm.requireKey('sk-ant-good-0000')
    expect((await put('llm:claude', 'sk-ant-bad-00000')).statusCode).toBe(400)
    expect((await put('llm:claude', 'sk-ant-good-0000')).statusCode).toBe(200)
  })

  it('an outage or an unknown profile keeps the key', async () => {
    mock.script({ method: 'GET', path: '/v1/models', status: 503, json: { error: { message: 'down' } } })
    expect((await put('llm:oa', 'sk-any-000000000')).statusCode).toBe(200)
    expect((await put('llm:not-a-profile', 'sk-any-000000000')).statusCode).toBe(400) // no URL to bind it to (route rule)
  })
})

describe('stt:* keys are checked with a free account request @R19', () => {
  it('Deepgram: 401 on /v1/projects refuses; an unknown answer keeps it', async () => {
    mock.script({ method: 'GET', path: '/v1/projects', status: 401, json: { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' } })
    const r = await put('stt:deepgram', 'dg-wrong-key')
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    expect(JSON.stringify(r.json())).not.toContain('Invalid credentials')
    expect(await saved('stt:deepgram')).toBe(false)
    mock.script({ method: 'GET', path: '/v1/projects', status: 200, json: { projects: [] } })
    expect((await put('stt:deepgram', 'dg-right-key')).statusCode).toBe(200)
    const req = mock.recorder.all().filter((x) => x.path === '/v1/projects').at(-1)!
    expect(req.headers.authorization).toBe('Token dg-right-key')
  })

  it('ElevenLabs: a scoped key without the user permission is kept', async () => {
    mock.script({ method: 'GET', path: '/v1/user', status: 401, json: { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read to execute this operation.' } } })
    expect((await put('stt:elevenlabs', 'xi-scoped-key')).statusCode).toBe(200)
    mock.script({ method: 'GET', path: '/v1/user', status: 401, json: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } })
    expect((await put('stt:elevenlabs', 'xi-bad-key')).statusCode).toBe(400)
  })

  it('OpenAI / Groq: the models list with a Bearer key', async () => {
    mock.llm.requireKey('sk-stt-good')
    expect((await put('stt:openai', 'sk-stt-bad')).statusCode).toBe(400)
    expect((await put('stt:openai', 'sk-stt-good')).statusCode).toBe(200)
    expect((await put('stt:groq', 'sk-stt-good')).statusCode).toBe(200)
    expect(mock.recorder.all().some((r) => r.path === '/openai/v1/models' || r.path.endsWith('/v1/models'))).toBe(true)
  })
})
