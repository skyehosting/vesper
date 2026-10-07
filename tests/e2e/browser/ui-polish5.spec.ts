/**
 * Phase 5b UI polish regressions (fix5-ui, docs/review/phase5a-findings.md), over the built standalone server:
 *   P03/P06 toasts never cover the composer (desktop: top right under the top bar; phone: under the top bar)
 *   P05     the chat header's model chip keeps its icon, a readable name and the caret at 1138 px with a long title
 *   P07     a health notice is toasted once, short, with its action under the text — and not at all on Settings
 *   P09     Settings sections share one header style (Memory, Privacy, Data, Voice, Access = General)
 *   P10     the health notice inside Settings is a rounded, amber-tinted callout in light theme
 *   P11     the wizard's Memory step uses the shared step header and left edge
 *   P12     phone palette: long chat titles end in "…" before the arrow; command usages wrap, never cut
 *   P14     search toolbar: every filter control has the same height and centre line
 *   P15     Privacy: the header badge no longer squeezes the intro
 *   P29     LAN/Tailscale on + "keep in tray" off → Settings → Access and the wizard step say closing quits, with a switch
 * @R6 @R21 @R22
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession } from '../helpers'
import { waitForReady } from '../hooks'
import { launchServer, removeDirs, type TestServer } from '../launch'
import { go, setTheme } from '../memoryUi'

let mock: MockServer
let s: TestServer | null = null
const dirs: string[] = []

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await mock?.close()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  removeDirs(dirs.splice(0))
})

type Box = { x: number; y: number; width: number; height: number }

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox()
  expect(b, 'element has a box').not.toBeNull()
  return b!
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

async function desktop(viewport = { width: 1440, height: 900 }, o: { dataDir?: string } = {}): Promise<TestServer> {
  s = await launchServer({ mock, login: 'desktop', open: false, viewport, ...(o.dataDir ? { dataDir: o.dataDir, localDir: `${o.dataDir}-local` } : {}) })
  await configureMockLlm(s.api, mock.url)
  await s.page.goto(s.url)
  await s.waitReady()
  return s
}

function dataDirWith(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-ui5-'))
  dirs.push(d, `${d}-local`)
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text)
  return d
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const a = srv.address()
      srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0))
    })
  })
}

const LONG_TITLE =
  'A very long chat title about planning the summer holiday in the mountains with friends, the train times, the huts, the packing list and what to cook on the last evening'

test('P03/P06: toasts land under the top bar, never on the composer — 1440, 1138 and phone @R22', async () => {
  const t = await desktop()
  const chat = await createSession(t.api, 'Weekly groceries')
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1138, height: 608 },
    { width: 390, height: 844 }
  ]) {
    await t.page.setViewportSize(vp)
    await go(t, `/s/${chat.uid}`)
    const composer = t.page.locator('form.composer')
    await expect(composer).toBeVisible()
    await t.hook('toast.clear')
    await t.hook('toast.show', 'success', 'Moved “Weekly groceries” to Trash', { action: 'Undo' })
    await t.hook('toast.show', 'warning', 'This model can’t see images, so the picture was not sent with your message.')
    const toasts = t.page.locator('.toast')
    await expect(toasts).toHaveCount(2)
    const bar = await box(t.page.locator('.shell__topbar'))
    const comp = await box(composer)
    for (let i = 0; i < 2; i++) {
      const tb = await box(toasts.nth(i))
      expect(overlaps(tb, comp), `${vp.width}: toast ${i} vs composer`).toBe(false)
      expect(tb.y, `${vp.width}: toast ${i} below the top bar`).toBeGreaterThanOrEqual(bar.y + bar.height)
      expect(tb.x + tb.width, `${vp.width}: toast inside the window`).toBeLessThanOrEqual(vp.width)
    }
    // Send stays clickable while a toast shows.
    const send = composer.locator('.composer__send')
    const sb = await box(send)
    const hit = await t.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.toast') !== null, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 })
    expect(hit, `${vp.width}: Send is not under a toast`).toBe(false)
  }
  await t.hook('toast.clear')
  await t.assertNoErrors()
})

/** The strip (or pill) and its button stay clear of the toasts: the toasts start below it, the button is clickable. */
async function expectConnClear(t: TestServer, label: string): Promise<void> {
  const strip = t.page.getByTestId('connection-banner')
  await expect(strip).toBeVisible()
  await t.hook('toast.clear')
  await t.hook('toast.show', 'error', 'Couldn’t save the chat title. Check the connection and try again.', { title: 'Not saved', action: 'Retry' })
  await t.hook('toast.show', 'success', 'Moved “Weekly groceries” to Trash', { action: 'Undo' })
  const toasts = t.page.locator('.toast')
  await expect(toasts).toHaveCount(2)
  const sb = await box(strip)
  for (let i = 0; i < 2; i++) {
    const tb = await box(toasts.nth(i))
    expect(overlaps(tb, sb), `${label}: toast ${i} vs the connection notice`).toBe(false)
  }
  const btn = await box(strip.getByRole('button'))
  const hit = await t.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.conn__action') !== null, { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 })
  expect(hit, `${label}: the connection notice's button is not under a toast`).toBe(true)
  await t.hook('toast.clear')
}

test('P03: toasts sit below the "Connection lost" strip, never over it or its Retry button — 1440, 1138 and phone @R22', async () => {
  const t = await desktop({ width: 1138, height: 608 })
  const chat = await createSession(t.api, 'Weekly groceries')
  await go(t, `/s/${chat.uid}`)
  await expect(t.page.locator('form.composer')).toBeVisible()
  // No strip: the toasts keep their place right under the top bar.
  await t.hook('toast.show', 'success', 'Saved')
  const bar = await box(t.page.locator('.shell__topbar'))
  expect((await box(t.page.locator('.toast'))).y).toBeLessThan(bar.y + bar.height + 16)
  await t.hook('toast.clear')
  // The server goes away (PC asleep, Vesper restarting): the in-flow strip shows under the top bar.
  t.proc.kill()
  await expect(t.page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 })
  for (const vp of [
    { width: 1138, height: 608 },
    { width: 390, height: 844 },
    { width: 1440, height: 900 }
  ]) {
    await t.page.setViewportSize(vp)
    await expectConnClear(t, `${vp.width}`)
  }
})

test('P03: on a bare page (Talk mode) toasts sit below the floating "Reconnecting" pill — 1138 and phone @R22', async () => {
  const t = await desktop({ width: 1138, height: 608 })
  const chat = await createSession(t.api, 'Weekly groceries')
  await go(t, `/talk/${chat.uid}`)
  await waitForReady(t.page)
  t.proc.kill()
  await expect(t.page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 })
  await expect(t.page.getByTestId('connection-banner')).toHaveClass(/conn-banner/)
  for (const vp of [
    { width: 1138, height: 608 },
    { width: 390, height: 844 }
  ]) {
    await t.page.setViewportSize(vp)
    await expectConnClear(t, `talk ${vp.width}`)
  }
})

test('P05: the model chip keeps its icon, name and caret at 1138 px with a 200-character title; full name on hover @R22', async () => {
  const t = await desktop({ width: 1138, height: 608 })
  const chat = await createSession(t.api, LONG_TITLE.slice(0, 200))
  for (const width of [1138, 1440]) {
    await t.page.setViewportSize({ width, height: width === 1138 ? 608 : 900 })
    await go(t, `/s/${chat.uid}`)
    const model = t.page.locator('.shead__chips .schip:not(.schip--mem)')
    await expect(model).toBeVisible()
    const m = await model.evaluate((el) => {
      const text = el.querySelector<HTMLElement>('.schip__text')!
      const caret = el.querySelector<SVGElement>('.schip__caret')!.getBoundingClientRect()
      const icon = el.querySelector<SVGElement>('svg')!.getBoundingClientRect()
      return { w: el.getBoundingClientRect().width, textW: text.clientWidth, full: text.scrollWidth, caret: caret.width, icon: icon.width, title: el.getAttribute('title') }
    })
    expect(m.icon, `${width}: icon`).toBeGreaterThan(10)
    expect(m.caret, `${width}: caret`).toBeGreaterThan(10)
    // "mock-echo" fits whole: the chip no longer gives up its width to the title.
    expect(m.full - m.textW, `${width}: model name not truncated`).toBeLessThanOrEqual(1)
    expect(m.textW, `${width}: model name width`).toBeGreaterThan(40)
    expect(m.title, `${width}: tooltip with the full model name`).toBe('mock-echo')
    // The title is what ellipsizes, and the header doesn't overflow the bar.
    const title = await box(t.page.locator('.shead__title'))
    expect(title.width, `${width}: the title keeps some room`).toBeGreaterThanOrEqual(79)
    const over = await t.page.locator('.shell__topbar').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(over, `${width}: no top-bar overflow`).toBeLessThanOrEqual(0)
  }
  await t.assertNoErrors()
})

/** Every visible top-bar control (the header's parts and the bar's buttons), as boxes in page coordinates. */
async function topBarControls(page: Page): Promise<{ name: string; b: Box }[]> {
  return page.locator('.shell__topbar').evaluate((bar) => {
    const sel = '.shead__title, .shead__id, .shead__pill, .schip, .shell__topbar button:not(.shead__title-btn):not(.shead__id):not(.schip)'
    const out: { name: string; b: { x: number; y: number; width: number; height: number } }[] = []
    for (const el of Array.from(bar.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || !el.checkVisibility()) continue
      const name = el.getAttribute('aria-label') ?? el.className
      out.push({ name, b: { x: r.x, y: r.y, width: r.width, height: r.height } })
    }
    return out
  })
}

test('P05: no top-bar control overlaps another while the window narrows — panel open 1000–1138, closed 720–900 @R22', async () => {
  const t = await desktop({ width: 1440, height: 900 })
  // A long model name and a long title (the checker's sweep), plus private and temporary chats whose pills need room.
  await configureMockLlm(t.api, mock.url, 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free')
  const plain = await createSession(t.api, LONG_TITLE.slice(0, 200))
  const priv = await t.api<{ uid: string }>('POST', '/api/sessions', { title: LONG_TITLE.slice(0, 120), private: true })
  expect([200, 201]).toContain(priv.status)
  const temp = await t.api<{ uid: string }>('POST', '/api/sessions', { title: LONG_TITLE.slice(0, 120), temporary: true })
  expect([200, 201]).toContain(temp.status)
  const bad: string[] = []
  for (const uid of [plain.uid, priv.json.uid, temp.json.uid]) {
    for (const panel of [true, false]) {
      await t.page.setViewportSize({ width: 1440, height: 900 })
      await go(t, `/s/${uid}`)
      const toggle = t.page.getByRole('button', { name: panel ? 'Show chat panel' : 'Hide chat panel' })
      if (await toggle.count()) await toggle.click()
      await expect(t.page.locator('.shell__panel[data-open]')).toHaveCount(panel ? 1 : 0)
      // Every 10 px around where the header gets tight (the checker's 1060–1120 with the panel, 740–800 without), up to 1138.
      const from = panel ? 1000 : 720
      const widths = [...Array.from({ length: (panel ? 1140 : 900) / 10 - from / 10 }, (_, i) => from + i * 10), 1138]
      for (const width of widths) {
        await t.page.setViewportSize({ width, height: 608 })
        await expect(t.page.locator('.shead__title')).toBeVisible()
        const bar = await box(t.page.locator('.shell__topbar'))
        const ctl = await topBarControls(t.page)
        for (let i = 0; i < ctl.length; i++) {
          const a = ctl[i]!
          if (a.b.x + a.b.width > bar.x + bar.width + 0.5) bad.push(`${width}${panel ? ' panel' : ''}: "${a.name}" leaves the bar`)
          for (let j = i + 1; j < ctl.length; j++) {
            const c = ctl[j]!
            const shrunk = { x: c.b.x + 0.5, y: c.b.y + 0.5, width: c.b.width - 1, height: c.b.height - 1 }
            if (overlaps(a.b, shrunk)) bad.push(`${width}${panel ? ' panel' : ''}: "${a.name}" overlaps "${c.name}"`)
          }
        }
        // While the model chip shows, it keeps its icon, a few characters and the caret.
        const model = t.page.locator('.shead__chips .schip:not(.schip--mem)')
        // The owner's monitor: the model chip stays, side panel open or not, plain, private or temporary.
        if (width === 1138 && !(await model.isVisible())) bad.push(`1138${panel ? ' panel' : ''} ${uid}: no model chip`)
        if (await model.isVisible()) {
          const m = await model.evaluate((el) => ({
            text: el.querySelector<HTMLElement>('.schip__text')!.getBoundingClientRect().width,
            caret: el.querySelector<SVGElement>('.schip__caret')!.getBoundingClientRect().width
          }))
          if (m.text < 24 || m.caret < 10) bad.push(`${width}${panel ? ' panel' : ''}: model chip squeezed (text ${m.text}px, caret ${m.caret}px)`)
        }
      }
    }
  }
  expect(bad).toEqual([])
  await t.assertNoErrors()
})

test('P07: a repaired settings.json is toasted once, short, action under the text; none on Settings @R20 @R22', async () => {
  // One invalid value: salvaged leaf by leaf ("repaired"), so the app opens normally (not on Settings).
  const dataDir = dataDirWith({ 'settings.json': JSON.stringify({ wizard: { completed: true }, chat: { fontSize: 99 } }) })
  const t = await desktop({ width: 1440, height: 900 }, { dataDir })
  const toastEl = t.page.locator('.toast').filter({ hasText: 'Some settings were reset' })
  await expect(toastEl).toBeVisible()
  const tb = await box(toastEl)
  expect(tb.width, 'toast width').toBeLessThanOrEqual(380)
  expect(tb.height, 'toast is a few lines, not a column').toBeLessThan(130)
  // Short: the kept file's name is on the Settings banner, not in the toast.
  await expect(toastEl).not.toContainText('settings.json.bad-')
  const body = await box(toastEl.locator('.toast__body'))
  const action = await box(toastEl.getByRole('button', { name: 'Open Settings' }))
  expect(action.y, 'the action sits under the text').toBeGreaterThanOrEqual(body.y + body.height - 1)
  expect(body.width, 'the text gets the toast width').toBeGreaterThan(260)
  // Opening Settings: the banner takes over and the toast goes.
  await toastEl.getByRole('button', { name: 'Open Settings' }).click()
  await expect(t.page).toHaveURL(/\/settings/)
  await expect(t.page.locator('[data-health]')).toContainText('Some settings were reset')
  await expect(t.page.locator('.toast').filter({ hasText: 'Some settings were reset' })).toHaveCount(0)
  // A reload on Settings shows the notice once: the banner, no toast.
  await t.page.reload()
  await t.waitReady()
  await expect(t.page.locator('[data-health]')).toContainText('Some settings were reset')
  await t.page.waitForTimeout(500)
  await expect(t.page.locator('.toast').filter({ hasText: 'Some settings were reset' })).toHaveCount(0)
  await t.assertNoErrors()
})

test('P10: the health notice in Settings is a rounded callout with amber tint in light theme and real buttons @R22', async () => {
  const dataDir = dataDirWith({ 'settings.json': JSON.stringify({ wizard: { completed: true }, chat: { fontSize: 99 } }) })
  const t = await desktop({ width: 1440, height: 900 }, { dataDir })
  await setTheme(t, 'light')
  await go(t, '/settings/memory')
  const notice = t.page.locator('[data-health] .callout')
  await expect(notice).toBeVisible()
  const st = await notice.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { radius: parseFloat(cs.borderTopLeftRadius), border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth), bg: cs.backgroundColor }
  })
  expect(st.radius).toBeGreaterThanOrEqual(8)
  expect(st.border).toBeGreaterThan(1)
  const [r, g, b] = st.bg.match(/[\d.]+/g)!.map(Number)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const hue = max === min ? 0 : max === r ? 60 * (((g - b) / (max - min)) % 6) : max === g ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - g) / (max - min) + 4)
  expect(hue, `warning tint hue of ${st.bg}`).toBeGreaterThanOrEqual(25)
  expect(hue, `warning tint hue of ${st.bg}`).toBeLessThanOrEqual(55)
  await expect(notice.locator('.btn--secondary', { hasText: 'Open folder' })).toBeVisible()
  await t.assertNoErrors()
})

test('P09: Memory, Privacy, Data, Voice and Access use the same section header as General @R22', async () => {
  const t = await desktop()
  await go(t, '/settings/general')
  const ref = await t.page.locator('.sgroup__title').first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return `${cs.fontSize}/${cs.fontWeight}`
  })
  const cardBg = await t.page.locator('.sgroup__body').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  for (const section of ['memory', 'privacy', 'data', 'voice-out', 'voice-in', 'access']) {
    await go(t, `/settings/${section}`)
    const titles = t.page.locator('#settings-body').locator('.sgroup__title, .mg__title, .vs-section__title, .acc-section__title')
    await expect(titles.first()).toBeVisible()
    const styles = await titles.evaluateAll((els) =>
      els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => `${getComputedStyle(e).fontSize}/${getComputedStyle(e).fontWeight}`)
    )
    expect(styles.length, section).toBeGreaterThan(0)
    for (const st of styles) expect(st, `${section}: section title style`).toBe(ref)
    expect(await t.page.locator('#settings-body .mg__icon').count(), `${section}: no heading icons`).toBe(0)
    if (section.startsWith('voice')) {
      // Voice controls sit in the same cards as everywhere else (not on the page background).
      const bodies = await t.page.locator('.vs-section:not(.vs-section--advanced) > .vs-section__body').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
      expect(bodies.length, section).toBeGreaterThan(0)
      for (const bg of bodies) expect(bg, `${section}: card surface`).toBe(cardBg)
    }
  }
  await t.assertNoErrors()
})

test('P11: the wizard Memory step uses the shared step header and the voice steps’ left edge @R22', async () => {
  const t = await desktop()
  const edge = async (step: string): Promise<{ title: number; progress: number; width: number }> => {
    const r = await t.api('PATCH', '/api/settings', { wizard: { completed: false, path: 'guided', step } })
    expect(r.status, r.text).toBe(200)
    // A fresh load: the wizard reads its resume step when it mounts.
    await t.page.goto(`${t.url}/setup`)
    await t.waitReady()
    await expect.poll(() => t.hook<string>('wizard.step')).toBe(step)
    const title = t.page.locator('.wiz-step__title')
    await expect(title).toBeVisible()
    const container = t.page.locator(`[data-testid="wizard-${step}"]`)
    return { title: (await box(title)).x, progress: (await box(t.page.locator('.wiz__progress'))).x, width: (await box(container)).width }
  }
  const voice = await edge('voice-in')
  const memory = await edge('memory')
  await expect(t.page.locator('[data-testid="wizard-memory"]').getByText('Memory · optional')).toBeVisible()
  expect(Math.abs(memory.title - voice.title), 'same left edge as the voice step').toBeLessThanOrEqual(1)
  expect(Math.abs(memory.title - memory.progress), 'lined up with the progress bar').toBeLessThanOrEqual(1)
  expect(memory.width).toBeLessThanOrEqual(641)
  await t.assertNoErrors()
})

test('P12: phone palette — long chat titles end in "…" before the arrow; command usages wrap @R6 @R22', async () => {
  const t = await desktop({ width: 390, height: 844 })
  await createSession(t.api, LONG_TITLE)
  await go(t, '/')
  const page: Page = t.page
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: /type \/ for commands/ })
  await expect(input).toBeFocused()
  await input.fill('mountains')
  const item = page.locator('.palette__item', { hasText: 'A very long chat title' }).first()
  await expect(item).toBeVisible()
  await item.hover()
  const m = await item.evaluate((el) => {
    const label = el.querySelector<HTMLElement>('.palette__label')!
    const text = el.querySelector<HTMLElement>('.palette__text')!.getBoundingClientRect()
    const go = el.querySelector('.palette__go')?.getBoundingClientRect() ?? null
    const l = label.getBoundingClientRect()
    return { right: l.right, textRight: text.right, goLeft: go ? go.left : null, ellipsis: label.scrollWidth > label.clientWidth, overflow: getComputedStyle(label).textOverflow }
  })
  expect(m.right, 'label stays inside its column').toBeLessThanOrEqual(m.textRight + 0.5)
  if (m.goLeft !== null) expect(m.right, 'label ends before the arrow').toBeLessThanOrEqual(m.goLeft)
  expect(m.ellipsis && m.overflow === 'ellipsis', 'the long title ends in an ellipsis').toBe(true)

  await input.fill('/prompt')
  const cmd = page.locator('.palette__item', { hasText: '/prompt' }).first()
  await expect(cmd).toBeVisible()
  const c = await cmd.evaluate((el) => {
    const label = el.querySelector<HTMLElement>('.palette__label')!
    const usage = el.querySelector<HTMLElement>('.palette__usage')
    return { cut: label.scrollWidth - label.clientWidth, right: label.getBoundingClientRect().right, item: el.getBoundingClientRect().right, usage: usage?.textContent ?? '' }
  })
  expect(c.usage).toContain('clear')
  expect(c.cut, 'usage is not cut off').toBeLessThanOrEqual(1)
  expect(c.right).toBeLessThanOrEqual(c.item)
  await page.keyboard.press('Escape')
  await t.assertNoErrors()
})

test('P14: the search toolbar controls share one height and centre line @R22', async () => {
  const t = await desktop()
  await go(t, '/search')
  const filters = t.page.locator('.search__filters')
  await expect(filters).toBeVisible()
  const ctl = await filters.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('.segmented, .input'))
      .filter((e) => e.offsetParent !== null)
      .map((e) => {
        const r = e.getBoundingClientRect()
        return { h: Math.round(r.height * 2) / 2, mid: Math.round((r.y + r.height / 2) * 2) / 2 }
      })
  )
  expect(ctl.length).toBe(5)
  for (const c of ctl) {
    expect(c.h, 'control height').toBe(ctl[0].h)
    expect(Math.abs(c.mid - ctl[0].mid), 'centre line').toBeLessThanOrEqual(0.5)
  }
  await t.assertNoErrors()
})

test('P15: the Privacy intro uses the full measure; the badge does not squeeze it @R21 @R22', async () => {
  const t = await desktop()
  await go(t, '/settings/privacy')
  const desc = t.page.locator('#settings-body .mp__desc').first()
  await expect(desc).toBeVisible()
  const d = await box(desc)
  const head = await box(t.page.locator('#settings-body .mp__head').first())
  const maxCh = await desc.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth))
  // As wide as other page intros (62ch or the column, whichever is less) — not ~360 px next to the badge.
  expect(d.width).toBeGreaterThanOrEqual(Math.min(maxCh, head.width) - 40)
  expect(d.width).toBeGreaterThan(480)
  await t.assertNoErrors()
})

test('P29: LAN on and "keep in tray" off — Access says closing quits, and one switch keeps Vesper in the tray @R1 @R3', async () => {
  s = await launchServer({ login: 'desktop', open: false })
  const t = s
  expect((await t.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  const lanPort = await freePort('127.0.0.2')
  expect((await t.api('PUT', '/api/network', { lanAddress: '127.0.0.2', lanPort })).status).toBe(200)

  // The wizard step: only once a network mode is picked.
  await t.page.goto(`${t.url}/__test/access-wizard`)
  await waitForReady(t.page)
  const quits = t.page.getByRole('note').filter({ hasText: 'Closing the window quits Vesper' })
  await expect(quits).toHaveCount(0)
  await t.page.locator('label.radio-card', { hasText: 'Local network' }).click()
  await expect(quits).toBeVisible()

  // Settings → Access with LAN on.
  expect((await t.api('POST', '/api/auth/password', { next: 'violin harbor 1987 tide' })).status).toBe(204)
  expect((await t.api('PUT', '/api/network', { mode: 'lan' })).status).toBe(200)
  await t.page.goto(`${t.url}/settings/access`)
  await waitForReady(t.page)
  const callout = t.page.locator('.acc-tray')
  await expect(callout).toContainText('Closing the window quits Vesper')
  // One setting, one name: the callout's switch and the This PC card's switch read the same label and stay in sync.
  const named = t.page.getByRole('switch', { name: 'Keep running in the tray when closed', exact: true })
  await expect(named).toHaveCount(2)
  const sw = callout.getByRole('switch', { name: 'Keep running in the tray when closed', exact: true })
  const card = named.nth(1)
  await expect(sw).not.toBeChecked()
  await expect(card).not.toBeChecked()
  await sw.click()
  await expect(sw).toBeChecked()
  await expect(card).toBeChecked()
  await expect(callout).toContainText('Vesper keeps running in the tray')
  const st = await t.api<{ desktop: { closeToTray: boolean } }>('GET', '/api/settings')
  expect(st.json.desktop.closeToTray).toBe(true)
  // Next visit: nothing to warn about.
  await t.page.reload()
  await waitForReady(t.page)
  await expect(t.page.getByRole('heading', { name: 'Access & security' })).toBeVisible()
  await expect(t.page.locator('.acc-tray')).toHaveCount(0)
  // Back to This PC only: no callout either way.
  expect((await t.api('PATCH', '/api/settings', { desktop: { closeToTray: false } })).status).toBe(200)
  expect((await t.api('PUT', '/api/network', { mode: 'local' })).status).toBe(200)
  await t.page.reload()
  await waitForReady(t.page)
  await expect(t.page.getByRole('heading', { name: 'Access & security' })).toBeVisible()
  await expect(t.page.locator('.acc-tray')).toHaveCount(0)
  await t.assertNoErrors()
})

// Found while making the full suite deterministic (settings-wizard "Guided setup" saved voiceId "Microsoft David" for
// ElevenLabs under load): the voice page auto-picks the first voice once voices are known (07 C22). If the Windows
// voices arrive after the owner chose another service but before the server's answer reached the page, that pick was
// saved for the NEW service. Recreated deterministically: the Windows voices and the provider switch's response are held.
test('Voice out: switching service while the old voices load never saves an old voice for the new service @R12', async () => {
  const t = await desktop()
  let releaseVoices!: () => void
  const voicesHeld = new Promise<void>((r) => (releaseVoices = r))
  let windowsVoices = 0
  let voicesAsked!: () => void
  const asked = new Promise<void>((r) => (voicesAsked = r))
  await t.page.route(/\/api\/tts\/voices\?.*provider=windows/, async (route) => {
    // The server's answer is in hand (listing Windows voices can take seconds under load) before the test goes on.
    const resp = await route.fetch({ timeout: 60_000 })
    windowsVoices = ((await resp.json()) as { voices: unknown[] }).voices.length
    voicesAsked()
    await voicesHeld
    await route.fulfill({ response: resp })
  })
  // The switch to ElevenLabs is held before it reaches the server; any voice pick made meanwhile is held until the
  // switch is done, so it lands after it (the order the real race produced).
  let releaseSwitch!: () => void
  const switchHeld = new Promise<void>((r) => (releaseSwitch = r))
  let switchDone!: () => void
  const switched = new Promise<void>((r) => (switchDone = r))
  const voicePicks: string[] = []
  await t.page.route('**/api/settings', async (route) => {
    const body = route.request().method() === 'PATCH' ? (route.request().postData() ?? '') : ''
    if (body.includes('"provider":"elevenlabs"')) {
      await switchHeld
      const resp = await route.fetch()
      switchDone()
      await route.fulfill({ response: resp })
      return
    }
    const m = /"voiceId":"([^"]+)"/.exec(body)
    if (m) {
      voicePicks.push(m[1]!)
      await switched
    }
    await route.continue()
  })
  await t.hook('go', '/settings/voice-out') // not go(): it waits for every request, and one is held on purpose
  await asked
  await t.page.locator('label.radio-card', { hasText: 'ElevenLabs' }).click()
  releaseVoices()
  // Give the page time to receive the Windows voices and run its auto-pick (the bug sent a PATCH here).
  await t.page.waitForTimeout(800)
  releaseSwitch()
  await switched
  await expect(t.page.getByRole('radio', { name: /ElevenLabs/ })).toBeChecked()
  expect(windowsVoices, 'the Windows voice list had voices to pick from').toBeGreaterThan(0)
  expect(voicePicks, 'no voice was picked while the switch was pending').toEqual([])
  const tts = (await t.api<{ voice: { tts: { provider: string; voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts
  expect(tts).toMatchObject({ provider: 'elevenlabs', voiceId: null })
  await t.page.unrouteAll({ behavior: 'ignoreErrors' })
  await t.assertNoErrors()
})
