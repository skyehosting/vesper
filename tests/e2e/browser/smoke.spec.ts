/**
 * Phase 1 acceptance (BLD-13) for the web app: the standalone server (out/main/server-node.js, no Electron APIs)
 * serves the client to headless Chromium signed in as a browser device; a chat turn against the mock LLM's echo shows
 * up in the page and persists after a reload.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, createSession, latestMessages, routes, wsTurn } from '../helpers'

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

test('serves the client to a signed-in browser with hooks and a live WebSocket @R1', async () => {
  s = await launchServer({ mock })
  expect(await s.hook<boolean>('ready')).toBe(true)
  await s.waitHook('ws.connected')
  const boot = await s.api<{ desktop: boolean; device: { kind: string }; isTest: boolean }>('GET', '/api/bootstrap')
  expect(boot.status).toBe(200)
  expect(boot.json.device.kind).toBe('browser')
  expect(boot.json.desktop).toBe(false)
  await s.assertNoErrors()
})

test('sends "hello" from the browser and the echo reply persists after reload @R1 @R2 @R6', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  // Provider settings are desktop-only (07 B2): configure them as a desktop device, chat as the browser.
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = pageApi(s.page)
  const session = await createSession(page, 'Browser smoke')
  await s.hook('go', routes.chat(session.uid))

  const turn = await wsTurn(s.page, session.uid, 'hello')
  expect(turn.body).toBe('Echo: hello')
  await expect(s.page.getByText('Echo: hello', { exact: true }).first()).toBeVisible()

  await s.page.reload()
  await s.waitReady()
  await s.hook('go', routes.chat(session.uid))
  await expect(s.page.getByText('Echo: hello', { exact: true }).first()).toBeVisible()
  expect((await latestMessages(page, session.uid)).map((m) => m.body)).toEqual(['hello', 'Echo: hello'])
  await s.assertNoErrors()
})
