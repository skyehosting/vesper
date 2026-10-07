/**
 * Screenshot pass for access-ui (review aid, not an assertion suite): every screen and state at 1440×900, 1138×608
 * (the owner's monitor in DIP) and 390×844 (phone, touch), dark and light. Runs only with ACCESS_SHOTS=1:
 *   ACCESS_SHOTS=1 PW_OUT=test-results/access-ui npx playwright test --project browser access-ui.shots
 * Images land in test-results/access-ui-shots/ (ACCESS_SHOTS_DIR).
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { rawRequest } from '../http'
import { waitForReady } from '../hooks'
import { launchServer, type TestServer } from '../launch'

const PASSWORD = 'violin harbor 1987 tide'
// Outside PW_OUT: Playwright empties its output folder at the start of every run.
const OUT = path.resolve(process.env.ACCESS_SHOTS_DIR ?? 'test-results/access-ui-shots')
const SIZES = [
  { id: 'desk', width: 1440, height: 900 },
  { id: 'owner', width: 1138, height: 608 },
  { id: 'phone', width: 390, height: 844 }
] as const
const ONLY = process.env.ACCESS_SHOTS_ONLY ? new RegExp(process.env.ACCESS_SHOTS_ONLY) : null

test.skip(!process.env.ACCESS_SHOTS, 'screenshot pass: set ACCESS_SHOTS=1')
test.setTimeout(300_000)

let s: TestServer | null = null
test.afterEach(async () => {
  await s?.close()
  s = null
})

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

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t
  }, theme)
  await page.waitForTimeout(120)
}

/**
 * `full`: the app scrolls inside its own containers (settings body, bare pages), so a full-page screenshot would only
 * show the viewport; grow the viewport to the content height instead, then restore it.
 */
async function shot(page: Page, name: string, o: { full?: boolean; themes?: ('dark' | 'light')[] } = {}): Promise<void> {
  if (ONLY && !ONLY.test(name)) return
  fs.mkdirSync(OUT, { recursive: true })
  const vp = page.viewportSize()!
  if (o.full) {
    const h = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.settings__body') ?? document.querySelector<HTMLElement>('.app-bare')
      return el ? el.scrollHeight + el.getBoundingClientRect().top : document.documentElement.scrollHeight
    })
    await page.setViewportSize({ width: vp.width, height: Math.min(7000, Math.max(vp.height, Math.ceil(h) + 8)) })
    await page.waitForTimeout(200)
  }
  for (const theme of o.themes ?? ['dark', 'light']) {
    await setTheme(page, theme)
    await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`), animations: 'disabled' })
  }
  await setTheme(page, 'dark')
  if (o.full) await page.setViewportSize(vp)
}

async function phoneContext(browser: Browser, baseURL?: string) {
  return browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
}

async function scrollTo(page: Page, text: string | RegExp): Promise<void> {
  await page.getByRole('heading', { name: text, exact: true }).first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
}

test('login screens', async () => {
  s = await launchServer({ login: false, open: false })
  const desk = await s.login('desktop')
  // No password yet.
  for (const size of SIZES) {
    const ctx = size.id === 'phone' ? await phoneContext(s.browser, s.url) : await s.browser.newContext({ baseURL: s.url, viewport: size })
    const page = await ctx.newPage()
    await page.goto(s.url)
    await waitForReady(page)
    await shot(page, `login-nopassword-${size.id}`)
    await ctx.close()
  }
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  for (const size of SIZES) {
    const ctx = size.id === 'phone' ? await phoneContext(s.browser, s.url) : await s.browser.newContext({ baseURL: s.url, viewport: size })
    const page = await ctx.newPage()
    await page.goto(s.url)
    await waitForReady(page)
    await shot(page, `login-first-${size.id}`, { full: size.id === 'phone' })
    await page.reload()
    await waitForReady(page)
    await page.getByLabel('Password').fill('not the password at all')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await shot(page, `login-wrong-${size.id}`)
    await ctx.close()
  }
  // Lockout: 5 per minute per IP.
  const ctx = await phoneContext(s.browser, s.url)
  const page = await ctx.newPage()
  await page.goto(s.url)
  await waitForReady(page)
  for (let i = 0; i < 6; i++) {
    await page.getByLabel('Password').fill(`wrong password number ${i}`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    // The form clears the field when the answer arrives (scrypt takes a moment).
    await expect(page.getByLabel('Password')).toHaveValue('')
    if (await page.getByRole('status').filter({ hasText: 'Too many attempts' }).isVisible()) break
  }
  await expect(page.getByRole('status').filter({ hasText: 'Too many attempts' })).toBeVisible()
  await shot(page, 'login-locked-phone')
  await ctx.close()
})

test('pair page and waiting screens', async () => {
  s = await launchServer({ login: false, open: false })
  const desk = await s.login('desktop')
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  const lanPort = await freePort('127.0.0.2')
  expect((await desk.api('PUT', '/api/network', { mode: 'lan', lanAddress: '127.0.0.2', lanPort })).status).toBe(200)
  let shift = 0
  for (const size of SIZES) {
    // Each round redeems twice; move the server clock past the per-IP minute so the limiter never kicks in here.
    shift += 61_000
    await rawRequest(s.url, { method: 'POST', path: '/api/test/clock', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMs: shift }) })
    const ctx = size.id === 'phone' ? await phoneContext(s.browser) : await s.browser.newContext({ viewport: size, ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    const pair = await desk.api<{ url: string }>('POST', '/api/auth/pair', { target: 'lan' })
    await page.goto(pair.json.url)
    await expect(page.getByRole('button', { name: 'Pair this device' })).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, `pair-confirm-${size.id}`)
    await page.getByRole('button', { name: 'Pair this device' }).click()
    await expect(page.getByRole('heading', { name: 'Waiting for your PC' })).toBeVisible()
    await shot(page, `pair-waiting-${size.id}`)
    await page.goto('about:blank')
    await page.goto(`${new URL(pair.json.url).origin}/pair#c=AAAAAAAAAAAAAAAAAAAAAA`)
    await page.getByRole('button', { name: 'Pair this device' }).click()
    await expect(page.getByRole('heading', { name: /can’t be used/ })).toBeVisible()
    await shot(page, `pair-invalid-${size.id}`)
    await page.goto(`${new URL(pair.json.url).origin}/pair`)
    await expect(page.getByRole('heading', { name: /incomplete/ })).toBeVisible()
    await shot(page, `pair-missing-${size.id}`)
    await ctx.close()
  }
})

test('settings: access & security on the desktop', async () => {
  // The page itself is the desktop device (a second desktop login would revoke it, 07 B11).
  s = await launchServer({ login: 'desktop', open: false })
  const desk = { api: s.api }
  expect((await desk.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  const page = s.page
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${s.url}/settings/access`)
    await waitForReady(page)
    await shot(page, `settings-local-${size.id}`)
    await shot(page, `settings-local-full-${size.id}`, { full: true, themes: ['dark'] })
  }
  // Choosing LAN without a password.
  await page.setViewportSize(SIZES[0])
  await page.locator('label.radio-card', { hasText: 'Local network' }).click()
  await shot(page, 'settings-apply-nopw-desk')
  await page.getByRole('button', { name: 'Set a password' }).click()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('violin harbor')
  await shot(page, 'settings-password-typing-desk')
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD)
  await page.getByLabel('Repeat the password').fill(PASSWORD)
  await shot(page, 'settings-password-ok-desk')

  // LAN on 127.0.0.2 (no firewall prompt possible).
  const lanPort = await freePort('127.0.0.2')
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  expect((await desk.api('PUT', '/api/network', { mode: 'lan', lanAddress: '127.0.0.2', lanPort })).status).toBe(200)
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${s.url}/settings/access`)
    await waitForReady(page)
    await expect(page.getByText(`https://127.0.0.2:${lanPort}`).first()).toBeVisible()
    await shot(page, `settings-lan-full-${size.id}`, { full: true })
  }
  // Firewall blocked / Public network (faked state).
  await page.setViewportSize(SIZES[1])
  await page.goto(`${s.url}/settings/access`)
  await waitForReady(page)
  await page.evaluate(() => {
    const t = window.__vesperTest as unknown as { access: { fakeNetwork(p: unknown): void }; store: { state(): { network: { lan: object } } } }
    const n = t.store.state().network
    t.access.fakeNetwork({ lan: { ...n.lan, firewall: 'blocked', profile: 'public' } })
  })
  await page.getByText('Windows Firewall', { exact: true }).scrollIntoViewIfNeeded()
  await shot(page, 'settings-lan-firewall-owner')
  await page.getByRole('button', { name: /Allow in Windows Firewall/ }).click()
  await shot(page, 'settings-firewall-confirm-owner')
  await page.keyboard.press('Escape')

  // Pair dialog (LAN target) at every size.
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${s.url}/settings/access`)
    await waitForReady(page)
    await page.getByRole('button', { name: 'Pair a device' }).first().click()
    await expect(page.getByRole('dialog', { name: 'Pair a device' })).toBeVisible()
    await page.waitForTimeout(500)
    await shot(page, `pair-dialog-${size.id}`)
    await page.keyboard.press('Escape')
  }

  // A phone pairs: the approval dialog.
  const phone = await phoneContext(s.browser)
  const pp = await phone.newPage()
  const pair = await desk.api<{ url: string }>('POST', '/api/auth/pair', { target: 'lan' })
  await pp.goto(pair.json.url)
  await pp.getByLabel('Name for this device').fill('Pixel 9')
  await pp.getByRole('button', { name: 'Pair this device' }).click()
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await expect(page.getByRole('dialog', { name: /Pair “Pixel 9”/ })).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, `approve-${size.id}`)
  }
  await page.getByRole('button', { name: 'Decide later' }).click()
  await scrollTo(page, 'Devices')
  await shot(page, 'devices-pending-phone')
  await page.getByRole('button', { name: 'Allow Pixel 9' }).click()
  await expect(pp.getByRole('heading', { name: 'Waiting for your PC' })).toBeHidden({ timeout: 15_000 })
  await page.setViewportSize(SIZES[0])
  await scrollTo(page, 'Devices')
  await page.getByRole('button', { name: 'Activity log' }).click()
  await page.waitForTimeout(400)
  await shot(page, 'devices-log-desk')
  await page.getByRole('button', { name: 'Revoke Pixel 9' }).click()
  await shot(page, 'devices-revoke-confirm-desk')
  await page.keyboard.press('Escape')
  await page.setViewportSize(SIZES[2])
  await scrollTo(page, 'Devices')
  await shot(page, 'devices-log-phone')
  await phone.close()

  // Tailscale (faked states: the test server never runs Tailscale).
  const ts = (over: Record<string, unknown>) =>
    page.evaluate((o) => {
      const t = window.__vesperTest as unknown as { access: { fakeNetwork(p: unknown): void } }
      t.access.fakeNetwork({ mode: 'tailscale', lan: null, ...o })
    }, over)
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${s.url}/settings/access`)
    await waitForReady(page)
    await ts({ tailscale: { installed: false, running: false, signedIn: false, dnsName: null, serving: false, funnel: false, url: null }, warnings: [] })
    await shot(page, `settings-ts-missing-${size.id}`, { full: true, themes: ['dark'] })
    await ts({
      tailscale: { installed: true, running: true, signedIn: true, dnsName: 'skye-pc.tail1234.ts.net.', serving: true, funnel: true, url: 'https://skye-pc.tail1234.ts.net', httpsEnabled: true, funnelUntilUtc: Date.now() + 8 * 3600_000 },
      warnings: [{ code: 'funnel_public', message: 'Funnel is on: anyone on the Internet can reach your sign-in page.' }]
    })
    await shot(page, `settings-ts-funnel-${size.id}`, { full: true })
  }
  await ts({ remote: { paused: true, loginSuspended: true }, tailscale: { installed: true, running: true, signedIn: true, dnsName: 'skye-pc.tail1234.ts.net.', serving: true, funnel: false, url: 'https://skye-pc.tail1234.ts.net', httpsEnabled: false, consentUrl: 'https://login.tailscale.com/f/serve?node=abc' } })
  await page.setViewportSize(SIZES[1])
  await shot(page, 'settings-ts-paused-owner', { full: true })
})

test('wizard step and remote viewer', async () => {
  // The page itself is the desktop device (a second desktop login would revoke it, 07 B11).
  s = await launchServer({ login: 'desktop', open: false })
  const desk = { api: s.api }
  expect((await desk.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  const page = s.page
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.goto(`${s.url}/__test/access-wizard`)
    await waitForReady(page)
    await shot(page, `wizard-local-${size.id}`, { full: size.id === 'phone' })
    await page.locator('label.radio-card', { hasText: 'Anywhere, with Tailscale' }).click()
    await shot(page, `wizard-ts-${size.id}`, { full: true })
  }
  // A signed-in phone looks at Settings → Access.
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  const phone = await phoneContext(s.browser, s.url)
  const pp = await phone.newPage()
  await pp.goto(s.url)
  await waitForReady(pp)
  await pp.getByLabel('Password').fill(PASSWORD)
  await pp.getByLabel('Name for this device').fill('Pixel 9')
  await pp.getByRole('button', { name: 'Sign in' }).click()
  await pp.waitForURL((u) => !u.pathname.startsWith('/login'))
  await pp.goto(`${s.url}/settings/access`)
  await waitForReady(pp)
  await shot(pp, 'remote-viewer-phone', { full: true })
  await phone.close()
})
