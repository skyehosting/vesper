/**
 * Screenshot pass for fix5-ui (review aid, not an assertion suite): every screen the Phase 5b UI fixes touched, at
 * 1440×900, 1138×608 and 390×844, dark and light. Opt-in:
 *   FIX5_SHOTS=1 PW_OUT=test-results/fix5-ui npx playwright test --project browser ui-polish5.shots
 * Images land in test-results/fix5-ui-shots/ (outside PW_OUT, which Playwright empties per run).
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession } from '../helpers'
import { waitForReady } from '../hooks'
import { launchServer, removeDirs, type TestServer } from '../launch'
import { go, setTheme } from '../memoryUi'

const OUT = path.resolve(process.env.FIX5_SHOTS_DIR ?? 'test-results/fix5-ui-shots')
const SIZES = [
  { id: 'w', width: 1440, height: 900 },
  { id: 'o', width: 1138, height: 608 },
  { id: 'p', width: 390, height: 844 }
] as const
const THEMES = ['dark', 'light'] as const

test.skip(!process.env.FIX5_SHOTS, 'screenshot pass: set FIX5_SHOTS=1')
test.setTimeout(600_000)

let mock: MockServer
let s: TestServer | null = null
const dirs: string[] = []
test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterAll(async () => {
  await mock?.close()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  removeDirs(dirs.splice(0))
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

async function snap(t: TestServer, name: string, full = false): Promise<void> {
  await t.page.waitForTimeout(300)
  const vp = t.page.viewportSize()!
  let grown = false
  if (full) {
    const extra = await t.page.evaluate(() => {
      let max = 0
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const oy = getComputedStyle(el).overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.clientHeight > 0) max = Math.max(max, el.scrollHeight - el.clientHeight)
      }
      return max
    })
    if (extra > 0) {
      await t.page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 6000) })
      await t.page.waitForTimeout(250)
      grown = true
    }
  }
  await t.page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' })
  if (grown) await t.page.setViewportSize(vp)
}

test('shots: chat header, toasts, palette, search, settings, wizard memory, access', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-ui5s-'))
  dirs.push(d, `${d}-local`)
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ wizard: { completed: true }, chat: { fontSize: 99 } }))
  s = await launchServer({ mock, login: 'desktop', open: false, dataDir: d, localDir: `${d}-local` })
  const t = s
  await configureMockLlm(t.api, mock.url)
  const chat = await createSession(
    t.api,
    'A very long chat title about planning the summer holiday in the mountains with friends, the train times, the huts and the packing list'
  )
  const lanPort = await freePort('127.0.0.2')
  expect((await t.api('POST', '/api/auth/password', { next: 'violin harbor 1987 tide' })).status).toBe(204)
  expect((await t.api('PUT', '/api/network', { mode: 'lan', lanAddress: '127.0.0.2', lanPort })).status).toBe(200)
  await t.page.goto(t.url)
  await t.waitReady()
  await t.hook('toast.clear')

  for (const theme of THEMES) {
    await setTheme(t, theme)
    for (const size of SIZES) {
      await t.page.setViewportSize({ width: size.width, height: size.height })
      const tag = `${size.id}-${theme}`
      await go(t, `/s/${chat.uid}`)
      await snap(t, `chat-header-${tag}`)
      await t.hook('toast.show', 'success', 'Moved “Weekly groceries” to Trash', { action: 'Undo' })
      await t.hook('toast.show', 'warning', 'Vesper kept a copy of the old file. Details are in Settings.', { title: 'Some settings were reset', action: 'Open Settings' })
      await snap(t, `chat-toasts-${tag}`)
      await t.hook('toast.clear')

      await t.page.keyboard.press('Control+k')
      const input = t.page.getByRole('combobox', { name: /type \/ for commands/ })
      await input.fill('mountains')
      await t.page.waitForTimeout(300)
      await snap(t, `palette-chats-${tag}`)
      await input.fill('/')
      await t.page.waitForTimeout(300)
      await t.page.locator('.palette__item', { hasText: '/prompt' }).first().scrollIntoViewIfNeeded()
      await snap(t, `palette-cmds-${tag}`)
      await t.page.keyboard.press('Escape')

      await go(t, '/search')
      await snap(t, `search-${tag}`)

      for (const section of ['general', 'memory', 'privacy', 'data', 'voice-out', 'voice-in', 'access']) {
        await go(t, `/settings/${section}`)
        await snap(t, `set-${section}-${tag}`, section !== 'general')
      }

      await t.page.goto(`${t.url}/__test/access-wizard`)
      await waitForReady(t.page)
      await t.page.locator('label.radio-card', { hasText: 'Local network' }).click()
      await snap(t, `wiz-access-${tag}`, true)

      for (const step of ['memory', 'voice-in']) {
        expect((await t.api('PATCH', '/api/settings', { wizard: { completed: false, path: 'guided', step } })).status).toBe(200)
        await t.page.goto(`${t.url}/setup`)
        await t.waitReady()
        await expect.poll(() => t.hook<string>('wizard.step')).toBe(step)
        await snap(t, `wiz-${step}-${tag}`)
      }
      expect((await t.api('PATCH', '/api/settings', { wizard: { completed: true } })).status).toBe(200)
      await t.page.goto(t.url)
      await t.waitReady()
      await t.hook('toast.clear')
    }
  }
})

test('shots (2nd pass): tight chat headers, toasts under the Connection lost strip', async () => {
  s = await launchServer({ mock, login: 'desktop', open: false })
  const t = s
  await configureMockLlm(t.api, mock.url, 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free')
  const title = 'A very long chat title about planning the summer holiday in the mountains with friends, the train times and the huts'
  const plain = await createSession(t.api, title)
  const priv = await t.api<{ uid: string }>('POST', '/api/sessions', { title, private: true })
  await t.page.goto(t.url)
  await t.waitReady()
  for (const theme of THEMES) {
    await setTheme(t, theme)
    for (const [name, uid] of [['plain', plain.uid], ['private', priv.json.uid]] as const) {
      for (const panel of [true, false]) {
        await t.page.setViewportSize({ width: 1440, height: 900 })
        await go(t, `/s/${uid}`)
        const toggle = t.page.getByRole('button', { name: panel ? 'Show chat panel' : 'Hide chat panel' })
        if (await toggle.count()) await toggle.click()
        for (const width of panel ? [1060, 1100, 1138] : [760, 790, 1138]) {
          await t.page.setViewportSize({ width, height: 608 })
          await snap(t, `head-${name}-${panel ? 'panel' : 'nopanel'}-${width}-${theme}`)
        }
      }
    }
  }
  await go(t, `/s/${plain.uid}`)
  const close = t.page.getByRole('button', { name: 'Hide chat panel' })
  if (await close.count()) await close.click()
  t.proc.kill()
  await expect(t.page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 })
  for (const theme of THEMES) {
    await t.page.evaluate((x) => (document.documentElement.dataset.theme = x), theme)
    for (const size of SIZES) {
      await t.page.setViewportSize({ width: size.width, height: size.height })
      await t.hook('toast.clear')
      await t.hook('toast.show', 'error', 'Couldn’t save the chat title. Check the connection and try again.', { title: 'Not saved', action: 'Retry' })
      await t.hook('toast.show', 'success', 'Moved “Weekly groceries” to Trash', { action: 'Undo' })
      await snap(t, `offline-toasts-${size.id}-${theme}`)
    }
  }
})
