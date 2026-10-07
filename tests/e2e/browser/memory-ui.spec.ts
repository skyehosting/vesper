/**
 * memory-ui end to end (standalone server + headless Chromium as the DESKTOP device, mock LLM + mock Voyage):
 * Settings → Memory (key, test, backfill consent, status, privacy text), the memory viewer (tagged timeline with machine
 * timestamps, filters, search, forget, links both ways, pinned facts, protocols editor with live warnings, diff and
 * reset), the prompt library (create → use in a chat), Settings → Privacy, Settings → Data (export download, ChatGPT
 * import with preview, backup now), wizard step 3, axe (0 serious/critical) on every screen and dialog, keyboard use,
 * the phone layout, and a leak check (listeners/stores/object URLs/workers back to baseline after 5 page cycles).
 * @R3 @R7 @R8 @R9 @R11 @R16 @R20 @R21 @R22
 */
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { ROOT, type TestServer } from '../launch'
import { createSession } from '../helpers'
import { expectAxeClean, go, launchDesktopBrowser, makeHistory, type History } from '../memoryUi'

let mock: MockServer
let s: TestServer
let h: History

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(180_000)
  mock = await startMockServer()
  s = await launchDesktopBrowser(mock)
  // Fast Voyage limits for the test (the free-trial pace is covered by memory's own tests).
  expect((await s.api('PATCH', '/api/settings', { memory: { voyage: { tier: 'tier1' } } })).status).toBe(200)
  h = await makeHistory(s)
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})
test.afterEach(async () => {
  await s.assertNoErrors()
})

interface Status {
  state: string
  indexed: number
  queued: number
}

async function status(): Promise<Status> {
  return (await s.api<Status>('GET', '/api/memory/status')).json
}

function page(): Page {
  return s.page
}

test('Settings → Memory: key, test, backfill consent, status and the exact privacy note @R7 @R21', async () => {
  const p = page()
  await go(s, '/settings/memory')
  // Off: the keyword-only explanation and the privacy note with the "$5" correction (07 A1).
  await expect(p.getByText('Keyword memory is always on')).toBeVisible()
  const note = p.getByTestId('voyage-privacy')
  await expect(note).toContainText('Your memory stays on this PC')
  await expect(note).toContainText('There is no $5 minimum')
  await expect(note).toContainText('Adding a payment method — no purchase needed — is what makes the opt-out switch available')
  await expect(note).toContainText('Paying alone doesn’t opt you out')
  await expect(note).toContainText('Opting out only covers text sent afterwards')
  await expect(note).toContainText('Voyage may cancel your free tokens')
  await expect(note.getByRole('link', { name: /legal@voyageai\.com/ })).toHaveAttribute('href', 'mailto:legal@voyageai.com')
  await expect(note.getByRole('link', { name: /voyageai\.com terms/ })).toHaveAttribute('href', 'https://www.voyageai.com/tos')
  await expectAxeClean(p, 'settings-memory (off)')

  // A wrong-shaped key is refused in the field; a good one saves and the automatic test reports success.
  const key = p.getByLabel('Voyage AI API key')
  await key.fill('short')
  await key.press('Enter')
  await expect(p.getByText('That looks too short for a Voyage AI key.')).toBeVisible()
  await key.fill('pa-e2e-memory-ui-key')
  await key.press('Enter')
  await expect(p.getByTestId('voyage-test-result')).toContainText('Connected')
  expect((await s.api<{ secretsSet: string[] }>('GET', '/api/bootstrap')).json.secretsSet).toContain('voyage')

  // Turning memory on with history asks first (07 C12).
  await p.getByRole('switch', { name: /Remember with Voyage AI/ }).click()
  const dialog = p.getByRole('dialog', { name: /Index \d+ messages from \d+ chats\?/ })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Private and temporary chats are never sent')
  await expectAxeClean(p, 'backfill dialog')
  expect(await status()).toMatchObject({ indexed: 0 })
  await dialog.getByRole('button', { name: 'Start indexing' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await status()).indexed, { timeout: 30_000 }).toBeGreaterThanOrEqual(6)
  await expect(p.getByRole('definition').filter({ hasText: /^6$/ }).first()).toBeVisible({ timeout: 10_000 })
  await expect(p.getByTestId('memory-state')).toHaveAttribute('data-state', 'ready')
  await expectAxeClean(p, 'settings-memory (on)')
})

test('memory viewer timeline: tags, machine time, session ids, filters, search, forget @R7 @R10', async () => {
  const p = page()
  await go(s, '/memory')
  const entries = p.getByTestId('memory-entry')
  await expect(entries).toHaveCount(6)
  const first = entries.first()
  await expect(first).toContainText('ai response')
  await expect(first).toContainText(/\w{3} \d{1,2} \w{3} \d{4} \d{2}:\d{2} \(UTC[+−]\d{2}:\d{2}\)/)
  await expect(first).toContainText(`#${(await s.api<{ shortId: string }>('GET', `/api/sessions/${h.garden.uid}`)).json.shortId}`)
  await expectAxeClean(p, 'memory timeline')

  // Who said it.
  await p.getByRole('radio', { name: 'You' }).click()
  await expect(entries).toHaveCount(3)
  await expect(entries.first()).toContainText('user response')
  await p.getByRole('radio', { name: 'Everyone' }).click()

  // Search by words (highlighted), then by meaning (Voyage mock).
  await p.getByRole('searchbox', { name: 'Search memory' }).fill('castle')
  await expect(entries.first().locator('mark')).toHaveText('castle')
  expect(new URL(p.url()).searchParams.get('q')).toBe('castle')
  await p.getByRole('radio', { name: 'Meaning' }).click()
  await expect(entries.first()).toContainText('castle')
  await p.getByRole('button', { name: 'Clear all' }).click()
  await expect(entries).toHaveCount(6)

  // Forget one message (07 B9 wording), with confirm; it disappears here and from search.
  const target = entries.filter({ hasText: 'My basil keeps wilting' }).filter({ hasText: 'user response' })
  await target.getByRole('button', { name: 'Forget this message' }).click()
  const confirm = p.getByRole('dialog', { name: 'Forget this message?' })
  await expect(confirm).toContainText('until the conversation is condensed')
  await expectAxeClean(p, 'forget dialog')
  await confirm.getByRole('button', { name: 'Forget' }).click()
  await expect(entries).toHaveCount(5)
  const hits = await s.api<{ items: unknown[] }>('GET', '/api/search?q=basil%20wilting')
  expect(hits.json.items.filter((x) => JSON.stringify(x).includes('"user response"'))).toHaveLength(0)
})

test('chats & links: manifest views, export, link both ways and unlink @R7 @R8', async () => {
  const p = page()
  await go(s, '/memory/sessions')
  const trip = p.getByTestId('manifest-session').filter({ hasText: 'Lisbon trip' })
  const garden = p.getByTestId('manifest-session').filter({ hasText: 'Balcony garden' })
  await expect(trip).toContainText('Can recall')
  await expectAxeClean(p, 'chats & links')

  await trip.getByRole('button', { name: 'Link a chat' }).click()
  await trip.getByRole('combobox', { name: /may recall/ }).fill('Balcony')
  await p.getByRole('option', { name: /Balcony garden/ }).click()
  await trip.getByRole('checkbox', { name: 'Both ways' }).check()
  await trip.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(trip.getByRole('button', { name: /Stop #\w+ recalling #\w+/ }).first()).toBeVisible()
  await expect(garden.locator('.mses__linkrow').first()).toContainText('Lisbon trip')
  const t = (await s.api<{ links: { shortId: string }[]; linkedFrom: { shortId: string }[] }>('GET', `/api/sessions/${h.trip.uid}`)).json
  expect(t.links).toHaveLength(1)
  expect(t.linkedFrom).toHaveLength(1)

  // The AI's view and the JSON view; export downloads manifest.json.
  await p.getByRole('radio', { name: 'As the AI sees it' }).click()
  await expect(p.getByLabel('Manifest text the AI sees')).toContainText('conversations you may access')
  await p.getByRole('radio', { name: 'JSON' }).click()
  await expect(p.getByLabel('Manifest as JSON')).toContainText('"format": "vesper-manifest"')
  const dl = p.waitForEvent('download')
  await p.getByRole('button', { name: 'Export' }).click()
  expect((await dl).suggestedFilename()).toBe('manifest.json')
  await p.getByRole('radio', { name: 'Chats' }).click()

  // Unlink one direction from the "Recalled by" side.
  await garden.locator('.mses__linkrow').nth(1).getByRole('button', { name: /Stop/ }).click()
  await expect.poll(async () => (await s.api<{ links: unknown[] }>('GET', `/api/sessions/${h.trip.uid}`)).json.links.length).toBe(0)
})

test('about you: add, edit, remove a pinned fact; /remember lands here @R7', async () => {
  const p = page()
  await go(s, '/memory/about')
  await expect(p.getByText('Nothing pinned yet')).toBeVisible()
  await p.getByRole('textbox', { name: 'New fact' }).fill('Prefers trams to taxis')
  await p.getByRole('button', { name: 'Add' }).click()
  await expect(p.getByTestId('fact')).toHaveCount(1)
  await p.getByRole('button', { name: /Edit “Prefers trams/ }).click()
  await p.getByRole('textbox', { name: 'Edit fact' }).fill('Prefers trams and ferries to taxis')
  await p.getByRole('textbox', { name: 'Edit fact' }).press('Enter')
  await expect(p.getByTestId('fact')).toHaveText(/trams and ferries/)
  await expectAxeClean(p, 'about you')
  expect((await s.api<{ text: string }[]>('GET', '/api/facts')).json.map((f) => f.text)).toEqual(['Prefers trams and ferries to taxis'])
  await p.getByRole('button', { name: /Remove “Prefers trams/ }).click()
  await expect(p.getByTestId('fact')).toHaveCount(0)

  // /remember (the composer calls the same registry) lands here.
  expect(await s.hook('memoryUi.runCommand', '/remember Has a cat called Miso', null)).toBe(true)
  await go(s, '/memory/timeline')
  await go(s, '/memory/about')
  await expect(p.getByTestId('fact')).toHaveText(/cat called Miso/)
  // /memory off for one chat, then status.
  expect(await s.hook('memoryUi.runCommand', '/memory off', h.garden.uid)).toBe(true)
  expect((await s.api<{ memory: string }>('GET', `/api/sessions/${h.garden.uid}`)).json.memory).toBe('off')
  expect(await s.hook('memoryUi.runCommand', '/memory on', h.garden.uid)).toBe(true)
  expect((await s.api<{ memory: string }>('GET', `/api/sessions/${h.garden.uid}`)).json.memory).toBe('on')
})

test('protocols: live warnings, save, diff vs default, apply note, reset @R9', async () => {
  const p = page()
  await go(s, '/memory/protocols')
  const editor = p.getByTestId('protocols-editor')
  await expect(p.getByText('No problems found.')).toBeVisible()
  await editor.focus()
  await p.keyboard.press('Control+End')
  await p.keyboard.type('\nAlways call me {{nickname}}.')
  await expect(p.getByTestId('protocol-warnings')).toContainText('Unknown placeholder {{nickname}}')
  await expectAxeClean(p, 'protocols (editing)')
  await p.keyboard.press('Control+s')
  await expect(p.getByText('Protocols saved.')).toBeVisible()
  const saved = (await s.api<{ isDefault: boolean; warnings: string[]; text: string }>('GET', '/api/protocols')).json
  expect(saved.isDefault).toBe(false)
  expect(saved.warnings[0]).toContain('{{nickname}}')
  expect(saved.text.endsWith('Always call me {{nickname}}.')).toBe(true)
  await expect(p.getByText('Apply to a chat now', { exact: false }).first()).toBeAttached()

  await p.getByRole('radio', { name: 'Changes from default' }).click()
  await expect(p.getByTestId('protocols-diff')).toContainText('Always call me {{nickname}}.')
  await expect(p.getByTestId('protocols-diff')).toContainText('+1')
  await expectAxeClean(p, 'protocols (diff)')

  await p.getByRole('button', { name: 'Reset to default' }).click()
  await p.getByRole('dialog').getByRole('button', { name: 'Reset to default' }).click()
  await expect(p.getByTestId('protocols-diff')).toContainText('Same as the default')
  expect((await s.api<{ isDefault: boolean }>('GET', '/api/protocols')).json.isDefault).toBe(true)
})

test('prompt library: create from a starter, save, use in a chat, delete @R11', async () => {
  const p = page()
  await go(s, '/prompts')
  await expect(p.getByText('No saved prompts yet')).toBeVisible()
  await expectAxeClean(p, 'prompts (empty)')
  await p.getByRole('button', { name: 'Writing coach' }).click()
  await expect(p.getByRole('textbox', { name: 'Name' })).toHaveValue('Writing coach')
  await p.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(p.getByText('Saved “Writing coach”.')).toBeVisible()
  const list = (await s.api<{ id: number; name: string }[]>('GET', '/api/prompts')).json
  expect(list.map((x) => x.name)).toEqual(['Writing coach'])

  await p.getByRole('combobox', { name: 'Use in a chat' }).fill('Lisbon')
  await p.getByRole('option', { name: /Lisbon trip/ }).click()
  await p.getByRole('button', { name: 'Use', exact: true }).click()
  await expect
    .poll(async () => (await s.api<{ promptId: number | null; systemPrompt: string }>('GET', `/api/sessions/${h.trip.uid}`)).json.promptId)
    .toBe(list[0].id)
  await expectAxeClean(p, 'prompts (editor)')

  await p.getByRole('button', { name: 'Delete this prompt' }).click()
  await p.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(p.getByText('No saved prompts yet')).toBeVisible()
  // The session panel's picker (sessions-ui embeds it): save the chat's prompt to the library, then apply it.
  await go(s, `/test/memory-ui/picker?session=${h.garden.uid}`)
  await p.getByRole('button', { name: 'Library' }).click()
  await p.getByRole('menuitem', { name: 'Save this prompt to the library…' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: 'Name' }).fill('Brief')
  await p.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(p.getByText('Saved to the library as “Brief”.')).toBeVisible()
  await p.getByRole('button', { name: 'Library' }).click()
  await p.getByRole('menuitem', { name: /Brief/ }).click()
  await expect.poll(async () => (await s.api<{ systemPrompt: string }>('GET', `/api/sessions/${h.garden.uid}`)).json.systemPrompt).toBe('Be brief and kind.')
  await s.api('DELETE', `/api/prompts/${(await s.api<{ id: number }[]>('GET', '/api/prompts')).json[0].id}`)
  // The chat keeps its own copy of the text.
  expect((await s.api<{ systemPrompt: string }>('GET', `/api/sessions/${h.trip.uid}`)).json.systemPrompt).toContain('writing coach')
})

test('Settings → Privacy: services in use, leaves-this-PC badges, previews switch, data paths @R21', async () => {
  const p = page()
  await go(s, '/settings/privacy')
  const voyage = p.locator('[data-testid="privacy-service"][data-service="voyage"]')
  await expect(voyage).toContainText('Voyage AI (MongoDB)')
  await expect(voyage.getByRole('note', { name: /Leaves this PC/ })).toBeVisible()
  await expect(voyage).toContainText('There is no $5 minimum')
  // The mock AI runs at a custom 127.0.0.1 address: local text plus research 08's forwarding caveat (F19).
  const localAi = p.locator('[data-testid="privacy-service"][data-service="llm.local-custom"]')
  await expect(localAi).toContainText('On this PC, unless the program forwards it')
  await expect(localAi).not.toContainText('Stays on this PC')
  await expect(localAi).toContainText('unless that program forwards requests online')
  const previews = p.getByRole('switch', { name: 'Show message text in notifications' })
  await expect(previews).toHaveAttribute('aria-checked', 'false')
  await previews.click()
  await expect.poll(async () => (await s.api<{ chat: { notificationPreviews: boolean } }>('GET', '/api/settings')).json.chat.notificationPreviews).toBe(true)
  await previews.click()
  await expect(p.getByText('Settings, chats, memory, backups')).toBeVisible()
  await p.getByText(/Other services Vesper can use/).click()
  await expect(p.locator('.pothers__name').filter({ hasText: 'Deepgram' })).toBeVisible()
  await expectAxeClean(p, 'settings-privacy')
})

test('Settings → Data: storage, export download, ChatGPT import with preview, backup now @R16 @R20', async () => {
  const p = page()
  await go(s, '/settings/data')
  await expect(p.getByTestId('data-usage')).toContainText('Chats & memory')
  await expectAxeClean(p, 'settings-data')

  const dl = p.waitForEvent('download')
  await p.getByRole('button', { name: 'Export all' }).click()
  const file = await dl
  expect(file.suggestedFilename()).toMatch(/\.zip$/)

  await p.locator('input[type=file]').setInputFiles(path.join(ROOT, 'tests/fixtures/import/chatgpt-conversations.json'))
  const preview = p.getByTestId('import-preview')
  await expect(preview).toContainText('Import 2 conversations (~6 messages) from ChatGPT')
  await expectAxeClean(p, 'import preview')
  await preview.getByRole('button', { name: 'Import' }).click()
  const result = p.getByTestId('import-result')
  await expect(result).toContainText('Imported 2 conversations from ChatGPT')
  await expect(result).toContainText('6 messages')
  await expect(result).toContainText('1 conversation skipped')

  await p.getByRole('button', { name: 'Back up now' }).click()
  await expect(p.getByText(/Backed up \(/)).toBeVisible()
  await expect(p.getByRole('list', { name: 'Backups' }).getByRole('listitem')).toHaveCount(1)

  // Imported chats are marked in the manifest.
  await go(s, '/memory/sessions')
  await expect(p.getByTestId('manifest-session').filter({ hasText: 'Trip to Lisbon' })).toContainText('Imported from ChatGPT')
  // ... and in the sidebar (SessionSummary.imported): a badge with its source, named for screen readers.
  const row = p.locator('.srow').filter({ hasText: 'Trip to Lisbon' })
  await expect(row.locator('.srow__imported')).toHaveAttribute('title', 'Imported from ChatGPT')
  await expect(row.locator('.srow__link')).toContainText('imported from chatgpt')
})

test('wizard step 3 renders, saves per step and passes axe @R3 @R21', async () => {
  const p = page()
  await go(s, '/test/memory-ui/wizard')
  const step = p.getByTestId('wizard-memory')
  await expect(step).toContainText('Memory')
  await expect(step.getByTestId('voyage-privacy')).toContainText('There is no $5 minimum')
  await expect(step.getByRole('radio', { name: /This chat and the chats you link to it/ })).toBeChecked()
  await step.getByRole('radio', { name: /Every chat/ }).check()
  await expect.poll(async () => (await s.api<{ memory: { scopeDefault: string } }>('GET', '/api/settings')).json.memory.scopeDefault).toBe('all')
  await step.getByRole('radio', { name: /This chat and the chats you link to it/ }).check()
  await expectAxeClean(p, 'wizard memory')
})

test('keyboard only: tabs, filters and an entry action are reachable and named @R22', async () => {
  const p = page()
  await go(s, '/memory')
  await p.getByRole('tab', { name: 'Timeline' }).focus()
  await p.keyboard.press('ArrowRight')
  await expect(p).toHaveURL(/\/memory\/sessions$/)
  await p.keyboard.press('ArrowRight')
  await expect(p).toHaveURL(/\/memory\/about$/)
  await p.keyboard.press('ArrowLeft')
  await p.keyboard.press('ArrowLeft')
  await expect(p).toHaveURL(/\/memory(\?.*)?$/)
  // Tab from the search box reaches the mode switch, then the filters, then an entry's named actions.
  await p.getByRole('searchbox', { name: 'Search memory' }).focus()
  await p.keyboard.press('Tab')
  expect(await p.evaluate(() => !!document.activeElement?.closest('[aria-label="Search by"]'))).toBe(true)
  let reached: string | null = null
  for (let i = 0; i < 30 && !reached; i++) {
    await p.keyboard.press('Tab')
    reached = await p.evaluate(() => {
      const el = document.activeElement
      return el?.closest('[data-testid="memory-entry"]') ? (el.getAttribute('aria-label') ?? el.textContent ?? '') : null
    })
  }
  expect(reached).toBeTruthy()
})

test('phone 390×844: filter sheet, 44 px targets, no horizontal overflow @R22', async () => {
  const p = page()
  await p.setViewportSize({ width: 390, height: 844 })
  try {
    for (const route of [
      '/memory',
      '/memory/sessions',
      '/memory/about',
      '/memory/protocols',
      '/prompts',
      '/settings/memory',
      '/settings/privacy',
      '/settings/data'
    ]) {
      await go(s, route)
      const overflow = await p.evaluate(() => {
        const main = document.querySelector('.shell__main') as HTMLElement
        return main.scrollWidth - main.clientWidth
      })
      expect(overflow, route).toBeLessThanOrEqual(0)
      const small = await p.locator('.shell__main button:visible, .shell__main [role="switch"]:visible, .shell__main a:visible').evaluateAll((els) =>
        els
          .filter((e) => {
            const r = e.getBoundingClientRect()
            // Inline text links inside prose are exempt (WCAG 2.5.8 inline exception); so is the kit's chevron inside a
            // combobox (the 44 px input around it is the target) and a switch (its 44 px hit area is a ::before).
            return (
              r.height > 0 &&
              r.height < 44 &&
              !e.closest('p, li, .mnote, .callout__text, .tabs__list') &&
              !e.classList.contains('switch') &&
              !e.classList.contains('combobox__toggle')
            )
          })
          .map((e) => `${e.className}:${(e.textContent || e.getAttribute('aria-label') || '').slice(0, 30)}`)
      )
      expect(small, route).toEqual([])
    }
    await go(s, '/memory')
    await p.getByRole('button', { name: /^Filters/ }).click()
    const sheet = p.getByRole('dialog', { name: 'Filters' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('radio', { name: 'You' }).click()
    await sheet.getByRole('button', { name: 'Show results' }).click()
    await expect(p.getByTestId('memory-entry').first()).toContainText('user response')
    await expect(p.getByRole('button', { name: 'Filters, 1 on' })).toBeVisible()
  } finally {
    await p.setViewportSize({ width: 1440, height: 900 })
  }
})

test('no leaks: listeners, live stores, object URLs and workers return to baseline after 5 page cycles @R17', async () => {
  const p = page()
  await go(s, '/s/' + (await createSession(s.api, 'Leak check')).uid)
  const stats = (): Promise<Record<string, number>> => s.hook<Record<string, number>>('memoryUi.stats')
  const base = await stats()
  for (let i = 0; i < 5; i++) {
    for (const r of [
      '/settings/memory',
      '/memory',
      '/memory/sessions',
      '/memory/about',
      '/memory/protocols',
      '/prompts',
      '/settings/privacy',
      '/settings/data'
    ])
      await go(s, r)
    await go(s, '/')
  }
  expect(await stats()).toEqual(base)
  expect(base).toMatchObject({ listeners: 0, resources: 0, blobUrls: 0, previewWorkers: 0 })
})
