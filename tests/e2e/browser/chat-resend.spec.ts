/**
 * F62 (07 C16, Phase 4c): the socket drops right after the composer's `chat.send` frame left (the ack is lost). The
 * client resends the very same frame after the reconnect and the server answers with the original ack — one user
 * message, one reply, one provider call; the composer stays empty and no "connection lost" error is shown.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, createSession, latestMessages, routes } from '../helpers'

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

test('a lost chat.send ack never makes a duplicate turn or gives the text back @R22', async () => {
  s = await launchServer({ mock })
  const desktop = (await s.login('desktop')).api
  await configureMockLlm(desktop, mock.url)
  const page = pageApi(s.page)
  const session = await createSession(page, 'Lost ack')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  mock.recorder.clear()

  // Drop the socket right after the next chat.send frame is handed to it (the server gets it, its ack is lost).
  await s.page.evaluate(() => {
    const orig = WebSocket.prototype.send
    let armed = true
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      orig.call(this, data)
      if (armed && typeof data === 'string' && data.includes('"t":"chat.send"')) {
        armed = false
        this.close()
      }
    }
  })

  const input = s.page.getByTestId('composer-input')
  await input.fill('only once please')
  await input.press('Enter')

  await expect(s.page.locator('article.msg--ai').filter({ hasText: 'Echo: only once please' })).toHaveCount(1, { timeout: 20_000 })
  await expect(input).toHaveValue('')
  await expect(s.page.getByText('The connection to Vesper was lost.')).toHaveCount(0)
  await expect(s.page.locator('article.msg--user').filter({ hasText: 'only once please' })).toHaveCount(1)

  const msgs = await latestMessages(page, session.uid)
  expect(msgs.map((m) => m.body)).toEqual(['only once please', 'Echo: only once please'])
  const chats = mock.recorder.all().filter((r) => r.method === 'POST' && r.path.endsWith('/chat/completions') && JSON.stringify(r.json).includes('only once please'))
  expect(chats.filter((r) => JSON.stringify(r.json).includes('# Protocols'))).toHaveLength(1)
  await s.assertNoErrors()
})
