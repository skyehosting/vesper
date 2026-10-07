/**
 * Soak 2 (LEAK-1 row 2): a 1,000,000-message session — top ↔ bottom twice (jumps to both ends, then five pages
 * inward), then 200 jumps anywhere. Gates: renderer heap after GC +≤ 20 MB, flat trend; store rows ≤ 3N + the live
 * reply; DOM messages ≤ 3N. (The markdown caches are bounded by construction: KaTeX 300 entries, shiki LRU 500 in its
 * worker — both ≤ 5N; the heap gate covers them.)
 */
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { rawRequest } from '../e2e/http'
import { launchServer, sameOriginHeaders, type TestServer } from '../e2e/launch'
import { cycles, finish, installPageCounters, Recorder, renderer, settle, SCALE } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

interface WindowInfo {
  rows: number
  domMessages: number
  loSeq: number
  hiSeq: number
  lastSeq: number
  anchor: { seq: number } | null
  loading: unknown
}

test('a 1M-message session: both ends twice and 200 jumps keep the window and the heap bounded @R5 @R17', async () => {
  const size = SCALE >= 1 ? 1_000_000 : Math.max(20_000, Math.round(1_000_000 * SCALE))
  const jumps = cycles(200, 20)
  test.setTimeout(20 * 60_000 + jumps * 3_000)
  const rec = new Recorder('history-scroll')
  rec.cycles('messages', size)
  rec.cycles('jumps', jumps)
  s = await launchServer({ mock, open: false, timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  const t0 = Date.now()
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/test/seed', headers: { ...sameOriginHeaders(s.url, await s.cookieHeader()), 'content-type': 'application/json' }, body: JSON.stringify({ sessions: 0, bigSession: size }), timeoutMs: 600_000 })
  expect(r.status, r.text).toBe(200)
  const uid = (r.json as { sessionUids: string[] }).sessionUids[0]
  rec.note(`seeded ${size} messages in ${Math.round((Date.now() - t0) / 1000)} s`)
  await s.hook('go', `/s/${uid}`)
  await settle(s, 500)
  const N = await s.hook<number>('chat.pageSize')
  const info = (): Promise<WindowInfo> => s!.hook<WindowInfo>('chat.window')

  let worstRows = 0
  let worstDom = 0
  const track = async (): Promise<void> => {
    const w = await info()
    worstRows = Math.max(worstRows, w.rows)
    worstDom = Math.max(worstDom, w.domMessages)
  }
  const jump = async (seq: number): Promise<void> => {
    await s!.page.evaluate(async (target) => {
      const t = window.__vesperTest as unknown as { chat: { jumpToSeq(seq: number): Promise<void> } }
      await t.chat.jumpToSeq(target)
    }, seq)
    await expect.poll(async () => Math.abs(((await info()).anchor?.seq ?? -1e9) - seq), { timeout: 15_000 }).toBeLessThan(N)
    await s!.waitReady()
    await track()
  }
  const pages = async (dir: 1 | -1, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await s!.hook('chat.scrollBy', dir * 3000)
      await s!.page.waitForTimeout(120)
      await s!.waitReady()
      await track()
    }
  }
  const ends = async (): Promise<void> => {
    await jump(1)
    await pages(1, 5)
    await jump(size)
    await pages(-1, 5)
  }

  // Warm-up: one round trip, then the baseline.
  await ends()
  const heap: number[] = [(await renderer(s.page)).heapMB]
  for (let k = 0; k < 2; k++) {
    await ends()
    heap.push((await renderer(s.page)).heapMB)
  }
  let seed = 11
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const sampleEvery = Math.max(1, Math.round(jumps / 10))
  for (let i = 0; i < jumps; i++) {
    await jump(1 + Math.floor(rnd() * (size - 1)))
    if ((i + 1) % sampleEvery === 0) heap.push((await renderer(s.page)).heapMB)
  }
  await jump(size)
  heap.push((await renderer(s.page)).heapMB)

  rec.gate({ name: 'renderer heap after GC', unit: 'MB', values: heap, threshold: 20 })
  rec.check('store rows, worst (≤ 3N + live reply)', worstRows, 3 * N + 1)
  rec.check('DOM messages, worst (≤ 3N)', worstDom, 3 * N)
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
