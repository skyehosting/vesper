/**
 * memory-ui e2e helpers: a desktop-signed-in browser on the standalone server with the mock providers, some realistic
 * history (chat turns through the mock LLM + a seeded session), and screenshot/axe utilities. The browser context is
 * the DESKTOP device so desktop-only settings (Voyage key, protocols) can be exercised (07 B2).
 */
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import type { MockServer } from '../mocks/server'
import { configureMockLlm, createSession, wsTurn, type SessionLite } from './helpers'
import { launchServer, ROOT, type LaunchServerOptions, type TestServer } from './launch'

export const SHOT_DIR = path.join(ROOT, process.env.PW_OUT ?? 'test-results/e2e', 'shots')

export async function launchDesktopBrowser(mock: MockServer, o: LaunchServerOptions = {}): Promise<TestServer> {
  const s = await launchServer({ mock, login: 'desktop', open: false, ...o })
  await configureMockLlm(s.api, mock.url)
  await s.page.goto(s.url)
  await s.waitReady()
  return s
}

/** Go to an in-app path and wait until the client is idle. */
export async function go(s: TestServer, p: string): Promise<void> {
  await s.hook('go', p)
  await s.waitReady()
}

export interface History {
  trip: SessionLite
  garden: SessionLite
}

/** Two chats with a few real turns each (tagged, timestamped by the server clock). */
export async function makeHistory(s: TestServer): Promise<History> {
  const trip = await createSession(s.api, 'Lisbon trip')
  const garden = await createSession(s.api, 'Balcony garden')
  await wsTurn(s.page, trip.uid, 'We should plan a trip to Lisbon in the spring')
  await wsTurn(s.page, trip.uid, 'Book a hotel near the castle and check the tram times')
  await wsTurn(s.page, garden.uid, 'My basil keeps wilting on the balcony, any ideas?')
  return { trip, garden }
}

export async function setTheme(s: TestServer, theme: 'dark' | 'light'): Promise<void> {
  const r = await s.api('PATCH', '/api/settings', { appearance: { theme } })
  expect(r.status).toBe(200)
  await s.page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
}

export const SIZES = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'owner', width: 1138, height: 608 },
  { name: 'phone', width: 390, height: 844 }
] as const

/**
 * Screenshot into PW_OUT/shots. `fullPage`: the app scrolls inside its panes (the window never scrolls), so the
 * viewport is grown temporarily by the largest pane overflow to capture the whole page, then restored.
 */
export async function shot(page: Page, name: string, o: { fullPage?: boolean } = {}): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${name}.png`)
  // Let transitions settle (reduced motion is not forced: the shots show the real look).
  await page.waitForTimeout(250)
  const vp = page.viewportSize()
  let grown = false
  if (o.fullPage && vp) {
    const extra = await page.evaluate(() => {
      let max = 0
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const oy = getComputedStyle(el).overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.clientHeight > 0) max = Math.max(max, el.scrollHeight - el.clientHeight)
      }
      return max
    })
    if (extra > 0) {
      await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 8000) })
      await page.waitForTimeout(200)
      grown = true
    }
  }
  await page.screenshot({ path: file, animations: 'disabled' })
  if (grown && vp) await page.setViewportSize(vp)
  return file
}

/** axe-core on the current page: no serious or critical violations (07 D9). */
export async function expectAxeClean(page: Page, label: string, include?: string): Promise<void> {
  // Overlays fade in (200–320 ms): measuring contrast mid-animation reports half-transparent text.
  await page.waitForTimeout(400)
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  if (include) b = b.include(include)
  const r = await b.analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    bad.map(
      (v) =>
        `${label}: ${v.id} (${v.impact}) ${v.help} → ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`
    )
  ).toEqual([])
}
