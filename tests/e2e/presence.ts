/**
 * E2E helpers for presence (Star, Talk mode, Constellation): a realistic sky of conversations (imported as a
 * ChatGPT export, so their dates span a year and their sizes vary), links and private sessions; a WebGL context
 * counter installed before the app loads (07 D5 gate); frame counters through `__vesperTest.presence`.
 */
import type { Page } from '@playwright/test'
import { rawRequest, type RawResponse } from './http'
import { sameOriginHeaders, type Api } from './launch'

const TITLES = [
  'Trip to Lisbon',
  'Sourdough starter rescue',
  'Learning the cello',
  'Job interview prep',
  'Garden plan for spring',
  'Reading list 2026',
  'Dad’s birthday ideas',
  'Rust borrow checker woes',
  'Marathon training week 6',
  'Moving apartments',
  'Night sky photography',
  'Budget for the year',
  'Writing the short story',
  'Learning Japanese — N4',
  'Fixing the bike gears',
  'Meal prep Sundays',
  'Game design notes',
  'Therapy reflections',
  'Home studio acoustics',
  'Planning the wedding toast',
  'Car insurance renewal',
  'The houseplant clinic',
  'Board game night rules',
  'Philosophy of mind',
  'Climbing technique',
  'Coffee brewing ratios',
  'Old friends reunion',
  'Learning to sketch',
  'Tax questions',
  'Morning routine',
  'Podcast episode ideas',
  'Ancient Rome rabbit hole',
  'Home network setup',
  'Kitchen renovation',
  'Bird watching log',
  'Sleep experiments'
]

const DAY = 86_400

/** A ChatGPT `conversations.json` with `n` conversations spread over the last year (deterministic). */
export function chatGptExport(n = TITLES.length, nowSec = Math.floor(Date.now() / 1000)): Buffer {
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const convs = []
  for (let i = 0; i < n; i++) {
    const age = Math.pow(i / Math.max(1, n - 1), 1.6) * 360 * DAY + rnd() * DAY
    const created = nowSec - age - 0.6 * DAY
    const turns = 1 + Math.floor(Math.pow(rnd(), 2.2) * 60)
    const mapping: Record<string, unknown> = { root: { id: 'root', parent: null, children: ['m0'], message: null } }
    let t = created
    for (let k = 0; k < turns * 2; k++) {
      const id = `m${k}`
      const role = k % 2 === 0 ? 'user' : 'assistant'
      t += 30 + rnd() * 210
      mapping[id] = {
        id,
        parent: k === 0 ? 'root' : `m${k - 1}`,
        children: k + 1 < turns * 2 ? [`m${k + 1}`] : [],
        message: {
          author: { role },
          create_time: t,
          content: { content_type: 'text', parts: [`${role === 'user' ? 'Question' : 'Answer'} ${k} about ${TITLES[i % TITLES.length]}`] }
        }
      }
    }
    convs.push({
      title: TITLES[i % TITLES.length],
      create_time: created,
      update_time: t,
      mapping,
      current_node: `m${turns * 2 - 1}`,
      conversation_id: `conv-${i}`
    })
  }
  return Buffer.from(JSON.stringify(convs))
}

function multipartBody(name: string, data: Buffer): { body: Buffer; type: string } {
  const boundary = `----vesper-presence-${Date.now()}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  return { body, type: `multipart/form-data; boundary=${boundary}` }
}

export interface SkySession {
  uid: string
  shortId: string
  title: string
  private: boolean
}

/** Import a sky of conversations (desktop device), link a few, make two private. Returns the sessions. */
export async function seedSky(url: string, desk: { api: Api; cookie: string }, n = TITLES.length): Promise<SkySession[]> {
  const mp = multipartBody('conversations.json', chatGptExport(n))
  const imp: RawResponse = await rawRequest(url, {
    method: 'POST',
    path: '/api/import',
    headers: { ...sameOriginHeaders(url, desk.cookie), 'content-type': mp.type },
    body: mp.body
  })
  if (imp.status !== 200) throw new Error(`import → ${imp.status} ${imp.text}`)
  const list = await desk.api<{ items: SkySession[] }>('GET', '/api/sessions?limit=200')
  const items = list.json.items
  const byTitle = (t: string): SkySession => {
    const s = items.find((x) => x.title === t)
    if (!s) throw new Error(`no session ${t}`)
    return s
  }
  const links: Array<[string, string, boolean]> = [
    ['Trip to Lisbon', 'Budget for the year', false],
    ['Trip to Lisbon', 'Night sky photography', false],
    ['Learning the cello', 'Home studio acoustics', true],
    ['Marathon training week 6', 'Meal prep Sundays', false],
    ['Marathon training week 6', 'Sleep experiments', true],
    ['Writing the short story', 'Ancient Rome rabbit hole', false],
    ['Writing the short story', 'Learning to sketch', false],
    ['Job interview prep', 'Morning routine', false],
    ['Garden plan for spring', 'The houseplant clinic', true],
    ['Game design notes', 'Board game night rules', false]
  ]
  for (const [a, b, both] of links) {
    if (!items.some((x) => x.title === a) || !items.some((x) => x.title === b)) continue
    const from = byTitle(a)
    const to = byTitle(b)
    const r = await desk.api('PUT', `/api/sessions/${from.uid}/links/${to.shortId}`, { bothWays: both })
    if (r.status !== 200) throw new Error(`link ${a} → ${b}: ${r.status} ${r.text}`)
  }
  for (const t of ['Therapy reflections', 'Tax questions']) {
    if (!items.some((x) => x.title === t)) continue
    const r = await desk.api('PATCH', `/api/sessions/${byTitle(t).uid}`, { private: true })
    if (r.status !== 200) throw new Error(`private ${t}: ${r.status}`)
  }
  // Only the imported conversations (an empty "New chat" the app opened is not a star).
  return (await desk.api<{ items: Array<SkySession & { messageCount: number }> }>('GET', '/api/sessions?limit=200')).json.items.filter(
    (x) => x.messageCount > 0
  )
}

/**
 * Count WebGL contexts the page creates (07 D5 gate): wraps HTMLCanvasElement.prototype.getContext before any app
 * code runs; distinct canvases that obtained a webgl/webgl2 context are counted, plus contexts lost for good.
 */
export async function installGlCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __glCount?: { created: number; canvases: WeakSet<HTMLCanvasElement> } }
    const box = { created: 0, canvases: new WeakSet<HTMLCanvasElement>() }
    w.__glCount = box
    const orig = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (orig as (...a: unknown[]) => unknown).call(this, type, ...rest)
      if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') && !box.canvases.has(this)) {
        box.canvases.add(this)
        box.created++
      }
      return ctx
    } as typeof orig
  })
}

export async function glContextsCreated(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __glCount?: { created: number } }).__glCount?.created ?? -1)
}

export interface FrameStats {
  frames: number
  callbacks: number
  polls: number
  running: boolean
  budget: { fps: number; poll: boolean; reason: string }
}

export interface GlInfo {
  created: number
  live: number
  rendered: number
  lost: number
  restored: number
  geometries: number
  textures: number
  programs: number
}

export interface SurfaceInfo {
  kind: string | null
  inTarget: boolean
  canvas: boolean
  canvasVisible: boolean
  minimal2d: boolean
  armilla2d?: boolean
  glyph: boolean
  state: string
}
