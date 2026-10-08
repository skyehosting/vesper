/**
 * README screenshots of the desktop app on the REAL GPU (opt-in: README_SHOTS=1). The window sits on the secondary
 * display (the launcher's dev-window placement, click-through, never focused) at 1440×900 and is captured at DPR 2
 * through CDP device metrics. One invented world (../readmeShots.ts), shot in this order so the sidebar stays as seeded
 * until the end:
 *   hero-dark               the hero conversation while Vesper speaks real speech (the horizon is its waveform)
 *   memory                  the memory viewer: a word search across chats (each tab kept raw for review)
 *   appearance              a detail of Settings → Presence & appearance: the live preview with "Preview speaking"
 *                           playing, the sliders and every avatar style (laid out taller than the window)
 *   privacy                 a detail of Settings → Privacy: how many services receive text, and the first one's
 *                           sends / keeps / opt out
 *   empty-chat              a new chat: Armilla large over the greeting
 *   talk-mode               Talk mode: a spoken question (the fake mic and the scripted recognizer), the reply spoken
 *                           in real recorded speech and revealed with it, caught at the end of its first sentence
 *   setup                   the setup wizard's welcome (Quick start or guided)
 * Images: docs/images/<name>.webp; raw and framed review PNGs and manifest.json in README_SHOTS_OUT (default: the
 * git-ignored .scratch/readme-shots/). The phone shots are the browser twin (browser/readme.shots.spec.ts).
 */
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, type TestApp } from '../launch'
import { AUDIO_FIXTURES } from '../stt'
import {
  assertPublishable,
  calm,
  closeComposer,
  cssSize,
  cutAtTop,
  detailClip,
  firstSentenceShown,
  heroTurns,
  hiDpi,
  keepRaw,
  publish,
  realSpeechTts,
  scrollIntoPlace,
  seedWorld,
  speechClip,
  stillInPause,
  TALK_QUESTION,
  TALK_REPLY,
  type Clip,
  type Driver
} from '../readmeShots'

test.skip(!process.env.README_SHOTS, 'README screenshots: set README_SHOTS=1')
test.describe.configure({ timeout: 900_000 })

/** Device pixels per CSS pixel of the published desktop images (the README column is ~900 CSS px; retina doubles it). */
const SCALE = 2
/** CSS height the appearance page is laid out at for its detail (the preview, the sliders and all five styles). */
const APPEARANCE_HEIGHT = 1320
const CLIP = speechClip(12_000)

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  realSpeechTts(mock)
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await closeComposer()
  await mock?.close()
})

interface Probe {
  last: { env: number } | null
}

/**
 * A clear moment of the voice: loud, moving along most of the horizon's front (`share`) and swinging well away from
 * the ring (`swing`, of full scale), all in the same frame.
 */
async function speaking(d: Driver, o: { share?: number; swing?: number } = {}): Promise<void> {
  const share = o.share ?? 0.55
  const swing = o.swing ?? 0.5
  await expect
    .poll(
      async () => {
        const env = (await d.hook<Probe>('presence.armilla')).last?.env ?? 0
        const w = await d.hook<{ heights: number[] } | null>('presence.armillaWave', 96)
        if (!w) return false
        const moving = w.heights.filter((h) => Math.abs(h) > 0.02).length / w.heights.length
        return env > 0.4 && moving > share && Math.max(...w.heights.map(Math.abs)) > swing
      },
      { timeout: 20_000, intervals: [30] }
    )
    .toBe(true)
}

async function theme(app: TestApp, th: 'dark' | 'light'): Promise<void> {
  expect((await app.api('PATCH', '/api/settings', { appearance: { theme: th } })).status).toBe(200)
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', th)
  await app.page.waitForTimeout(700)
}

async function go(app: TestApp, p: string): Promise<void> {
  await app.hook('go', p)
  await app.waitReady()
}

test('README: the desktop app', async () => {
  t = await launchApp({
    mock,
    size: '1440x900',
    fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'),
    env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: TALK_QUESTION }
  })
  const app = t
  const page = app.page
  await app.waitHook('presence.surface')
  const world = await seedWorld(app, mock)
  await app.hook('presence.setFocus', true)
  await app.hook('audio.unlock')
  const hd = await hiDpi(page, SCALE, app.hook)
  const desktop = { width: 1440, height: 900, scale: SCALE, kind: 'desktop' as const }

  // 1 · The hero: a conversation while Vesper speaks (dark; the README shows only images it uses, so no light twin).
  await go(app, `/s/${world.uid.hero}`)
  await heroTurns(app, mock, world.uid.hero)
  await page.waitForTimeout(1500)
  await theme(app, 'dark')
  expect((await app.api('PATCH', '/api/settings', { appearance: { star: { visibility: 1.5 } } })).status).toBe(200)
  await page.waitForTimeout(400)
  await calm(page)
  await app.hook('presence.speakWav', CLIP.b64, CLIP.ms)
  await speaking(app)
  await assertPublishable(page, 'hero-dark')
  expect(await cutAtTop(page), 'the hero starts on a clean edge').toBe(false)
  const heroPng = await hd.capture()
  await app.hook('audio.stop')
  await publish({
    ...desktop,
    name: 'hero-dark',
    png: heroPng,
    theme: 'dark',
    shows: `Desktop app, dark theme (avatar visibility 150 %): a conversation in which Vesper recalls a restaurant from an earlier chat ("Remembered · 2") and plans a day, while it speaks (the horizon draws the voice's waveform); sidebar with chats grouped by day, one pinned, three linked.`,
    alt: 'Vesper on Windows: a chat where Vesper remembers a restaurant from an earlier conversation and suggests a plan for Saturday, with the Armilla presence speaking behind the messages and the chat list on the left'
  })
  await page.waitForTimeout(400)

  // 2 · The memory viewer: every tab kept for review; published: a word search that finds the book club chat.
  for (const tab of ['sessions', 'about', 'timeline'] as const) {
    await go(app, `/memory/${tab}`)
    await calm(page)
    await page.waitForTimeout(700)
    await assertPublishable(page, `memory-${tab}`)
    keepRaw(`memory-${tab}`, await hd.capture())
  }
  // The timeline reads its filters from the URL when it mounts: come back to it from another page.
  await go(app, '/settings')
  await go(app, '/memory?q=Hartley')
  await expect(page.getByRole('searchbox', { name: 'Search memory' })).toHaveValue('Hartley')
  await calm(page)
  await page.waitForTimeout(700)
  await assertPublishable(page, 'memory')
  await publish({
    ...desktop,
    name: 'memory',
    png: await hd.capture(),
    theme: 'dark',
    shows: 'The memory viewer: a word search over every chat finds the street in today’s chat, the book club notes from days earlier and a chat from weeks ago.',
    alt: 'The memory viewer: searching remembered messages for “Hartley” finds today’s chat, the book club notes from earlier in the week and a herb garden chat from three weeks ago, each with its time and chat ID'
  })

  // 3 · Settings → Presence & appearance, a detail: the one canvas moved into the preview with "Preview speaking"
  // playing, the visibility at 150 % (seeded), and every style. Taller than the window holds, so it is laid out taller.
  await go(app, '/settings/appearance')
  await expect.poll(async () => (await app.hook<{ kind: string | null }>('presence.surface')).kind).toBe('preview')
  await hd.height(APPEARANCE_HEIGHT)
  await scrollIntoPlace(page, 'text="The Star"', 36)
  await page.getByRole('button', { name: 'Preview speaking' }).click()
  await calm(page)
  await speaking(app, { share: 0.5, swing: 0.35 })
  await assertPublishable(page, 'appearance')
  // From the group's title to the style cards (the group above ends ~26 px over the title; the row's divider sits
  // 15 px below the cards).
  const look = (): Promise<Clip> => detailClip(page, { top: 'text="The Star"', bottom: '.star-styles', across: '.avatar-preview', padTop: 18, padBottom: 12 })
  const lookPng = await hd.capture(look)
  await publish({
    ...cssSize(lookPng, SCALE),
    scale: SCALE,
    kind: 'detail',
    name: 'appearance',
    png: lookPng,
    theme: 'dark',
    shows: 'A detail of Settings → Presence & appearance: the live avatar preview speaking behind a sample message, Avatar visibility at 150 % and size at 100 %, and the five avatar styles (Armilla, Orb, Nebula, 2D star, None).',
    alt: 'Settings, Presence and appearance: a live preview of the Armilla avatar speaking behind a sample message, sliders for its visibility and size, and the five avatar styles to choose from'
  })
  await app.hook('audio.stop')
  await hd.height()

  // 4 · Settings → Privacy, a detail: the headline count, then the first service and what it receives and keeps.
  await go(app, '/settings/privacy')
  await calm(page)
  await page.waitForTimeout(500)
  await assertPublishable(page, 'privacy')
  // The page head spans the content column (its badge sits at the right edge, as the service cards do); the detail
  // stops above the card's source links (~15 px under the table).
  const priv = (): Promise<Clip> =>
    detailClip(page, { top: '#settings-body .mp__head', bottom: '[data-testid="privacy-service"] .psvc__facts', across: '#settings-body .mp__head', padBottom: 10 })
  const privPng = await hd.capture(priv)
  await publish({
    ...cssSize(privPng, SCALE),
    scale: SCALE,
    kind: 'detail',
    name: 'privacy',
    png: privPng,
    theme: 'dark',
    shows: 'A detail of Settings → Privacy: "3 services receive text", then the first service in use (Anthropic, for AI replies) with its chips (Leaves this PC, Not used for training) and what it sends, keeps and how to opt out.',
    alt: 'Settings, Privacy: three services receive text; the first, Anthropic for AI replies, is marked as leaving this PC and not used for training, with what it is sent, how long it keeps it and how to opt out'
  })

  // 5 · A new chat: Armilla large over the greeting (before Talk mode, which moves its chat to the top of the list).
  await go(app, `/s/${world.uid.hero}`)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect.poll(() => app.hook<string>('route')).not.toBe(`/s/${world.uid.hero}`)
  await app.waitReady()
  await calm(page)
  await page.waitForTimeout(2200)
  await assertPublishable(page, 'empty-chat')
  await publish({
    ...desktop,
    name: 'empty-chat',
    png: await hd.capture(),
    theme: 'dark',
    shows: 'A new, empty chat: the Armilla presence large behind the greeting.',
    alt: 'A new chat in Vesper: the Armilla presence, a slowly turning armillary sphere, large behind the greeting'
  })

  // 6 · Talk mode: a spoken question, the reply spoken in real recorded speech, caught at its first full stop.
  mock.llm.script({ text: TALK_REPLY })
  await app.hook('audio.clearEvents')
  await go(app, `/talk/${world.uid.bread}`)
  await calm(page)
  const since = await firstSentenceShown(app.hook)
  await speaking(app, { share: 0.5, swing: 0 })
  await assertPublishable(page, 'talk-mode')
  const talk = await hd.capture()
  stillInPause(since)
  await publish({
    ...desktop,
    name: 'talk-mode',
    png: talk,
    theme: 'dark',
    shows: 'Talk mode: the presence full size while Vesper speaks its reply, with live captions (the question, and the reply revealed with the voice up to its first full stop) and the controls.',
    alt: 'Talk mode: a calm full-window view with the Armilla presence speaking its answer about baking banana bread, live captions and the mute, hold, interrupt and end controls'
  })
  await app.hook('audio.stop')

  // 7 · The setup wizard's welcome (last: running it again marks setup as in progress).
  await go(app, '/setup?rerun=1')
  await page.getByText('Quick start', { exact: true }).click()
  await calm(page)
  await page.waitForTimeout(800)
  await assertPublishable(page, 'setup')
  await publish({
    ...desktop,
    name: 'setup',
    png: await hd.capture(),
    theme: 'dark',
    shows: 'The setup wizard welcome with Quick start chosen (guided setup is the other way).',
    alt: 'The setup wizard: Quick start connects an AI service in about a minute; guided setup also covers you, memory, voice, other devices and the look'
  })
  await hd.done()
  await app.assertNoErrors()
})
