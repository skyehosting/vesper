/**
 * sessions-ui acceptance (R6 side panel with session history, R8 links + /continue, R11 per-session prompts, 07 D8/D9/
 * D12/D13, 03 §5 commands): the shell, the sessions sidebar (groups, badges, rename, pin, archive, delete + undo,
 * Trash, keyboard, windowing, live updates), the top bar (title, ID, chips, voice, game mode), the session panel
 * (prompt + library, memory, scope, private, links both ways, info, continue), the slash commands with argument
 * completion through the Ctrl+K palette, global search with filters and the jump link, the shortcuts sheet, the phone
 * sheets, axe on every screen/dialog, and leak counters back to baseline after repeated open/close.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, type TestServer } from '../launch'
import { configureMockLlm, wsTurn } from '../helpers'
import { axe, seedChats, shotPath, type Seeded } from './sessionsUi.seed'

let mock: MockServer
let s: TestServer
let page: Page
let seeded: Seeded

interface SessionJson {
  uid: string
  shortId: string
  title: string
  pinned: boolean
  archived: boolean
  private: boolean
  memory: string
  memoryScope: string
  systemPrompt: string
  promptId: number | null
  model: string | null
  links: { uid: string; shortId: string }[]
  linkedFrom: { uid: string; shortId: string }[]
  meta: { continuedFrom?: string; continuedIn?: string }
  deletedUtc?: number | null
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  mock = await startMockServer()
  s = await launchServer({ mock })
  page = s.page
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: s.url })
  seeded = await seedChats(s, mock, { turns: true })
})

test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

test.afterEach(async () => {
  await s.assertNoErrors()
})

const uidOf = (title: string): string => seeded.byTitle[title].uid
const shortOf = (title: string): string => seeded.byTitle[title].shortId

async function get(uid: string): Promise<SessionJson> {
  const r = await s.api<SessionJson>('GET', `/api/sessions/${uid}`)
  expect(r.status, r.text).toBe(200)
  return r.json
}

async function open(path: string): Promise<void> {
  await s.hook('go', path)
  await s.waitReady()
}

const sidebar = (): Locator => page.locator('.shell__sidebar, .edge-sheet--start')
const row = (title: string | RegExp): Locator => sidebar().getByRole('link', { name: typeof title === 'string' ? new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : title })

async function palette(text: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: /type \/ for commands/ })
  await expect(input).toBeFocused()
  await input.fill(text)
}

async function runCommand(text: string): Promise<void> {
  await palette(text)
  // Wait for the async completion list to settle on this text, then run it.
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
}

async function navStats(): Promise<Record<string, number>> {
  return s.hook<Record<string, number>>('nav.stats')
}

test('sidebar: groups, badges, and live updates from another device @R6', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(`/s/${uidOf('Planning the Lisbon trip')}`)
  const headings = await sidebar().locator('.slist__heading').allTextContents()
  expect(headings.map((h) => h.toLowerCase())).toEqual(['pinned', 'today', 'yesterday', 'this week', 'older'])
  await expect(row('Planning the Lisbon trip')).toHaveAttribute('aria-current', 'page')
  await expect(row('Morning journal')).toHaveAccessibleName(/private/)
  await expect(row('Spanish practice')).toHaveAccessibleName(/linked to 2 chats, custom system prompt/)
  await expect(row('Debugging the borrow checker')).toHaveAccessibleName(/memory off/)

  // Another device creates and renames a chat: the list follows without a reload.
  const other = await s.login('browser')
  const made = await other.api<SessionJson>('POST', '/api/sessions', { title: 'From the phone' })
  await expect(row('From the phone')).toBeVisible()
  await other.api('PATCH', `/api/sessions/${made.json.uid}`, { title: 'Renamed on the phone' })
  await expect(row('Renamed on the phone')).toBeVisible()
  await other.api('DELETE', `/api/sessions/${made.json.uid}`)
  await expect(row('Renamed on the phone')).toHaveCount(0)
})

test('sidebar: inline rename, pin, archive, delete with undo, Trash restore and empty @R6', async () => {
  const groceries = uidOf('Weekly groceries')
  // F2 renames inline; Enter saves.
  await row('Weekly groceries').focus()
  await page.keyboard.press('F2')
  const field = sidebar().getByRole('textbox', { name: 'Chat title' })
  await expect(field).toBeFocused()
  await field.fill('Groceries for the week')
  await page.keyboard.press('Enter')
  await expect(row('Groceries for the week')).toBeVisible()
  await expect.poll(async () => (await get(groceries)).title).toBe('Groceries for the week')
  await expect(row('Groceries for the week')).toBeFocused()

  // Pin from the row's menu.
  await row('Groceries for the week').hover()
  await sidebar().getByRole('button', { name: 'More for Groceries for the week' }).click()
  await page.getByRole('menuitem', { name: 'Pin to top' }).click()
  await expect.poll(async () => (await get(groceries)).pinned).toBe(true)
  await expect
    .poll(async () => (await sidebar().locator('.slist__row, .slist__heading').allTextContents()).slice(0, 4).join('|'))
    .toMatch(/^Pinned\|(Groceries for the week|Planning the Lisbon trip)\|(Groceries for the week|Planning the Lisbon trip)\|Today/)

  // Delete key → Trash, with Undo.
  await row('Garden layout ideas').focus()
  await page.keyboard.press('Delete')
  const toast = page.locator('.toast').filter({ hasText: 'Moved “Garden layout ideas” to Trash' })
  await expect(toast).toBeVisible()
  await expect(row('Garden layout ideas')).toHaveCount(0)
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(row('Garden layout ideas')).toBeVisible()
  expect((await get(uidOf('Garden layout ideas'))).deletedUtc ?? null).toBeNull()

  // Delete again, restore from the Trash view.
  await row('Garden layout ideas').focus()
  await page.keyboard.press('Delete')
  await expect(row('Garden layout ideas')).toHaveCount(0)
  await page.getByRole('button', { name: 'Trash' }).click()
  await expect(sidebar().getByRole('heading', { name: 'Trash', exact: true })).toBeVisible()
  await sidebar().getByRole('button', { name: 'Restore Garden layout ideas' }).click()
  await expect(page).toHaveURL(new RegExp(`/s/${uidOf('Garden layout ideas')}$`))
  await expect(sidebar().getByRole('button', { name: 'Restore Garden layout ideas' })).toHaveCount(0)
  // (The chat another device deleted in the first test is still in the Trash.)
  await expect(sidebar().getByRole('button', { name: 'Restore Renamed on the phone' })).toBeVisible()

  // Delete the open chat: the next chat opens; then empty the Trash for good.
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await row('Garden layout ideas').focus()
  await page.keyboard.press('Delete')
  await expect(page).not.toHaveURL(new RegExp(`/s/${uidOf('Garden layout ideas')}$`))
  await page.getByRole('button', { name: 'Trash' }).click()
  await sidebar().getByRole('button', { name: 'Empty' }).click()
  const confirm = page.getByRole('dialog', { name: 'Empty the Trash?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete for good' }).click()
  await expect(sidebar().getByText('Trash is empty')).toBeVisible()
  const trash = await s.api<{ items: unknown[] }>('GET', '/api/sessions?filter=trash')
  expect(trash.json.items).toEqual([])
  expect((await s.api('GET', `/api/sessions/${uidOf('Garden layout ideas')}`)).status).toBe(404)

  // Archive from the menu, then bring it back from the Archived view.
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await row('Taxes 2025 — what to keep').hover()
  await sidebar().getByRole('button', { name: 'More for Taxes 2025 — what to keep' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(row('Taxes 2025 — what to keep')).toHaveCount(0)
  await expect.poll(async () => (await get(uidOf('Taxes 2025 — what to keep'))).archived).toBe(true)
  await page.getByRole('button', { name: 'Archived chats' }).click()
  await sidebar().getByRole('button', { name: 'Unarchive Taxes 2025 — what to keep' }).click()
  await expect.poll(async () => (await get(uidOf('Taxes 2025 — what to keep'))).archived).toBe(false)
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await expect(row('Taxes 2025 — what to keep')).toBeVisible()
})

test('sidebar: one tab stop, arrows/Home/End move, Enter opens @R6 @R22', async () => {
  await open(`/s/${uidOf('Spanish practice')}`)
  // The open chat is the list's tab stop.
  await expect(row('Spanish practice')).toHaveAttribute('tabindex', '0')
  expect(await sidebar().locator('.srow__link[tabindex="0"]').count()).toBe(1)
  await row('Spanish practice').focus()
  await page.keyboard.press('ArrowDown')
  await expect(row('Book notes: The Overstory')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(sidebar().locator('.srow__link').first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(sidebar().locator('.srow__link').last()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  const name = (await page.evaluate(() => document.activeElement?.textContent ?? '')).trim()
  await page.keyboard.press('Enter')
  await expect(page.locator('.shead__title')).toContainText(name.split(',')[0])
  // From the search box, ↓ enters the list.
  await sidebar().getByRole('searchbox', { name: /Search chats/ }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(sidebar().locator('.srow__link').first()).toBeFocused()
})

test('top bar: rename inline, copy ID, chips, voice toggle, game mode @R6 @R11', async () => {
  const uid = uidOf('Book notes: The Overstory')
  await open(`/s/${uid}`)
  await page.getByRole('button', { name: /Rename chat: Book notes/ }).click()
  const input = page.getByRole('textbox', { name: 'Chat title' })
  await input.fill('Book notes — The Overstory')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await get(uid)).title).toBe('Book notes — The Overstory')
  await expect(row('Book notes — The Overstory')).toBeVisible()
  seeded.byTitle['Book notes — The Overstory'] = seeded.byTitle['Book notes: The Overstory']

  // ID chip copies "#XXXXXX".
  await page.getByRole('button', { name: new RegExp(`Chat ID #${shortOf('Book notes: The Overstory')}`) }).click()
  await expect(page.locator('.toast').filter({ hasText: `Copied #${shortOf('Book notes: The Overstory')}` })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`#${shortOf('Book notes: The Overstory')}`)

  // Memory chip: keyword memory (Voyage is off by default, F37); it opens the panel's memory section.
  const mem = page.getByRole('button', { name: /^Keyword only\./ })
  await mem.click()
  await expect(page.getByRole('heading', { name: 'Memory', level: 3 })).toBeFocused()
  await page.getByRole('button', { name: 'Hide chat panel' }).click()

  // Model chip: pick a model the provider didn't list (free text) → this chat's override.
  await page.getByRole('button', { name: /^Model: mock-echo/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Model for this chat' })
  await expect(dialog).toBeVisible()
  const model = dialog.getByRole('combobox', { name: 'Model' })
  await model.fill('mock-thinker')
  await page.getByRole('option', { name: /Use “mock-thinker”/ }).click()
  await expect.poll(async () => (await get(uid)).model).toBe('mock-thinker')
  await expect(page.getByRole('button', { name: /^Model: mock-thinker/ })).toBeVisible()

  // Voice toggle without a voice provider explains and offers the setup.
  await page.getByRole('button', { name: 'Voice replies (set up a voice first)' }).click()
  await expect(page.locator('.toast').filter({ hasText: 'Voice replies need a voice provider.' })).toBeVisible()

  // Game mode pill (07 D3).
  await s.hook('nav.setGameMode', true, 'fullscreen')
  await expect(page.getByRole('status', { name: /^Game mode/ })).toBeVisible()
  await s.hook('nav.setGameMode', false)
  await expect(page.getByRole('status', { name: /^Game mode/ })).toHaveCount(0)
})

test('session panel: prompt + library, memory, scope, private, links both ways, info, continue @R8 @R11', async () => {
  const uid = uidOf('Debugging the borrow checker')
  await open(`/s/${uid}`)
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  const panel = page.locator('.shell__panel')

  // System prompt: edit and save (Ctrl+Enter), pick from the library, save to the library, clear.
  const prompt = panel.getByRole('textbox', { name: 'System prompt' })
  await prompt.fill('You are a Rust mentor. Explain lifetimes simply.')
  await page.keyboard.press('Control+Enter')
  await expect.poll(async () => (await get(uid)).systemPrompt).toBe('You are a Rust mentor. Explain lifetimes simply.')
  // The library is memory-ui's one PromptPicker, with "Manage the library" → /prompts.
  await panel.getByRole('button', { name: 'Library' }).click()
  await expect(page.getByRole('menuitem', { name: 'Manage the library' })).toBeVisible()
  await page.getByRole('menuitem', { name: /Gentle editor/ }).click()
  await expect.poll(async () => (await get(uid)).promptId).not.toBeNull()
  await expect(prompt).toHaveValue(/gentle, precise editor/)
  await expect(panel.getByText(/From the library: Gentle editor/)).toBeVisible()
  await prompt.fill('Answer like a calm pair programmer.')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await get(uid)).systemPrompt).toBe('Answer like a calm pair programmer.')
  await panel.getByRole('button', { name: 'Library' }).click()
  await page.getByRole('menuitem', { name: 'Save this prompt to the library…' }).click()
  const saveDlg = page.getByRole('dialog', { name: 'Save to the prompt library' })
  await saveDlg.getByRole('textbox', { name: 'Name' }).fill('Pair programmer')
  await saveDlg.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => ((await s.api<{ name: string }[]>('GET', '/api/prompts')).json.map((p) => p.name))).toContain('Pair programmer')
  // The chat is linked to the entry it was saved as.
  const saved = (await s.api<{ id: number; name: string }[]>('GET', '/api/prompts')).json.find((p) => p.name === 'Pair programmer')
  await expect.poll(async () => (await get(uid)).promptId).toBe(saved?.id)
  await panel.getByRole('button', { name: 'Clear' }).click()
  await expect.poll(async () => (await get(uid)).systemPrompt).toBe('')

  // Memory on, scope "All chats", private.
  await panel.getByRole('radio', { name: 'On', exact: true }).click({ force: true })
  await expect.poll(async () => (await get(uid)).memory).toBe('on')
  await panel.locator('label', { hasText: /^All chats/ }).first().click()
  await expect.poll(async () => (await get(uid)).memoryScope).toBe('all')
  await panel.getByRole('switch', { name: /Private chat/ }).click()
  await expect.poll(async () => (await get(uid)).private).toBe(true)
  await expect(page.getByRole('note', { name: /^Private chat/ })).toBeVisible()
  await panel.getByRole('switch', { name: /Private chat/ }).click()
  await expect.poll(async () => (await get(uid)).private).toBe(false)

  // Links: add by search, both ways, remove.
  await panel.locator('label', { hasText: /^This chat and linked chats/ }).first().click()
  const add = panel.getByRole('combobox', { name: 'Add a chat the AI can recall' })
  await add.fill('Taxes')
  await page.getByRole('option', { name: /Taxes 2025/ }).click()
  await expect.poll(async () => (await get(uid)).links.map((l) => l.shortId)).toContain(shortOf('Taxes 2025 — what to keep'))
  await panel.getByRole('button', { name: /One way: let Taxes 2025/ }).click()
  await expect.poll(async () => (await get(uidOf('Taxes 2025 — what to keep'))).links.map((l) => l.uid)).toContain(uid)
  await expect(panel.getByRole('button', { name: /Both ways: Taxes 2025/ })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: /Unlink Taxes 2025/ }).click()
  await expect.poll(async () => (await get(uid)).links).toEqual([])
  // Taxes still recalls this chat: shown as an incoming link.
  await expect(panel.getByRole('list', { name: 'Chats that can recall this one' })).toContainText('Taxes 2025 — what to keep')

  // Info: the ID, then continue in a new chat.
  await expect(panel.locator('.pinfo__id')).toContainText(`#${shortOf('Debugging the borrow checker')}`)
  await panel.getByRole('button', { name: 'Continue in a new chat' }).click()
  await expect(page).not.toHaveURL(new RegExp(`/s/${uid}$`))
  const newUid = new URL(page.url()).pathname.split('/').pop() ?? ''
  const cont = await get(newUid)
  expect(cont.meta.continuedFrom).toBe(uid)
  expect(cont.title).toBe('Debugging the borrow checker (cont.)')
  expect(cont.links.map((l) => l.uid)).toContain(uid)
  await expect(page.locator('.shead__title')).toContainText('(cont.)')
  await page.getByRole('button', { name: 'Hide chat panel' }).click()
})

test('slash commands through the Ctrl+K palette, with argument completion @R8 @R11', async () => {
  const uid = uidOf('Spanish practice')
  await open(`/s/${uid}`)

  // Completion: "/cont" lists /continue; Tab completes; session suggestions follow. ("/con" also matches presence's
  // /constellation, which sorts first, so the prefix has to be specific enough to make /continue the top option.)
  await palette('/cont')
  const list = page.getByRole('listbox', { name: 'Results' })
  await expect(list.getByRole('option', { name: /\/continue/ })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: /type \/ for commands/ })).toHaveValue('/continue ')
  await expect(list.getByRole('option', { name: /Planning the Lisbon trip/ })).toBeVisible()
  await page.keyboard.press('Escape')

  await runCommand('/title Práctica de español')
  await expect.poll(async () => (await get(uid)).title).toBe('Práctica de español')

  await runCommand(`/unlink #${shortOf('Morning journal')}`)
  await expect.poll(async () => (await get(uid)).links.map((l) => l.shortId)).not.toContain(shortOf('Morning journal'))
  await runCommand(`/link ${shortOf('Morning journal').toLowerCase()}`)
  await expect.poll(async () => (await get(uid)).links.map((l) => l.shortId)).toContain(shortOf('Morning journal'))

  await runCommand('/prompt Habla despacio.')
  await expect.poll(async () => (await get(uid)).systemPrompt).toBe('Habla despacio.')
  await runCommand('/prompt use Gentle editor')
  await expect.poll(async () => (await get(uid)).systemPrompt).toMatch(/gentle, precise editor/)
  await runCommand('/prompt save Spanish tutor')
  await expect.poll(async () => ((await s.api<{ name: string }[]>('GET', '/api/prompts')).json.map((p) => p.name))).toContain('Spanish tutor')
  await runCommand('/prompt clear')
  await expect.poll(async () => (await get(uid)).systemPrompt).toBe('')

  await runCommand('/memory on')
  await expect.poll(async () => (await get(uid)).memory).toBe('on')
  await runCommand('/memory default')
  await expect.poll(async () => (await get(uid)).memory).toBe('inherit')
  await runCommand('/private on')
  await expect.poll(async () => (await get(uid)).private).toBe(true)
  await runCommand('/private off')
  await expect.poll(async () => (await get(uid)).private).toBe(false)
  await runCommand('/model mock-fast')
  await expect.poll(async () => (await get(uid)).model).toBe('mock-fast')
  await runCommand('/model default')
  await expect.poll(async () => (await get(uid)).model).toBeNull()

  await runCommand('/id')
  await expect(page.locator('.toast').filter({ hasText: `Chat ID #${shortOf('Spanish practice')}` })).toBeVisible()

  await runCommand('/links')
  await expect(page.getByRole('heading', { name: 'AI can access', level: 3 })).toBeFocused()
  await page.getByRole('button', { name: 'Hide chat panel' }).click()

  await runCommand('/new Ideas for the weekend')
  await expect(page.locator('.shead__title')).toContainText('Ideas for the weekend')
  const created = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect((await get(created)).title).toBe('Ideas for the weekend')

  await runCommand(`/continue #${shortOf('Planning the Lisbon trip')}`)
  await expect(page.locator('.shead__title')).toContainText('Planning the Lisbon trip (cont.)')
  const cont = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect((await get(cont)).meta.continuedFrom).toBe(uidOf('Planning the Lisbon trip'))

  // An unknown command is said so, not sent.
  await runCommand('/frobnicate now')
  await expect(page.locator('.toast').filter({ hasText: 'isn\'t a command here' })).toBeVisible()
})

test('global search: words, filters, earlier versions marked, the hit opens the message @R7 @R10', async () => {
  await open('/search')
  await expect(page.getByRole('searchbox', { name: 'Search all messages' })).toBeFocused()
  await page.keyboard.type('pastel')
  await expect(page.locator('.shit')).toHaveCount(4)
  await expect(page).toHaveURL(/\/search\?q=pastel$/)
  await expect(page.locator('.shit mark').first()).toHaveText('pastel')

  await page.getByRole('radio', { name: 'You' }).check({ force: true })
  await expect(page.locator('.shit')).toHaveCount(2)
  await expect(page).toHaveURL(/role=user/)
  await page.getByRole('radio', { name: 'Anyone' }).check({ force: true })
  await expect(page.locator('.shit')).toHaveCount(4)

  // One chat only.
  const chat = page.getByRole('combobox', { name: 'Chat' })
  await chat.fill('Planning')
  await page.getByRole('option').filter({ hasText: 'Planning the Lisbon trip' }).filter({ hasNotText: '(cont.)' }).click()
  await expect(page.locator('.shit')).toHaveCount(2)
  await expect(page).toHaveURL(new RegExp(`session=${uidOf('Planning the Lisbon trip')}`))

  // Opening a hit goes to the chat at that message (chat-ui reads ?m=).
  const first = page.locator('.shit__link').first()
  const href = await first.getAttribute('href')
  expect(href).toMatch(new RegExp(`^/s/${uidOf('Planning the Lisbon trip')}\\?m=`))
  // chat-ui consumes ?m= as soon as the chat is ready (it replaces the URL), so the URL may already be bare: assert the
  // chat and the message instead.
  const messageUid = decodeURIComponent(new URL(href ?? '', 'http://x').searchParams.get('m') ?? '')
  await first.click()
  await expect(page).toHaveURL(new RegExp(`/s/${uidOf('Planning the Lisbon trip')}(\\?m=.*)?$`))
  await expect(page.locator(`article[data-uid="${messageUid}"]`)).toBeInViewport()

  // No results, and back to the empty state.
  await open('/search?q=zzzqqq')
  await expect(page.getByRole('heading', { name: 'No messages match “zzzqqq”' })).toBeVisible()
  // The sidebar's search offers the message search.
  await sidebar().getByRole('searchbox', { name: /Search chats/ }).fill('sintra')
  await sidebar().getByRole('link', { name: /Search messages for “sintra”/ }).click()
  await expect(page).toHaveURL(/\/search\?q=sintra$/)
  await expect(page.locator('.shit')).toHaveCount(2)
  await sidebar().getByRole('searchbox', { name: /Search chats/ }).fill('')
})

test('keyboard: palette navigation, shortcuts sheet, new chat, next chat, panel toggle @R6 @R22', async () => {
  await open(`/s/${uidOf('Planning the Lisbon trip')}`)
  await palette('morning')
  await expect(page.getByRole('option', { name: /Morning journal/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/s/${uidOf('Morning journal')}$`))
  // Settings sections are in the palette too.
  await palette('privacy')
  await expect(page.getByRole('option', { name: /^Privacy/ })).toBeVisible()
  await page.keyboard.press('Escape')
  // Presence actions: Talk mode for the open chat, and pausing the Star on this device (and back).
  await palette('talk mode')
  await expect(page.getByRole('option', { name: /^Talk mode/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await palette('pause the star')
  await expect(page.getByRole('option', { name: /^Pause the Star/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vesper.starPaused'))).toBe('true')
  await palette('star')
  await expect(page.getByRole('option', { name: /^Resume the Star/ })).toBeVisible()
  await page.getByRole('option', { name: /^Resume the Star/ }).click()
  await palette('star')
  await expect(page.getByRole('option', { name: /^Pause the Star/ })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('vesper.starPaused'))).toBeNull()
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+/')
  const help = page.getByRole('dialog', { name: 'Keyboard & commands' })
  await expect(help).toBeVisible()
  await expect(help.getByText('Command palette')).toBeVisible()
  await help.getByRole('radio', { name: 'Slash commands' }).check({ force: true })
  for (const c of ['/continue', '/link', '/unlink', '/links', '/prompt', '/private', '/memory', '/title', '/id', '/temp', '/model', '/voice', '/new']) {
    await expect(help.getByText(new RegExp(`^${c.replace('/', '\\/')}( |$)`))).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  // "?" outside a text field opens it too.
  await page.locator('body').click({ position: { x: 700, y: 400 } })
  await page.keyboard.press('Shift+?')
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')

  const before = new URL(page.url()).pathname
  await page.keyboard.press('Alt+Shift+ArrowDown')
  await expect(page).not.toHaveURL(new RegExp(`${before}$`))
  await page.keyboard.press('Control+.')
  await expect(page.locator('.shell__panel')).toHaveAttribute('data-open', 'true')
  await page.keyboard.press('Control+.')
  await expect(page.locator('.shell__panel')).not.toHaveAttribute('data-open', 'true')
  await page.keyboard.press('Control+Shift+O')
  await expect(page.locator('.shead__title')).toContainText('New chat')
  await page.keyboard.press('Control+Shift+S')
  await expect(page.locator('.shell')).not.toHaveClass(/has-sidebar/)
  await page.keyboard.press('Control+Shift+S')
  await expect(page.locator('.shell')).toHaveClass(/has-sidebar/)
})

test('long lists are windowed and page in as you scroll @R6 @R5', async () => {
  const r = await s.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 400, messagesPerSession: 0 })
  expect(r.status).toBe(200)
  await page.reload()
  await s.waitReady()
  await open(`/s/${uidOf('Planning the Lisbon trip')}`)
  const list = sidebar().locator('.slist')
  await expect(list).toHaveAttribute('data-virtual', 'true')
  const rendered = await s.hook<number>('nav.sidebarRows')
  expect(rendered).toBeGreaterThan(10)
  expect(rendered).toBeLessThan(80)
  const loaded = await page.evaluate(() => (window as unknown as { __vesperTest: { store: { state(): { sessions: { items: unknown[] } } } } }).__vesperTest.store.state().sessions.items.length)
  // Scroll to the end: more pages arrive, the DOM stays bounded.
  for (let i = 0; i < 6; i++) {
    await sidebar().locator('.sidebar__list').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page.waitForTimeout(250)
  }
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __vesperTest: { store: { state(): { sessions: { items: unknown[] } } } } }).__vesperTest.store.state().sessions.items.length)).toBeGreaterThan(loaded)
  expect(await s.hook<number>('nav.sidebarRows')).toBeLessThan(80)
  // The focused row survives being scrolled far out of view.
  await sidebar().locator('.sidebar__list').evaluate((el) => (el.scrollTop = 0))
  await page.waitForTimeout(100)
  await sidebar().locator('.srow__link').first().focus()
  await sidebar().locator('.sidebar__list').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => document.activeElement?.classList.contains('srow__link'))).toBe(true)
})

test('phone layout: sheets, swipe to close, 44 px targets, safe areas @R6 @R22', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(`/s/${uidOf('Planning the Lisbon trip')}`)
  await expect(page.locator('.shell')).toHaveClass(/shell--phone/)
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Chats' })
  await expect(sheet).toBeVisible()
  // Every target in the sheet is at least 44 px tall (07 D8).
  const small = await sheet.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('a, button, input'))
      .filter((x) => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden' && !x.closest('.srow__more'))
      .map((x) => ({ h: x.getBoundingClientRect().height, name: x.getAttribute('aria-label') ?? x.textContent?.trim() }))
      .filter((x) => x.h < 43.5)
  )
  expect(small).toEqual([])
  // Swipe toward the edge closes it.
  await swipe(page, '.edge-sheet__panel', -160)
  await expect(sheet).toBeHidden()
  // Opening a chat from the sheet closes it.
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await row('Groceries for the week').click()
  await expect(sheet).toBeHidden()
  await expect(page.locator('.shead__title')).toContainText('Groceries for the week')
  // The panel is a sheet from the right; Esc closes it and focus returns to its button.
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  const panel = page.getByRole('dialog', { name: 'Chat panel' })
  await expect(panel).toBeVisible()
  await swipe(page, '.edge-sheet--end .edge-sheet__panel', 160)
  await expect(panel).toBeHidden()
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show chat panel' })).toBeFocused()
  await page.setViewportSize({ width: 1440, height: 900 })
})

async function swipe(p: Page, selector: string, dx: number): Promise<void> {
  await p.locator(selector).evaluate((el, d) => {
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    const x0 = d < 0 ? r.right - 40 : r.left + 40
    const ev = (type: string, x: number): PointerEvent => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true })
    el.dispatchEvent(ev('pointerdown', x0))
    for (let i = 1; i <= 8; i++) el.dispatchEvent(ev('pointermove', x0 + (d * i) / 8))
    el.dispatchEvent(ev('pointerup', x0 + d))
  }, dx)
}

test('axe: no serious or critical issues on every screen and dialog, dark and light @R22', async () => {
  for (const theme of ['dark', 'light'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(`/s/${uidOf('Spanish practice')}`)
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await axe(page, `${theme} chat`)
    await page.getByRole('button', { name: 'Show chat panel' }).click()
    await expect(page.locator('.psec').first()).toBeVisible()
    await axe(page, `${theme} chat + panel`)
    await page.getByRole('button', { name: /^Model: / }).click()
    await expect(page.locator('.popover')).toBeVisible()
    await axe(page, `${theme} model popover`, '.popover')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Hide chat panel' }).click()
    await palette('/')
    await expect(page.locator('.palette__item').first()).toBeVisible()
    await axe(page, `${theme} palette`, '.palette')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+/')
    await expect(page.getByRole('dialog', { name: 'Keyboard & commands' })).toBeVisible()
    await axe(page, `${theme} shortcuts`, '.dialog')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Trash' }).click()
    // Exact: once the (empty) Trash has loaded it also shows a "Trash is empty" heading. Axe runs on the loaded view.
    await expect(sidebar().getByRole('heading', { name: 'Trash', exact: true })).toBeVisible()
    await expect(sidebar().locator('.sbin__list')).not.toHaveAttribute('aria-busy', 'true')
    await axe(page, `${theme} trash`)
    await page.getByRole('button', { name: 'Back to chats' }).click()
    await row('Planning the Lisbon trip').hover()
    await sidebar().getByRole('button', { name: /^More for Planning the Lisbon trip/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await axe(page, `${theme} row menu`, '[role="menu"]')
    await page.keyboard.press('Escape')
    await open('/search?q=pastel')
    await expect(page.locator('.shit').first()).toBeVisible()
    await axe(page, `${theme} search`)
    await open('/search')
    await axe(page, `${theme} search empty`)
    await page.setViewportSize({ width: 390, height: 844 })
    await open(`/s/${uidOf('Spanish practice')}`)
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Chats' })).toBeVisible()
    await axe(page, `${theme} phone sidebar sheet`, '.edge-sheet')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Show chat panel' }).click()
    await expect(page.locator('.psec').first()).toBeVisible()
    await axe(page, `${theme} phone panel sheet`, '.edge-sheet')
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
})

test('voice: per-device on/off in the top bar and /voice, the chat’s voice and voice model from the provider lists @R12 @R11', async () => {
  const desk = await s.login('desktop')
  expect((await desk.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', autoSpeak: true } } })).status).toBe(200)
  expect((await desk.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const uid = uidOf('Morning journal')
  await open(`/s/${uid}`)
  // On by default (voice.tts.autoSpeak); the toggle turns it off for this device only.
  const on = page.getByRole('button', { name: 'Voice replies on' })
  await expect(on).toHaveAttribute('aria-pressed', 'true')
  await on.click()
  await expect(page.getByRole('button', { name: 'Voice replies off' })).toHaveAttribute('aria-pressed', 'false')
  // Per device: kept in this browser's voice prefs (one switch since the Phase 3 merge), not in the account settings.
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('vesper.device.voice.v1') ?? '{}') as { autoSpeak?: boolean }).autoSpeak)).toBe(false)
  expect((await s.api<{ voice: { tts: { autoSpeak: boolean } } }>('GET', '/api/settings')).json.voice.tts.autoSpeak).toBe(true)
  await runCommand('/voice on')
  await expect(page.getByRole('button', { name: 'Voice replies on' })).toBeVisible()

  // This chat's voice: from the provider's list, then a voice model, then back to the default.
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  const panel = page.locator('.shell__panel')
  await expect(panel.getByRole('switch', { name: /Speak replies on this device/ })).toHaveAttribute('aria-checked', 'true')
  const voice = panel.getByRole('combobox', { name: /Voice for this chat/ })
  await expect(voice).toHaveValue(/Default \(Aria \(mock\)\)/)
  await voice.click()
  await page.getByRole('option', { name: /^Rowan \(mock\)/ }).click()
  await expect.poll(async () => (await s.api<{ voice: { voiceId: string } | null }>('GET', `/api/sessions/${uid}`)).json.voice?.voiceId).toBe('mock-rowan')
  await panel.getByRole('combobox', { name: 'Voice model' }).click()
  await page.getByRole('option', { name: /Eleven Flash v2\.5/ }).click()
  await expect.poll(async () => (await s.api<{ voice: { model?: string } | null }>('GET', `/api/sessions/${uid}`)).json.voice?.model).toBe('eleven_flash_v2_5')
  await page.screenshot({ path: shotPath('voice-panel-dark'), animations: 'disabled', caret: 'hide' })
  await panel.getByRole('button', { name: 'Use the default voice' }).click()
  await expect.poll(async () => (await s.api<{ voice: unknown }>('GET', `/api/sessions/${uid}`)).json.voice).toBeNull()
  await page.getByRole('button', { name: 'Hide chat panel' }).click()

  // /voice <name> picks a voice for this chat; completion lists the provider's voices.
  await palette('/voice ')
  await expect(page.getByRole('option', { name: /My cloned voice \(mock\)/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await runCommand('/voice rowan')
  await expect.poll(async () => (await s.api<{ voice: { voiceId: string } | null }>('GET', `/api/sessions/${uid}`)).json.voice?.voiceId).toBe('mock-rowan')
  await runCommand('/voice default')
  await expect.poll(async () => (await s.api<{ voice: unknown }>('GET', `/api/sessions/${uid}`)).json.voice).toBeNull()
  // Leave voice output off again for the tests that follow.
  await desk.api('PATCH', '/api/settings', { voice: { tts: { enabled: false } } })
})

test('export this chat: a device without sudo is told why; the desktop downloads Markdown @R6 @R18', async () => {
  await open(`/s/${uidOf('Planning the Lisbon trip')}`)
  await page.getByRole('button', { name: 'Show chat panel' }).click()
  await page.getByRole('button', { name: 'Export Markdown' }).click()
  await expect(page.locator('.toast').filter({ hasText: 'Exporting needs your password on this device' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide chat panel' }).click()

  // A desktop-class device (sudo) gets the file.
  const desk = await launchServer({ mock, login: 'desktop' })
  try {
    const st = await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'Notes: export/test?' })
    await desk.hook('go', `/s/${st.json.uid}`)
    await desk.waitReady()
    await wsTurnIn(desk, st.json.uid)
    await desk.page.getByRole('button', { name: 'Show chat panel' }).click()
    const download = desk.page.waitForEvent('download')
    await desk.page.getByRole('button', { name: 'Export Markdown' }).click()
    const d = await download
    expect(d.suggestedFilename()).toBe('Notes export test.md')
    const text = await streamText(await d.createReadStream())
    expect(text).toContain('Export me, please')
    await desk.assertNoErrors()
  } finally {
    await desk.close()
  }
})

async function wsTurnIn(t: TestServer, uid: string): Promise<void> {
  // The context is already the desktop device (a second desktop sign-in would end the first one's session).
  await configureMockLlm(t.api, mock.url)
  await wsTurn(t.page, uid, 'Export me, please')
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
  return out
}

test('leaks: 20 open/close cycles of every overlay return the counters to baseline @R17', async () => {
  await open(`/s/${uidOf('Spanish practice')}`)
  await page.waitForTimeout(300)
  const base = await navStats()
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.type('/pro')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+/')
    await expect(page.getByRole('dialog', { name: 'Keyboard & commands' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+.')
    await expect(page.locator('.psec').first()).toBeVisible()
    await page.keyboard.press('Control+.')
    await row('Planning the Lisbon trip').hover()
    await sidebar().getByRole('button', { name: /^More for Planning the Lisbon trip/ }).click()
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Chats' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Chats' })).toBeHidden()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)
  const after = await navStats()
  for (const k of ['kit.layers', 'kit.docListeners', 'kit.timers', 'kit.observers', 'kit.frames', 'layers', 'nav.timers', 'nav.windowListeners', 'shortcuts.installed', 'cache.promptListeners']) {
    expect(after[k] ?? 0, k).toBe(base[k] ?? 0)
  }
  expect(after['cache.models'] ?? 0).toBeLessThanOrEqual(2)
})
