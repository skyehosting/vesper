/**
 * The chat engine end to end in the standalone server (llm-engine, Phase 2): an Anthropic profile whose key is saved
 * through the secrets API, two turns from a browser device, a native tool loop, byte-stable history (07 C1) and the
 * key sent only to the origin it was saved for (07 B1).
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { createSession, latestMessages, wsTurn } from '../helpers'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})

test.afterEach(async () => {
  await s?.close()
  s = null
})

test.afterAll(async () => {
  await mock?.close()
})

test('Anthropic turns with a native tool loop keep a byte-stable prefix @R2 @R9 @R11', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  const profile = { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: `${mock.url}/anthropic`, model: 'claude-opus-5-5' }
  const set = await desktop.api('PATCH', '/api/settings', { llm: { profiles: [profile], defaultProfile: 'claude' }, chat: { autoTitle: false }, wizard: { completed: true } })
  expect(set.status, set.text).toBe(200)
  const key = await desktop.api('PUT', '/api/secrets/llm:claude', { value: 'sk-ant-e2e-0123456789' })
  expect(key.status, key.text).toBe(200)

  const page = pageApi(s.page)
  const session = await createSession(page, 'Engine e2e')
  expect((await wsTurn(s.page, session.uid, 'hello')).body).toBe('Echo: hello')

  mock.llm.script({ text: 'Let me check.', toolCalls: [{ name: 'memory_search', input: { query: 'hello' } }] }, { text: 'Nothing earlier, but hello again!' })
  const turn = await wsTurn(s.page, session.uid, 'did we talk before?')
  expect(turn.body).toBe('Let me check.\n\nNothing earlier, but hello again!')
  expect(turn.events).toContain('reply.tool')

  const reqs = mock.recorder.find((r) => r.method === 'POST' && r.path.endsWith('/v1/messages'))
  expect(reqs).toHaveLength(3)
  for (const r of reqs) expect(r.headers['x-api-key']).toBe('sk-ant-e2e-0123456789')
  // Voyage is off by default: memory answers by keywords on this PC (F37), never "memory is disabled".
  expect(JSON.stringify(reqs[2].json)).toContain('memory_result')
  expect(JSON.stringify(reqs[2].json)).not.toContain('"content":"memory is disabled"')
  mock.recorder.assertPrefixInvariant()
  expect((await latestMessages(page, session.uid)).map((m) => m.body)).toEqual(['hello', 'Echo: hello', 'did we talk before?', 'Let me check.\n\nNothing earlier, but hello again!'])
  await s.assertNoErrors()
})
