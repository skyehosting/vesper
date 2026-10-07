/**
 * Temporary chats end to end in the standalone server (Phase 3 engine-int, 07 B9): created over REST, two turns over
 * the page's own WebSocket, listed (temporary:true) for this device, never in search, and gone after DELETE.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, latestMessages, wsTurn } from '../helpers'

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

test('a temporary chat works like a chat and leaves nothing behind @R3 @R9', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = pageApi(s.page)

  const created = await page<{ uid: string; temporary: boolean }>('POST', '/api/sessions', { temporary: true, title: 'Off the record' })
  expect(created.status, created.text).toBe(200)
  expect(created.json.temporary).toBe(true)
  const uid = created.json.uid

  expect((await wsTurn(s.page, uid, 'remember the word quokkacanary')).body).toBe('Echo: remember the word quokkacanary')
  expect((await wsTurn(s.page, uid, 'second turn')).body).toBe('Echo: second turn')
  expect((await latestMessages(page, uid)).map((m) => m.body)).toEqual(['remember the word quokkacanary', 'Echo: remember the word quokkacanary', 'second turn', 'Echo: second turn'])

  const list = await page<{ items: { uid: string; temporary: boolean }[] }>('GET', '/api/sessions')
  expect(list.json.items.find((x) => x.uid === uid)).toMatchObject({ temporary: true })
  // Never indexed or searchable (07 B9).
  const found = await page<{ items: unknown[] }>('GET', '/api/search?q=quokkacanary')
  expect(found.status).toBe(200)
  expect(found.json.items).toEqual([])

  const end = await page('DELETE', `/api/sessions/${uid}`)
  expect(end.status).toBe(204)
  // Checked from outside the page: a 404 inside it would be logged as a console error.
  expect((await desktop.api('GET', `/api/sessions/${uid}`)).status).toBe(404)
  const after = await page<{ items: { uid: string }[] }>('GET', '/api/sessions')
  expect(after.json.items.some((x) => x.uid === uid)).toBe(false)
  await s.assertNoErrors()
})
