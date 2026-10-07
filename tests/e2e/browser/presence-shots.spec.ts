/**
 * Screenshot pass for presence (Star, Talk mode, Constellation) at 1440×900, 1138×608 (the owner's primary monitor in
 * DIP) and 390×844, dark and light. Opt-in: PRESENCE_SHOTS=1 (it is a review aid, not a gate). Images land in
 * test-results/presence-shots/ (outside PW_OUT, which Playwright empties).
 */
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm } from '../helpers'
import { launchServer, type TestServer } from '../launch'
import { seedSky, type FrameStats } from '../presence'
import { AUDIO_FIXTURES } from '../stt'

// Outside PW_OUT: Playwright empties its output dir on every run.
const OUT = path.resolve('test-results', 'presence-shots')
const SIZES = [
  { w: 1440, h: 900 },
  { w: 1138, h: 608 },
  { w: 390, h: 844 }
]
const THEMES = ['dark', 'light'] as const

test.skip(!process.env.PRESENCE_SHOTS, 'screenshot pass: set PRESENCE_SHOTS=1')
test.describe.configure({ timeout: 600_000 })

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

async function settle(page: Page, hook: TestServer['hook'], ms = 700): Promise<void> {
  await hook('presence.setFocus', true)
  await page.waitForTimeout(ms)
}

/** The Star's slot at 1:1, for detail review. */
async function closeup(page: Page, name: string): Promise<void> {
  const box = await page.locator('.star-slot').first().boundingBox()
  if (box) await page.screenshot({ path: path.join(OUT, name), clip: box })
}

async function setTheme(s: TestServer, theme: 'dark' | 'light'): Promise<void> {
  await s.hook('presence.appearance', { theme })
}

test('Star lab: states, styles, accents', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  for (const size of SIZES) {
    await s.page.setViewportSize({ width: size.w, height: size.h })
    for (const theme of THEMES) {
      await s.hook('go', '/presence-lab')
      await s.waitReady()
      await s.waitHook('presence.surface')
      await s.hook('presenceLab.setTheme', theme)
      for (const st of ['idle', 'thinking', 'listening', 'muted', 'error']) {
        await s.hook('presenceLab.setState', st)
        await settle(s.page, s.hook, st === 'idle' ? 1200 : 900)
        await s.page.screenshot({ path: path.join(OUT, `lab-${st}-${theme}-${size.w}x${size.h}.png`) })
        if (size.w === 1440) await closeup(s.page, `lab-close-${st}-${theme}.png`)
      }
      await s.hook('presenceLab.setState', 'live')
      await s.hook('presence.speak', 'Of course. The light you see tonight left that star long before anyone was there to see it, and still it arrives.')
      await s.page.waitForTimeout(1200)
      await s.page.screenshot({ path: path.join(OUT, `lab-speaking-${theme}-${size.w}x${size.h}.png`) })
      if (size.w === 1440) await closeup(s.page, `lab-close-speaking-${theme}.png`)
      await s.hook('audio.stop')
      if (size.w === 1440) {
        for (const style of ['nebula', 'minimal2d', 'off']) {
          await s.hook('presence.setPrefs', { style })
          await s.hook('presenceLab.setState', 'thinking')
          await settle(s.page, s.hook, 1200)
          await s.page.screenshot({ path: path.join(OUT, `lab-style-${style}-${theme}.png`) })
        }
        await s.hook('presence.setPrefs', { style: 'orb' })
        for (const accent of ['violet', 'rose', 'aurora', 'ice', 'gold']) {
          await s.hook('presenceLab.setAccent', accent)
          await s.hook('presenceLab.setState', 'idle')
          await settle(s.page, s.hook, 900)
          await s.page.screenshot({ path: path.join(OUT, `lab-accent-${accent}-${theme}.png`) })
        }
      }
    }
  }
  await s.assertNoErrors()
})

test('Constellation: map, hover card, search, list, empty', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desk = await s.login('desktop')
  // Empty sky first.
  for (const theme of THEMES) {
    await s.hook('go', '/constellation')
    await s.waitReady()
    await setTheme(s, theme)
    await settle(s.page, s.hook, 500)
    await s.page.screenshot({ path: path.join(OUT, `cst-empty-${theme}-1440x900.png`) })
  }
  await seedSky(s.url, desk)
  for (const size of SIZES) {
    await s.page.setViewportSize({ width: size.w, height: size.h })
    for (const theme of THEMES) {
      await s.hook('go', '/settings')
      await s.hook('go', '/constellation')
      await s.waitReady()
      await setTheme(s, theme)
      await settle(s.page, s.hook, 1600)
      await s.page.screenshot({ path: path.join(OUT, `cst-map-${theme}-${size.w}x${size.h}.png`) })
      if (size.w > 700) {
        // Hover the brightest big star (projected position from the scene).
        const pt = await s.page.evaluate(() => {
          const el = document.querySelector('.cst__stage') as HTMLElement
          const r = el.getBoundingClientRect()
          const labels = Array.from(document.querySelectorAll<HTMLElement>('.cst-label'))
          const first = labels[0]
          if (!first) return null
          const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(first.style.transform)
          return m ? { x: r.left + Number(m[1]) - 14, y: r.top + Number(m[2]) + 9 } : null
        })
        if (pt) {
          await s.page.mouse.move(pt.x, pt.y)
          await s.page.waitForTimeout(500)
          await s.page.screenshot({ path: path.join(OUT, `cst-hover-${theme}-${size.w}x${size.h}.png`) })
          await s.page.mouse.move(5, size.h - 5)
        }
        await s.page.getByRole('searchbox', { name: 'Find a conversation' }).fill('learn')
        await settle(s.page, s.hook, 900)
        await s.page.screenshot({ path: path.join(OUT, `cst-search-${theme}-${size.w}x${size.h}.png`) })
        await s.page.getByRole('searchbox', { name: 'Find a conversation' }).fill('')
      } else {
        await s.page.getByRole('button', { name: 'Show the list' }).click()
        await s.page.waitForTimeout(500)
        await s.page.screenshot({ path: path.join(OUT, `cst-list-${theme}-${size.w}x${size.h}.png`) })
        await s.page.keyboard.press('Escape')
      }
    }
  }
  await s.assertNoErrors()
})

test('Talk mode: listening, thinking, reply, held, muted', async () => {
  s = await launchServer({
    mock,
    fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'),
    env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Hello Vesper, can you hear me?' }
  })
  await s.waitHook('ws.connected')
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  const sess = (await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'Evening walk' })).json
  for (const size of SIZES) {
    await s.page.setViewportSize({ width: size.w, height: size.h })
    for (const theme of THEMES) {
      await s.hook('go', `/talk/${sess.uid}`)
      await s.waitReady()
      await setTheme(s, theme)
      await settle(s.page, s.hook, 2500)
      await s.page.screenshot({ path: path.join(OUT, `talk-${theme}-${size.w}x${size.h}.png`) })
      await expect(s.page.locator('.talk__captions')).toContainText('Echo:', { timeout: 20_000 })
      await s.page.waitForTimeout(600)
      await s.page.screenshot({ path: path.join(OUT, `talk-reply-${theme}-${size.w}x${size.h}.png`) })
      const frames = await s.hook<FrameStats>('presence.frames')
      expect(frames.frames).toBeGreaterThan(0)
      await s.page.getByRole('button', { name: 'Mute' }).click()
      await s.page.waitForTimeout(600)
      await s.page.screenshot({ path: path.join(OUT, `talk-muted-${theme}-${size.w}x${size.h}.png`) })
      await s.page.getByRole('button', { name: 'Unmute' }).first().click()
      await s.page.getByRole('button', { name: 'Hold' }).click()
      await s.page.waitForTimeout(600)
      await s.page.screenshot({ path: path.join(OUT, `talk-held-${theme}-${size.w}x${size.h}.png`) })
      await s.hook('go', `/s/${sess.uid}`)
      await s.waitReady()
    }
  }
})

test('Talk mode without a microphone; Constellation dialogs', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desk = await s.login('desktop')
  const sess = (await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'Quiet room' })).json
  for (const theme of THEMES) {
    await s.hook('go', `/talk/${sess.uid}`)
    await s.waitReady()
    await setTheme(s, theme)
    await expect(s.page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 10_000 })
    await settle(s.page, s.hook, 600)
    await s.page.screenshot({ path: path.join(OUT, `talk-nomic-${theme}-1440x900.png`) })
    await s.hook('go', '/settings')
  }
  await seedSky(s.url, desk)
  for (const theme of THEMES) {
    await s.page.setViewportSize({ width: 1440, height: 900 })
    await s.hook('go', '/constellation')
    await s.waitReady()
    await setTheme(s, theme)
    await settle(s.page, s.hook, 1200)
    await s.page.getByRole('button', { name: 'Link “Trip to Lisbon” to…' }).click()
    await s.page.waitForTimeout(400)
    await s.page.screenshot({ path: path.join(OUT, `cst-linkdialog-${theme}.png`) })
    await s.page.keyboard.press('Escape')
    await s.page.setViewportSize({ width: 390, height: 844 })
    await s.page.waitForTimeout(500)
    const cello = (await desk.api<{ items: Array<{ uid: string; title: string }> }>('GET', '/api/sessions?limit=100')).json.items.find(
      (x) => x.title === 'Learning the cello'
    )!
    await s.hook('presence.selectStar', cello.uid)
    await s.page.waitForTimeout(600)
    await s.page.screenshot({ path: path.join(OUT, `cst-phone-tap-${theme}.png`) })
    await s.page.keyboard.press('Escape')
    await s.hook('go', '/settings')
  }
})
