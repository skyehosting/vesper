/**
 * Request guards of the loopback listener (02 §5.2, 07 B2/B10/B15), checked with raw HTTP so every header is exactly
 * what the test says: cross-origin writes, DNS-rebinding Hosts and cookie-less API calls are refused; the test-only
 * ping answers in a test build.
 */
import { expect, test } from '@playwright/test'
import { launchServer, sameOriginHeaders, type TestServer } from '../launch'
import { rawRequest } from '../http'

let s: TestServer

test.beforeAll(async () => {
  s = await launchServer({ open: false })
})

test.afterAll(async () => {
  await s?.close()
})

const json = { 'content-type': 'application/json' }

test('a mutating request with the right Origin passes (control) @R1', async () => {
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/sessions', headers: { ...sameOriginHeaders(s.url, await s.cookieHeader()), ...json }, body: JSON.stringify({ title: 'control' }) })
  expect(r.status, r.text).toBeLessThan(300)
})

test('a mutating request with a foreign Origin is rejected with 403 @R1', async () => {
  const headers = { ...sameOriginHeaders(s.url, await s.cookieHeader()), ...json, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/sessions', headers, body: JSON.stringify({ title: 'csrf' }) })
  expect(r.status, r.text).toBe(403)
})

test('a mutating request without X-Vesper is rejected @R1', async () => {
  const headers: Record<string, string> = { ...sameOriginHeaders(s.url, await s.cookieHeader()), ...json }
  delete headers['x-vesper']
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/sessions', headers, body: JSON.stringify({ title: 'no header' }) })
  expect([400, 403], r.text).toContain(r.status)
})

test('a request with Host: evil.example is rejected (DNS rebinding) @R1', async () => {
  const r = await rawRequest(s.url, { path: '/api/bootstrap', headers: { cookie: await s.cookieHeader(), host: 'evil.example' } })
  expect([400, 403, 421], `${r.status} ${r.text}`).toContain(r.status)
})

test('GET /api/bootstrap without a cookie is 401; with the cookie it is 200 @R1', async () => {
  const anon = await rawRequest(s.url, { path: '/api/bootstrap' })
  expect(anon.status, anon.text).toBe(401)
  expect((anon.json as { error?: { code?: string } } | undefined)?.error?.code).toBe('unauthorized')
  const signedIn = await rawRequest(s.url, { path: '/api/bootstrap', headers: { cookie: await s.cookieHeader() } })
  expect(signedIn.status, signedIn.text).toBe(200)
})

test('GET /api/test/ping answers in a test build', async () => {
  const r = await rawRequest(s.url, { path: '/api/test/ping' })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true })
})
