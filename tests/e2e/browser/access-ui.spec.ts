/**
 * access-ui end to end (R1; 07 B2/B4/B15/B16, D8/D9): password sign-in from a phone-sized browser with the lockout
 * countdown; pairing with two browser contexts (the desktop approves, the phone gets in; deny; revoke kicks the
 * phone back to the login page); "Open in browser" on this PC; the Access page rendering the server's network status
 * (LAN on 127.0.0.2, never a firewall prompt) and following `network.changed`; the sudo prompt; the wizard step;
 * keyboard-only use; axe on every screen and dialog (0 serious/critical); leak counters back to baseline.
 */
import net from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { rawRequest } from '../http'
import { collectPageErrors, waitForHook, waitForReady } from '../hooks'
import { launchServer, type TestServer } from '../launch'

const PASSWORD = 'violin harbor 1987 tide'

let s: TestServer | null = null
const extra: BrowserContext[] = []

test.afterEach(async () => {
  for (const c of extra.splice(0)) await c.close().catch(() => undefined)
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

/** 07 D9: no serious or critical axe violations. */
async function expectAxeClean(page: Page, what: string, include?: string): Promise<void> {
  // Entry animations (dialogs fade in) would make axe measure colors at partial opacity.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
  let b = new AxeBuilder({ page })
  if (include) b = b.include(include)
  const r = await b.analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `axe on ${what}`).toEqual([])
}

async function phone(browser: Browser, baseURL?: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true })
  extra.push(ctx)
  const page = await ctx.newPage()
  const errors: string[] = []
  collectPageErrors(page, errors)
  return { ctx, page, errors }
}

/** The desktop is the launcher's own page (a desktop device); a second desktop login would revoke it (07 B11). */
async function desktopWithLan(): Promise<{ s: TestServer; lanPort: number; lanUrl: string }> {
  const srv = await launchServer({ login: 'desktop', open: false })
  s = srv
  expect((await srv.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  expect((await srv.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  const lanPort = await freePort('127.0.0.2')
  const put = await srv.api<{ lan: { url: string; running: boolean } }>('PUT', '/api/network', { mode: 'lan', lanAddress: '127.0.0.2', lanPort })
  expect(put.status, put.text).toBe(200)
  expect(put.json.lan.running).toBe(true)
  return { s: srv, lanPort, lanUrl: put.json.lan.url }
}

async function openAccessSettings(srv: TestServer): Promise<Page> {
  const page = srv.page
  await page.goto(`${srv.url}/settings/access`)
  await waitForReady(page)
  await expect(page.getByRole('heading', { name: 'Access & security', level: 2 })).toBeVisible()
  return page
}

/** Mint a LAN pairing code through the desktop UI and return the phone's link (read from the dialog). */
async function pairFromDialog(desk: Page, lanUrl: string): Promise<string> {
  await desk.getByRole('button', { name: 'Pair a device' }).first().click()
  const dialog = desk.getByRole('dialog', { name: 'Pair a device' })
  await expect(dialog).toBeVisible()
  const codeText = dialog.locator('.acc-pair__codetext')
  await expect(codeText).toHaveText(/\S{4}/)
  const code = (await codeText.innerText()).replace(/\s+/g, '')
  return `${lanUrl}/pair#c=${code}`
}

test('a phone-sized browser signs in with the password; the lockout counts down @R1', async () => {
  s = await launchServer({ login: false, open: false })
  const desk = await s.login('desktop')
  const p = await phone(s.browser, s.url)
  await p.page.goto(s.url)
  await waitForReady(p.page)
  // No password yet: the page explains pairing instead of showing a form.
  await expect(p.page.getByText('Pair this device from your PC')).toBeVisible()
  // First visit: what Vesper is and that the owner approves new devices.
  await expect(p.page.getByText('New paired devices only get in after the owner allows them on the PC.')).toBeVisible()
  await expectAxeClean(p.page, 'login (no password)')
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)

  await p.page.reload()
  await waitForReady(p.page)
  // Later visits fold the intro away.
  await expect(p.page.getByRole('button', { name: 'What is Vesper?' })).toHaveAttribute('aria-expanded', 'false')
  await expectAxeClean(p.page, 'login')
  const password = p.page.getByLabel('Password')
  const signIn = p.page.getByRole('button', { name: 'Sign in' })
  // 44 px touch targets on a phone (07 D8).
  expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await password.boundingBox())!.height).toBeGreaterThanOrEqual(42)

  for (let i = 0; i < 5; i++) {
    await password.fill(`not my password ${i}!`)
    await password.press('Enter')
    await expect(p.page.getByRole('alert')).toHaveText('That password is not right.')
    await expect(password).toHaveValue('')
  }
  await expectAxeClean(p.page, 'login with an error')
  await password.fill(PASSWORD)
  await signIn.click()
  const status = p.page.getByRole('status').filter({ hasText: 'Too many attempts' })
  await expect(status).toHaveText(/^Too many attempts\. Try again in \d+ s\.$/)
  await expect(signIn).toBeDisabled()
  const first = Number(/in (\d+) s/.exec(await status.innerText())![1])
  await expect.poll(async () => Number(/in (\d+) s/.exec(await status.innerText())?.[1] ?? first), { timeout: 5000 }).toBeLessThan(first)
  await expectAxeClean(p.page, 'login locked')

  // A minute later (server clock) the right password gets in.
  expect((await rawRequest(s.url, { method: 'POST', path: '/api/test/clock', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMs: 61_000 }) })).status).toBe(200)
  await p.page.reload()
  await waitForReady(p.page)
  await p.page.getByLabel('Password').fill(PASSWORD)
  await p.page.getByLabel('Name for this device').fill('Pixel 9')
  await p.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.page).not.toHaveURL(/\/login/)
  await waitForReady(p.page)
  const boot = await p.page.evaluate(async () => (await fetch('/api/bootstrap')).json())
  expect(boot).toMatchObject({ desktop: false, device: { kind: 'browser', name: 'Pixel 9' } })
  // The refused sign-ins themselves (401/429) are the only console lines.
  expect(p.errors.filter((e) => !/status of (401|429)/.test(e))).toEqual([])
})

test('pairing end to end: the desktop approves, the phone gets in; revoke sends it back to the login page @R1', async () => {
  const { s: srv, lanUrl } = await desktopWithLan()
  const desk = await openAccessSettings(srv)
  const link = await pairFromDialog(desk, lanUrl)
  await expectAxeClean(desk, 'pair dialog', '[role="dialog"]')
  await desk.keyboard.press('Escape')
  await expect(desk.getByRole('dialog', { name: 'Pair a device' })).toBeHidden()

  const p = await phone(srv.browser)
  await p.page.goto(link)
  // The code is wiped from the address bar right away (it lives only in the fragment).
  await expect(p.page).toHaveURL(/\/pair$/)
  await expect(p.page.getByRole('heading', { name: 'Pair this device with Vesper' })).toBeVisible()
  await expectAxeClean(p.page, 'pair page')
  await p.page.getByLabel('Name for this device').fill('Pixel 9')
  await p.page.getByRole('button', { name: 'Pair this device' }).click()
  await expect(p.page.getByRole('heading', { name: 'Waiting for your PC' })).toBeVisible()
  await expect(p.page.getByRole('status').filter({ hasText: 'expires in' })).toContainText(/expires in \d+:\d\d/)
  await expectAxeClean(p.page, 'waiting for approval')

  // The desktop asks.
  const ask = desk.getByRole('dialog', { name: /^Pair “Pixel 9” from / })
  await expect(ask).toBeVisible()
  await expectAxeClean(desk, 'approval dialog', '[role="dialog"]')
  // Keyboard: focus starts on the safe "Decide later", never on Allow (F50); Allow takes a deliberate Tab or click.
  await expect(ask.getByRole('button', { name: 'Decide later' })).toBeFocused()
  await ask.getByRole('button', { name: 'Allow' }).focus()
  await desk.keyboard.press('Enter')
  await expect(ask).toBeHidden()

  // The phone gets in by itself (it polls /api/auth/state).
  await expect(p.page.getByRole('heading', { name: 'Waiting for your PC' })).toBeHidden({ timeout: 15_000 })
  await expect(p.page).not.toHaveURL(/\/(pair|login)$/)
  await expect.poll(async () => ((await rawRequest(srv.url, { path: '/api/test/stats' })).json as { clients: number }).clients, { timeout: 10_000 }).toBe(2)

  // Listed on the desktop (live via devices.changed), then revoked: the phone's socket closes → login page.
  const row = desk.getByRole('listitem').filter({ hasText: 'Pixel 9' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Waiting for approval')).toBeHidden()
  await desk.getByRole('button', { name: 'Revoke Pixel 9' }).click()
  const confirm = desk.getByRole('dialog', { name: 'Sign out “Pixel 9”?' })
  await expect(confirm).toBeVisible()
  await expectAxeClean(desk, 'revoke confirmation', '[role="dialog"]')
  await confirm.getByRole('button', { name: 'Revoke access' }).click()
  await expect(row).toBeHidden()
  await expect(p.page).toHaveURL(/\/login$/, { timeout: 15_000 })
  await expect(p.page.getByRole('heading', { name: 'Sign in to Vesper' })).toBeVisible()
  // Only the 403 of the client's test-hook probe on Listener B (loopback-only by design) may appear.
  expect(p.errors.filter((e) => !/status of 403/.test(e))).toEqual([])
  expect(srv.errors).toEqual([])
})

test('a denied phone is told so; "decide later" keeps it pending in the device list @R1', async () => {
  const { s: srv, lanUrl } = await desktopWithLan()
  const desk = await openAccessSettings(srv)

  // Deny from the dialog.
  const link1 = await pairFromDialog(desk, lanUrl)
  await desk.keyboard.press('Escape')
  const a = await phone(srv.browser)
  await a.page.goto(link1)
  await a.page.getByLabel('Name for this device').fill('Tablet')
  await a.page.getByRole('button', { name: 'Pair this device' }).click()
  const ask = desk.getByRole('dialog', { name: /^Pair “Tablet”/ })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Deny' }).click()
  await expect(a.page.getByRole('heading', { name: 'This device wasn’t allowed' })).toBeVisible({ timeout: 15_000 })
  await expectAxeClean(a.page, 'denied')

  // Decide later → allow from the device list.
  const link2 = await pairFromDialog(desk, lanUrl)
  await desk.keyboard.press('Escape')
  const b = await phone(srv.browser)
  await b.page.goto(link2)
  await b.page.getByLabel('Name for this device').fill('Laptop')
  await b.page.getByRole('button', { name: 'Pair this device' }).click()
  const ask2 = desk.getByRole('dialog', { name: /^Pair “Laptop”/ })
  await expect(ask2).toBeVisible()
  await ask2.getByRole('button', { name: 'Decide later' }).click()
  await expect(ask2).toBeHidden()
  const row = desk.getByRole('listitem').filter({ hasText: 'Laptop' })
  await expect(row.getByText('Waiting for approval')).toBeVisible()
  await desk.getByRole('button', { name: 'Allow Laptop' }).click()
  await expect(b.page.getByRole('heading', { name: 'Waiting for your PC' })).toBeHidden({ timeout: 15_000 })
  await expect(b.page).not.toHaveURL(/\/(pair|login)$/)
  await expect(row.getByText('Waiting for approval')).toBeHidden()

  // A new password sign-in elsewhere: the desktop gets a toast with one-click Revoke (07 B16, notify {deviceId}).
  const c = await phone(srv.browser, srv.url)
  await c.page.goto(srv.url)
  await waitForReady(c.page)
  await c.page.getByLabel('Password').fill(PASSWORD)
  await c.page.getByLabel('Name for this device').fill('Stranger')
  await c.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(c.page).not.toHaveURL(/\/login$/)
  // Toasts are divs (not <li>) since the kit's axe fix: a role=status item can't also be a listitem.
  const t = desk.getByRole('region', { name: 'Notifications' }).locator('.toast', { hasText: 'Stranger' })
  await expect(t).toContainText('New sign-in to Vesper')
  await t.getByRole('button', { name: 'Revoke' }).click()
  await expect(c.page).toHaveURL(/\/login$/, { timeout: 15_000 })
  await expect(desk.getByRole('listitem').filter({ hasText: 'Stranger' })).toHaveCount(0)
})

test('the Access page shows the server’s network status and follows network.changed (LAN on 127.0.0.2) @R1', async () => {
  const { s: srv, lanPort, lanUrl } = await desktopWithLan()
  const desk = await openAccessSettings(srv)
  const st = (await srv.api<{ lan: { certFingerprint: string; urls: string[] }; loopback: { browserUrl: string } }>('GET', '/api/network')).json
  // Mode, address, fingerprint, firewall: all from GET /api/network.
  await expect(desk.locator('label.radio-card', { hasText: 'Local network' }).getByText('Current')).toBeVisible()
  await expect(desk.getByText(`https://127.0.0.2:${lanPort}`).first()).toBeVisible()
  expect(lanUrl).toBe(`https://127.0.0.2:${lanPort}`)
  const fp = st.lan.certFingerprint.toUpperCase().split(':')
  await expect(desk.locator('.acc-cert .acc-fp')).toContainText(fp.slice(0, 8).join(':'))
  await expect(desk.getByText('No firewall rule needed')).toBeVisible()
  await expect(desk.getByRole('img', { name: /Address of Vesper on your network/ })).toBeVisible()
  // The one address to type on a phone, and what its browser will say (07 H-v111-firewall).
  await expect(desk.getByRole('group', { name: 'On your phone, open' })).toContainText(`https://127.0.0.2:${lanPort}`)
  await expect(desk.getByText('Your phone will warn about the certificate the first time — choose Advanced → Proceed.')).toBeVisible()
  // The This PC card shows both addresses: this PC's and the one other devices use.
  const thisPc = desk.getByRole('region', { name: 'This PC', exact: true }).first()
  await expect(thisPc).toContainText(`Browsers on this PC use ${st.loopback.browserUrl}`)
  await expect(thisPc.getByTestId('acc-others')).toContainText(`Phones and computers on your network: https://127.0.0.2:${lanPort}`)
  await expect(thisPc.getByRole('button', { name: `Copy https://127.0.0.2:${lanPort}` })).toBeVisible()
  await expectAxeClean(desk, 'Access page (LAN)')

  // A change made elsewhere (the tray, another window) arrives as network.changed.
  expect((await srv.api('PUT', '/api/network', { paused: true })).status).toBe(200)
  await expect(desk.getByText('Access from other devices is paused')).toBeVisible()
  expect((await srv.api('PUT', '/api/network', { paused: false, mode: 'local' })).status).toBe(200)
  await expect(desk.locator('label.radio-card', { hasText: 'This PC only' }).getByText('Current')).toBeVisible()
  await expect(desk.getByText('Certificate fingerprint (SHA-256)')).toBeHidden()
  await expect(desk.getByText('Access from other devices is paused')).toBeHidden()
  // LAN off: the card says other devices can't reach Vesper, and its button picks Local network.
  await expect(thisPc.getByTestId('acc-others')).toContainText('Other devices can’t reach Vesper until Local network access is on.')

  // Switching through the page: a draft until applied; the apply bar says Windows will ask about the firewall rule.
  await thisPc.getByRole('button', { name: 'Turn on Local network…' }).click()
  await expect(desk.getByText('Switch to Local network?')).toBeVisible()
  await expect(desk.locator('.acc-apply__text')).toContainText('Windows will ask for permission to add Vesper’s firewall rule')
  await desk.getByRole('button', { name: 'Use Local network' }).click()
  await expect(desk.locator('label.radio-card', { hasText: 'Local network' }).getByText('Current')).toBeVisible()
  await expect(desk.getByText(`https://127.0.0.2:${lanPort}`).first()).toBeVisible()
  expect(srv.errors).toEqual([])
})

test('switching modes asks for a password first; the live rules match the server @R1', async () => {
  s = await launchServer({ login: 'desktop', open: false })
  expect((await s.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  // Bind a future Listener B to 127.0.0.2 on a free port (no firewall prompt, no fixed port).
  const lanPort = await freePort('127.0.0.2')
  expect((await s.api('PUT', '/api/network', { lanAddress: '127.0.0.2', lanPort })).status).toBe(200)
  const desk = await openAccessSettings(s)
  await expectAxeClean(desk, 'Access page (this PC only)')
  await desk.locator('label.radio-card', { hasText: 'Local network' }).click()
  await expect(desk.getByText('needs a password first')).toBeVisible()
  await desk.getByRole('button', { name: 'Set a password' }).click()
  const pw = desk.getByRole('textbox', { name: 'Password', exact: true })
  await expect(pw).toBeFocused()
  await pw.fill('passwordpassword1')
  const rules = desk.getByRole('list', { name: 'Password rules' })
  await expect(rules.getByRole('listitem').filter({ hasText: 'Not a commonly used password' })).toContainText('(not yet)')
  await pw.fill('short one')
  await expect(rules.getByRole('listitem').filter({ hasText: 'At least 15 characters' })).toContainText('(not yet)')
  await pw.fill(PASSWORD)
  await expect(rules.getByRole('listitem').filter({ hasText: '(done)' })).toHaveCount(3)
  await desk.getByLabel('Repeat the password').fill(PASSWORD)
  await expectAxeClean(desk, 'password form')
  await desk.getByRole('button', { name: 'Set password' }).click()
  // Saving the password applies the chosen mode.
  await expect(desk.locator('label.radio-card', { hasText: 'Local network' }).getByText('Current')).toBeVisible({ timeout: 15_000 })
  await expect(desk.getByText(`https://127.0.0.2:${lanPort}`).first()).toBeVisible()
  await expect(desk.getByText('A password is set.')).toBeVisible()
})

test('"Open in browser" signs a browser on this PC in at vesper.localhost without approval @R1', async () => {
  s = await launchServer({ login: 'desktop', open: false })
  expect((await s.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  const desk = await openAccessSettings(s)
  const popup = s.context.waitForEvent('page')
  await desk.getByRole('button', { name: 'Open in browser' }).click()
  const local = await popup
  await local.waitForURL(/^http:\/\/vesper\.localhost:\d+\/(?!pair)/, { timeout: 20_000 })
  await waitForReady(local)
  const boot = await local.evaluate(async () => (await fetch('/api/bootstrap')).json())
  expect(boot).toMatchObject({ desktop: false, device: { kind: 'paired', listener: 'loopback' } })
  await local.close()
})

test('a phone off the PC confirms its password before revoking another device (sudo) @R1', async () => {
  const { s: srv } = await desktopWithLan()
  // Another device to revoke.
  const other = await srv.browser.newContext()
  extra.push(other)
  const r = await other.request.post(`${srv.url}/api/auth/login`, { data: { password: PASSWORD, deviceName: 'Old laptop' }, headers: { 'x-vesper': '1', origin: srv.url } })
  expect(r.status()).toBe(200)

  const p = await phone(srv.browser, srv.url)
  await p.page.goto(srv.url)
  await waitForReady(p.page)
  await p.page.getByLabel('Password').fill(PASSWORD)
  await p.page.getByLabel('Name for this device').fill('Pixel 9')
  await p.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.page).not.toHaveURL(/\/login/)
  // 11 minutes later the sign-in's sudo window is over.
  expect((await rawRequest(srv.url, { method: 'POST', path: '/api/test/clock', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMs: 11 * 60_000 }) })).status).toBe(200)
  await p.page.goto(`${srv.url}/settings/access`)
  await waitForReady(p.page)
  // Off the PC: the mode is read-only, the password change needs the current password.
  await expect(p.page.getByText('Access settings can only be changed in Vesper on the PC.')).toBeVisible()
  await expectAxeClean(p.page, 'Access page on a phone')
  await p.page.getByRole('button', { name: 'Revoke Old laptop' }).click()
  await p.page.getByRole('dialog', { name: 'Sign out “Old laptop”?' }).getByRole('button', { name: 'Revoke access' }).click()
  const sudo = p.page.getByRole('dialog', { name: 'Confirm it’s you' })
  await expect(sudo).toBeVisible()
  await expectAxeClean(p.page, 'sudo prompt', '[role="dialog"]')
  await sudo.getByLabel('Password').fill('wrong password, sorry')
  await sudo.getByRole('button', { name: 'Continue' }).click()
  await expect(sudo.getByText('That password is not right.')).toBeVisible()
  await sudo.getByLabel('Password').fill(PASSWORD)
  await sudo.getByLabel('Password').press('Enter')
  await expect(sudo).toBeHidden()
  await expect(p.page.getByRole('listitem').filter({ hasText: 'Old laptop' })).toBeHidden()
  const devices = await srv.api<{ name: string }[]>('GET', '/api/auth/devices')
  expect(devices.json.some((d) => d.name === 'Old laptop')).toBe(false)
})

test('wizard step 6: This PC by default; LAN needs a password set right there @R1 @R3', async () => {
  s = await launchServer({ login: 'desktop', open: false })
  expect((await s.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
  const lanPort = await freePort('127.0.0.2')
  expect((await s.api('PUT', '/api/network', { lanAddress: '127.0.0.2', lanPort })).status).toBe(200)
  const page = s.page
  await page.goto(`${s.url}/__test/access-wizard`)
  await waitForReady(page)
  await expect(page.getByRole('radio', { name: 'This PC only' })).toBeChecked()
  await expect(page.getByRole('table', { name: 'What works in each access mode' })).toBeVisible()
  await expectAxeClean(page, 'wizard step')
  await page.locator('label.radio-card', { hasText: 'Local network' }).click()
  const next = page.getByRole('button', { name: 'Continue' })
  await expect(next).toBeDisabled()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD)
  await page.getByLabel('Repeat the password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByText('A password is set.')).toBeVisible()
  await expect(next).toBeEnabled()
  await next.click()
  await expect(page.getByText('Next step')).toBeVisible()
  const n = await s.api<{ mode: string; lan: { running: boolean } }>('GET', '/api/network')
  expect(n.json).toMatchObject({ mode: 'lan', lan: { running: true } })
})

test('keyboard only: sign in and reach the Access page without a mouse; leak counters return to baseline @R1 @R17', async () => {
  const { s: srv, lanUrl } = await desktopWithLan()
  const desk = await openAccessSettings(srv)
  const stats = () => srv.hook<{ hosts: number; sudoListeners: number; deviceWatchers: number }>('access.hostStats')
  // Zero entries appear once a counter was used; compare only the non-zero ones.
  const kit = async () => Object.fromEntries(Object.entries(await srv.hook<Record<string, number>>('access.kitStats')).filter(([, v]) => v !== 0))
  expect((await stats()).deviceWatchers).toBe(1)
  const kitBase = await kit()

  // Open/close the pairing dialog 10 times (QR, timers, layers).
  for (let i = 0; i < 10; i++) {
    await desk.getByRole('button', { name: 'Pair a device' }).first().click()
    await expect(desk.locator('.acc-pair__codetext')).toBeVisible()
    await desk.keyboard.press('Escape')
    await expect(desk.getByRole('dialog')).toHaveCount(0)
  }
  // Leave and come back 5 times (device watchers, subscriptions).
  for (let i = 0; i < 5; i++) {
    await srv.hook('go', '/settings/general')
    await waitForReady(desk)
    expect((await stats()).deviceWatchers).toBe(0)
    await srv.hook('go', '/settings/access')
    await waitForReady(desk)
  }
  const after = await stats()
  expect(after).toEqual({ hosts: 1, sudoListeners: 1, deviceWatchers: 1 })
  expect(await kit()).toEqual(kitBase)

  // A phone signs in with the keyboard only (Tab / type / Enter) over LAN.
  const p = await phone(srv.browser)
  await p.page.goto(lanUrl)
  await expect(p.page.getByLabel('Password')).toBeFocused()
  await p.page.keyboard.type(PASSWORD)
  await p.page.keyboard.press('Tab')
  await p.page.keyboard.press('Control+A')
  await p.page.keyboard.type('Keyboard phone')
  await p.page.keyboard.press('Enter')
  await expect(p.page).not.toHaveURL(/\/login$/)
  // The waiting screen's poller is gone once a page has used it (no pairing here: zero from the start).
  const polls = await srv.hook<number>('access.pendingPollers').catch(() => 0)
  expect(polls).toBe(0)
  await waitForHook(desk, srv.hook, 'ws.connected')
})
