/**
 * Soak 1 (LEAK-1 row 1): 1,000 streamed text replies (mock LLM, ~4 kB each with code and math) through the composer,
 * on the built server + headless Chromium. Gates:
 *   renderer heap after GC +≤ 15 MB over the post-warm-up value, flat trend;
 *   DOM nodes ≤ the empty chat + 3N rows × the largest message's node count;
 *   jsEventListeners back to baseline ±2 % after switching to an empty session;
 *   server heap after GC +≤ 10 MB; no reply, controller or timer left in the engine; the WAL and the log at the end.
 */
import { test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../mocks/server'
import { configureMockLlm, createSession } from '../e2e/helpers'
import { launchServer, type TestServer } from '../e2e/launch'
import { cycles, finish, installPageCounters, Recorder, renderer, server, settle, steady } from './soak'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterAll(async () => {
  await s?.close()
  await mock?.close()
})

/** ~4 kB of markdown: prose, a fenced code block (shiki), display and inline math (KaTeX), a list and a table. */
function bigReply(i: number): string {
  const para = `Reply ${i}. The harbour lights came on one by one while the ferry crossed the bay; the gulls settled on the pier and the water turned from copper to ink. `
  const code = [
    '```ts',
    `export function orbit${i}(r: number, t: number): { x: number; y: number } {`,
    '  // a point on a circle, sampled for the Star',
    '  const a = (t / 1000) * Math.PI * 2',
    '  return { x: Math.cos(a) * r, y: Math.sin(a) * r }',
    '}',
    `const pts = Array.from({ length: 64 }, (_, k) => orbit${i}(${(i % 7) + 1}, k * 16))`,
    'console.log(pts.length, pts[0])',
    '```'
  ].join('\n')
  const math = `$$\\int_0^{${(i % 9) + 1}} x^2\\,dx = \\frac{${((i % 9) + 1) ** 3}}{3}$$`
  const inline = `Inline: $e^{i\\pi} + 1 = 0$ and $\\sum_{k=1}^{${i % 50}} k$.`
  const list = ['- first point', '- second point with **bold** and `code`', '- third point'].join('\n')
  const table = ['| a | b |', '| - | - |', `| ${i} | ${i * 2} |`].join('\n')
  let body = [para.repeat(6), code, math, inline, list, table].join('\n\n')
  while (body.length < 4000) body += `\n\n${para}`
  return body.slice(0, 4200)
}

async function waitReply(page: Page, uid: string, expectedLastSeq: number): Promise<void> {
  await page.waitForFunction(
    ({ uid: u, seq }) => {
      const st = (window.__vesperTest as unknown as { store: { state(): { chats: Record<string, { lastSeq: number; inflight: Record<string, unknown> }> } } }).store.state()
      const v = st.chats[u]
      return !!v && v.lastSeq >= seq && Object.keys(v.inflight).length === 0
    },
    { uid, seq: expectedLastSeq },
    { timeout: 60_000, polling: 50 }
  ).catch(async (e: unknown) => {
    // Say what the client had when the reply never settled.
    const state = await page.evaluate((u) => {
      const st = (window.__vesperTest as unknown as { store: { state(): { chats: Record<string, Record<string, unknown>> } } }).store.state()
      const v = st.chats[u] ?? {}
      const msgs = (v.messages as unknown[] | undefined) ?? []
      return { lastSeq: v.lastSeq, loSeq: v.loSeq, hiSeq: v.hiSeq, hasAfter: v.hasAfter, rows: msgs.length, inflight: Object.keys((v.inflight as object) ?? {}), pending: ((v.pending as unknown[]) ?? []).length, status: v.status, composer: (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null)?.value }
    }, uid)
    throw new Error(`reply ${expectedLastSeq / 2} did not settle: ${JSON.stringify(state)} (${e instanceof Error ? e.message : String(e)})`)
  })
}

test('1,000 streamed text replies: renderer heap, DOM nodes and listeners stay bounded @R17', async () => {
  const total = cycles(1000, 20)
  const warm = Math.min(200, Math.max(10, Math.round(total / 5)))
  const every = Math.max(1, Math.round((total - warm) / 10))
  test.setTimeout(30 * 60_000 + total * 2_000)
  const rec = new Recorder('text-replies')
  rec.cycles('replies', total)
  let n = 0
  mock.llm.setDefault(() => ({ text: bigReply(++n), chunkChars: 64 }))

  s = await launchServer({ mock, open: false, timeoutMs: 60_000 })
  await installPageCounters(s.page)
  await s.page.goto(s.url)
  await s.waitReady()
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  await steady(desk.api)
  const sess = await createSession(s.api, 'Soak: replies')
  const empty = await createSession(s.api, 'Soak: empty')
  await s.page.reload()
  await s.waitReady()
  const go = async (uid: string): Promise<void> => {
    await s!.hook('go', `/s/${uid}`)
    await settle(s!)
  }
  await go(sess.uid)
  const input = s.page.getByTestId('composer-input')
  let lastSeq = 0
  const turn = async (i: number): Promise<void> => {
    await input.fill(`Question ${i}: tell me about the harbour`)
    await input.press('Enter')
    lastSeq += 2
    await waitReply(s!.page, sess.uid, lastSeq)
  }

  for (let i = 0; i < warm; i++) await turn(i)
  await settle(s, 800)
  // Baselines: the empty session (listeners, nodes), then the chat (heap) and the server.
  await go(empty.uid)
  const emptyBase = await renderer(s.page)
  await go(sess.uid)
  await s.page.waitForTimeout(800)
  const heap: number[] = [(await renderer(s.page)).heapMB]
  const srvBase = await server(s.url)
  const srvHeap: number[] = [srvBase.heapUsedMB]

  for (let i = warm; i < total; i++) {
    await turn(i)
    if ((i - warm + 1) % every === 0) {
      await s.page.waitForTimeout(300)
      heap.push((await renderer(s.page)).heapMB)
      srvHeap.push((await server(s.url)).heapUsedMB)
    }
  }
  await settle(s, 1000)

  // DOM: the window keeps ≤ 3N rows; nodes stay under 3N × the largest message's nodes over the empty chat.
  const N = await s.hook<number>('chat.pageSize')
  const w = await s.hook<{ rows: number; domMessages: number }>('chat.window')
  const perMsg = await s.page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('article.msg')).map((a) => a.getElementsByTagName('*').length + 1)))
  const end = await renderer(s.page)
  rec.check('store rows (≤ 3N)', w.rows, 3 * N)
  rec.check('DOM messages (≤ 3N)', w.domMessages, 3 * N)
  rec.check('DOM nodes (≤ empty + 3N × max/msg)', end.nodes, emptyBase.nodes + 3 * N * perMsg)
  rec.note(`largest message: ${perMsg} nodes; empty chat ${emptyBase.nodes} nodes; chat at the end ${end.nodes} nodes`)
  rec.gate({ name: 'renderer heap after GC', unit: 'MB', values: heap, threshold: 15 })
  rec.gate({ name: 'server heap after GC', unit: 'MB', values: srvHeap, threshold: 10 })

  // Listeners back to baseline (±2 %) on the empty session.
  await go(empty.uid)
  await s.page.waitForTimeout(500)
  const emptyEnd = await renderer(s.page)
  rec.check('jsEventListeners vs empty-chat baseline (Δ)', Math.abs(emptyEnd.listeners - emptyBase.listeners), Math.max(2, Math.ceil(emptyBase.listeners * 0.02)))
  rec.note(`listeners on the empty chat: ${emptyBase.listeners} → ${emptyEnd.listeners}; documents ${emptyEnd.documents}`)
  const srv = await server(s.url)
  rec.check('engine replies/controllers/background left', (srv.engine?.active ?? 0) + (srv.engine?.controllers ?? 0) + (srv.engine?.background ?? 0), 0)
  // One pending session-summary timer per recently used session is expected (not per reply).
  rec.check('engine timers', srv.engine?.timers ?? 0, 2)
  const chatCounters = await s.hook<{ objectUrls: number; deltaBuffers: number }>('chat.counters')
  rec.check('chat delta buffers', chatCounters.deltaBuffers, 0)
  await s.assertNoErrors()
  await finish(rec, s)
  await s.close()
  s = null
  rec.done()
})
