/**
 * Access from other devices (R1; 07 B15/D8): a browser that is NOT the desktop signs in with the password; wrong
 * passwords and the per-IP lockout show their messages; LAN mode serves the same app over HTTPS (self-signed) on
 * Listener B, where a phone-sized browser signs in and gets a live WebSocket. Listener B binds 127.0.0.2 so no
 * firewall prompt can appear.
 */
import net from 'node:net'
import { expect, test } from '@playwright/test'
import { rawRequest } from '../http'
import { collectPageErrors, waitForHook, waitForReady } from '../hooks'
import { launchServer, type TestServer } from '../launch'

const PASSWORD = 'violin harbor 1987 tide'

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

test('a browser signs in with the password; wrong passwords and the lockout show their messages @R1', async () => {
  s = await launchServer({ login: false, open: false })
  const desk = await s.login('desktop')
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)

  const page = s.page
  await page.goto(s.url)
  await waitForReady(page)
  expect(await s.hook<string>('route')).toBe('/login')
  const password = page.getByLabel('Password')
  const signIn = page.getByRole('button', { name: 'Sign in' })

  for (let i = 0; i < 5; i++) {
    await password.fill(`not my password ${i}!`)
    await signIn.click()
    await expect(page.getByRole('alert')).toHaveText('That password is not right.')
    await expect(password).toHaveValue('')
  }
  await password.fill(PASSWORD)
  await signIn.click()
  // The 6th attempt within a minute is refused before the password is even checked (07 B15: 5/min per IP).
  await expect(page.getByRole('status').filter({ hasText: 'Too many attempts' })).toHaveText(/^Too many attempts\. Try again in \d+ s\.$/)
  await expect(signIn).toBeDisabled()

  // A minute later (server clock), the right password gets in.
  expect((await rawRequest(s.url, { method: 'POST', path: '/api/test/clock', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMs: 61_000 }) })).status).toBe(200)
  await page.reload()
  await waitForReady(page)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel('Name for this device').fill('E2E browser')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await waitForHook(page, s.hook, 'ws.connected')
  const boot = await page.evaluate(async () => (await fetch('/api/bootstrap')).json())
  expect(boot).toMatchObject({ desktop: false, device: { kind: 'browser', listener: 'loopback', name: 'E2E browser' } })
  const log = await desk.api<{ event: string }[]>('GET', '/api/auth/log')
  expect(log.json.filter((e) => e.event === 'login.fail')).toHaveLength(5)
  expect(log.json.some((e) => e.event === 'login.ok')).toBe(true)
})

test('LAN mode: Listener B serves the app over HTTPS and a phone-sized browser signs in with a live WebSocket @R1', async () => {
  s = await launchServer({ login: false, open: false })
  const desk = await s.login('desktop')
  expect((await desk.api('POST', '/api/auth/password', { next: PASSWORD })).status).toBe(204)
  const lanPort = await freePort('127.0.0.2')
  const put = await desk.api<{ lan: { url: string; running: boolean; certFingerprint: string; firewall: string } }>('PUT', '/api/network', { mode: 'lan', lanAddress: '127.0.0.2', lanPort })
  expect(put.status, put.text).toBe(200)
  expect(put.json.lan).toMatchObject({ running: true, url: `https://127.0.0.2:${lanPort}`, firewall: 'not-needed' })

  const context = await s.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    const page = await context.newPage()
    const errors: string[] = []
    collectPageErrors(page, errors)
    const res = await page.goto(put.json.lan.url)
    expect(res?.status()).toBe(200)
    const sec = await res!.securityDetails()
    expect(sec?.subjectName).toBe('Vesper')
    expect(sec?.issuer).toBe('Vesper')
    // Test hooks live only on Listener A (/api/test/* is loopback-only), so this page is driven through the DOM.
    await expect(page).toHaveURL(/\/login$/)
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByLabel('Name for this device').fill('Phone over LAN')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).not.toHaveURL(/\/login$/)
    // The page's WebSocket (wss on Listener B) is the server's only client.
    await expect.poll(async () => ((await rawRequest(s!.url, { path: '/api/test/stats' })).json as { clients: number }).clients).toBe(1)
    const boot = await page.evaluate(async () => (await fetch('/api/bootstrap')).json())
    expect(boot).toMatchObject({ desktop: false, device: { kind: 'browser', listener: 'lan', name: 'Phone over LAN' }, network: { mode: 'lan' } })
    // The PC is told about the new sign-in, and the device shows up in its list.
    const devices = await desk.api<{ name: string; listener: string }[]>('GET', '/api/auth/devices')
    expect(devices.json.find((d) => d.name === 'Phone over LAN')?.listener).toBe('lan')
    // The client's test-hook probe (GET /api/test/ping) is refused off loopback, by design.
    expect(errors.filter((e) => !/status of 403/.test(e))).toEqual([])

    // Back to "This PC only": the LAN origin goes away.
    expect((await desk.api('PUT', '/api/network', { mode: 'local' })).status).toBe(200)
    await expect(page.request.get(`${put.json.lan.url}/api/auth/state`)).rejects.toThrow()
  } finally {
    await context.close()
  }
})
