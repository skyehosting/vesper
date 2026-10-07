/**
 * Phase 1 acceptance (BLD-13) for the desktop app: the built Electron app boots on the test switches, its client
 * registers its hooks and WebSocket, a chat turn runs against the mock LLM's echo, and the messages persist across a
 * reload and a restart on the same data dir.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, removeDirs, type TestApp } from '../launch'
import { configureMockLlm, createSession, latestMessages, routes, wsTurn } from '../helpers'

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})

test.afterEach(async () => {
  await t?.close()
  t = null
})

test.afterAll(async () => {
  await mock?.close()
})

test('boots with test hooks, no console errors and a live WebSocket @R1', async () => {
  t = await launchApp({ mock })
  expect(await t.hook<boolean>('ready')).toBe(true)
  expect(typeof (await t.hook<string>('route'))).toBe('string')
  await t.waitHook('ws.connected')
  await t.assertNoErrors()
})

test('sends "hello" and shows the echo reply, which persists after reload and restart @R1 @R2 @R6', async () => {
  t = await launchApp({ mock })
  await t.waitHook('ws.connected')
  await configureMockLlm(t.api, mock.url)
  const session = await createSession(t.api, 'Smoke')
  await t.hook('go', routes.chat(session.uid))

  const turn = await wsTurn(t.page, session.uid, 'hello')
  expect(turn.body).toBe('Echo: hello')
  expect(turn.events).toContain('message.created')
  await expect(t.page.getByText('Echo: hello', { exact: true }).first()).toBeVisible()
  // The reply came from the mock LLM: its /chat/completions recorder saw the user's "hello" (after the [Now: …] header).
  const seen = mock.recorder.find((r) => r.method === 'POST' && r.path.endsWith('/chat/completions'))
  expect(seen.length).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(seen[seen.length - 1].json)).toMatch(/\[Now: [^\]]+\]\\nhello"/)

  await t.page.reload()
  await t.waitReady()
  await t.hook('go', routes.chat(session.uid))
  await expect(t.page.getByText('Echo: hello', { exact: true }).first()).toBeVisible()
  await t.assertNoErrors()

  // Restart on the same data: the conversation is read back from SQLite.
  const { dataDir, localDir } = t
  await t.close({ keepData: true })
  t = await launchApp({ mock, dataDir, localDir })
  try {
    const bodies = (await latestMessages(t.api, session.uid)).map((m) => m.body)
    expect(bodies).toEqual(['hello', 'Echo: hello'])
    await t.hook('go', routes.chat(session.uid))
    await expect(t.page.getByText('Echo: hello', { exact: true }).first()).toBeVisible()
    await t.assertNoErrors()
  } finally {
    await t.close()
    t = null
    // The relaunch reused dirs it did not create, so it leaves them; remove them now.
    removeDirs([dataDir, localDir])
  }
})
