/**
 * ui-kit acceptance (BLD-13; 04, 07 D8–D10/D13): the /gallery page renders every component with no console errors,
 * every interactive element has a role and a name, the composite widgets are fully keyboard-driven (Select, Combobox,
 * Menu, Tabs, Slider, Dialog/Sheet with nested popups), the virtual list keeps its anchor, the code highlighter runs in
 * its worker under the production CSP, opening/closing overlays leaves no listeners behind, and screenshots at
 * 1440×900 and 390×844 in dark and light land in test-results (PW_OUT) for review.
 *
 * Tags: @R22 (polish), @R18 (copy/paste, files), @R19 (silence slider), @R21 (privacy callout), @R5 (virtual list).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { launchServer, ROOT, type TestServer } from '../launch'

let s: TestServer
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  s = await launchServer()
  page = s.page
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: s.url })
  await openGallery()
})

test.afterAll(async () => {
  await s?.close()
})

async function openGallery(): Promise<void> {
  await s.hook('go', '/gallery')
  await s.waitReady()
  await expect(page.getByTestId('gallery')).toBeVisible()
}

async function setAppearance(theme: 'dark' | 'light', accent = 'gold'): Promise<void> {
  await s.hook('kit.setAppearance', theme, accent, false)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function stats(): Promise<Record<string, number>> {
  return s.hook<Record<string, number>>('kit.stats')
}

/** Every focusable/interactive element exposes a role and an accessible name (a light axe-style pass). */
async function unnamedControls(scope: Locator | Page): Promise<string[]> {
  const root = 'locator' in scope && !('goto' in scope) ? scope : page.locator('body')
  return root.evaluate((el) => {
    const SEL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="slider"], [role="combobox"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="listbox"], [role="menu"], [role="dialog"], [role="tablist"], [role="radiogroup"], [role="progressbar"], [tabindex="0"]'
    const text = (n: Element | null): string => (n?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const nameOf = (e: Element): string => {
      const labelledBy = e.getAttribute('aria-labelledby')
      if (labelledBy) return labelledBy.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim()
      const aria = e.getAttribute('aria-label')
      if (aria) return aria.trim()
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || e instanceof HTMLButtonElement) {
        const labels = e.labels ? Array.from(e.labels).map(text).join(' ') : ''
        if (labels) return labels
      }
      if (e instanceof HTMLElement && e.closest('label') && e.matches('input')) return text(e.closest('label'))
      if (e instanceof HTMLInputElement && e.placeholder) return e.placeholder
      const t = text(e)
      if (t && !e.matches('input, textarea, [role="slider"], [role="progressbar"], [role="listbox"], [role="menu"], [role="dialog"], [role="tablist"], [role="radiogroup"]')) return t
      return e.getAttribute('title') ?? ''
    }
    const out: string[] = []
    for (const e of Array.from(el.querySelectorAll(SEL))) {
      if (!(e instanceof HTMLElement) || e.closest('[aria-hidden="true"], [hidden], [inert]') || e.getClientRects().length === 0) continue
      if (e.matches('input[type="file"]')) continue
      if (!nameOf(e)) out.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}[role=${e.getAttribute('role') ?? ''}] ${e.outerHTML.slice(0, 120)}`)
    }
    return out
  })
}

const shotDir = (): string => test.info().outputPath()

async function fullShot(name: string): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add('gallery-full'))
  // Let the virtual list and fonts settle after the layout change.
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(shotDir(), `${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' })
  // One image per section too: the full page is too tall to review at a readable scale.
  for (const section of await page.locator('.g-section').all()) {
    const id = (await section.getAttribute('data-testid')) ?? 'section'
    await section.screenshot({ path: path.join(shotDir(), name, `${id}.png`), animations: 'disabled', caret: 'hide' })
  }
  await page.evaluate(() => document.documentElement.classList.remove('gallery-full'))
}

test('the gallery renders every section with no errors and named controls @R22', async () => {
  for (const id of ['buttons', 'inputs', 'select', 'toggles', 'slider', 'tabs', 'menus', 'overlays', 'feedback', 'states', 'data', 'remembered', 'secret', 'code', 'files', 'qr', 'virtual', 'audio']) {
    await expect(page.getByTestId(`gallery-${id}`), id).toBeAttached()
  }
  expect(await unnamedControls(page)).toEqual([])
  await s.assertNoErrors()
})

test('screenshots: desktop 1440×900 and phone 390×844, dark and light @R22', async () => {
  for (const [w, h] of [
    [1440, 900],
    [390, 844]
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const theme of ['dark', 'light'] as const) {
      await setAppearance(theme)
      await page.evaluate(() => document.querySelector('.gallery')?.scrollTo(0, 0))
      await page.screenshot({ path: path.join(shotDir(), `viewport-${theme}-${w}.png`), animations: 'disabled', caret: 'hide' })
      await fullShot(`full-${theme}-${w}`)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await setAppearance('dark')
  await s.assertNoErrors()
})

// ── keyboard: composite widgets ──────────────────────────────────────────────────────────────────

const activeOption = async (combo: Locator): Promise<string> => {
  const id = await combo.getAttribute('aria-activedescendant')
  return id ? ((await page.locator(`[id="${id}"]`).textContent()) ?? '').trim() : ''
}

test('Select: arrows, typeahead, Enter, Esc, Home/End — focus stays on the button @R22', async () => {
  const sel = page.locator('#g-accent-select')
  await sel.focus()
  await page.keyboard.press('ArrowDown')
  await expect(sel).toHaveAttribute('aria-expanded', 'true')
  const listbox = page.getByRole('listbox', { name: 'Accent' })
  await expect(listbox).toBeVisible()
  expect(await activeOption(sel)).toContain('Vesper gold')
  await page.keyboard.press('ArrowDown')
  expect(await activeOption(sel)).toContain('Dusk violet')
  await page.keyboard.press('r')
  expect(await activeOption(sel)).toContain('Rose')
  await page.keyboard.press('Enter')
  await expect(listbox).toBeHidden()
  await expect(sel).toContainText('Rose')
  await expect(sel).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  expect(await activeOption(sel)).toContain('Ice')
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  await expect(sel).toContainText('Rose')
  await page.keyboard.press('Space')
  await page.keyboard.press('Home')
  expect(await activeOption(sel)).toContain('Vesper gold')
  await page.keyboard.press('Tab')
  await expect(listbox).toBeHidden()
  await expect(sel).toContainText('Vesper gold')
})

test('Combobox: typing filters and highlights, Enter picks, Esc closes then restores @R22', async () => {
  const input = page.locator('#g-voice')
  await input.focus()
  await input.fill('')
  await input.pressSequentially('swed')
  const listbox = page.getByRole('listbox', { name: 'Voice' })
  await expect(listbox.getByRole('option')).toHaveCount(1)
  expect(await activeOption(input)).toContain('Charlotte')
  await page.keyboard.press('Enter')
  await expect(listbox).toBeHidden()
  await expect(input).toHaveValue('Charlotte')

  await input.fill('zzz')
  await expect(page.getByText('No matches')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('No matches')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Charlotte')
  await page.keyboard.press('ArrowDown')
  await expect(listbox).toBeVisible()
  expect(await activeOption(input)).toContain('Charlotte')
  await page.keyboard.press('Escape')
})

test('Menu: Enter opens on the first item, arrows wrap and skip disabled, typeahead, Esc returns focus @R22', async () => {
  const trigger = page.getByTestId('g-menu-trigger')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Chat actions' })
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitem', { name: /Rename/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: /Copy link/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  // "Archive" is disabled: skipped.
  await expect(page.getByRole('menuitemcheckbox', { name: 'Pinned' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: /Rename/ })).toBeFocused()
  await page.keyboard.press('e')
  await expect(page.getByRole('menuitem', { name: /Export/ })).toBeFocused()
  await page.screenshot({ path: path.join(shotDir(), 'menu-open.png') })
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(page.getByTestId('g-menu-result')).toHaveText('Compact')
  await expect(trigger).toBeFocused()
})

test('kit fixes: a squeezed button keeps its icon; a tooltip under an open menu ignores that Esc; no global .vlist @R22', async () => {
  // Button icons don't shrink in a tight flex row (they went to 0–7 px).
  const width = await page.getByTestId('g-menu-trigger').evaluate((b) => {
    const row = b.parentElement as HTMLElement
    const before = row.getAttribute('style') ?? ''
    row.style.display = 'flex'
    row.style.width = '40px'
    const w = b.querySelector('.btn__icon svg')?.getBoundingClientRect().width ?? 0
    row.setAttribute('style', before)
    return w
  })
  expect(width).toBeGreaterThanOrEqual(15.5)

  // A tooltip (here: shown by hovering "More options") ignores the Esc that closes a menu opened on top of it from
  // the keyboard — that Esc belongs to the menu; the next Esc hides the tooltip.
  await page.getByRole('button', { name: 'More options' }).hover()
  const tip = page.locator('[role="tooltip"]').filter({ hasText: 'More options' })
  await expect(tip).toBeVisible()
  const trigger = page.getByTestId('g-menu-trigger')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Chat actions' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(tip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tip).toBeHidden()
  await page.mouse.move(0, 0)

  // The virtual list's class no longer collides with KaTeX's `.vlist` fraction layout.
  expect(await page.locator('.vlist').count()).toBe(0)
  await expect(page.locator('.virtual-list').first()).toBeAttached()
})

test('ContextMenu opens from Shift+F10 and right-click; Popover closes on Esc and returns focus @R22', async () => {
  const target = page.getByTestId('g-context-target')
  await target.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Message actions' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(target).toBeFocused()
  await target.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.getByRole('menuitem', { name: 'Speak again' }).click()
  await expect(page.getByTestId('g-menu-result')).toHaveText('Speak again')

  const open = page.getByRole('button', { name: 'Open link…' })
  await open.click()
  const pop = page.getByRole('dialog', { name: 'Open this link?' })
  await expect(pop).toBeVisible()
  await expect(pop.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()
  await expect(open).toBeFocused()
})

test('Tabs: roving focus with arrows, Home/End, automatic activation, disabled skipped @R22', async () => {
  const section = page.getByTestId('gallery-tabs-line')
  const tab = (name: RegExp): Locator => section.getByRole('tab', { name })
  await tab(/About you/).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(/Sessions/)).toBeFocused()
  await expect(tab(/Sessions/)).toHaveAttribute('aria-selected', 'true')
  await expect(section.getByRole('tabpanel')).toHaveText('Sessions and their links.')
  await page.keyboard.press('End')
  await expect(tab(/Memory index/)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(tab(/About you/)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(tab(/Memory index/)).toBeFocused()
  // Only the selected tab is in the tab order.
  expect(await section.locator('[role="tab"][tabindex="0"]').count()).toBe(1)
})

test('Slider: APG keys, value text, commit, pointer click snaps (silence 300–5000) @R19 @R22', async () => {
  const slider = page.getByRole('slider', { name: 'Silence before sending' })
  await slider.focus()
  await expect(slider).toHaveAttribute('aria-valuenow', '1200')
  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuenow', '1300')
  await expect(slider).toHaveAttribute('aria-valuetext', '1.3 s')
  await page.keyboard.press('PageUp')
  await expect(slider).toHaveAttribute('aria-valuenow', '1800')
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '5.0 s')
  await page.keyboard.press('Home')
  await expect(slider).toHaveAttribute('aria-valuenow', '300')
  await expect(page.getByTestId('g-silence-committed')).toHaveText('Saved: 300 ms')
  const track = page.getByTestId('gallery-silence').locator('.slider__track-area')
  const box = (await track.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(slider).toHaveAttribute('aria-valuenow', '2700')
  await expect(page.getByTestId('g-silence-committed')).toHaveText('Saved: 2700 ms')
})

test('Dialog: focus moves in, Tab is trapped, a listbox inside closes first on Esc, focus returns; nested non-dismissible @R22', async () => {
  const opener = page.getByTestId('g-dialog-open')
  await opener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Session settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toBeFocused()
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  const sel = dialog.locator('#g-dialog-select')
  await sel.focus()
  await page.keyboard.press('ArrowDown')
  const listbox = page.getByRole('listbox', { name: 'Memory scope' })
  await expect(listbox).toBeVisible()
  await page.screenshot({ path: path.join(shotDir(), 'dialog-with-listbox.png') })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(sel).toContainText('All sessions')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  await expect(dialog).toBeVisible()

  await dialog.getByTestId('g-dialog-nested').click()
  const nested = page.getByRole('dialog', { name: 'Nested dialog' })
  await expect(nested).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(nested).toBeVisible()
  await nested.getByRole('button', { name: 'Done' }).click()
  await expect(nested).toBeHidden()
  await expect(dialog.getByTestId('g-dialog-nested')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('ConfirmDialog: danger starts on Cancel; typed confirmation gates the button; failures stay open with the message @R22', async () => {
  await page.getByRole('button', { name: 'Delete chat…' }).click()
  const d = page.getByRole('dialog', { name: 'Delete this chat?' })
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(d).toBeHidden()

  await page.getByRole('button', { name: 'Typed confirmation…' }).click()
  const t = page.getByRole('dialog', { name: 'Delete all memory?' })
  const go = t.getByRole('button', { name: 'Delete memory' })
  await expect(go).toBeDisabled()
  await page.keyboard.type('DELETE')
  await expect(go).toBeEnabled()
  await go.click()
  await expect(t).toBeHidden()

  await page.getByRole('button', { name: 'Failing action…' }).click()
  const f = page.getByRole('dialog', { name: 'Re-index memory?' })
  await f.getByRole('button', { name: 'Re-index' }).click()
  await expect(f.getByRole('alert')).toContainText("Can't reach the service")
  await f.getByRole('button', { name: 'Cancel' }).click()
  await expect(f).toBeHidden()
})

test('Switch, Checkbox, Radio, Segmented work from the keyboard @R22', async () => {
  const sw = page.getByRole('switch', { name: 'Game mode' })
  await sw.focus()
  await page.keyboard.press('Space')
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Enter')
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  const cb = page.getByRole('checkbox', { name: 'Attachments' })
  await cb.focus()
  await page.keyboard.press('Space')
  await expect(cb).toBeChecked()
  const radio = page.getByRole('radio', { name: 'This PC', exact: true }).first()
  await radio.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('radio', { name: 'Local network' })).toBeChecked()
  const seg = page.getByRole('radiogroup', { name: 'Star style' })
  await seg.getByRole('radio', { name: 'Orb' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(seg.getByRole('radio', { name: 'Nebula' })).toBeChecked()
})

// ── content components ───────────────────────────────────────────────────────────────────────────

test('CodeBlock highlights in a worker under the production CSP; copy uses the clipboard @R18 @R22', async () => {
  const ts = page.getByTestId('gallery-code-ts')
  await expect(ts.locator('figure[data-highlighted]')).toBeAttached({ timeout: 15_000 })
  expect(await ts.locator('.tok').count()).toBeGreaterThan(10)
  const color = await ts.locator('.tok').first().evaluate((e) => getComputedStyle(e).color)
  expect(color).not.toBe(await ts.locator('pre').evaluate((e) => getComputedStyle(e).color))
  const hl = await s.hook<{ worker: boolean; cached: number }>('kit.highlighter')
  expect(hl.worker).toBe(true)
  expect(hl.cached).toBeGreaterThanOrEqual(2)

  const copy = page.getByRole('button', { name: 'Copy as Markdown' })
  await copy.click()
  await expect(page.getByTestId('gallery-code').getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('# Markdown')
})

test('QR code renders as an image; SecretInput never shows a saved key @R22', async () => {
  const img = page.getByRole('img', { name: /Pairing code/ })
  await expect(img).toBeVisible()
  expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)

  const section = page.getByTestId('gallery-secret')
  const field = section.getByLabel('Voyage AI key')
  await field.fill('test-key-123')
  await expect(field).toHaveAttribute('type', 'password')
  await page.keyboard.press('Enter')
  await expect(section.getByRole('button', { name: 'Replace' })).toHaveCount(2)
  expect(await section.innerHTML()).not.toContain('test-key-123')
  // A refused key keeps the field and says why (catalogue message, 07 C19).
  await section.getByRole('button', { name: 'Replace' }).nth(1).click()
  await expect(section.getByLabel('Voyage AI key')).toBeFocused()
  await page.keyboard.type('bad')
  await page.keyboard.press('Enter')
  await expect(section.getByText('The AI service rejected the API key.')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('FileDrop checks type and size immediately and lists accepted files @R18', async () => {
  const section = page.getByTestId('gallery-files')
  const input = section.locator('input[type="file"]').first()
  await input.setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'setup.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') }
  ])
  await expect(section.getByText(/notes\.txt · 5 B/)).toBeVisible()
  await expect(section.getByRole('alert')).toContainText("setup.exe: this file type isn't supported.")
})

test('VirtualList keeps the reader’s place on prepend (also at scrollTop 0), follows output, bounds the DOM @R5', async () => {
  const v = 'kit.virtual'
  await page.getByTestId('gallery-virtual').scrollIntoViewIfNeeded()
  // Mid-list prepend.
  const before = await s.hook<{ key: number; top: number } | null>(`${v}.topAtIndex`, 400)
  expect(before).not.toBeNull()
  await page.waitForTimeout(200)
  const again = await s.hook<number | null>(`${v}.rowTop`, before!.key)
  const n0 = await s.hook<number>(`${v}.count`)
  await s.hook(`${v}.prepend`, 100)
  await expect.poll(() => s.hook<number>(`${v}.count`)).toBe(n0 + 100)
  await page.waitForTimeout(200)
  const after = await s.hook<number | null>(`${v}.rowTop`, before!.key)
  expect(after).not.toBeNull()
  expect(Math.abs(after! - again!)).toBeLessThanOrEqual(2)

  // At scrollTop 0 the list loads older rows by itself (onStartReached) — and still doesn't jump.
  const n1 = await s.hook<number>(`${v}.count`)
  const top0 = await s.hook<{ key: number; top: number; scrollTop: number } | null>(`${v}.topAtIndex`, 0)
  expect(top0?.scrollTop).toBe(0)
  await expect.poll(() => s.hook<number>(`${v}.count`)).toBeGreaterThan(n1)
  await page.waitForTimeout(200)
  const after0 = await s.hook<number | null>(`${v}.rowTop`, top0!.key)
  expect(Math.abs(after0! - top0!.top)).toBeLessThanOrEqual(2)
  expect(await s.hook<number>(`${v}.domRows`)).toBeLessThan(80)

  // Follow output while streaming into the last row.
  await page.getByTestId('gallery-virtual').getByRole('button', { name: 'Bottom' }).click()
  await expect.poll(() => s.hook<boolean>(`${v}.atBottom`)).toBe(true)
  await page.getByRole('button', { name: 'Stream into last row' }).click()
  await page.waitForTimeout(1200)
  const gap = await page.getByTestId('g-vlist').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)
  expect(gap).toBeLessThanOrEqual(2)
  await page.getByRole('button', { name: 'Stop streaming' }).click()
})

// ── phone, leaks, bundle ─────────────────────────────────────────────────────────────────────────

test('phone 390×844: 44 px targets, bottom sheet, no horizontal overflow @R22', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  const small = await page
    .getByTestId('gallery-buttons')
    .locator('.btn, .icon-btn')
    .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44).map((e) => e.textContent || e.getAttribute('aria-label')))
  expect(small).toEqual([])
  const overflow = await page.locator('.gallery').evaluate((g) => g.scrollWidth - g.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.getByTestId('g-sheet-open').click()
  const sheet = page.getByRole('dialog', { name: 'Chat panel' })
  await expect(sheet).toHaveClass(/sheet--bottom/)
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shotDir(), 'phone-sheet.png') })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('g-sheet-open').click()
  await expect(sheet).toHaveClass(/sheet--end/)
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shotDir(), 'desktop-sheet.png') })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
})

test('opening and closing overlays 15× leaves no listeners, layers or observers behind @R17', async () => {
  const base = await stats()
  expect(base.openLayers ?? 0).toBe(0)
  for (let i = 0; i < 15; i++) {
    await page.locator('#g-accent-select').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await page.getByTestId('g-menu-trigger').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await page.getByTestId('g-dialog-open').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Session settings' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open link…' }).click()
    await page.keyboard.press('Escape')
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const end = await stats()
  for (const k of ['kit.layers', 'kit.docListeners', 'kit.positioners', 'openLayers', 'kit.observers']) expect(end[k] ?? 0, k).toBe(base[k] ?? 0)
  await s.assertNoErrors()
})

test('initial JS stays within budget and keeps shiki/qrcode out (07 D7: ≤ 350 KB gzip) @R22', async () => {
  const web = path.join(ROOT, 'out', 'web')
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  const urls = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])
  expect(urls.length).toBeGreaterThan(0)
  let gz = 0
  for (const u of urls) {
    const buf = fs.readFileSync(path.join(web, u))
    gz += zlib.gzipSync(buf).length
    const text = buf.toString('utf8')
    expect(text, u).not.toContain('createHighlighterCore')
    expect(text, u).not.toContain('QR Code')
  }
  expect(gz).toBeLessThan(350 * 1024)
})
