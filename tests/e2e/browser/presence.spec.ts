/**
 * Presence (07 D4/D5/D6/D9, A4) through the built server and a real Chromium (WebGL via SwiftShader):
 *   - the one-canvas gate: exactly one WebGL context after 50 route switches (and with Settings' live preview);
 *   - the chat backdrop: centred from its first frame on a session switch (v1.1.3); the live voice oscilloscope (v1.1.5);
 *   - the frame budget: 0 frames at rest, while hidden, with the Star off-stage; audio-reactive speaking; CPU sanity;
 *   - no leaked geometries/materials/textures after style switches; context loss and restore;
 *   - Talk mode end to end (fake mic → STT → chat.send talk → reply) with its controls and shortcuts;
 *   - Constellation: stars, hover card, click to open, drag to link, search, recall pulses, keyboard list;
 *   - axe (0 serious/critical) on Talk mode, Constellation and its dialog.
 */
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession } from '../helpers'
import { launchServer, type TestServer } from '../launch'
import { glContextsCreated, installGlCounter, seedSky, type FrameStats, type GlInfo, type SurfaceInfo } from '../presence'
import { AUDIO_FIXTURES } from '../stt'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  mock.reset()
})
test.afterAll(async () => {
  await mock?.close()
})

/** Launch with the GL counter installed before any app code, signed in, ready. */
async function start(o: Parameters<typeof launchServer>[0] = {}): Promise<TestServer> {
  const srv = await launchServer({ mock, open: false, ...o })
  await installGlCounter(srv.page)
  await recordWsSends(srv.page)
  await srv.page.goto(srv.url)
  await srv.waitReady()
  await srv.waitHook('ws.connected')
  await srv.waitHook('presence.surface')
  await srv.hook('presence.setFocus', true)
  return srv
}

/** Record every JSON message the page sends over its WebSockets (to assert prewarm / chat.send flags). */
async function recordWsSends(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __wsSent: Array<Record<string, unknown>> }
    w.__wsSent = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string') {
        try {
          w.__wsSent.push(JSON.parse(data) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      return orig.call(this, data)
    }
  })
}

async function wsSent(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __wsSent: Array<Record<string, unknown>> }).__wsSent)
}

async function go(srv: TestServer, route: string): Promise<void> {
  await srv.hook('go', route)
  await srv.waitReady()
}

async function frames(srv: TestServer): Promise<FrameStats> {
  return srv.hook<FrameStats>('presence.frames')
}

async function settleRest(srv: TestServer): Promise<void> {
  // Unfocused + idle rests at once (pauseWhenUnfocused, 07 D4) — the same 0-fps path as the 20 s rest.
  await srv.hook('presence.setFocus', false)
  await expect.poll(async () => (await frames(srv)).running, { timeout: 5000 }).toBe(false)
}

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).analyze()
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
}

test('one WebGL context after 50 route switches; renderer resources back to baseline @R15', async () => {
  s = await start({ fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), env: { VESPER_STT_FAKE: '1' } })
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  const sky = await seedSky(s.url, desk)
  const uid = sky[0].uid

  const routes = ['/constellation', `/s/${uid}`, `/talk/${uid}`, '/settings', '/presence-lab']
  // Warm-up round (shader programs, the composer), then the baseline on the lab.
  for (const r of routes) await go(s, r)
  await s.page.waitForTimeout(800)
  const base = await s.hook<GlInfo>('presence.gl')
  expect(base.live).toBe(1)
  expect(base.rendered).toBeGreaterThan(0)
  await go(s, '/settings')
  type Counters = Record<string, number>
  const wsBase = await s.hook<{ listeners: number; subscriptions: number; binary: number }>('ws.stats')
  const audioBase = await s.hook<Counters>('audio.counters')
  await go(s, '/presence-lab')

  for (let i = 0; i < 50; i++) {
    await go(s, routes[i % routes.length])
    if (i % 10 === 4) await s.page.waitForTimeout(250)
  }
  await go(s, '/presence-lab')
  await s.page.waitForTimeout(800)
  expect(await glContextsCreated(s.page)).toBe(1)
  const after = await s.hook<GlInfo>('presence.gl')
  expect(after).toMatchObject({ created: 1, live: 1, lost: 0 })
  // Nothing accumulates: GPU resources are back to (or below) the warmed-up baseline after 50 switches.
  expect(after.geometries).toBeLessThanOrEqual(base.geometries)
  expect(after.textures).toBeLessThanOrEqual(base.textures)
  expect(after.programs).toBeLessThanOrEqual(base.programs)
  // Every Talk visit stopped its mic; WS listeners and audio objects went back to the baseline (07 D14).
  expect(await s.hook<{ active: boolean }>('audio.micStats')).toMatchObject({ active: false })
  await go(s, '/settings')
  const wsAfter = await s.hook<{ listeners: number; subscriptions: number; binary: number }>('ws.stats')
  expect(wsAfter).toMatchObject({ listeners: wsBase.listeners, subscriptions: wsBase.subscriptions, binary: wsBase.binary })
  const audioAfter = await s.hook<Counters>('audio.counters')
  for (const k of ['streams', 'ports', 'nodes', 'sources', 'replies']) if (k in audioBase) expect(audioAfter[k], k).toBeLessThanOrEqual(audioBase[k])
  expect((await s.hook<{ replies: number; timers: number }>('presence.driver')).replies).toBe(0)
  await s.assertNoErrors()
})

test('the avatar lives behind the chat, never in the top bar; the one canvas moves to Talk mode and back, never remounted @R15', async () => {
  s = await start()
  const sess = await createSession(s.api, 'Moving avatar')
  await go(s, `/s/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  await expect.poll(async () => s!.hook<SurfaceInfo>('presence.surface'), { timeout: 15_000 }).toMatchObject({ inTarget: true, canvas: true, canvasVisible: true })
  // v1.1: no stage in the top bar any more (the old 30 px slot and the band above the messages are gone).
  await expect(s.page.locator('#star-stage-compact, .shead__stage, .chat-stage')).toHaveCount(0)
  // The same canvas element all along (07 D5: moved, never remounted).
  await s.page.evaluate(() => ((document.querySelector('.presence-host canvas') as HTMLCanvasElement & { __mark?: number }).__mark = 7))
  const same = async (): Promise<boolean> =>
    s!.page.evaluate(() => (document.querySelector('.presence-host canvas') as (HTMLCanvasElement & { __mark?: number }) | null)?.__mark === 7)
  await go(s, `/talk/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('stage')
  expect(await same()).toBe(true)
  await go(s, `/s/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  expect(await same()).toBe(true)
  // "Show in chat" off on this device: no backdrop; the canvas idles off-stage.
  await s.hook('presence.setPrefs', { showInChat: false })
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBeNull()
  await expect(s.page.locator('.chat-backdrop')).toHaveCount(0)
  await s.hook('presence.setPrefs', { showInChat: true })
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  expect(await same()).toBe(true)
  await go(s, '/settings')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBeNull()
  expect(await glContextsCreated(s.page)).toBe(1)
  await s.assertNoErrors()
})

/** The backdrop avatar's shown box (after its CSS transform). */
async function avatarBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('.chat-backdrop__avatar').boundingBox())!
}

test('the chat backdrop: the hero of an empty chat, comes forward while Vesper speaks; Talk mode is one click away (v1.1) @R15 @R19', async () => {
  s = await start()
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  // Game mode pinned off: a fullscreen game on this PC must not decide whether the avatar comes forward (07 D3 'auto').
  // Voice input on: Talk mode's entries open it (with it off they explain instead — the F51 tests below).
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'off' }, voice: { stt: { enabled: true } } })).status).toBe(200)
  const sess = await createSession(s.api, 'Backdrop and talk')
  await go(s, `/s/${sess.uid}`)
  const layer = s.page.locator('.chat-backdrop')
  await expect(layer).toHaveAttribute('data-mode', 'hero')
  await expect(layer).toHaveAttribute('data-avatar', 'armilla')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  await expect.poll(async () => s!.hook<SurfaceInfo>('presence.surface'), { timeout: 15_000 }).toMatchObject({ inTarget: true, canvas: true, canvasVisible: true })
  // Armilla is wide (its horizon line) and centred on the chat column. (Measured once its size transition has ended.)
  await expect
    .poll(async () => {
      const a = (await avatarBox(s!.page)).height
      await s!.page.waitForTimeout(250)
      return Math.abs(a - (await avatarBox(s!.page)).height) < 0.5
    })
    .toBe(true)
  const rest = await avatarBox(s.page)
  expect(rest.width / rest.height).toBeGreaterThan(1.5)
  const body = (await s.page.locator('.chat__body').boundingBox())!
  expect(Math.abs(rest.x + rest.width / 2 - (body.x + body.width / 2))).toBeLessThan(2)
  const content = s.page.locator('.shell__content')
  const contentBox = async (): Promise<string> => JSON.stringify(await content.boundingBox())
  const restBox = await contentBox()

  // Speaking brings it forward a little (scale + strength, compositor only); nothing in the layout moves.
  const banner = s.page.locator('header.shell__topbar')
  await s.hook('presence.speak')
  await expect.poll(async () => (await avatarBox(s!.page)).height, { timeout: 5000 }).toBeGreaterThan(rest.height * 1.03)
  expect(await contentBox()).toBe(restBox)
  await expect(banner.locator('.presence-state')).toContainText('Speaking')
  // The pause control (07 D9) is in the top bar while the avatar is active (the backdrop itself takes no input).
  await expect(banner.getByRole('button', { name: 'Pause the avatar’s animation' })).toBeVisible()
  await s.hook('audio.stop')
  await expect.poll(async () => (await avatarBox(s!.page)).height, { timeout: 5000 }).toBeLessThanOrEqual(rest.height + 0.5)
  // Game mode: static, it does not come forward (07 D3).
  await s.hook('presence.setGameMode', true)
  await s.hook('presence.speak')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state).toBe('speaking')
  await s.page.waitForTimeout(900)
  expect((await avatarBox(s.page)).height).toBeLessThanOrEqual(rest.height + 0.5)
  await s.hook('audio.stop')
  await s.hook('presence.setGameMode', false)

  // Visible ways into Talk mode: the top bar button and the empty chat's action; Talk mode keeps its full stage.
  await expect(banner.getByRole('button', { name: 'Talk mode' })).toBeVisible()
  await expect(s.page.getByRole('button', { name: 'Talk instead' })).toBeVisible()
  expect(await axe(s.page)).toEqual([])
  await banner.getByRole('button', { name: 'Talk mode' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/talk/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('stage')
  await s.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')

  // Hide/show per device from the top bar; the choice survives a reload.
  await banner.getByRole('button', { name: 'Hide Vesper behind the chat' }).click()
  await expect(layer).toHaveCount(0)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBeNull()
  await s.page.reload()
  await s.waitReady()
  await s.waitHook('presence.surface')
  await expect(layer).toHaveCount(0)
  await banner.getByRole('button', { name: 'Show Vesper behind the chat' }).click()
  await expect(layer).toBeVisible()
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  expect(await glContextsCreated(s.page)).toBeLessThanOrEqual(1)

  // "Show in chat" off: no backdrop and no toggle.
  await s.hook('presence.setPrefs', { showInChat: false })
  await expect(layer).toHaveCount(0)
  await expect(banner.getByRole('button', { name: /Vesper behind the chat/ })).toHaveCount(0)
  await s.hook('presence.setPrefs', { showInChat: true })
  await expect(layer).toBeVisible()

  // Phones: the same backdrop, smaller, drawn in 2D (07 D8: no WebGL avatar on phones); Talk stays in the top bar.
  await s.page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => s!.hook<SurfaceInfo>('presence.surface')).toMatchObject({ kind: 'backdrop', armilla2d: true, canvasVisible: false })
  const phone = await avatarBox(s.page)
  expect(phone.width).toBeLessThanOrEqual(390.5)
  expect(phone.height).toBeLessThan(rest.height * 1.2)
  await expect(banner.getByRole('button', { name: 'Talk mode' })).toBeVisible()
  await s.assertNoErrors()
})

test('the backdrop never takes clicks, scrolling or selection from the messages and never scrolls, in either theme (v1.1) @R15', async () => {
  s = await start()
  const desk = await s.login('desktop')
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'off' } })).status).toBe(200)
  const seeded = await s.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 1, messagesPerSession: 40 })
  expect(seeded.status, seeded.text).toBe(200)
  const uid = seeded.json.sessionUids[0]!
  await go(s, `/s/${uid}`)
  await expect(s.page.locator('article.msg').first()).toBeVisible()
  await expect(s.page.locator('.chat-backdrop')).toHaveAttribute('data-mode', 'conversation')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')

  /** What a pointer hits across the avatar's box: never the backdrop or the presence host. */
  const probe = async (): Promise<string[]> =>
    s!.page.evaluate(() => {
      const b = document.querySelector('.chat-backdrop__avatar')!.getBoundingClientRect()
      const hits: string[] = []
      for (let fx = 0.1; fx < 1; fx += 0.2)
        for (let fy = 0.1; fy < 1; fy += 0.2) {
          const el = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy) as HTMLElement | null
          if (el?.closest('.chat-backdrop, .presence-host')) hits.push(`${el.tagName}.${el.className}`)
        }
      return hits
    })

  for (const theme of ['light', 'dark'] as const) {
    await s.page.emulateMedia({ colorScheme: theme })
    expect((await desk.api('PATCH', '/api/settings', { appearance: { theme } })).status).toBe(200)
    await expect(s.page.locator('html')).toHaveAttribute('data-theme', theme)
    // Armilla lays its own ink in the light theme: no invert filter on the box.
    expect(await s.page.locator('.chat-backdrop').getAttribute('data-ink')).toBeNull()
    await s.hook('presence.speak')
    await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state).toBe('speaking')
    expect(await probe()).toEqual([])
    // The list scrolls over it; the avatar's box does not move with the scroll.
    const before = await avatarBox(s.page)
    const centre = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
    const top0 = await s.page.locator('.mw__list').evaluate((el) => el.scrollTop)
    await s.page.mouse.move(centre.x, centre.y)
    await s.page.mouse.wheel(0, -600)
    await expect.poll(async () => s!.page.locator('.mw__list').evaluate((el) => el.scrollTop)).not.toBe(top0)
    const after = await avatarBox(s.page)
    expect(Math.abs(after.x + after.width / 2 - centre.x)).toBeLessThan(1)
    expect(Math.abs(after.y + after.height / 2 - centre.y)).toBeLessThan(1)
    await s.hook('audio.stop')
  }
  await s.assertNoErrors()
})

interface WaveShot {
  heights: number[]
  level: number
  who: number
  delayMs: number
  ageMs: number
  windowMs: number
  version: number
}

/** The largest swing drawn across the front (0 … 1 of full scale; 0: a flat line). */
function waveSwing(w: WaveShot | null): number {
  return w ? Math.max(0, ...w.heights.map(Math.abs)) : 0
}

/** Where the drawn curves' weight sits along the horizon: 0 = the left end … 1 = the right end (−1: a flat line). */
function waveCentre(w: WaveShot | null): number {
  if (!w) return -1
  let m = 0
  let mu = 0
  w.heights.forEach((h, i) => {
    m += Math.abs(h)
    mu += Math.abs(h) * ((i + 1) / (w.heights.length + 1))
  })
  return m > 1e-3 ? mu / m : -1
}

test('switching sessions or routes: the avatar appears already centred on its first frame, no slide from the corner (v1.1.3) @R15', async () => {
  s = await start()
  const desk = await s.login('desktop')
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'off' } })).status).toBe(200)
  const seeded = await s.api<{ sessionUids: string[] }>('POST', '/api/test/seed', { sessions: 2, messagesPerSession: 12 })
  expect(seeded.status, seeded.text).toBe(200)
  const [a, b] = seeded.json.sessionUids as [string, string]
  await go(s, `/s/${a}`)
  await expect(s.page.locator('.chat-backdrop')).toHaveAttribute('data-mode', 'conversation')
  await expect(s.page.locator('.chat-backdrop[data-animate]')).toHaveCount(1)

  /** From the first frame the NEW backdrop is shown: its avatar's centre against the chat body's (x: middle, y: 48 %). */
  const watcher = (): void => {
    const w = window as unknown as { __boxes: Array<{ dx: number; dy: number; h: number }> }
    const old = document.querySelector('.chat-backdrop') as (HTMLElement & { __old?: boolean }) | null
    if (old) old.__old = true
    w.__boxes = []
    const tick = (): void => {
      const layer = document.querySelector('.chat-backdrop[data-ready]') as (HTMLElement & { __old?: boolean }) | null
      if (layer && !layer.__old && getComputedStyle(layer).visibility !== 'hidden') {
        const r = (layer.querySelector('.chat-backdrop__avatar') as HTMLElement).getBoundingClientRect()
        const body = layer.getBoundingClientRect()
        w.__boxes.push({ dx: r.left + r.width / 2 - (body.left + body.width / 2), dy: r.top + r.height / 2 - (body.top + Math.round(body.height * 0.48)), h: r.height })
      }
      if (w.__boxes.length < 24) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  const watch = async (): Promise<void> => s!.page.evaluate(watcher)
  const frames = async (): Promise<Array<{ dx: number; dy: number; h: number }>> => {
    await expect.poll(() => s!.page.evaluate(() => (window as unknown as { __boxes: unknown[] }).__boxes.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(24)
    return s!.page.evaluate(() => (window as unknown as { __boxes: Array<{ dx: number; dy: number; h: number }> }).__boxes)
  }
  const centred = (boxes: Array<{ dx: number; dy: number; h: number }>, label: string): void => {
    // The first frame it is seen, and every frame after: centred, not travelling in from the top-left corner.
    expect(Math.abs(boxes[0].dx), `${label}: first frame x`).toBeLessThan(2)
    expect(Math.abs(boxes[0].dy), `${label}: first frame y`).toBeLessThan(2)
    for (const bx of boxes) expect(Math.max(Math.abs(bx.dx), Math.abs(bx.dy)), label).toBeLessThan(2)
  }
  for (const [i, uid] of [b, a, b].entries()) {
    await watch()
    await go(s, `/s/${uid}`)
    centred(await frames(), `session switch ${i + 1}`)
  }
  // A route change (Settings → the chat) and a reload (the first mount) too.
  await go(s, '/settings')
  await watch()
  await go(s, `/s/${a}`)
  centred(await frames(), 'route change')
  // The first mount: watching from the document's start (the init script runs before the app).
  await s.page.addInitScript(watcher)
  await s.page.reload()
  await s.waitReady()
  centred(await frames(), 'first mount')
  await s.assertNoErrors()
})

test('Settings shows the avatar live: the one canvas moves into the preview, "Preview speaking" draws the live oscilloscope, visibility and size apply (v1.1.3, v1.1.5) @R15 @R20', async () => {
  // The desktop app's own window: Settings are writable there (a remote browser only reads them).
  s = await start({ login: 'desktop' })
  const desk = { api: s.api }
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'off' } })).status).toBe(200)
  const sess = await createSession(s.api, 'Preview')
  await go(s, `/s/${sess.uid}`)
  await expect.poll(async () => s!.hook<SurfaceInfo>('presence.surface'), { timeout: 15_000 }).toMatchObject({ kind: 'backdrop', canvas: true })
  await s.page.evaluate(() => ((document.querySelector('.presence-host canvas') as HTMLCanvasElement & { __mark?: number }).__mark = 9))
  // The engine's own graph (analyser + master) exists once unlocked: the baseline is taken after that.
  await s.hook('audio.unlock')
  const audioBase = await s.hook<Record<string, number>>('audio.counters')

  await go(s, '/settings/appearance')
  // The one surface moved into the preview (07 D5): the same canvas, still one context.
  await expect.poll(async () => s!.hook<SurfaceInfo>('presence.surface'), { timeout: 15_000 }).toMatchObject({ kind: 'preview', inTarget: true, canvasVisible: true })
  expect(await s.page.evaluate(() => (document.querySelector('.presence-host canvas') as (HTMLCanvasElement & { __mark?: number }) | null)?.__mark)).toBe(9)
  expect(await glContextsCreated(s.page)).toBe(1)
  const preview = s.page.locator('.avatar-preview')
  await expect(preview.getByRole('img', { name: /Live preview/ })).toBeVisible()
  // The style picker shows stills (images, never another canvas).
  await expect(s.page.locator('.star-styles .radio-card__icon img')).toHaveCount(4)
  expect(await s.page.locator('canvas').count()).toBe(1)

  // Visibility: the slider (data-setting row) changes the preview at once; 200 % is the strongest, still the same canvas.
  const avatarOpacity = async (): Promise<number> => Number(await preview.locator('.chat-backdrop__avatar').evaluate((el) => (el as HTMLElement).style.opacity))
  const before = await avatarOpacity()
  const visibility = s.page.locator('[data-setting="appearance.star.visibility"] [role="slider"]')
  await visibility.focus()
  await s.page.keyboard.press('End')
  await expect.poll(async () => (await desk.api<{ appearance: { star: { visibility: number } } }>('GET', '/api/settings')).json.appearance.star.visibility).toBe(2)
  await expect.poll(avatarOpacity).toBeGreaterThan(before)
  const size = s.page.locator('[data-setting="appearance.star.size"] [role="slider"]')
  const h0 = (await preview.locator('.chat-backdrop__avatar').boundingBox())!.height
  await size.focus()
  await s.page.keyboard.press('Home')
  await expect.poll(async () => (await preview.locator('.chat-backdrop__avatar').boundingBox())!.height).toBeLessThan(h0 - 5)

  // "Preview speaking": the real AudioEngine plays the clip (muted in test mode; the analyser sits before the volume),
  // the state turns to speaking, and the horizon's front draws that audio as a live oscilloscope (v1.1.5): curves up
  // and down across the front, standing in place — centred every time it is looked at, never entering from one end.
  await preview.getByRole('button', { name: 'Preview speaking' }).click()
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state, { timeout: 10_000 }).toBe('speaking')
  await expect.poll(async () => waveSwing(await s!.hook<WaveShot | null>('presence.armillaWave')), { timeout: 10_000 }).toBeGreaterThan(0.2)
  const centres: number[] = []
  for (let i = 0; i < 8; i++) {
    const w = await s.hook<WaveShot | null>('presence.armillaWave')
    if (waveSwing(w) > 0.2) centres.push(waveCentre(w))
    await s.page.waitForTimeout(120)
  }
  expect(centres.length).toBeGreaterThanOrEqual(3)
  // A real voice can lean one frame to a side (a syllable starting inside the 35 ms window); what must never happen is a
  // trace travelling across: then the centres sweep from one end to the other. The median stays near the middle and the centres never sweep.
  const sorted = [...centres].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  expect(Math.abs(median - 0.5), `median centre ${median} of ${centres.join(", ")}`).toBeLessThan(0.15)
  // No sweep: a travelling trace moves its centre the same way frame after frame across most of the ring.
  const steps = centres.slice(1).map((c, i) => c - centres[i])
  const sweep = steps.every((d) => d > 0.02) || steps.every((d) => d < -0.02)
  expect(sweep && Math.abs(centres[centres.length - 1] - centres[0]) > 0.4, `sweep across ${centres.join(", ")}`).toBe(false)
  await expect(preview.getByRole('button', { name: 'Stop' })).toBeVisible()
  await preview.getByRole('button', { name: 'Stop' }).click()
  await expect(preview.getByRole('button', { name: 'Preview speaking' })).toBeVisible()
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state, { timeout: 5000 }).toBe('idle')
  // Silence: a calm, flat ring.
  await expect.poll(async () => waveCentre(await s!.hook<WaveShot | null>('presence.armillaWave')), { timeout: 3000 }).toBe(-1)
  expect(await axe(s.page)).toEqual([])

  // Leaving Settings hands the surface back to the chat; nothing leaked.
  await go(s, `/s/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).kind).toBe('backdrop')
  expect(await glContextsCreated(s.page)).toBe(1)
  const audioAfter = await s.hook<Record<string, number>>('audio.counters')
  for (const k of ['nodes', 'sources', 'buffers', 'replies']) if (k in audioBase) expect(audioAfter[k], k).toBeLessThanOrEqual(audioBase[k])
  await s.assertNoErrors()
})

test('style switches dispose everything they made; Off releases the context @R15 @R17', async () => {
  s = await start()
  await go(s, '/presence-lab')
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).rendered, { timeout: 15_000 }).toBeGreaterThan(0)
  await s.page.waitForTimeout(300)
  const base = await s.hook<GlInfo>('presence.gl')
  for (let round = 0; round < 3; round++) {
    for (const p of [{ style: 'nebula' }, { quality: 'low' }, { style: 'orb', quality: 'medium' }, { style: 'minimal2d' }, { style: 'armilla', quality: 'medium' }, { style: 'armilla', quality: 'high' }]) {
      await s.hook('presence.setPrefs', p)
      await s.page.waitForTimeout(150)
    }
  }
  await s.page.waitForTimeout(400)
  const after = await s.hook<GlInfo>('presence.gl')
  expect(after.live).toBe(1)
  expect(after.geometries).toBe(base.geometries)
  expect(after.textures).toBe(base.textures)
  expect(after.programs).toBeLessThanOrEqual(base.programs + 3)

  // Off: the canvas goes (dispose + forceContextLoss, 07 D5) and the static glyph stays.
  await s.hook('presence.setPrefs', { style: 'off' })
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).live).toBe(0)
  expect(await s.hook<SurfaceInfo>('presence.surface')).toMatchObject({ canvas: false, glyph: true })
  await s.hook('presence.setPrefs', { style: 'armilla' })
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).live).toBe(1)
  await s.assertNoErrors()
})

test('0 frames at rest, hidden or off-stage; speaking pulses with the voice; CPU sanity @R15', async () => {
  s = await start()
  await go(s, '/presence-lab')
  await expect.poll(async () => (await frames(s!)).frames, { timeout: 15_000 }).toBeGreaterThan(3)

  // At rest: the loop is gone — no frames, no rAF callbacks.
  await settleRest(s)
  await s.hook('presence.resetFrames')
  await s.page.waitForTimeout(1500)
  expect(await frames(s)).toMatchObject({ frames: 0, callbacks: 0, polls: 0, running: false })

  // CPU sanity at rest (CDP task time over 2 s of wall time).
  const cdp = await s.page.context().newCDPSession(s.page)
  await cdp.send('Performance.enable')
  const task = async (): Promise<number> => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
  const t0 = await task()
  await s.page.waitForTimeout(2000)
  const restMs = (await task()) - t0
  expect(restMs).toBeLessThan(2000 * 0.03)

  // The 20 s idle rest itself (focused).
  await s.hook('presence.setFocus', true)
  await expect.poll(async () => (await frames(s!)).budget.reason, { timeout: 25_000, intervals: [500] }).toBe('rest')

  // Speaking: drawn at up to 60 fps with analyser polling, then back to rest.
  await s.hook('presence.resetFrames')
  await s.hook('presence.speak')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state).toBe('speaking')
  await s.page.waitForTimeout(1000)
  const speaking = await frames(s)
  expect(speaking.polls).toBeGreaterThan(20)
  expect(speaking.budget).toMatchObject({ poll: true })
  const t1 = await task()
  await s.page.waitForTimeout(1000)
  const speakMs = (await task()) - t1
  console.log(`presence CPU: rest ${restMs.toFixed(1)} ms / 2 s; speaking ${speakMs.toFixed(1)} ms / 1 s (software WebGL)`)
  await s.hook('audio.stop')
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).state, { timeout: 5000 }).toBe('idle')

  // Hidden: nothing drawn and no analyser polling even while audio plays.
  await s.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await s.hook('presence.resetFrames')
  await s.hook('presence.speak')
  await s.page.waitForTimeout(1200)
  expect(await frames(s)).toMatchObject({ frames: 0, polls: 0 })
  await s.hook('audio.stop')
  await s.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(async () => (await frames(s!)).frames).toBeGreaterThan(0)

  // Off-stage: no target on the settings page → parked, nothing drawn.
  await go(s, '/settings')
  await s.hook('presence.resetFrames')
  await s.page.waitForTimeout(800)
  expect((await frames(s)).frames).toBe(0)
  expect((await s.hook<SurfaceInfo>('presence.surface')).kind).toBeNull()

  // Game mode: static, ≤ 10 fps while speaking.
  await go(s, '/presence-lab')
  await s.hook('presence.setGameMode', true)
  await s.hook('presence.speak')
  await s.page.waitForTimeout(300)
  await s.hook('presence.resetFrames')
  await s.page.waitForTimeout(1000)
  const gm = await frames(s)
  expect(gm.budget.fps).toBe(10)
  expect(gm.frames).toBeLessThanOrEqual(13)
  await s.hook('audio.stop')
  await s.hook('presence.setGameMode', false)

  // Reduced motion (OS): no displacement or pulses, ≤ 20 fps while the voice plays, rest otherwise (07 D9).
  await s.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(async () => (await frames(s!)).budget.reason, { timeout: 5000 }).toMatch(/^reduced/)
  await s.hook('presence.speak')
  await expect.poll(async () => (await frames(s!)).budget).toMatchObject({ fps: 20, reason: 'reduced-audio' })
  await s.hook('audio.stop')
  await s.page.emulateMedia({ reducedMotion: 'no-preference' })

  // Paused by the user: 0 frames even while speaking.
  await s.hook('presence.setPaused', true)
  await s.hook('presence.speak')
  await s.page.waitForTimeout(200)
  await s.hook('presence.resetFrames')
  await s.page.waitForTimeout(800)
  expect((await frames(s)).frames).toBe(0)
  await s.hook('audio.stop')
  await s.hook('presence.setPaused', false)
  await s.assertNoErrors()
})

test('one rAF chain: scheduler callbacks never outrun the display after many crossfades (review F44) @R15 @R17', async () => {
  s = await start()
  await go(s, '/presence-lab')
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).rendered, { timeout: 15_000 }).toBeGreaterThan(0)
  // Every state change crossfades the look; the Star's useFrame kicks the scheduler from inside drawn frames.
  for (let i = 0; i < 6; i++) {
    await s.hook('presence.speak')
    await s.page.waitForTimeout(500)
    await s.hook('audio.stop')
    await s.page.waitForTimeout(500)
  }
  await s.hook('presence.speak')
  await s.page.waitForTimeout(600)
  // Count the page's own rAF callbacks over the same second as the scheduler's.
  const r = await s.page.evaluate(async () => {
    const w = window as unknown as { __vesperTest: { presence: { resetFrames(): void; frames(): { callbacks: number; frames: number } } } }
    let ref = 0
    let on = true
    const tick = (): void => {
      ref++
      if (on) requestAnimationFrame(tick)
    }
    w.__vesperTest.presence.resetFrames()
    requestAnimationFrame(tick)
    await new Promise((res) => setTimeout(res, 1000))
    on = false
    return { ref, ...w.__vesperTest.presence.frames() }
  })
  console.log(`scheduler: ${r.callbacks} callbacks, ${r.frames} frames vs ${r.ref} page rAF callbacks in 1 s`)
  expect(r.frames).toBeGreaterThan(5)
  expect(r.callbacks).toBeLessThanOrEqual(r.ref + 3)
  await s.hook('audio.stop')
  await s.assertNoErrors()
})

test('context loss is survived: nothing drawn while lost, one frame after the restore @R15', async () => {
  s = await start()
  await go(s, '/presence-lab')
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).rendered, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await s.hook<boolean>('presence.loseContext', 600)).toBe(true)
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).lost).toBe(1)
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).restored, { timeout: 5000 }).toBe(1)
  const before = (await s.hook<GlInfo>('presence.gl')).rendered
  await expect.poll(async () => (await s!.hook<GlInfo>('presence.gl')).rendered).toBeGreaterThan(before)
  expect(await glContextsCreated(s.page)).toBe(1)
  await s.assertNoErrors()
})

test('Talk mode: one mic, prewarm, hands-free turn, captions, controls and shortcuts @R19 @R15 @R14', async () => {
  s = await start({ fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Hello Vesper, can you hear me?' } })
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  // A voice is set up, so Talk mode speaks its replies (07 D6).
  expect((await desk.api('PATCH', '/api/settings', { voice: { stt: { silenceMs: 800 }, tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })).status).toBe(200)
  expect((await desk.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const sess = await createSession(s.api, 'Evening walk')
  await go(s, '/settings')
  const wsBase = await s.hook<{ listeners: number; subscriptions: number }>('ws.stats')

  await go(s, `/talk/${sess.uid}`)
  await expect(s.page.getByRole('heading', { name: 'Evening walk' })).toBeVisible()
  expect((await s.hook<SurfaceInfo>('presence.surface')).kind).toBe('stage')
  // Pre-warm on open (07 D6), then a conversation-mode STT session.
  await expect.poll(async () => (await wsSent(s!.page)).map((m) => m.t)).toEqual(expect.arrayContaining(['tts.prewarm', 'stt.prewarm', 'stt.start']))
  // The fake mic says the fixture; the reply comes back and is shown.
  // Your words, then the reply, land in the captions (the chat barrel's Transcript).
  await expect(s.page.locator('.talk__captions')).toContainText('Hello Vesper, can you hear me?', { timeout: 20_000 })
  await expect(s.page.locator('.talk__captions')).toContainText('Echo: Hello Vesper, can you hear me?', { timeout: 20_000 })
  const send = (await wsSent(s.page)).find((m) => m.t === 'chat.send')
  expect(send).toMatchObject({ sessionUid: sess.uid, text: 'Hello Vesper, can you hear me?', speak: true, talk: true })
  await expect(s.page.getByRole('status').filter({ hasText: 'Listening' })).toBeVisible({ timeout: 10_000 })
  expect(await s.hook<{ active: boolean }>('audio.micStats')).toMatchObject({ active: true })

  // Mute: the mic track stays, nothing is heard.
  await s.page.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(s.page.getByText('Muted — Vesper isn’t listening')).toBeVisible()
  expect(await s.hook<{ active: boolean }>('audio.micStats')).toMatchObject({ active: true })
  await s.page.getByRole('button', { name: 'Unmute' }).first().click()
  // Hold and resume; Space is the big button.
  await s.page.getByRole('button', { name: 'Hold' }).click()
  await expect(s.page.getByRole('status').filter({ hasText: 'On hold' })).toBeVisible()
  await s.page.locator('.talk__state').click()
  await s.page.keyboard.press('Space')
  await expect(s.page.getByRole('status').filter({ hasText: /Listening|Warming/ })).toBeVisible()
  // axe on the Talk page (07 D9).
  expect(await axe(s.page)).toEqual([])

  // Esc ends Talk mode: back to the chat, mic released, listeners back to baseline.
  await s.page.keyboard.press('Escape')
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await expect.poll(async () => (await s!.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)
  await go(s, '/settings')
  const wsAfter = await s.hook<{ listeners: number; subscriptions: number }>('ws.stats')
  expect(wsAfter.listeners).toBe(wsBase.listeners)
  expect(wsAfter.subscriptions).toBe(wsBase.subscriptions)
  expect((await s.hook<{ replies: number; timers: number }>('presence.driver')).timers).toBeLessThanOrEqual(1)
  await s.assertNoErrors()
})

test('Talk mode without a speech model offers the way out; its error stays in Talk mode @R19 @R22', async () => {
  // The desktop app, a microphone, but no speech model (no VESPER_STT_FAKE): stt.start answers stt_model_missing.
  s = await start({ fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), login: 'desktop' })
  await configureMockLlm(s.api, mock.url)
  const sess = await createSession(s.api, 'No model yet')
  await go(s, `/s/${sess.uid}`)
  const banner = s.page.locator('header.shell__topbar')
  const composerMic = s.page.locator('.composer [data-mic-control]')
  await expect(composerMic).toHaveAttribute('aria-label', 'Voice input is off')

  // Voice input off: the entries say what is missing instead of opening into an error (second pass of F51).
  await expect(s.page.getByRole('button', { name: 'Talk instead' })).toHaveCount(0)
  await banner.getByRole('button', { name: 'Talk mode' }).click()
  const toastEl = s.page.locator('.toast').filter({ hasText: 'Talk mode needs voice input.' })
  await expect(toastEl).toBeVisible()
  expect(await s.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await toastEl.getByRole('button', { name: 'Set up voice input' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe('/settings/voice-in')
  expect((await s.api('PATCH', '/api/settings', { voice: { stt: { enabled: true } } })).status).toBe(200)
  await go(s, `/s/${sess.uid}`)
  await expect(s.page.getByRole('button', { name: 'Talk instead' })).toBeVisible()

  await banner.getByRole('button', { name: 'Talk mode' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/talk/${sess.uid}`)
  const notice = s.page.locator('.talk__notice')
  await expect(notice).toContainText('speech model', { timeout: 15_000 })
  // Not a dead end: the big button leads to setup (a retry would fail the same way), and text is offered.
  await expect(s.page.locator('.talk__primary')).toHaveAttribute('aria-label', 'Download the speech model')
  await expect(notice.getByRole('button', { name: 'Download the speech model' })).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Type instead' })).toBeVisible()
  expect(await axe(s.page)).toEqual([])

  // Type instead: back in the chat, the composer mic does not inherit Talk mode's error.
  await notice.getByRole('button', { name: 'Type instead' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await expect(composerMic).toHaveAttribute('aria-label', 'Dictate')
  await expect(composerMic).not.toHaveClass(/is-problem/)

  // Space (the big button) opens Voice-in settings, where the model is downloaded.
  await go(s, `/talk/${sess.uid}`)
  await expect(s.page.locator('.talk__primary')).toHaveAttribute('aria-label', 'Download the speech model', { timeout: 15_000 })
  await s.page.locator('.talk__state').click()
  await s.page.keyboard.press('Space')
  await expect.poll(() => s!.hook<string>('route')).toBe('/settings/voice-in')
  await expect.poll(async () => (await s!.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)

  // A composer's own failed dictation names the problem (not "Dictate" with a red dot).
  await go(s, `/s/${sess.uid}`)
  await expect(composerMic).toHaveAttribute('aria-label', 'Dictate')
  await composerMic.click()
  await expect(composerMic).toHaveAttribute('aria-label', 'Voice input problem — show help', { timeout: 15_000 })
  await s.assertNoErrors()
})

test('off the PC, Talk mode never sends you to a setup that only works on the PC (second pass of F51) @R19 @R22', async () => {
  // A phone-sized browser device (not the desktop app), a microphone, no speech model.
  s = await start({ fakeMic: path.join(AUDIO_FIXTURES, 'hello.wav'), viewport: { width: 390, height: 844 } })
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  const sess = await createSession(s.api, 'Phone, no model')
  await go(s, `/s/${sess.uid}`)
  const banner = s.page.locator('header.shell__topbar')

  // Voice input off: the entry says where to turn it on, with no action that leads to "Download on your PC".
  await banner.getByRole('button', { name: 'Talk mode' }).click()
  const toastEl = s.page.locator('.toast').filter({ hasText: 'Turn it on in Vesper on your PC' })
  await expect(toastEl).toBeVisible()
  await expect(toastEl.getByRole('button', { name: 'Set up voice input' })).toHaveCount(0)
  expect(await s.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await expect(s.page.getByRole('button', { name: 'Talk instead' })).toHaveCount(0)

  // (On a phone the toast sits over the top bar: dismiss it first.)
  await toastEl.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(toastEl).toHaveCount(0)
  expect((await desk.api('PATCH', '/api/settings', { voice: { stt: { enabled: true } } })).status).toBe(200)
  await expect(s.page.getByRole('button', { name: 'Talk instead' })).toBeVisible()
  await banner.getByRole('button', { name: 'Talk mode' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/talk/${sess.uid}`)
  const notice = s.page.locator('.talk__notice')
  await expect(notice).toContainText('on your PC', { timeout: 15_000 })
  // The big button (and Space) retries (once the PC has the model it works), never "Download the speech model" here.
  await expect(s.page.locator('.talk__primary')).toHaveAttribute('aria-label', 'Try again')
  await expect(s.page.getByRole('button', { name: 'Download the speech model' })).toHaveCount(0)
  await expect(notice.getByRole('button', { name: 'Open Voice in settings' })).toHaveCount(0)
  await expect(notice.getByRole('button', { name: 'Type instead' })).toBeVisible()
  expect(await axe(s.page)).toEqual([])
  await s.page.locator('.talk__state').click()
  await s.page.keyboard.press('Space')
  await expect(notice).toContainText('on your PC', { timeout: 15_000 })
  expect(await s.hook<string>('route')).toBe(`/talk/${sess.uid}`)
  await notice.getByRole('button', { name: 'Type instead' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sess.uid}`)
  await s.assertNoErrors()
})

test('Talk mode explains a missing microphone instead of a dead button @R19', async () => {
  s = await start()
  const sess = await createSession(s.api, 'No mic here')
  await go(s, `/talk/${sess.uid}`)
  // Headless Chromium has no real microphone (or the speech model is missing): either way a way out, never a dead
  // button — a retry for what may come back, setup for what can't, and text.
  await expect(s.page.locator('.talk__notice')).toBeVisible({ timeout: 10_000 })
  await expect(s.page.locator('.talk__primary')).toHaveAttribute('aria-label', /Try again|Download the speech model|Set up voice input/)
  await expect(s.page.locator('.talk__primary')).toBeEnabled()
  await expect(s.page.locator('.talk__notice').getByRole('button', { name: 'Type instead' })).toBeVisible()
  await s.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sess.uid}`)
})

test('Constellation: stars, card, open, drag to link, search, pulses, list and keyboard @R7 @R8 @R15', async () => {
  s = await start()
  const desk = await s.login('desktop')
  const sky = await seedSky(s.url, desk)
  await go(s, '/constellation')
  await expect.poll(async () => (await s!.hook<{ nodes: number }>('presence.constellation')).nodes, { timeout: 15_000 }).toBe(sky.length)
  expect((await s.hook<{ edges: number }>('presence.constellation')).edges).toBe(10)
  expect((await s.hook<SurfaceInfo>('presence.surface')).kind).toBe('constellation')
  await expect(s.page.getByRole('list', { name: 'Conversations in the constellation' }).getByRole('listitem')).toHaveCount(sky.length)
  // Let the opening camera ease settle before aiming at stars.
  await s.page.waitForTimeout(1500)

  // Hover a star: the card; then click it: the chat opens.
  const target = sky.find((x) => x.title === 'Learning the cello')!
  const at = await s.hook<{ x: number; y: number } | null>('presence.starAt', target.uid)
  expect(at).not.toBeNull()
  await s.page.mouse.move(at!.x, at!.y)
  await expect(s.page.locator('.cst-card')).toContainText('Learning the cello')
  await s.page.mouse.click(at!.x, at!.y)
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${target.uid}`)

  // Drag one star onto another: a link (07 A4).
  await go(s, '/constellation')
  await expect.poll(async () => (await s!.hook<{ nodes: number }>('presence.constellation')).nodes).toBe(sky.length)
  await s.page.waitForTimeout(1500)
  const from = sky.find((x) => x.title === 'Coffee brewing ratios')!
  const to = sky.find((x) => x.title === 'Morning routine')!
  const a = (await s.hook<{ x: number; y: number }>('presence.starAt', from.uid))!
  const b = (await s.hook<{ x: number; y: number }>('presence.starAt', to.uid))!
  await s.page.mouse.move(a.x, a.y)
  await s.page.mouse.down()
  await s.page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 })
  await expect(s.page.locator('.cst-drag__hint')).toBeVisible()
  const b2 = (await s.hook<{ x: number; y: number }>('presence.starAt', to.uid))!
  await s.page.mouse.move(b2.x, b2.y, { steps: 6 })
  await s.page.mouse.up()
  await expect(s.page.getByText('Linked', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await desk.api<{ links: Array<{ shortId: string }> }>('GET', `/api/sessions/${from.uid}`)).json.links.map((l) => l.shortId))
    .toContain(to.shortId)
  await expect.poll(async () => (await s!.hook<{ edges: number }>('presence.constellation')).edges).toBe(11)

  // Search highlights.
  await s.page.getByRole('searchbox', { name: 'Find a conversation' }).fill('learn')
  await expect(s.page.getByRole('status').filter({ hasText: '3 matches' })).toBeVisible()
  await s.page.getByRole('searchbox', { name: 'Find a conversation' }).fill('')

  // A recall during a reply pulses its sources.
  await s.hook('presence.recalled', from.uid, [to.shortId, target.shortId])
  expect(await s.hook<{ pulses: number; replying: number }>('presence.constellation')).toMatchObject({ pulses: 2 })
  // A refresh while they run (the reply's own session.updated, a rename elsewhere) keeps them.
  expect((await desk.api('PATCH', `/api/sessions/${from.uid}`, { title: 'Coffee brewing notes' })).status).toBe(200)
  await expect(s.page.getByRole('list', { name: 'Conversations in the constellation' })).toContainText('Coffee brewing notes')
  expect(await s.hook<{ pulses: number; replying: number }>('presence.constellation')).toMatchObject({ pulses: 2 })
  expect((await frames(s)).budget.fps).toBeGreaterThan(0)

  // Keyboard: the list is the way through the map; Enter opens.
  const row = s.page.getByRole('button', { name: /^Trip to Lisbon,/ })
  await row.focus()
  await expect.poll(async () => (await s!.hook<{ selected: number }>('presence.constellation')).selected).toBeGreaterThanOrEqual(0)
  expect(await axe(s.page)).toEqual([])
  // The link dialog (keyboard linking).
  await s.page.getByRole('button', { name: 'Link “Trip to Lisbon” to…' }).click()
  await expect(s.page.getByRole('dialog', { name: 'Link “Trip to Lisbon”' })).toBeVisible()
  expect(await axe(s.page)).toEqual([])
  await s.page.keyboard.press('Escape')
  await row.focus()
  await s.page.keyboard.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${sky.find((x) => x.title === 'Trip to Lisbon')!.uid}`)

  // Leaving the page releases its model listeners.
  await go(s, '/settings')
  expect(await s.hook<{ listeners: number; projListeners: number; nodes: number }>('presence.constellation')).toMatchObject({ projListeners: 0, nodes: 0 })
  await s.assertNoErrors()
})

test('without WebGL: the Star falls back to 2D and the Constellation to a list @R15', async () => {
  s = await start()
  const desk = await s.login('desktop')
  await seedSky(s.url, desk, 6)
  await go(s, '/presence-lab')
  await s.hook('presence.setWebgl', 'unavailable')
  // Armilla (the v1.1 default) has its own 2D twin; the 1.0 styles fall back to the minimal 2D star.
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).armilla2d).toBe(true)
  expect((await s.hook<SurfaceInfo>('presence.surface')).canvas).toBe(false)
  // The 2D twin draws the same live oscilloscope: curves across the front, centred (v1.1.5).
  await s.hook('presence.speak')
  await expect.poll(async () => waveSwing(await s!.hook<WaveShot | null>('presence.armillaWave')), { timeout: 10_000 }).toBeGreaterThan(0.2)
  await expect.poll(async () => Math.abs(waveCentre(await s!.hook<WaveShot | null>('presence.armillaWave')) - 0.5), { timeout: 5000 }).toBeLessThan(0.15)
  await s.hook('audio.stop')
  await s.hook('presence.setPrefs', { style: 'orb' })
  await expect.poll(async () => (await s!.hook<SurfaceInfo>('presence.surface')).minimal2d).toBe(true)
  await go(s, '/constellation')
  await expect(s.page.getByText('The 3D map isn’t available here')).toBeVisible()
  await expect(s.page.getByRole('list', { name: 'Conversations in the constellation' }).getByRole('listitem')).toHaveCount(6)
  await s.page.getByRole('searchbox', { name: 'Find a conversation' }).fill('cello')
  await expect(s.page.getByRole('list', { name: 'Conversations in the constellation' }).getByRole('listitem')).toHaveCount(1)
  await s.page.screenshot({ path: path.resolve('test-results', 'presence-shots', 'cst-nogl.png') })
  expect(await axe(s.page)).toEqual([])
  await s.assertNoErrors()
})

test('Constellation empty state and the phone list sheet @R15', async () => {
  s = await start({ viewport: { width: 390, height: 844 } })
  // Phones draw the avatar in 2D (Armilla's twin, v1.1): no WebGL context until something needs one (07 D5, D8).
  await go(s, '/presence-lab')
  expect(await s.hook<SurfaceInfo>('presence.surface')).toMatchObject({ armilla2d: true, canvas: false })
  expect(await glContextsCreated(s.page)).toBe(0)
  await go(s, '/constellation')
  await expect(s.page.getByRole('heading', { name: 'Your sky is still empty' })).toBeVisible()
  await s.page.getByRole('button', { name: 'Start a conversation' }).click()
  await expect.poll(() => s!.hook<string>('route')).toMatch(/^\/s\//)
  const desk = await s.login('desktop')
  await seedSky(s.url, desk, 8)
  await go(s, '/constellation')
  await expect.poll(async () => (await s!.hook<{ nodes: number }>('presence.constellation')).nodes, { timeout: 15_000 }).toBe(8)
  await s.page.getByRole('button', { name: 'Show the list' }).click()
  await expect(s.page.getByRole('dialog', { name: 'Conversations' })).toBeVisible()
  const box = await s.page.getByRole('button', { name: /^Trip to Lisbon,/ }).boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(await axe(s.page)).toEqual([])
  await s.assertNoErrors()
})
