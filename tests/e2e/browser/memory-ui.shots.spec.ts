/**
 * Screenshot pass for the memory-ui screens (memory, privacy, prompts, data, wizard step 3) at 1440×900, 1138×608
 * (the owner's monitor in DIP) and 390×844, dark and light. Opt-in: VESPER_SHOTS=1 (SHOTS=<filter> limits screens).
 * Output: $PW_OUT/shots/<screen>-<size>-<theme>.png — reviewed by eye, not asserted.
 */
import { test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import path from 'node:path'
import { ROOT, type TestServer } from '../launch'
import { go, launchDesktopBrowser, makeHistory, setTheme, shot, SIZES } from '../memoryUi'

test.skip(!process.env.VESPER_SHOTS, 'screenshots are opt-in (VESPER_SHOTS=1)')

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

const SCREENS: { name: string; path: string; prepare?: (s: TestServer) => Promise<void> }[] = [
  { name: 'settings-memory', path: '/settings/memory' },
  { name: 'memory-timeline', path: '/memory' },
  { name: 'memory-sessions', path: '/memory/sessions' },
  { name: 'memory-about', path: '/memory/about' },
  { name: 'memory-protocols', path: '/memory/protocols' },
  { name: 'prompts', path: '/prompts' },
  { name: 'settings-privacy', path: '/settings/privacy' },
  { name: 'settings-data', path: '/settings/data' },
  { name: 'wizard-memory', path: '/test/memory-ui/wizard' },
  { name: 'memory-search', path: '/memory?q=castle' },
  { name: 'memory-sessions-ai', path: '/memory/sessions', prepare: async (t) => void (await t.page.getByRole('radio', { name: 'As the AI sees it' }).click()) },
  {
    name: 'memory-protocols-diff',
    path: '/memory/protocols',
    prepare: async (t) => {
      await t.page.getByTestId('protocols-editor').focus()
      await t.page.keyboard.press('Control+End')
      await t.page.keyboard.type('\nAlways call me {{nickname}}.')
      await t.page.getByRole('radio', { name: 'Changes from default' }).click()
    }
  },
  {
    name: 'data-import-preview',
    path: '/settings/data',
    prepare: async (t) => {
      await t.page.locator('input[type=file]').setInputFiles(path.join(ROOT, 'tests/fixtures/import/chatgpt-conversations.json'))
      await t.page.getByTestId('import-preview').waitFor()
      await t.page.getByTestId('import-preview').scrollIntoViewIfNeeded()
    }
  }
]

test('memory-ui screenshots', async () => {
  test.setTimeout(600_000)
  s = await launchDesktopBrowser(mock)
  const h = await makeHistory(s)
  await s.api('POST', '/api/facts', { text: 'Prefers trams to taxis' })
  await s.api('POST', '/api/facts', { text: 'Has a cat called Miso who hates thunderstorms' })
  await s.api('POST', '/api/prompts', { name: 'Travel planner', body: 'You are a calm, practical travel planner. Ask about budget first.' })
  await s.api('PUT', `/api/sessions/${h.trip.uid}/links/${h.garden.shortId}`, { bothWays: false })
  if (process.env.SHOTS_MEMORY_ON) {
    await s.api('PATCH', '/api/settings', { memory: { enabled: true, voyage: { tier: 'free' } } })
    await s.api('PUT', '/api/secrets/voyage', { value: 'pa-e2e-shots-key' })
    await s.api('POST', '/api/memory/backfill', { choice: 'all' })
  }
  const filter = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(s, theme)
    for (const size of SIZES) {
      await s.page.setViewportSize({ width: size.width, height: size.height })
      for (const sc of SCREENS) {
        if (filter && !filter.test(sc.name)) continue
        await go(s, sc.path)
        await sc.prepare?.(s)
        await shot(s.page, `${sc.name}-${size.name}-${theme}`, { fullPage: size.name !== 'owner' })
      }
    }
  }
})
