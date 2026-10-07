/**
 * v11 design pass — Armilla (the resonant armillary avatar) on the REAL GPU in the desktop window (the launcher puts
 * it on the secondary display, click-through, never focused). Opt-in: ARMILLA_SHOTS=1 (a review aid, not a gate).
 * ARMILLA_PASS=quick takes a handful of stills at 1440×900; the full pass takes every state × theme × accent at
 * 1440×900 and 1138×608, the 2D fallback at 390×844, frame sequences, and the cost measurements.
 * Images land in ARMILLA_OUT (default: the main checkout's git-ignored .scratch/v11-design/v11-d3/).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchApp, type TestApp } from '../launch'
import { AUDIO_FIXTURES } from '../stt'

const OUT = process.env.ARMILLA_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v11-design\\v11-d3'
const PASS = process.env.ARMILLA_PASS ?? 'full'

test.skip(!process.env.ARMILLA_SHOTS, 'design pass: set ARMILLA_SHOTS=1')
test.describe.configure({ timeout: 1_800_000 })

let mock: MockServer
let t: TestApp | null = null
const tmpFiles: string[] = []

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
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

// ── WAV helpers (16-bit mono) ─────────────────────────────────────────────────────────────────────────
function readPcm(file: string): { rate: number; pcm: Int16Array } {
  const b = fs.readFileSync(file)
  let off = 12
  let rate = 16000
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') {
      const pcm = new Int16Array(size / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(off + 8 + i * 2)
      return { rate, pcm }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${file}`)
}

function wav(pcm: Int16Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + pcm.length * 2, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2)
  return b
}

function scaled(pcm: Int16Array, gain: number): Int16Array {
  const o = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)))
  return o
}

function concat(parts: Int16Array[]): Int16Array {
  const o = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
  let k = 0
  for (const p of parts) {
    o.set(p, k)
    k += p.length
  }
  return o
}

const hello = readPcm(path.join(AUDIO_FIXTURES, 'hello.wav'))
const search = readPcm(path.join(AUDIO_FIXTURES, 'search.wav'))
const silence = (s: number, rate: number): Int16Array => new Int16Array(Math.round(s * rate))

/** The fake microphone: the owner speaking softly, a pause, then clearly (it loops). */
function micWav(): string {
  const f = path.join(os.tmpdir(), `armilla-mic-${process.pid}.wav`)
  fs.writeFileSync(f, wav(concat([scaled(hello.pcm, 0.12), silence(0.6, hello.rate), scaled(hello.pcm, 1.0), silence(0.6, hello.rate)]), hello.rate))
  tmpFiles.push(f)
  return f
}

/** Real speech for the AI voice: loud (hello + search) and quiet (search at a low gain). */
const LOUD = { b64: wav(concat([hello.pcm, silence(0.3, hello.rate), search.pcm]), hello.rate).toString('base64'), ms: ((hello.pcm.length + search.pcm.length) / hello.rate) * 1000 + 300 }
const QUIET = { b64: wav(concat([scaled(search.pcm, 0.16), scaled(hello.pcm, 0.16)]), hello.rate).toString('base64'), ms: ((hello.pcm.length + search.pcm.length) / hello.rate) * 1000 }

// ── page helpers ─────────────────────────────────────────────────────────────────────────────────────
interface Probe {
  frames: number
  cpuMs: number[]
  gpuMs: number[]
  last: { env: number; micEnv: number; onset: number; pulses: number; bright: number } | null
}

async function probe(app: TestApp): Promise<Probe> {
  return app.hook<Probe>('presence.armilla')
}

async function waitFor(app: TestApp, pred: (p: Probe) => boolean, timeout = 15_000): Promise<Probe> {
  const end = Date.now() + timeout
  for (;;) {
    const p = await probe(app)
    if (pred(p)) return p
    if (Date.now() > end) throw new Error(`probe condition not met: ${JSON.stringify(p.last)}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function starBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.locator('.star-slot').first().boundingBox()
}

async function shot(page: Page, name: string, close = false): Promise<void> {
  const file = path.join(OUT, name)
  if (close) {
    const box = await starBox(page)
    if (box) {
      await page.screenshot({ path: file, clip: box })
      return
    }
  }
  await page.screenshot({ path: file })
}

async function setup(size: string, style: 'armilla' | 'minimal2d' = 'armilla'): Promise<TestApp> {
  const app = await launchApp({ mock, size, fakeMic: micWav(), env: { VESPER_STT_FAKE: '1' } })
  await app.waitHook('presence.surface')
  await app.hook('go', '/presence-lab')
  await app.waitReady()
  await app.hook('presence.setFocus', true)
  await app.hook('presence.setPrefs', { style, quality: 'high' })
  await app.hook('presenceLab.setChrome', false)
  await app.hook('audio.unlock')
  return app
}

async function speak(app: TestApp, which: typeof LOUD): Promise<void> {
  await app.hook('presence.speakWav', which.b64, which.ms)
}

/** Every state of one theme × accent. */
async function statePass(app: TestApp, tag: string, close: boolean): Promise<void> {
  const page = app.page
  const lab = (s: string): Promise<unknown> => app.hook('presenceLab.setState', s)
  await lab('idle')
  await page.waitForTimeout(1600)
  await shot(page, `rest-${tag}.png`, close)
  await lab('thinking')
  await page.waitForTimeout(1800)
  await shot(page, `thinking-${tag}.png`, close)
  // Listening: the real (fake) microphone, soft then clear.
  await lab('listening')
  await app.hook('presence.mic', true)
  await page.waitForTimeout(1800)
  await waitFor(app, (p) => !!p.last && p.last.micEnv > 0.08 && p.last.micEnv < 0.35, 25_000)
  await page.waitForTimeout(120)
  await shot(page, `listening-low-${tag}.png`, close)
  await waitFor(app, (p) => !!p.last && p.last.micEnv > 0.62, 25_000)
  await shot(page, `listening-high-${tag}.png`, close)
  await app.hook('presence.mic', false)
  // Speaking: real speech through the AudioEngine.
  await lab('speaking')
  await speak(app, QUIET)
  await waitFor(app, (p) => !!p.last && p.last.env > 0.15, 10_000)
  await page.waitForTimeout(900)
  await shot(page, `speaking-quiet-${tag}.png`, close)
  await app.hook('audio.stop')
  await speak(app, LOUD)
  await waitFor(app, (p) => !!p.last && p.last.env > 0.55, 10_000)
  await page.waitForTimeout(700)
  await shot(page, `speaking-loud-${tag}.png`, close)
  const before = (await probe(app)).last?.pulses ?? 0
  await waitFor(app, (p) => (p.last?.pulses ?? 0) > before, 10_000)
  await page.waitForTimeout(90)
  await shot(page, `speaking-onset-${tag}.png`, close)
  await app.hook('audio.stop')
  await lab('idle')
}

/** ~12 frames over 2 s of one state (clipped to the presence for speed). */
async function sequence(app: TestApp, tag: string): Promise<void> {
  const box = await starBox(app.page)
  const t0 = Date.now()
  for (let i = 0; i < 12; i++) {
    const due = t0 + i * 166
    const wait = due - Date.now()
    if (wait > 0) await app.page.waitForTimeout(wait)
    const ms = Date.now() - t0
    await app.page.screenshot({ path: path.join(OUT, 'seq', `${tag}-${String(i).padStart(2, '0')}-${ms}ms.png`), clip: box ?? undefined })
  }
}

test('Armilla: design captures on the real GPU', async () => {
  fs.mkdirSync(path.join(OUT, 'seq'), { recursive: true })
  const log: string[] = []

  if (PASS === 'debug') {
    t = await setup('1440x900')
    await t.hook('presenceLab.setSize', 620)
    await t.hook('presenceLab.setState', 'speaking')
    await t.hook('presence.armillaInject', { out: { rms: 0.8, low: 0.8, mid: 0.6, high: 0.3, onset: 0 } })
    await t.hook('presence.armillaDebug', true)
    await t.page.waitForTimeout(3000)
    await shot(t.page, 'debug.png')
    await t.hook('presence.armillaInject', null)
    console.log(JSON.stringify((await probe(t)).last))
    return
  }
  if (PASS === 'quick2d') {
    t = await setup('390x844')
    await t.hook('presenceLab.setSize', 340)
    for (const theme of ['dark', 'light'] as const) {
      await t.hook('presence.appearance', { theme, accent: 'gold' })
      await statePass(t, `q2d-${theme}-gold`, false)
    }
    await t.assertNoErrors()
    return
  }
  if (PASS === 'quick') {
    t = await setup('1440x900')
    await t.hook('presenceLab.setSize', 620)
    await t.hook('presence.appearance', { theme: 'dark', accent: 'gold' })
    await statePass(t, 'q-dark-gold', false)
    await t.hook('presence.appearance', { theme: 'light', accent: 'gold' })
    await statePass(t, 'q-light-gold', false)
    await t.hook('presenceLab.setBackdrop', true)
    for (const theme of ['dark', 'light'] as const) {
      await t.hook('presence.appearance', { theme, accent: 'gold' })
      await t.hook('presenceLab.setState', 'speaking')
      await speak(t, LOUD)
      await waitFor(t, (p) => !!p.last && p.last.env > 0.55)
      await t.page.waitForTimeout(600)
      await shot(t.page, `q-behind-text-speaking-${theme}.png`)
      await t.hook('audio.stop')
      await t.hook('presenceLab.setState', 'idle')
      await t.page.waitForTimeout(1200)
      await shot(t.page, `q-behind-text-rest-${theme}.png`)
    }
    await t.assertNoErrors()
    return
  }

  for (const size of ['1440x900', '1138x608']) {
    t = await setup(size)
    const h = Number(size.split('x')[1])
    await t.hook('presenceLab.setSize', Math.round(h * 0.7))
    for (const theme of ['dark', 'light'] as const) {
      for (const accent of ['gold', 'ice'] as const) {
        await t.hook('presence.appearance', { theme, accent })
        await statePass(t, `${theme}-${accent}-${size}`, false)
      }
    }
    if (size === '1440x900') {
      // The other accents, dark + light, speaking (the busiest state).
      for (const theme of ['dark', 'light'] as const) {
        for (const accent of ['violet', 'rose', 'aurora'] as const) {
          await t.hook('presence.appearance', { theme, accent })
          await t.hook('presenceLab.setState', 'speaking')
          await speak(t, LOUD)
          await waitFor(t, (p) => !!p.last && p.last.env > 0.55)
          await t.page.waitForTimeout(600)
          await shot(t.page, `accent-${accent}-${theme}-speaking.png`, true)
          await t.hook('audio.stop')
          await t.hook('presenceLab.setState', 'idle')
          await t.page.waitForTimeout(900)
          await shot(t.page, `accent-${accent}-${theme}-rest.png`, true)
        }
      }
      // Frame sequences: speaking and listening, dark gold.
      await t.hook('presence.appearance', { theme: 'dark', accent: 'gold' })
      await t.hook('presenceLab.setState', 'speaking')
      await speak(t, LOUD)
      await waitFor(t, (p) => !!p.last && p.last.env > 0.4)
      await sequence(t, 'speaking-dark-gold')
      await t.hook('audio.stop')
      await t.hook('presenceLab.setState', 'listening')
      await t.hook('presence.mic', true)
      await waitFor(t, (p) => !!p.last && p.last.micEnv > 0.5, 25_000)
      await sequence(t, 'listening-dark-gold')
      await t.hook('presence.mic', false)
      await t.hook('presence.appearance', { theme: 'light', accent: 'violet' })
      await t.hook('presenceLab.setState', 'speaking')
      await speak(t, LOUD)
      await waitFor(t, (p) => !!p.last && p.last.env > 0.4)
      await sequence(t, 'speaking-light-violet')
      await t.hook('audio.stop')

      // Behind text: the avatar's real home, dimmed, dark + light.
      await t.hook('presenceLab.setBackdrop', true)
      for (const theme of ['dark', 'light'] as const) {
        await t.hook('presence.appearance', { theme, accent: 'gold' })
        await t.hook('presenceLab.setState', 'idle')
        await t.page.waitForTimeout(1200)
        await shot(t.page, `behind-text-rest-${theme}.png`)
        await t.hook('presenceLab.setState', 'speaking')
        await speak(t, LOUD)
        await waitFor(t, (p) => !!p.last && p.last.env > 0.55)
        await t.page.waitForTimeout(600)
        await shot(t.page, `behind-text-speaking-${theme}.png`)
        await t.hook('audio.stop')
        await t.hook('presenceLab.setState', 'listening')
        await t.hook('presence.mic', true)
        await waitFor(t, (p) => !!p.last && p.last.micEnv > 0.6, 25_000)
        await shot(t.page, `behind-text-listening-${theme}.png`)
        await t.hook('presence.mic', false)
      }
      await t.hook('presenceLab.setBackdrop', false)

      // Reduced motion and low quality (integrated GPUs).
      await t.hook('presence.appearance', { theme: 'dark', accent: 'gold' })
      await t.hook('presence.setPrefs', { style: 'armilla', quality: 'low' })
      await t.hook('presenceLab.setState', 'speaking')
      await speak(t, LOUD)
      await waitFor(t, (p) => !!p.last && p.last.env > 0.55)
      await t.page.waitForTimeout(500)
      await shot(t.page, `quality-low-speaking-dark.png`, true)
      await t.hook('audio.stop')
      await t.hook('presence.setPrefs', { style: 'armilla', quality: 'high', motion: 'reduced' })
      for (const st of ['idle', 'listening', 'thinking']) {
        await t.hook('presenceLab.setState', st)
        await t.page.waitForTimeout(1500)
        await shot(t.page, `reduced-${st}-dark.png`, true)
      }
      await t.hook('presenceLab.setState', 'speaking')
      await speak(t, LOUD)
      await waitFor(t, (p) => !!p.last && p.last.env > 0.5)
      await t.page.waitForTimeout(500)
      await shot(t.page, `reduced-speaking-dark.png`, true)
      await t.hook('audio.stop')
      await t.hook('presence.setPrefs', { style: 'armilla', quality: 'high', motion: 'full' })

      // Cost: CPU of the renderer main thread while speaking (07 D4 ≤ 6 % of a core), the avatar's own per-frame JS,
      // GPU time per frame (timer queries), and rest = 0 frames.
      const cdp = await t.page.context().newCDPSession(t.page)
      await cdp.send('Performance.enable')
      const task = async (): Promise<number> => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
      for (const [label, q] of [
        ['high', 'high'],
        ['low', 'low']
      ] as const) {
        await t.hook('presence.setPrefs', { style: 'armilla', quality: q })
        await t.hook('presenceLab.setState', 'speaking')
        await t.page.waitForTimeout(400)
        await t.hook('presence.armillaTiming', true)
        await speak(t, LOUD)
        await t.page.waitForTimeout(500)
        await t.hook('presence.armillaReset')
        await t.hook('presence.resetFrames')
        const c0 = await task()
        await t.page.waitForTimeout(3000)
        const cpu = (await task()) - c0
        const pr = await probe(t)
        const fr = await t.hook<{ frames: number; budget: { fps: number } }>('presence.frames')
        const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN)
        log.push(
          `speaking ${label} @1440x900 (lab 630 px): renderer main thread ${(cpu / 30).toFixed(2)} % of a core over 3 s; ` +
            `${fr.frames} frames (budget ${fr.budget.fps} fps); avatar JS per frame median ${med(pr.cpuMs).toFixed(3)} ms; ` +
            `GPU per frame median ${med(pr.gpuMs).toFixed(3)} ms (n=${pr.gpuMs.length})`
        )
        await t.hook('presence.armillaTiming', false)
        await t.hook('audio.stop')
      }
      await t.hook('presence.setPrefs', { style: 'armilla', quality: 'high' })
      // Behind text at full window size (the biggest canvas).
      await t.hook('presenceLab.setBackdrop', true)
      await t.hook('presenceLab.setState', 'speaking')
      await t.page.waitForTimeout(400)
      await t.hook('presence.armillaTiming', true)
      await speak(t, LOUD)
      await t.page.waitForTimeout(500)
      await t.hook('presence.armillaReset')
      const c1 = await task()
      await t.page.waitForTimeout(3000)
      const cpu1 = (await task()) - c1
      const pr1 = await probe(t)
      const med1 = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN)
      log.push(`speaking high, behind text full window 1440x900: renderer ${(cpu1 / 30).toFixed(2)} % of a core; GPU median ${med1(pr1.gpuMs).toFixed(3)} ms`)
      await t.hook('presence.armillaTiming', false)
      await t.hook('audio.stop')
      await t.hook('presenceLab.setBackdrop', false)
      // Rest: after the idle window the loop stops (0 frames), the last frame kept.
      await t.hook('presenceLab.setState', 'idle')
      await expect.poll(async () => (await t!.hook<{ running: boolean }>('presence.frames')).running, { timeout: 30_000, intervals: [500] }).toBe(false)
      await t.hook('presence.resetFrames')
      const r0 = await task()
      await t.page.waitForTimeout(2000)
      const rest = (await task()) - r0
      const frs = await t.hook<{ frames: number; callbacks: number }>('presence.frames')
      log.push(`rest: ${frs.frames} frames, ${frs.callbacks} rAF callbacks over 2 s; renderer ${(rest / 20).toFixed(2)} % of a core`)
      await shot(t.page, 'rest-after-idle-dark-gold.png', true)
    }
    await t.assertNoErrors()
    await t.close()
    t = null
  }

  // The 2D fallback (no WebGL) at phone size.
  t = await setup('390x844')
  await t.hook('presenceLab.setSize', 340)
  for (const theme of ['dark', 'light'] as const) {
    for (const accent of ['gold', 'ice'] as const) {
      await t.hook('presence.appearance', { theme, accent })
      await statePass(t, `2d-${theme}-${accent}-390x844`, false)
    }
  }
  await t.hook('presence.appearance', { theme: 'dark', accent: 'gold' })
  await t.hook('presenceLab.setState', 'speaking')
  await speak(t, LOUD)
  await waitFor(t, (p) => !!p.last || true)
  await t.page.waitForTimeout(400)
  await sequence(t, '2d-speaking-dark-gold')
  await t.hook('audio.stop')
  await t.assertNoErrors()

  fs.writeFileSync(path.join(OUT, 'costs.txt'), log.join('\n') + '\n')
  console.log(log.join('\n'))
})
