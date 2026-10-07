/**
 * sessions-ui e2e fixtures: a server with the mock LLM, a believable set of chats spread over Today / Yesterday / This
 * week / Older (the server clock is shifted with /api/test/clock while creating them), a few real turns for search,
 * links and a prompt library entry. Shared by sessions-ui.spec.ts and sessions-ui.shots.spec.ts.
 */
import { expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type MockServer } from '../../mocks/server'
import { configureMockLlm, wsTurn } from '../helpers'
import { ROOT, type Api, type TestServer } from '../launch'

export interface Seeded {
  byTitle: Record<string, { uid: string; shortId: string }>
}

const DAY = 86_400_000

export async function setClock(s: TestServer, offsetMs: number): Promise<void> {
  const r = await s.api('POST', '/api/test/clock', { offsetMs })
  expect(r.status, r.text).toBe(200)
}

export async function seedChats(s: TestServer, mock: MockServer, o: { turns?: boolean } = {}): Promise<Seeded> {
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  const api: Api = s.api
  const plan: { title: string; daysAgo: number; pinned?: boolean; private?: boolean; prompt?: string; memory?: 'off' }[] = [
    { title: 'Garden layout ideas', daysAgo: 64 },
    { title: 'Taxes 2025 — what to keep', daysAgo: 21 },
    { title: 'Book notes: The Overstory', daysAgo: 5, prompt: 'You are a thoughtful reading companion.' },
    { title: 'Spanish practice', daysAgo: 3, prompt: 'Reply in Spanish, then English.' },
    { title: 'Morning journal', daysAgo: 1, private: true },
    { title: 'Debugging the borrow checker', daysAgo: 0, memory: 'off' },
    { title: 'Weekly groceries', daysAgo: 0 },
    { title: 'Planning the Lisbon trip', daysAgo: 0, pinned: true }
  ]
  const byTitle: Seeded['byTitle'] = {}
  for (const p of plan) {
    await setClock(s, -p.daysAgo * DAY - 3_600_000)
    const r = await api<{ uid: string; shortId: string }>('POST', '/api/sessions', { title: p.title, ...(p.prompt ? { systemPrompt: p.prompt } : {}) })
    expect(r.status, r.text).toBe(200)
    byTitle[p.title] = { uid: r.json.uid, shortId: r.json.shortId }
    const patch: Record<string, unknown> = {}
    if (p.pinned) patch.pinned = true
    if (p.private) patch.private = true
    if (p.memory) patch.memory = p.memory
    if (Object.keys(patch).length) expect((await api('PATCH', `/api/sessions/${r.json.uid}`, patch)).status).toBe(200)
  }
  await setClock(s, 0)
  // Spanish practice may recall the journal and the book notes; the book notes recall Spanish practice back.
  const sp = byTitle['Spanish practice']
  expect((await api('PUT', `/api/sessions/${sp.uid}/links/${byTitle['Morning journal'].shortId}`, {})).status).toBe(200)
  expect((await api('PUT', `/api/sessions/${sp.uid}/links/${byTitle['Book notes: The Overstory'].shortId}`, { bothWays: true })).status).toBe(200)
  expect((await api('POST', '/api/prompts', { name: 'Gentle editor', body: 'You are a gentle, precise editor. Suggest, never rewrite wholesale.' })).status).toBe(200)
  if (o.turns) {
    await wsTurn(s.page, byTitle['Planning the Lisbon trip'].uid, 'Which neighbourhood in Lisbon has the best pastel de nata?')
    await wsTurn(s.page, byTitle['Planning the Lisbon trip'].uid, 'And a day trip to Sintra?')
    await wsTurn(s.page, byTitle['Weekly groceries'].uid, 'Add oat milk, lemons and pastel dough')
  }
  return { byTitle }
}

/** Screenshots land outside PW_OUT (which Playwright wipes per run) so a review pass can compare runs. */
export function shotPath(name: string): string {
  const dir = path.join(ROOT, 'test-results', 'sessions-ui-shots')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${name}.png`)
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: shotPath(name), animations: 'disabled', caret: 'hide' })
}

export async function setTheme(s: TestServer, theme: 'dark' | 'light', accent = 'gold'): Promise<void> {
  await s.page.evaluate(
    ({ t, a }) => {
      document.documentElement.dataset.theme = t
      document.documentElement.dataset.accent = a
    },
    { t: theme, a: accent }
  )
  await expect(s.page.locator('html')).toHaveAttribute('data-theme', theme)
}

/** axe-core (07 D9): zero serious/critical violations in `include` (default: the whole page). */
export async function axe(page: Page, label: string, include?: string): Promise<void> {
  // Entry animations (opacity) would make axe measure half-faded text: let them finish first.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  if (include) b = b.include(include)
  const r = await b.analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const text = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 5).map((n) => n.target.join(' ')).join('\n  ')}`).join('\n')
  expect(bad, `${label}:\n${text}`).toEqual([])
}
