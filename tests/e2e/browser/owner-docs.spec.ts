/**
 * Phase 5a docs/copy fixes on screen (fix5-docs): the Design notes dialog shows the final OWNER-NOTES.md (no "Draft",
 * real labels) (P27); Settings → Chat and Settings → Privacy show the same temporary-chat text with its real lifetime
 * (P25); the pairing dialog's "This PC" steps state how long that browser stays signed in (P34). The docs themselves
 * are checked against the code in tests/unit/docs/owner-docs.test.ts. Second pass: the code stays above the pairing
 * dialog's fold (1138×608, 390×844), the texts inside a temporary chat say when it ends, and the app shows the docs'
 * names (chat panel, chat ID).
 * @R21 @R22
 */
import { expect, test } from '@playwright/test'
import { launchServer, type TestServer } from '../launch'

let s: TestServer | null = null

test.afterEach(async () => {
  await s?.close()
  s = null
})

async function desktop(): Promise<TestServer> {
  s = await launchServer({ login: 'desktop', open: false, viewport: { width: 1440, height: 900 } })
  expect((await s.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  return s
}

test('Design notes show the final notes, with labels that exist in Settings (P27)', async () => {
  const t = await desktop()
  await t.page.goto(`${t.url}/settings/about`)
  await t.waitReady()
  await t.page.getByRole('button', { name: 'Read the notes' }).click()
  const dialog = t.page.getByRole('dialog', { name: 'Design notes' })
  // The notes' own title (h1) is hidden under the dialog's; the first thing shown is the table.
  await expect(dialog.getByRole('heading', { name: 'Things only your keys can confirm' })).toBeVisible()
  await expect(dialog).not.toContainText(/draft/i)
  await expect(dialog).toContainText('Memory "stored within Voyage"')
  await expect(dialog).toContainText('Where the AI puts the tone')
  await expect(dialog).toContainText('Anywhere, with Tailscale')
  await expect(dialog.getByRole('region', { name: 'Table' })).toBeVisible()
})

test('Settings → Chat and Settings → Privacy explain temporary chats the same, true way (P25)', async () => {
  const t = await desktop()
  const lifetime = 'about 10 minutes after you leave it (when no device has it open), after 24 hours without use, or when Vesper quits'
  await t.page.goto(`${t.url}/settings/chat`)
  await t.waitReady()
  await expect(t.page.getByText('Start one with the ghost button next to New chat', { exact: false })).toBeVisible()
  await expect(t.page.getByText(lifetime, { exact: false })).toBeVisible()
  await expect(t.page.getByText('New chat menu')).toHaveCount(0)
  await t.page.goto(`${t.url}/settings/privacy`)
  await t.waitReady()
  await expect(t.page.getByText(lifetime, { exact: false })).toBeVisible()
  await expect(t.page.getByText('temporary folder that is emptied when it ends', { exact: false })).toBeVisible()
})

test('the pairing dialog says how long a browser on this PC stays signed in (P34)', async () => {
  const t = await desktop()
  await t.page.goto(`${t.url}/settings/access`)
  await t.waitReady()
  await t.page.getByRole('button', { name: 'Pair a device' }).first().click()
  const dialog = t.page.getByRole('dialog', { name: 'Pair a device' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Sign-in lasts up to 30 days, less if unused.')
  await expect(dialog).not.toContainText('until you sign it out')
})

// Second pass (P34-fold): the sign-in lifetime must not push the pairing code below the dialog's fold on the owner's
// 1138×608 monitor (where "Copy link" and "Open in browser" were already below it), nor "Open in browser" on a 390×844
// phone (where it fitted before).
for (const [viewport, wanted] of [
  [{ width: 1138, height: 608 }, ['code']],
  [{ width: 390, height: 844 }, ['code', 'open']]
] as const) {
  test(`the pairing dialog keeps ${wanted.join(' and ')} above the fold at ${viewport.width}×${viewport.height} (P34)`, async () => {
    s = await launchServer({ login: 'desktop', open: false, viewport })
    expect((await s.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
    await s.page.goto(`${s.url}/settings/access`)
    await s.waitReady()
    await s.page.getByRole('button', { name: 'Pair a device' }).first().click()
    const dialog = s.page.getByRole('dialog', { name: 'Pair a device' })
    const targets = { code: dialog.locator('.acc-pair__codetext'), open: dialog.getByRole('button', { name: 'Open in browser' }) }
    await expect(targets.open).toBeAttached()
    await expect(dialog).toContainText('30 days')
    for (const name of wanted) {
      // The element's bottom edge must be inside its nearest scrolling box (and the viewport) as the dialog opens.
      const fit = await targets[name].evaluate((el) => {
        let box: HTMLElement | null = el.parentElement
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
        const limit = Math.min(box ? box.getBoundingClientRect().bottom : innerHeight, innerHeight)
        return { bottom: Math.round(el.getBoundingClientRect().bottom), limit: Math.round(limit), scrollTop: box?.scrollTop ?? 0 }
      })
      expect(fit.scrollTop, name).toBe(0)
      expect(fit.bottom, name).toBeLessThanOrEqual(fit.limit)
    }
  })
}

test('inside a temporary chat, the banner and the pill say when it ends (P25)', async () => {
  const t = await desktop()
  await t.page.goto(t.url)
  await t.waitReady()
  await t.page.getByRole('complementary', { name: 'Chats' }).getByRole('button', { name: 'New temporary chat' }).click()
  const pill = t.page.getByRole('note', { name: /^Temporary chat: not saved/ })
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute('aria-label', /ends about 10 minutes after you leave it/)
  await expect(t.page.locator('.chat__temp')).toContainText('It ends about 10 minutes after you leave it.')
  await pill.hover()
  await expect(t.page.getByText('It ends about 10 minutes after you leave it.', { exact: false }).last()).toBeVisible()
})

test('owner-visible names: chat panel, chat ID (P36)', async () => {
  const t = await desktop()
  await t.page.goto(t.url)
  await t.waitReady()
  await t.page.getByRole('complementary', { name: 'Chats' }).getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(t.page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  await t.page.getByRole('button', { name: 'Show chat panel' }).click()
  await expect(t.page.getByRole('complementary', { name: 'Chat panel' })).toBeVisible()
  await expect(t.page.getByRole('button', { name: 'Copy chat ID' })).toBeVisible()
  await expect(t.page.getByRole('button', { name: /^Chat ID #/ })).toBeVisible()
  await expect(t.page.getByText(/session/i)).toHaveCount(0)
  await t.page.getByRole('button', { name: 'Close chat panel' }).click()
})
