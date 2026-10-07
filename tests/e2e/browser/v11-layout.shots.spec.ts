/**
 * v11 layout review pass (opt-in: V11_SHOTS=1): the avatar behind the messages (presence <ChatBackdrop>) at 1440×900,
 * 1138×608 (the owner's monitor in DIP) and 390×844, dark and light — empty chat (first-run checklist and plain),
 * a long conversation, speaking, listening, thinking, reading, game mode, reduced motion, avatar off, Talk mode.
 *
 * It also MEASURES legibility: for every text run in the chat body it samples the pixels behind it with the text made
 * transparent (several frames while the avatar speaks — the brightest frames), and reports the worst WCAG contrast
 * ratio per text colour. The numbers land in <OUT>/contrast.json; images in <OUT>/*.png.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { RICH_REPLY } from '../chatFixtures'
import { configureMockLlm, wsTurn } from '../helpers'
import { launchServer, type TestServer } from '../launch'

// pngjs ships without types (a transitive dependency); only the sync reader is used.
interface PNG {
  width: number
  height: number
  data: Buffer
}
const { PNG } = createRequire(__filename)('pngjs') as { PNG: { sync: { read(b: Buffer): PNG } } }

const OUT = process.env.V11_OUT ?? path.resolve('test-results', 'v11-layout')
const SIZES = (process.env.V11_SIZES ?? '1440x900,1138x608,390x844').split(',').map((s) => {
  const [w, h] = s.split('x').map(Number)
  return { w, h }
})
const THEMES = (process.env.V11_THEMES ?? 'dark,light').split(',') as Array<'dark' | 'light'>

test.skip(!process.env.V11_SHOTS, 'v11 layout screenshot pass: set V11_SHOTS=1')
test.describe.configure({ timeout: Number(process.env.V11_TIMEOUT ?? 1_800_000) })

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

interface Run {
  x: number
  y: number
  w: number
  h: number
  color: [number, number, number]
  token: string
  where: string
  large: boolean
}

interface Worst {
  ratio: number
  where: string
  bg: [number, number, number]
}

type Report = Record<string, { worst: Worst | null; byToken: Record<string, Worst>; runs: number; baseline: Record<string, number> }>
const report: Report = {}

const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const lum = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** Text runs in the chat body: one rect per line box, with the run's colour and the token it uses. */
async function textRuns(page: Page): Promise<Run[]> {
  return page.evaluate(() => {
    const body = document.querySelector('.chat__body')
    if (!body) return []
    const bodyRect = body.getBoundingClientRect()
    const root = getComputedStyle(document.documentElement)
    const tokens: Record<string, string> = {}
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    for (const t of ['--text-0', '--text-1', '--text-2', '--accent-ink', '--accent']) {
      probe.style.color = root.getPropertyValue(t)
      tokens[getComputedStyle(probe).color] = t
    }
    probe.remove()
    const out: Run[] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && out.length < 1500; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim()) continue
      if (el.closest('.chat-backdrop, .sr-only, [aria-hidden="true"] .sr-only')) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(cs.color)
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.05)) continue
      // The scoped token (the backdrop lifts --text-2 in .mw): read it where the text is.
      const local = getComputedStyle(el)
      const scoped: Record<string, string> = {}
      for (const t of ['--text-0', '--text-1', '--text-2']) scoped[t] = local.getPropertyValue(t).trim()
      const range = document.createRange()
      range.selectNodeContents(n)
      const size = parseFloat(cs.fontSize)
      const bold = Number(cs.fontWeight) >= 700
      const large = size >= 24 || (bold && size >= 18.66)
      const where = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || ''}`
      let token = tokens[cs.color] ?? cs.color
      for (const [t, v] of Object.entries(scoped)) {
        probe.style.color = v
        document.body.appendChild(probe)
        if (getComputedStyle(probe).color === cs.color) token = t
        probe.remove()
      }
      for (const r of Array.from(range.getClientRects())) {
        const x0 = Math.max(r.left, bodyRect.left)
        const y0 = Math.max(r.top, bodyRect.top)
        const x1 = Math.min(r.right, bodyRect.right, window.innerWidth)
        const y1 = Math.min(r.bottom, bodyRect.bottom, window.innerHeight)
        if (x1 - x0 < 2 || y1 - y0 < 4) continue
        out.push({ x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), color: [Number(m[1]), Number(m[2]), Number(m[3])], token, where, large })
      }
    }
    return out
  })
}

const HIDE_TEXT = `.chat__body *:not(.chat-backdrop):not(.chat-backdrop *) { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; text-decoration-color: transparent !important; }
.chat__body svg { visibility: hidden !important; } .md.is-streaming *::after { visibility: hidden !important; }`

async function backgroundShot(page: Page, extraCss = ''): Promise<PNG> {
  const handle = await page.addStyleTag({ content: HIDE_TEXT + extraCss })
  await page.waitForTimeout(30)
  const buf = await page.screenshot({ animations: 'allow' })
  await handle.evaluate((el) => (el as Element).remove())
  return PNG.sync.read(buf)
}

/** Worst background luminance behind each run over `frames` captures: brightest (light text) or darkest (dark text). */
function worstFor(runs: Run[], pngs: PNG[]): Array<{ run: Run; ratio: number; bg: [number, number, number] }> {
  return runs.map((run) => {
    const tl = lum(...run.color)
    let worst = Infinity
    let bg: [number, number, number] = [0, 0, 0]
    for (const png of pngs) {
      const W = png.width
      for (let y = run.y; y < run.y + run.h && y < png.height; y++) {
        for (let x = run.x; x < run.x + run.w && x < W; x++) {
          const i = (y * W + x) * 4
          const r = png.data[i]
          const g = png.data[i + 1]
          const b = png.data[i + 2]
          const c = ratio(tl, lum(r, g, b))
          if (c < worst) {
            worst = c
            bg = [r, g, b]
          }
        }
      }
    }
    return { run, ratio: worst, bg }
  })
}

async function measure(page: Page, key: string, frames = 1, gapMs = 0): Promise<void> {
  const runs = await textRuns(page)
  const pngs: PNG[] = []
  for (let i = 0; i < frames; i++) {
    pngs.push(await backgroundShot(page))
    if (gapMs) await page.waitForTimeout(gapMs)
  }
  const base = await backgroundShot(page, ' .chat-backdrop { visibility: hidden !important; }')
  const results = worstFor(runs, pngs)
  const baseRes = worstFor(runs, [base])
  const byToken: Record<string, Worst> = {}
  const baseline: Record<string, number> = {}
  let worst: Worst | null = null
  results.forEach((r, i) => {
    const t = r.run.token
    const w = { ratio: Math.round(r.ratio * 100) / 100, where: r.run.where, bg: r.bg }
    if (!byToken[t] || w.ratio < byToken[t].ratio) byToken[t] = w
    if (!worst || w.ratio < worst.ratio) worst = { ...w, where: `${t} ${w.where}` }
    const b = Math.round(baseRes[i].ratio * 100) / 100
    if (baseline[t] === undefined || b < baseline[t]) baseline[t] = b
  })
  report[key] = { worst, byToken, runs: runs.length, baseline }
  fs.writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify(report, null, 1))
}

async function shot(page: Page, name: string, wait = 300): Promise<void> {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

async function geometry(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const body = document.querySelector('.chat__body')?.getBoundingClientRect()
    const av = document.querySelector('.chat-backdrop__avatar') as HTMLElement | null
    const r = av?.getBoundingClientRect()
    const canvas = av?.querySelector('canvas')
    return {
      body: body && { x: Math.round(body.left), y: Math.round(body.top), w: Math.round(body.width), h: Math.round(body.height) },
      avatar: r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), box: av?.offsetWidth, opacity: av ? getComputedStyle(av).opacity : null },
      canvas: canvas && { w: canvas.width, h: canvas.height },
      mode: document.querySelector('.chat-backdrop')?.getAttribute('data-mode') ?? null
    }
  })
}

test('chat backdrop: layout, states, legibility', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  const first = (await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'First chat' })).json
  const geo: Record<string, unknown> = {}
  const frames: Record<string, unknown> = {}

  const settle = async (ms = 900): Promise<void> => {
    await s!.hook('presence.setFocus', true)
    await s!.page.waitForTimeout(ms)
  }
  const theme = async (t: 'dark' | 'light'): Promise<void> => {
    await s!.hook('presence.appearance', { theme: t })
  }

  // 1 · first run: the hero + greeting + setup checklist.
  for (const size of SIZES) {
    await s.page.setViewportSize({ width: size.w, height: size.h })
    for (const t of THEMES) {
      await s.hook('go', `/s/${first.uid}`)
      await s.waitReady()
      await theme(t)
      await s.waitHook('presence.surface')
      await settle(1600)
      await shot(s.page, `empty-first-${t}-${size.w}x${size.h}`)
      await measure(s.page, `empty-first-${t}-${size.w}x${size.h}`)
      geo[`empty-first-${size.w}x${size.h}`] = await geometry(s.page)
    }
  }

  // 2 · a long conversation (seeded rows + a rich reply).
  const seeded = (await s.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 1, messagesPerSession: 60 })).json.sessionUids[0]
  await s.hook('go', `/s/${seeded}`)
  await s.waitReady()
  await wsTurn(s.page, seeded, RICH_REPLY)
  await wsTurn(s.page, seeded, 'Could you say that again, a little more slowly this time? I was making tea and only half heard it.')
  const empty = (await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'Quiet' })).json

  for (const size of SIZES) {
    await s.page.setViewportSize({ width: size.w, height: size.h })
    const tag = `${size.w}x${size.h}`
    for (const t of THEMES) {
      await s.hook('go', `/s/${empty.uid}`)
      await s.waitReady()
      await theme(t)
      await settle(1400)
      await shot(s.page, `empty-${t}-${tag}`)
      await measure(s.page, `empty-${t}-${tag}`)

      await s.hook('go', `/s/${seeded}`)
      await s.waitReady()
      await theme(t)
      await s.page.waitForSelector('.msg')
      await settle(1400)
      await shot(s.page, `conversation-${t}-${tag}`)
      await measure(s.page, `conversation-${t}-${tag}`)
      geo[`conversation-${tag}`] = await geometry(s.page)

      // Speaking: the brightest frames — sample six of them.
      await s.hook('presence.resetFrames')
      await s.hook('presence.speak', 'Of course. The light you see tonight left that star long before anyone was there to see it, and still it arrives, and it will keep arriving long after we stop looking up.')
      await s.page.waitForTimeout(900)
      await shot(s.page, `speaking-${t}-${tag}`, 0)
      await measure(s.page, `speaking-${t}-${tag}`, 6, 220)
      geo[`speaking-${tag}`] = await geometry(s.page)
      frames[`speaking-${t}-${tag}`] = await s.hook('presence.frames')
      await s.hook('audio.stop')

      await s.hook('presence.forceState', 'listening')
      await settle(900)
      await shot(s.page, `listening-${t}-${tag}`)
      await measure(s.page, `listening-${t}-${tag}`)
      await s.hook('presence.forceState', 'thinking')
      await settle(900)
      await shot(s.page, `thinking-${t}-${tag}`)
      await s.hook('presence.forceState', null)

      // Reading: the reader scrolls up.
      const list = s.page.locator('.mw__list')
      const box = await list.boundingBox()
      if (box) {
        await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await s.page.mouse.wheel(0, -600)
        await s.page.waitForTimeout(450)
        await shot(s.page, `reading-${t}-${tag}`, 0)
        await measure(s.page, `reading-${t}-${tag}`)
        await s.page.mouse.move(2, 2)
      }

      if (size.w === 1440 || size.w === 390) {
        await s.hook('presence.setGameMode', true)
        await settle(900)
        await shot(s.page, `gamemode-${t}-${tag}`)
        await s.hook('presence.setGameMode', false)
        await s.hook('presence.setPrefs', { motion: 'reduced' })
        await settle(900)
        await shot(s.page, `reduced-${t}-${tag}`)
        await s.hook('presence.setPrefs', { motion: 'system', style: 'off' })
        await settle(700)
        await shot(s.page, `off-${t}-${tag}`)
        await s.hook('go', `/s/${empty.uid}`)
        await s.waitReady()
        await settle(700)
        await shot(s.page, `off-empty-${t}-${tag}`)
        await s.hook('presence.setPrefs', { style: undefined })
        if (size.w === 1440) {
          await s.hook('presence.setPrefs', { style: 'minimal2d' })
          await s.hook('go', `/s/${seeded}`)
          await s.waitReady()
          await settle(1200)
          await shot(s.page, `m2d-conversation-${t}-${tag}`)
          await s.hook('presence.speak', 'And here is the simple star, speaking softly behind the words.')
          await s.page.waitForTimeout(800)
          await measure(s.page, `m2d-speaking-${t}-${tag}`, 4, 200)
          await s.hook('audio.stop')
          await s.hook('presence.setPrefs', { style: undefined })
        }
      }

      await s.hook('go', `/talk/${seeded}`)
      await s.waitReady()
      await theme(t)
      await settle(1800)
      await shot(s.page, `talk-${t}-${tag}`)
    }
  }
  fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify({ geo, frames }, null, 1))
  expect(Object.keys(report).length).toBeGreaterThan(0)
})
