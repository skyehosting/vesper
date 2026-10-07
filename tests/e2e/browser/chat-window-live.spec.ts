/**
 * The history window stays bounded at the live edge (07 D1 "cap 3N"; found by the text-replies soak, review F45):
 * replies that arrive while the reader sits at the bottom of a chat used to append to the store forever — the far
 * end was trimmed only after a page load, so a chat left open all day kept every message (1,700 rows after 1,000
 * replies at N = 100). @R5 @R17
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, wsTurn } from '../helpers'
import { launchServer, type TestServer } from '../launch'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  mock.reset()
})
test.afterAll(async () => {
  await mock?.close()
})

test('replies arriving at the live edge keep the window at ≤ 3N rows, the reader at the bottom @R5 @R17', async () => {
  test.setTimeout(180_000)
  s = await launchServer({ mock })
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  expect((await desk.api('PATCH', '/api/settings', { chat: { pageSize: 20 } })).status).toBe(200)
  const sess = await createSession(s.api, 'Live edge')
  await s.page.reload()
  await s.waitReady()
  await s.hook('go', `/s/${sess.uid}`)
  await s.waitReady()
  const turns = 45 // 90 messages: 1.5 × the 3N cap
  await wsTurn(s.page, sess.uid, 'Message number 0')
  // The message window (and its hooks) replaces the empty state once the first turn is in.
  await s.waitHook('chat.window')
  const N = await s.hook<number>('chat.pageSize')
  expect(N).toBe(20)
  for (let i = 1; i < turns; i++) await wsTurn(s.page, sess.uid, `Message number ${i}`)
  type Info = { rows: number; lastSeq: number; hiSeq: number; atBottom: boolean }
  await expect.poll(async () => (await s!.hook<Info>('chat.window')).lastSeq, { timeout: 15_000 }).toBe(turns * 2)
  await expect.poll(async () => (await s!.hook<Info>('chat.window')).rows, { timeout: 10_000 }).toBeLessThanOrEqual(3 * N)
  const w = await s.hook<Info>('chat.window')
  expect(w.hiSeq).toBe(turns * 2)
  expect(w.atBottom).toBe(true)
  await expect(s.page.locator('article.msg').last()).toContainText(`Message number ${turns - 1}`)
  await s.assertNoErrors()
})
