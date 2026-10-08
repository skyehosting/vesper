/**
 * README screenshots on a phone (opt-in: README_SHOTS=1): the standalone server and a headless Chromium (on the GPU)
 * as a 390×844 phone at DPR 3 (touch, mobile viewport), signed in as a browser device, in the same invented world as
 * the desktop shots (../readmeShots.ts):
 *   phone-chat   the hero conversation's first exchange (the question and the recall) while Vesper speaks it in real
 *                speech, Armilla behind it in its 2D twin (phones draw no WebGL avatar, 07 D8)
 *   phone-talk   Talk mode: a spoken question (the fake mic and the scripted recognizer), the reply spoken in real
 *                recorded speech and revealed with it, caught at the end of its first sentence
 * Images: docs/images/<name>.webp; raw and framed review PNGs and manifest.json in README_SHOTS_OUT (default: the
 * git-ignored .scratch/readme-shots/). The desktop shots are the Electron twin (electron/readme.shots.spec.ts).
 */
import path from 'node:path'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { clientErrors, collectPageErrors, hookCaller, waitForReady, type HookFn } from '../hooks'
import { chromiumLaunchOptions, launchServer, sameOriginHeaders, type TestServer } from '../launch'
import { AUDIO_FIXTURES } from '../stt'
import {
  assertPublishable,
  calm,
  closeComposer,
  firstSentenceShown,
  heroTurns,
  publish,
  realSpeechTts,
  seedWorld,
  speechClip,
  stillInPause,
  TALK_QUESTION,
  TALK_REPLY
} from '../readmeShots'

test.skip(!process.env.README_SHOTS, 'README screenshots: set README_SHOTS=1')
test.describe.configure({ timeout: 600_000 })

const PHONE = { width: 390, height: 844 }
const SCALE = 3
const CLIP = speechClip(12_000)

let mock: MockServer
let s: TestServer | null = null
let phoneBrowser: Browser | null = null
let phone: BrowserContext | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  realSpeechTts(mock)
})
test.afterEach(async () => {
  await phone?.close().catch(() => undefined)
  await phoneBrowser?.close().catch(() => undefined)
  phone = null
  phoneBrowser = null
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await closeComposer()
  await mock?.close()
})

/**
 * A phone on the same server, signed in as a browser device: its own headless Chromium on the GPU (the software
 * rasterizer tiles the presence's soft glow at DPR 3) with the fake microphone, and a mobile context (DPR 3, touch).
 */
async function openPhone(srv: TestServer, errors: string[]): Promise<{ page: Page; hook: HookFn }> {
  phoneBrowser = await chromium.launch({
    headless: true,
    args: [
      '--mute-audio',
      '--enable-gpu',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(AUDIO_FIXTURES, 'hello.wav')}%noloop`
    ],
    ...chromiumLaunchOptions()
  })
  phone = await phoneBrowser.newContext({ baseURL: srv.url, viewport: PHONE, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true })
  const r = await phone.request.post(`${srv.url}/api/test/login-as`, { data: { kind: 'browser' }, headers: sameOriginHeaders(srv.url, '') })
  expect(r.ok(), await r.text()).toBe(true)
  const page = await phone.newPage()
  collectPageErrors(page, errors)
  await page.goto(srv.url)
  await waitForReady(page)
  return { page, hook: hookCaller(page) }
}

async function go(page: Page, hook: HookFn, p: string): Promise<void> {
  await hook('go', p)
  await waitForReady(page)
}

/** The 2D twin draws the voice: wait for a loud moment. */
async function loud(hook: HookFn): Promise<void> {
  await expect.poll(async () => (await hook<{ last: { env: number } | null }>('presence.armilla')).last?.env ?? 0, { timeout: 15_000, intervals: [30] }).toBeGreaterThan(0.4)
}

/** A loud moment whose horizon swings clearly (when the twin reports its wave). */
async function swinging(hook: HookFn): Promise<void> {
  await expect
    .poll(
      async () => {
        const env = (await hook<{ last: { env: number } | null }>('presence.armilla')).last?.env ?? 0
        const w = await hook<{ heights: number[] } | null>('presence.armillaWave', 96)
        return env > 0.4 && (!w || Math.max(...w.heights.map(Math.abs)) > 0.45)
      },
      { timeout: 20_000, intervals: [30] }
    )
    .toBe(true)
}

test('README: the phone', async () => {
  s = await launchServer({ mock, env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: TALK_QUESTION } })
  const srv = s
  await srv.waitHook('ws.connected')
  const desk = await srv.login('desktop')
  const world = await seedWorld({ page: srv.page, api: desk.api, hook: srv.hook, waitReady: srv.waitReady }, mock)
  // Only the recall: the whole exchange fits a phone screen, read from its start, and is what Vesper is saying.
  await heroTurns({ page: srv.page, api: desk.api, hook: srv.hook, waitReady: srv.waitReady }, mock, world.uid.hero, { recallOnly: true })
  // The top of the visibility range (200 %): the 2D presence still reads at the README's phone size.
  expect((await desk.api('PATCH', '/api/settings', { appearance: { star: { visibility: 2 } } })).status).toBe(200)

  const errors: string[] = []
  const { page, hook } = await openPhone(srv, errors)
  await hook('presence.setFocus', true)
  await hook('audio.unlock')
  const shot = { width: PHONE.width, height: PHONE.height, scale: SCALE, kind: 'phone' as const, theme: 'dark' as const }

  // 1 · The hero conversation's first exchange, from its start, while Vesper speaks it.
  await go(page, hook, `/s/${world.uid.hero}`)
  await expect.poll(async () => (await hook<{ armilla2d?: boolean }>('presence.surface')).armilla2d).toBe(true)
  await page.waitForTimeout(1200)
  const scrolled = (): Promise<number> =>
    page.locator('article.msg').first().evaluate((el) => {
      let sc: HTMLElement | null = el.parentElement
      while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
      return sc?.scrollTop ?? 0
    })
  expect(await scrolled(), 'the phone chat shows its start').toBe(0)
  await calm(page)
  await hook('presence.speakWav', CLIP.b64, CLIP.ms)
  await swinging(hook)
  expect(await scrolled(), 'the phone chat stays at its start').toBe(0)
  await assertPublishable(page, 'phone-chat')
  await publish({
    ...shot,
    name: 'phone-chat',
    png: await page.screenshot({ caret: 'hide' }),
    shows: 'Phone (390×844, avatar visibility 200 %): the hero conversation’s first exchange, the question and the recall with "Remembered · 2", while Vesper speaks it; the 2D presence behind the messages.',
    alt: 'Vesper on a phone: the chat about Saturday plans, where Vesper remembers the restaurant from an earlier chat, with the presence speaking behind the messages'
  })
  await hook('audio.stop')

  // 2 · Talk mode on the phone, caught at the reply's first full stop.
  mock.llm.script({ text: TALK_REPLY })
  await hook('audio.clearEvents')
  await go(page, hook, `/talk/${world.uid.bread}`)
  await calm(page)
  const since = await firstSentenceShown(hook)
  await loud(hook)
  await assertPublishable(page, 'phone-talk')
  const talk = await page.screenshot({ caret: 'hide' })
  stillInPause(since)
  await publish({
    ...shot,
    name: 'phone-talk',
    png: talk,
    shows: 'Phone (390×844): Talk mode while Vesper speaks its reply, with live captions (the question, and the reply up to its first full stop).',
    alt: 'Talk mode on a phone: the presence speaking, the captions of a spoken question and its answer, and the talk controls'
  })
  await hook('audio.stop')
  expect([...errors, ...(await clientErrors(page))]).toEqual([])
  await srv.assertNoErrors()
})
