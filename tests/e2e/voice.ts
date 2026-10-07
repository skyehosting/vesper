/**
 * E2E helpers for the voice client (owner: voice-client): a server with the mock LLM + mock ElevenLabs configured as
 * the desktop device, screenshots at the owner's sizes in both themes, and an axe pass (07 D9).
 */
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import type { MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from './helpers'
import { launchServer, pageApi, ROOT, type LaunchServerOptions, type TestServer } from './launch'
import { AUDIO_FIXTURES } from './stt'

export const HELLO_WAV = path.join(AUDIO_FIXTURES, 'hello.wav')
export const HELLO_TEXT = 'Hello Vesper, can you hear me?'

export interface VoiceSetup {
  s: TestServer
  sessionUid: string
}

/**
 * Server signed in as the desktop (settings that name providers are desktop-only), mock LLM as the default profile,
 * ElevenLabs (mock) as the voice with a saved key, voice replies on, and one session.
 */
export async function voiceServer(mock: MockServer, o: LaunchServerOptions & { tts?: boolean; stt?: Record<string, unknown> } = {}): Promise<VoiceSetup> {
  const s = await launchServer({ mock, login: 'desktop', ...o })
  const api = pageApi(s.page)
  await configureMockLlm(api, mock.url)
  if (o.tts !== false) {
    expect((await api('PATCH', '/api/settings', { voice: { tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })).status).toBe(200)
    expect((await api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  }
  if (o.stt) expect((await api('PATCH', '/api/settings', { voice: { stt: o.stt } })).status).toBe(200)
  const session = await createSession(api, 'Voice client e2e')
  // Reload so the client boots with these settings (and the secretsSet) in its bootstrap.
  await s.page.reload()
  await s.waitReady()
  return { s, sessionUid: session.uid }
}

export async function goLab(s: TestServer, query: string): Promise<void> {
  await s.hook('go', `/voice-lab?${query}`)
  await s.waitReady()
}

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1138, h: 608 },
  { w: 390, h: 844 }
] as const

// Outside PW_OUT: Playwright empties its output dir at the start of every run.
export const SHOT_DIR = path.join(ROOT, 'test-results', 'voice-client-shots')

/**
 * Screenshots at 1440×900, 1138×608 (the owner's monitor in DIP) and 390×844, dark and light. `prepare` runs after
 * each resize (re-open a popover, scroll an element into view). Restores the viewport afterwards.
 */
export async function shots(page: Page, name: string, o: { fullPage?: boolean; prepare?: () => Promise<void>; sizes?: ReadonlyArray<{ w: number; h: number }>; scroll?: string } = {}): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const before = page.viewportSize()
  for (const size of o.sizes ?? SIZES) {
    await page.setViewportSize({ width: size.w, height: size.h })
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t
      }, theme)
      if (o.prepare) await o.prepare()
      await page.waitForTimeout(250)
      if (!o.scroll) {
        await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.w}x${size.h}-${theme}.png`), fullPage: o.fullPage ?? false, animations: 'disabled' })
        continue
      }
      // A page that scrolls inside a container: one shot per screenful (at most 5), top to bottom.
      const sel = o.scroll
      const steps = await page.evaluate((q) => {
        const el = document.querySelector(q)
        if (!el) return 1
        el.scrollTop = 0
        return Math.min(5, Math.max(1, Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight * 0.85)) + 1))
      }, sel)
      for (let i = 0; i < steps; i++) {
        await page.evaluate(
          ({ q, i: k }) => {
            const el = document.querySelector(q)
            if (el) el.scrollTop = k * el.clientHeight * 0.85
          },
          { q: sel, i }
        )
        await page.waitForTimeout(120)
        await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${size.w}x${size.h}-${theme}-p${i + 1}.png`), animations: 'disabled' })
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  if (before) await page.setViewportSize(before)
}

/** 07 D9: no serious or critical axe violations in `include` (default: the whole page). */
export async function expectAxeClean(page: Page, include?: string): Promise<void> {
  let b = new AxeBuilder({ page })
  if (include) b = b.include(include)
  const r = await b.analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')} — ${v.help}`)).toEqual([])
}
