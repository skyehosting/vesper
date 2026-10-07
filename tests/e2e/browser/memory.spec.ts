/**
 * Memory end to end on the standalone server (built db.worker thread, mock Voyage via VESPER_MOCK_BASE): chat turns
 * are tagged, timestamped and indexed; search finds them by keyword and meaning; a private session never reaches
 * Voyage; pinned facts round-trip. @R7 @R8 @R21
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type Api, type TestServer } from '../launch'
import { configureMockLlm, createSession, wsTurn } from '../helpers'

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

interface Status {
  state: string
  indexed: number
  queued: number
}

async function waitIndexed(api: Api, atLeast: number): Promise<Status> {
  let last: Status | null = null
  await expect
    .poll(
      async () => {
        last = (await api<Status>('GET', '/api/memory/status')).json
        return last.queued === 0 && last.indexed >= atLeast
      },
      { timeout: 20_000, message: 'memory indexing' }
    )
    .toBe(true)
  return last!
}

test('chat turns are indexed and found by keyword and by meaning; private stays local @R7 @R8 @R21', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  expect((await desktop.api('PATCH', '/api/settings', { memory: { enabled: true, voyage: { tier: 'tier1' } } })).status).toBe(200)
  expect((await desktop.api('PUT', '/api/secrets/voyage', { value: 'pa-e2e-key' })).status).toBe(200)

  const page = pageApi(s.page)
  const trip = await createSession(page, 'Trip planning')
  await wsTurn(s.page, trip.uid, 'We should plan a trip to Lisbon in the spring')
  await wsTurn(s.page, trip.uid, 'Book a hotel near the castle and check the tram times')
  const status = await waitIndexed(page, 4)
  expect(status.state).toBe('ready')

  const texts = mock.voyage.embeddedTexts()
  expect(texts.some((t) => t.startsWith('user response: We should plan a trip to Lisbon'))).toBe(true)
  expect(texts.join('\n')).not.toContain('[tone=')

  const kw = await page<{ items: { message: { body: string; tag: string; tsUtc: number }; session: { uid: string; shortId: string }; snippet: string }[] }>('GET', '/api/search?q=Lisbon')
  expect(kw.status).toBe(200)
  const hit = kw.json.items.find((i) => i.message.body.startsWith('We should plan a trip'))!
  expect(hit).toBeTruthy()
  expect(hit.message.tag).toBe('user response')
  expect(hit.session.uid).toBe(trip.uid)
  expect(hit.snippet).toContain('«Lisbon»')
  const sem = await page<{ items: { message: { body: string } }[] }>('GET', '/api/search?q=castle%20hotel%20tram&mode=semantic')
  expect(sem.json.items[0].message.body).toContain('castle')

  // A private session: its messages and searches never reach Voyage (07 B9).
  const secret = await createSession(page, 'Diary')
  expect((await page('PATCH', `/api/sessions/${secret.uid}`, { private: true })).status).toBe(200)
  await wsTurn(s.page, secret.uid, 'my canary yellow submarine secret')
  const recall = await page<{ body: string }[]>('POST', '/api/memory/recall', { query: 'canary submarine', sessionUid: secret.uid })
  expect(recall.status).toBe(200)
  expect(recall.json.some((h) => h.body.includes('canary'))).toBe(true)
  expect(mock.voyage.embeddedTexts().join('\n')).not.toContain('canary')

  // Pinned facts ("About you", 07 A4) and the manifest.
  expect((await page('POST', '/api/facts', { text: 'Prefers trams to taxis' })).status).toBe(200)
  expect((await page<{ text: string }[]>('GET', '/api/facts')).json.map((f) => f.text)).toEqual(['Prefers trams to taxis'])
  const manifest = await page<{ sessions: { uid: string; private: boolean }[] }>('GET', '/api/memory/manifest')
  expect(manifest.json.sessions.find((x) => x.uid === secret.uid)?.private).toBe(true)
  await s.assertNoErrors()
})
