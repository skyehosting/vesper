/**
 * Vesper 1.1.3 avatar captures on the REAL GPU (opt-in: V113_SHOTS=1). The desktop window sits on the secondary display
 * (the launcher's dev-window placement, click-through, never focused).
 *   - speaking-waveform-dark.png: a conversation while the AI speaks real speech — the horizon draws that audio's real
 *     waveform, entering at the left end and flowing right;
 *   - settings-preview-dark.png / settings-preview-light.png: Settings → Presence & appearance with "Avatar
 *     visibility" raised and "Preview speaking" playing (the one canvas moved into the preview);
 *   - the contrast measurement (contrast.ts) at the TOP of the visibility range while speaking, dark and light: message
 *     text (--text-0) ≥ 4.5:1 — the clamp's promise, measured;
 *   - V113_THUMBS=1: the style picker's stills (src/web/features/settings/previews/<style>-<theme>.png, 104×60).
 * Images land in V113_OUT (default: the main checkout's git-ignored .scratch/v113/).
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { measureContrast } from '../contrast'
import { configureMockLlm, wsTurn } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import { AUDIO_FIXTURES } from '../stt'

const OUT = process.env.V113_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v113'
const THUMBS = path.resolve(__dirname, '../../../src/web/features/settings/previews')

test.skip(!process.env.V113_SHOTS, 'v1.1.3 avatar captures: set V113_SHOTS=1')
test.describe.configure({ timeout: 900_000 })

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

/** Real speech for the AI's voice: the fixtures' words several times over, as one 16-bit mono WAV. */
function speech(): { b64: string; ms: number } {
  const parts = ['hello.wav', 'search.wav', 'hello.wav', 'search.wav', 'hello.wav', 'search.wav'].map((f) => {
    const b = fs.readFileSync(path.join(AUDIO_FIXTURES, f))
    let off = 12
    let rate = 16000
    while (off < b.length - 8) {
      const id = b.toString('ascii', off, off + 4)
      const size = b.readUInt32LE(off + 4)
      if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
      if (id === 'data') return { rate, pcm: b.subarray(off + 8, off + 8 + size) }
      off += 8 + size + (size % 2)
    }
    throw new Error(`no data in ${f}`)
  })
  const rate = parts[0].rate
  const pcm = Buffer.concat(parts.map((p) => p.pcm))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return { b64: Buffer.concat([h, pcm]).toString('base64'), ms: (pcm.length / 2 / rate) * 1000 }
}
const WAV = speech()

interface Probe {
  last: { env: number; wave: number; span: number } | null
}

async function untilLoud(app: TestApp): Promise<void> {
  await expect.poll(async () => (await app.hook<Probe>('presence.armilla')).last?.env ?? 0, { timeout: 10_000, intervals: [30] }).toBeGreaterThan(0.4)
}

/** Wait until the voice covers most of the horizon (the share of its front that moves), then a little loud moment. */
async function filled(app: TestApp, share = 0.55): Promise<void> {
  await expect
    .poll(
      async () => {
        const w = await app.hook<{ heights: number[] } | null>('presence.armillaWave', 96)
        return w ? w.heights.filter((h) => Math.abs(h) > 0.02).length / w.heights.length : 0
      },
      { timeout: 15_000, intervals: [50] }
    )
    .toBeGreaterThan(share)
}

async function open(size: string): Promise<TestApp> {
  const app = await launchApp({ mock, size })
  await app.waitHook('presence.surface')
  await configureMockLlm(app.api, mock.url)
  expect((await app.api('PATCH', '/api/settings', { performance: { gameMode: 'off' }, appearance: { theme: 'dark', accent: 'gold' } })).status).toBe(200)
  await app.hook('presence.setFocus', true)
  await app.hook('audio.unlock')
  return app
}

async function conversation(app: TestApp): Promise<string> {
  const chat = (await app.api<{ uid: string }>('POST', '/api/sessions', { title: 'Evening walk' })).json
  await app.hook('go', `/s/${chat.uid}`)
  await app.waitReady()
  mock.llm.script({
    text: 'It was a good walk. You went along the river path as far as the old mill, about four kilometres, and turned back when the light started going. You mentioned the herons by the weir and that your knee felt fine the whole way.'
  })
  await wsTurn(app.page, chat.uid, 'Can you remind me how far I walked on Sunday?')
  mock.llm.script({
    text: 'Of course. Next Sunday, try the loop past the mill and back through the orchard: about six kilometres, mostly flat. Leave around four so you are home before dark, and take the thermos — the wind picks up along the water in the evening.'
  })
  await wsTurn(app.page, chat.uid, 'Nice. Could you suggest a slightly longer route for next weekend?')
  await app.page.waitForSelector('article.msg')
  await app.page.waitForTimeout(1200)
  return chat.uid
}

async function theme(app: TestApp, th: 'dark' | 'light'): Promise<void> {
  expect((await app.api('PATCH', '/api/settings', { appearance: { theme: th } })).status).toBe(200)
  await expect(app.page.locator('html')).toHaveAttribute('data-theme', th)
  await app.page.waitForTimeout(600)
}

test('v1.1.3 avatar: the real waveform, the Settings preview, the visibility clamp measured', async () => {
  t = await open('1440x900')
  const page = t.page
  const log: string[] = []

  // 1. The AI speaking in a conversation: the real waveform crossing the horizon (dark).
  await conversation(t)
  await t.hook('presence.speakWav', WAV.b64, WAV.ms)
  await untilLoud(t)
  await filled(t)
  await untilLoud(t)
  await page.screenshot({ path: path.join(OUT, 'speaking-waveform-dark.png') })
  log.push(`probe ${JSON.stringify((await t.hook<Probe>('presence.armilla')).last)}`)
  await t.hook('audio.stop')

  // 2. The clamp, measured: the top of the visibility range while speaking — message text ≥ 4.5:1 in both themes.
  expect((await t.api('PATCH', '/api/settings', { appearance: { star: { visibility: 2 } } })).status).toBe(200)
  for (const th of ['dark', 'light'] as const) {
    await theme(t, th)
    await t.hook('presence.speakWav', WAV.b64, WAV.ms)
    await untilLoud(t)
    await page.waitForTimeout(1500)
    const r = await measureContrast(page, 6)
    log.push(`visibility 200 % ${th} speaking: ${JSON.stringify(Object.fromEntries(Object.entries(r.byToken).map(([k, v]) => [k, v.ratio])))}`)
    expect(r.byToken['--text-0']?.ratio ?? Infinity, `${th} --text-0`).toBeGreaterThanOrEqual(4.5)
    await t.hook('audio.stop')
  }

  // 3. Settings → Presence & appearance: the live preview, visibility raised, "Preview speaking" (dark, then light).
  expect((await t.api('PATCH', '/api/settings', { appearance: { star: { visibility: 1.8 } } })).status).toBe(200)
  for (const th of ['dark', 'light'] as const) {
    await theme(t, th)
    await t.hook('go', '/settings/appearance')
    await t.waitReady()
    await expect.poll(async () => (await t!.hook<{ kind: string | null }>('presence.surface')).kind).toBe('preview')
    // The preview and the visibility slider right under it, in view together.
    await page.locator('.avatar-preview').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Preview speaking' }).click()
    await untilLoud(t)
    await filled(t, 0.6)
    await page.screenshot({ path: path.join(OUT, `settings-preview-${th}.png`) })
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    await t.hook('audio.stop')
  }
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n') + '\n')
  console.log(log.join('\n'))
  await t.assertNoErrors()
})

test('v1.1.3 style picker stills (V113_THUMBS=1)', async () => {
  test.skip(!process.env.V113_THUMBS, 'set V113_THUMBS=1 to refresh the style stills')
  t = await open('1440x900')
  const page = t.page
  await t.hook('go', '/presence-lab')
  await t.waitReady()
  await t.hook('presenceLab.setChrome', false)
  for (const th of ['dark', 'light'] as const) {
    await t.hook('presence.appearance', { theme: th, accent: 'gold' })
    for (const style of ['armilla', 'orb', 'nebula', 'minimal2d'] as const) {
      const armilla = style === 'armilla'
      // Armilla fills its width (the horizon); the round styles fill the still's height.
      await t.hook('presenceLab.setSize', armilla ? 104 : 60)
      await t.hook('presence.setPrefs', { style, quality: 'high' })
      await t.hook('presenceLab.setState', 'speaking')
      await t.hook('presence.speakWav', WAV.b64, WAV.ms)
      await page.waitForTimeout(armilla ? 2600 : 1600)
      const box = (await page.locator('.star-slot').first().boundingBox())!
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.screenshot({ path: path.join(THUMBS, `${style}-${th}.png`), clip: { x: Math.round(cx - 52), y: Math.round(cy - 30), width: 104, height: 60 } })
      await t.hook('audio.stop')
      await page.waitForTimeout(300)
    }
  }
  await t.assertNoErrors()
})
