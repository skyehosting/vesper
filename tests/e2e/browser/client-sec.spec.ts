/**
 * Client privacy, second pass of the Phase 4c fixes (docs/review/phase4b-findings.md F09, F19):
 *   - a chat deleted elsewhere while it is open: its unsent draft is not written back by the Composer's unmount save;
 *   - revoked (session ended) and signed out: no unsent draft stays readable in this browser's localStorage;
 *   - a loopback custom AI address (the mock AI): the Privacy page and the provider editor make no absolute
 *     "Nothing leaves this PC" / green "On this PC" claim (research 08 §4.2: unless that program forwards it).
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm } from '../helpers'
import { launchServer, pageApi, type TestServer } from '../launch'

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

const draftKeys = async (page: Page): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vesper.draft.')).sort())
const draftValues = async (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('vesper.draft.'))
      .map((k) => localStorage.getItem(k) ?? '')
  )
/** Lets React finish the commit that left the chat (unmount effects included) before storage is read. */
const settle = async (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))))

async function openChatWithDraft(srv: TestServer, title: string, text: string): Promise<string> {
  const page = srv.page
  const uid = (await srv.api<{ uid: string }>('POST', '/api/sessions', { title })).json.uid
  await page.goto(`${srv.url}/s/${uid}`)
  await srv.waitReady()
  await srv.waitHook('ws.connected')
  await page.getByTestId('composer-input').fill(text)
  // Saved shortly after typing stops (an ordinary chat: localStorage).
  await expect.poll(async () => page.evaluate((k) => localStorage.getItem(k), `vesper.draft.${uid}`)).toBe(text)
  return uid
}

test('a chat deleted elsewhere while open: its draft is not written back by the unmount save (F09) @R9', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = s.page
  const uid = await openChatWithDraft(s, 'Open while deleted', 'PRIVATE DRAFT TEXT')

  expect((await desktop.api('DELETE', `/api/sessions/${uid}`)).status).toBe(204)
  await expect(page).not.toHaveURL(new RegExp(`/s/${uid}$`))
  await expect(page.getByTestId('composer-input')).not.toHaveValue('PRIVATE DRAFT TEXT')
  await settle(page)
  expect(await draftKeys(page)).not.toContain(`vesper.draft.${uid}`)
  expect((await draftValues(page)).some((v) => v.includes('PRIVATE DRAFT TEXT'))).toBe(false)
  // Restored from Trash and opened again: drafts work for it as before.
  expect((await desktop.api('POST', `/api/sessions/${uid}/restore`)).status).toBeLessThan(300)
  await page.goto(`${s.url}/s/${uid}`)
  await s.waitReady()
  await page.getByTestId('composer-input').fill('typed after restore')
  await expect.poll(async () => page.evaluate((k) => localStorage.getItem(k), `vesper.draft.${uid}`)).toBe('typed after restore')
  await s.assertNoErrors()
})

test('revoked while a chat is open, and signed out: no unsent draft stays in this browser (F09) @R1 @R9', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const page = s.page
  await page.evaluate(() => localStorage.setItem('vesper.draft.00000000-0000-4000-8000-000000000001', 'older unsent text'))
  await openChatWithDraft(s, 'Open while revoked', 'UNSENT ON A SHARED BROWSER')

  // Revoked from the desktop: the socket closes, the app goes to the login page; the open Composer's unmount save
  // must not put the draft back.
  const me = (await pageApi(page)<{ id: string; current: boolean }[]>('GET', '/api/auth/devices')).json.find((d) => d.current)
  expect(me).toBeTruthy()
  expect((await desktop.api('DELETE', `/api/auth/devices/${me!.id}`)).status).toBe(204)
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 })
  await settle(page)
  expect(await draftKeys(page)).toEqual([])
  expect(s.errors.filter((e) => !/status of 40[13]/.test(e))).toEqual([])
  await s.close()

  // Signed out with "Sign out" (Settings → Access): the drafts saved before are removed.
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  await configureMockLlm((await s.login('desktop')).api, mock.url)
  const page2 = s.page
  await openChatWithDraft(s, 'Before sign-out', 'TEXT I NEVER SENT')
  await page2.goto(`${s.url}/settings/access`)
  await s.waitReady()
  expect(await draftKeys(page2)).toHaveLength(1)
  await page2.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page2).toHaveURL(/\/login$/, { timeout: 15_000 })
  await settle(page2)
  expect(await draftKeys(page2)).toEqual([])
  expect(s.errors.filter((e) => !/status of 40[13]/.test(e))).toEqual([])
})

test('a loopback custom AI address: no absolute "Nothing leaves this PC" or green "On this PC" (F19) @R21', async () => {
  s = await launchServer({ mock, login: 'desktop' })
  await s.waitHook('ws.connected')
  await configureMockLlm(s.api, mock.url)
  const page = s.page
  await page.goto(`${s.url}/settings/privacy`)
  await s.waitReady()
  const card = page.locator('[data-testid="privacy-service"][data-service="llm.local-custom"]')
  await expect(card).toContainText('On this PC, unless the program forwards it')
  await expect(page.getByText('Stays on this PC unless your local program forwards it')).toBeVisible()
  await expect(page.getByText('Nothing leaves this PC', { exact: true })).toHaveCount(0)
  await expect(page.getByText('A program on this PC', { exact: true })).toBeVisible()
  // The provider editor: no green "On this PC" for it.
  await s.hook('go', '/settings/providers')
  await s.waitReady()
  await expect(page.getByText('On this PC, unless it forwards', { exact: true })).toBeVisible()
  await expect(page.getByText('On this PC', { exact: true })).toHaveCount(0)
  // The model chip says where the text goes, and its picker says it may be passed on.
  const uid = (await s.api<{ uid: string }>('POST', '/api/sessions', { title: 'Chip' })).json.uid
  await s.hook('go', `/s/${uid}`)
  await s.waitReady()
  const chip = page.getByRole('button', { name: /^Model: mock-echo, text goes to a program on this PC that may forward it/ })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByText(/go to a program on this PC \(Mock LLM\); it may pass them on to an online service/)).toBeVisible()
  await s.assertNoErrors()
})
