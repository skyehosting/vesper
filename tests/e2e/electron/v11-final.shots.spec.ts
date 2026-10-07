/**
 * Vesper 1.1 owner screenshots and the presence gates on the REAL GPU (opt-in: V11_FINAL=1). The desktop window sits
 * on the secondary display (the launcher's dev-window placement, click-through, never focused):
 *   1. owner shots at 1440×900 — empty-dark-gold.png (the hero), speaking-dark.png and speaking-light.png (a
 *      conversation while the AI speaks real speech: the horizon is the waveform) — and the contrast GATE measured on
 *      the avatar layer where text sits (contrast.ts): speaking peak and thinking (comet heads), dark and light, plus
 *      the 1138×608 empty chat where the hero meets the greeting. Body text ≥ 7:1 in dark, text-2 ≥ 4.5:1 in both.
 *   2. the ring rule in pixels: three frames (quiet, loud, quiet) with the pose held still (reduced motion), diffed on
 *      the gimbals outside the horizon's band (V11_DIAG_OUT/seq).
 *   3. GPU / CPU per frame (timer queries) at 1440×900 and 1138×608, DPR 1.25 and 2, speaking and thinking, each
 *      quality; and a speaking frame at a real 2.25 DPR (hairlines).
 * The phone shot is the browser twin (browser/v11-final.shots.spec.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { measureContrast, type ContrastResult } from '../contrast'
import { configureMockLlm, wsTurn } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import { AUDIO_FIXTURES } from '../stt'

const OUT = process.env.V11_FINAL_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v11-final'
const DIAG = process.env.V11_DIAG_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v11-design\\v11-d3\\seq'
const { PNG } = createRequire(__filename)('pngjs') as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } }

test.skip(!process.env.V11_FINAL, 'v1.1 owner screenshots: set V11_FINAL=1')
test.describe.configure({ timeout: 900_000 })

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(DIAG, { recursive: true })
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

/** Real speech for the AI's voice: the fixtures' words, several times over (≈ 10 s), as a 16-bit mono WAV. */
function speech(): { b64: string; ms: number } {
  const parts = ['hello.wav', 'search.wav', 'hello.wav', 'search.wav', 'hello.wav'].map((f) => {
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

async function untilLoud(app: TestApp): Promise<void> {
  await expect.poll(async () => (await app.hook<{ last: { env: number } | null }>('presence.armilla')).last?.env ?? 0, { timeout: 10_000, intervals: [30] }).toBeGreaterThan(0.4)
}

async function open(size: string, o: { env?: Record<string, string> } = {}): Promise<TestApp> {
  const app = await launchApp({ mock, size, env: o.env })
  await app.waitHook('presence.surface')
  await configureMockLlm(app.api, mock.url)
  expect((await app.api('PATCH', '/api/settings', { performance: { gameMode: 'off' }, appearance: { theme: 'dark', accent: 'gold' } })).status).toBe(200)
  await app.hook('presence.setFocus', true)
  await app.hook('audio.unlock')
  return app
}

/** A short conversation: two turns, the AI's replies long enough to sit over the rings. */
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

/** The gate (brief §9): body text ≥ 7:1 in dark, text-1 / text-2 ≥ 4.5:1 in both themes (the app has no text-3). */
function gate(key: string, theme: 'dark' | 'light', r: ContrastResult): string[] {
  const bad: string[] = []
  const min = (tok: string): number => r.byToken[tok]?.ratio ?? Infinity
  if (min('--text-0') < (theme === 'dark' ? 7 : 4.5)) bad.push(`${key}: --text-0 ${min('--text-0')}`)
  for (const tok of ['--text-1', '--text-2']) if (min(tok) < 4.5) bad.push(`${key}: ${tok} ${min(tok)}`)
  return bad
}

test('v1.1 owner shots and the contrast gate (avatar layer where text sits)', async () => {
  t = await open('1440x900')
  const report: Record<string, ContrastResult> = {}
  const bad: string[] = []

  // 1 · The empty chat: the hero.
  const empty = (await t.api<{ uid: string }>('POST', '/api/sessions', { title: 'New chat' })).json
  await t.hook('go', `/s/${empty.uid}`)
  await t.waitReady()
  await t.page.waitForTimeout(2200)
  await t.page.screenshot({ path: path.join(OUT, 'empty-dark-gold.png') })

  // 2 · A conversation: the AI speaking (dark, then light) and thinking (comet heads).
  await conversation(t)
  for (const theme of ['dark', 'light'] as const) {
    await t.hook('presence.appearance', { theme, accent: 'gold' })
    await t.page.waitForTimeout(600)
    await t.hook('presence.speakWav', WAV.b64, WAV.ms)
    await untilLoud(t)
    await t.page.waitForTimeout(700)
    await t.page.screenshot({ path: path.join(OUT, `speaking-${theme}.png`) })
    report[`speaking-${theme}`] = await measureContrast(t.page, 6, 150)
    bad.push(...gate(`speaking-${theme}`, theme, report[`speaking-${theme}`]))
    await t.hook('audio.stop')
    await t.hook('presence.forceState', 'thinking')
    await t.page.waitForTimeout(1500)
    report[`thinking-${theme}`] = await measureContrast(t.page, 6, 170)
    bad.push(...gate(`thinking-${theme}`, theme, report[`thinking-${theme}`]))
    await t.hook('presence.forceState', null)
  }
  await t.assertNoErrors()
  await t.close()

  // 3 · The owner's 1138×608: the hero over the greeting (no cap in the dark theme).
  t = await open('1138x608')
  const e2 = (await t.api<{ uid: string }>('POST', '/api/sessions', { title: 'New chat' })).json
  await t.hook('go', `/s/${e2.uid}`)
  await t.waitReady()
  for (const theme of ['dark', 'light'] as const) {
    await t.hook('presence.appearance', { theme, accent: 'gold' })
    await t.page.waitForTimeout(1500)
    report[`hero-1138x608-${theme}`] = await measureContrast(t.page, 3, 200)
    bad.push(...gate(`hero-1138x608-${theme}`, theme, report[`hero-1138x608-${theme}`]))
  }
  await t.page.screenshot({ path: path.join(DIAG, 'hero-1138x608-light.png') })
  fs.writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify(report, null, 1))
  for (const [k, r] of Object.entries(report)) console.log(k, JSON.stringify(Object.fromEntries(Object.entries(r.byToken).map(([tok, v]) => [tok, v.ratio]))))
  expect(bad).toEqual([])
  await t.assertNoErrors()
})

test('ring rule in pixels: quiet, loud, quiet — the gimbals do not change outside the horizon band', async () => {
  t = await open('1440x900')
  await t.hook('go', '/presence-lab')
  await t.waitReady()
  await t.hook('presenceLab.setChrome', false)
  await t.hook('presenceLab.setSize', 620)
  await t.hook('presence.setPrefs', { style: 'armilla', quality: 'high', motion: 'reduced' })
  await t.hook('presenceLab.setState', 'speaking')
  const box = (await t.page.locator('.star-slot').first().boundingBox())!
  const levels = [
    { rms: 0.08, low: 0.08, mid: 0.06, high: 0.03, onset: 0 },
    { rms: 0.95, low: 0.95, mid: 0.8, high: 0.6, onset: 1 },
    { rms: 0.08, low: 0.08, mid: 0.06, high: 0.03, onset: 0 }
  ]
  const shots: Array<{ width: number; height: number; data: Buffer }> = []
  for (const [i, out] of levels.entries()) {
    await t.hook('presence.armillaInject', { out })
    await t.page.waitForTimeout(900)
    const file = path.join(DIAG, `ringdiff-${i}-${i === 1 ? 'loud' : 'quiet'}.png`)
    await t.page.screenshot({ path: file, clip: box })
    shots.push(PNG.sync.read(fs.readFileSync(file)))
  }
  await t.hook('presence.armillaInject', null)
  // Gimbal pixels: lit in any frame, outside the horizon's band (its ellipse is ±32 px tall here) and the bead.
  const { width: W, height: H } = shots[0]
  const cx = W / 2
  const cy = H / 2
  const pxPerWorld = W / 2 / 1.36
  const band = 1.25 * Math.sin((6.5 * Math.PI) / 180) * pxPerWorld + 14
  let n = 0
  let maxD = 0
  let sum = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (Math.abs(y - cy) < band || Math.hypot(x - cx, y - cy) < 0.235 * pxPerWorld * 1.6) continue
      const i = (y * W + x) * 4
      const lum = (k: number): number => shots[k].data[i] + shots[k].data[i + 1] + shots[k].data[i + 2]
      if (Math.max(lum(0), lum(1), lum(2)) < 60) continue
      n++
      const d = Math.max(...[0, 1, 2].map((c) => Math.max(Math.abs(shots[1].data[i + c] - shots[0].data[i + c]), Math.abs(shots[2].data[i + c] - shots[0].data[i + c]))))
      maxD = Math.max(maxD, d)
      sum += d
    }
  const result = { gimbalPixels: n, maxDiff: maxD, meanDiff: n ? sum / n : 0 }
  fs.writeFileSync(path.join(DIAG, 'ringdiff.json'), JSON.stringify(result, null, 1))
  console.log('ring diff (8-bit levels, gimbal pixels outside the horizon band):', JSON.stringify(result))
  expect(n).toBeGreaterThan(500)
  await t.assertNoErrors()
})

test('GPU and CPU per frame behind the chat (timer queries), and a real 2.25-DPR hairline frame', async () => {
  const rows: string[] = []
  const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN)
  for (const size of ['1440x900', '1138x608']) {
    t = await open(size)
    await conversation(t)
    for (const quality of ['low', 'medium', 'high'] as const) {
      await t.hook('presence.setPrefs', { style: 'armilla', quality })
      for (const dpr of [1.25, 2]) {
        await t.hook('presence.setDpr', dpr)
        for (const state of ['speaking', 'thinking'] as const) {
          if (state === 'speaking') await t.hook('presence.speakWav', WAV.b64, WAV.ms)
          else await t.hook('presence.forceState', 'thinking')
          await t.page.waitForTimeout(600)
          await t.hook('presence.armillaTiming', true)
          await t.page.waitForTimeout(300)
          await t.hook('presence.armillaReset')
          await t.page.waitForTimeout(2000)
          const pr = await t.hook<{ cpuMs: number[]; gpuMs: number[]; last: { resX: number; resY: number } | null }>('presence.armilla')
          rows.push(`| ${size} | ${quality} | ${dpr} | ${state} | ${pr.last ? `${pr.last.resX}×${pr.last.resY}` : '?'} | ${med(pr.gpuMs).toFixed(3)} | ${med(pr.cpuMs).toFixed(3)} | ${pr.gpuMs.length} |`)
          await t.hook('presence.armillaTiming', false)
          await t.hook('audio.stop')
          await t.hook('presence.forceState', null)
        }
      }
      await t.hook('presence.setDpr', null)
    }
    await t.assertNoErrors()
    await t.close()
    t = null
  }
  const table = ['| window | quality | DPR | state | canvas px | GPU ms (median) | avatar JS ms (median) | frames timed |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n')
  fs.writeFileSync(path.join(OUT, 'gpu.md'), `${table}\n`)
  console.log(table)

  // A real 2.25-DPR window (kept inside the secondary display by the dev-window placement): hairlines while speaking.
  t = await open('840x470', { env: { VESPER_TEST_SCALE: '2.25' } })
  await conversation(t)
  await t.hook('presence.speakWav', WAV.b64, WAV.ms)
  await untilLoud(t)
  await t.page.waitForTimeout(600)
  expect(await t.page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(2.25, 2)
  await t.page.screenshot({ path: path.join(DIAG, 'hairline-dpr2.25-speaking.png') })
  await t.hook('audio.stop')
  await t.assertNoErrors()
})
