/**
 * Temporary chats through the UI (07 B9; Phase 4 integration of sessions-ui's shell with engine-int's TemporaryStore):
 * "New temporary chat" opens one with the header pill and a ghost row; a turn works; the panel hides Memory and
 * "AI can access"; "End temporary chat" deletes it for good (no Trash, no Undo); and a temporary chat ended elsewhere
 * (session.ended) takes the reader back home with a notice. Nothing of it reaches the stored chats or search.
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm } from '../helpers'
import { launchServer, type TestServer } from '../launch'
import { expectNoAxeViolations } from '../settingsWizard'

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

test('New temporary chat: pill, a turn, panel without memory or links, End deletes it; ended elsewhere → home @R6 @R9', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = s.page
  const sidebar = page.getByRole('complementary', { name: 'Chats' })

  // Start one from the sidebar.
  // The app may already show an ordinary "New chat" at /s/<uid>: wait for the temporary one before reading its uid.
  const before = page.url()
  await sidebar.getByRole('button', { name: 'New temporary chat' }).click()
  const pill = page.getByRole('note', { name: /^Temporary chat: not saved/ })
  await expect(pill).toBeVisible()
  await expect(page).not.toHaveURL(before)
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  const uid = new URL(page.url()).pathname.split('/').pop() ?? ''
  await expect(page.locator('.shead__title')).toContainText('Temporary chat')
  const row = page.locator(`.srow[data-session="${uid}"]`)
  await expect(row.locator('.srow__link')).toContainText('temporary')
  await expect(row.locator('.srow__lead')).toBeVisible()

  // A turn works like any chat.
  const input = page.getByTestId('composer-input')
  await input.fill('remember the word quokkatemp')
  await input.press('Enter')
  await expect(page.locator('article.msg').filter({ hasText: 'Echo: remember the word quokkatemp' })).toBeVisible({ timeout: 20_000 })
  await expectNoAxeViolations(page, 'temporary chat')

  // The panel: no Memory, no "AI can access" (a temporary chat is never recalled and can't link).
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  const panel = page.locator('.shell__panel')
  await expect(panel.getByRole('heading', { name: 'System prompt' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Memory' })).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'AI can access' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Hide chat panel' }).click()

  // Never searchable, never stored: nothing in the message search.
  expect((await desktop.api<{ items: unknown[] }>('GET', '/api/search?q=quokkatemp')).json.items).toEqual([])

  // End it from its row menu: DELETE ends it for good — no Trash, no Undo.
  await row.hover()
  await page.getByRole('button', { name: 'More for Temporary chat' }).click()
  await page.getByRole('menuitem', { name: 'End temporary chat' }).click()
  await expect(page.locator('.toast').filter({ hasText: 'Temporary chat ended. Nothing was saved.' })).toBeVisible()
  await expect(page.locator('.toast').filter({ hasText: 'Undo' })).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(`/s/${uid}$`))
  await expect(row).toHaveCount(0)
  expect((await desktop.api('GET', `/api/sessions/${uid}`)).status).toBe(404)
  const trash = await desktop.api<{ items: { uid: string }[] }>('GET', '/api/sessions?filter=trash')
  expect((trash.json.items ?? []).some((x) => x.uid === uid)).toBe(false)

  // A second one, ended somewhere else while it is open: session.ended takes the reader home with a notice.
  const home = page.url()
  await sidebar.getByRole('button', { name: 'New temporary chat' }).click()
  await expect(pill).toBeVisible()
  await expect(page).not.toHaveURL(home)
  const uid2 = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect(uid2).not.toBe(uid)
  expect((await desktop.api('DELETE', `/api/sessions/${uid2}`)).status).toBe(204)
  await expect(page).not.toHaveURL(new RegExp(`/s/${uid2}$`))
  await expect(page.locator('.toast').filter({ hasText: 'This temporary chat has ended. Nothing from it was saved.' })).toBeVisible()
  await expect(page.locator(`.srow[data-session="${uid2}"]`)).toHaveCount(0)
  await s.assertNoErrors()
})

test('a temporary chat stays temporary while the sidebar is searched: uploads stay temporary, the notice stays, drafts never touch storage (F70, F09/F17) @R9 @R21', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = s.page
  const sidebar = page.getByRole('complementary', { name: 'Chats' })
  const uploads: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/attachments') uploads.push(new URL(r.url()).search)
  })

  const before = page.url()
  await sidebar.getByRole('button', { name: 'New temporary chat' }).click()
  await expect(page.getByRole('note', { name: /^Temporary chat: not saved/ })).toBeVisible()
  await expect(page).not.toHaveURL(before)
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  const uid = new URL(page.url()).pathname.split('/').pop() ?? ''
  const notice = page.locator('.chat__temp')
  await expect(notice).toBeVisible()

  // Searching the sidebar drops the chat from the list; it is still temporary.
  await sidebar.getByRole('searchbox', { name: 'Search chats by title or ID' }).fill('xyz')
  await expect(sidebar.locator(`.srow[data-session="${uid}"]`)).toHaveCount(0)
  await expect(notice).toBeVisible()
  await expect(page.getByRole('note', { name: /^Temporary chat: not saved/ })).toBeVisible()
  const file = page.locator('.composer input[type=file]')
  await file.setInputFiles({ name: 'note2.txt', mimeType: 'text/plain', buffer: Buffer.from('temporary attachment text') })
  await expect(page.locator('.composer__atts li')).toHaveCount(1)
  await expect.poll(() => uploads.length).toBe(1)
  expect(uploads).toEqual(['?temporary=1'])

  // A draft typed into a temporary chat lives in memory only: nothing in localStorage, even after the save delay.
  const input = page.getByTestId('composer-input')
  await input.fill('a sensitive half-written thought')
  await page.waitForTimeout(700)
  const drafts = async (): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vesper.draft.')))
  expect(await drafts()).toEqual([])
  // Leaving the chat (unmount saves the draft) still writes nothing to storage.
  await sidebar.getByRole('searchbox', { name: 'Search chats by title or ID' }).fill('')
  await sidebar.getByRole('button', { name: 'New chat' }).click()
  await expect(page).not.toHaveURL(new RegExp(`/s/${uid}$`))
  await page.waitForTimeout(500)
  expect(await drafts()).toEqual([])
  await s.assertNoErrors()
})

test('drafts of a deleted chat are removed from storage; stale drafts of gone chats are swept at start (F09/F17) @R9', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = s.page
  const created = (await desktop.api<{ uid: string }>('POST', '/api/sessions', { title: 'Will be deleted' })).json
  const kept = (await desktop.api<{ uid: string }>('POST', '/api/sessions', { title: 'Kept' })).json
  await page.evaluate(
    ([a, b]) => {
      localStorage.setItem(`vesper.draft.${a}`, 'draft of a chat about to be deleted')
      localStorage.setItem(`vesper.draft.${b}`, 'draft that stays')
      localStorage.setItem('vesper.draft.00000000-0000-4000-8000-000000000000', 'draft of a chat that is long gone')
    },
    [created.uid, kept.uid]
  )
  // A fresh start sweeps drafts whose chat no longer exists.
  await page.reload()
  await s.waitHook('ws.connected')
  const keys = async (): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vesper.draft.')).sort())
  await expect.poll(keys).toEqual([`vesper.draft.${created.uid}`, `vesper.draft.${kept.uid}`].sort())
  // Deleting a chat (anywhere: the event reaches every device) removes its draft.
  expect((await desktop.api('DELETE', `/api/sessions/${created.uid}`)).status).toBe(204)
  await expect.poll(keys).toEqual([`vesper.draft.${kept.uid}`])
  await s.assertNoErrors()
})
