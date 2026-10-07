/**
 * Synced reveal in the conversation (R14, 07 C14/C15, BLD-5): a reply this client speaks is held until its audio is
 * ready, then appears letter by letter in time with it — the last letter within 50 ms of the audio end — with no
 * layout jump while it reveals; barge-in freezes it and "show rest" finishes it.
 *
 * The audio comes from audio-core's synthetic speech through the real AudioEngine and RevealController
 * (`__vesperTest.chat.armSpeech`), each chunk's markdown arriving with its audio as voice-client delivers `heldText`.
 * The last test drives the full server path (mock TTS → speech job → voice-client's speech client → the same reveal).
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type TestServer } from '../launch'
import { configureMockLlm, createSession, routes } from '../helpers'

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

interface RevealLog {
  replyId: string
  status: string
  at: number
  audioEndAt: number | null
  chars: number
}

const REPLY =
  'The lighthouse stood on the northern cliff for a hundred years. Its keeper wrote every storm into a **leather logbook**, and `the lamp` never failed once.\n\nOn the last night the fog came in so thick that the beam looked solid. You can read more in [the archive](https://example.com/lighthouse).'

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input')
  await input.fill(text)
  await input.press('Enter')
}

/**
 * Start sampling BEFORE the message is sent: every frame, every reply root that has text gets its geometry recorded
 * and, at its first appearance, its reveal progress. Starting after the first chunk was seen raced the audio under
 * load (the reveal had begun by the first sample: "text visible before its audio" at 0.13). Collect with
 * `collectLayout(page, replyId)` once the reply id is known.
 */
async function startLayoutWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = window.__vesperTest as unknown as { audio: { revealProgress(id: string): number; revealLog(): Array<{ replyId: string }> } }
    const seen = new Map<string, { heights: number[]; tops: number[]; firstHidden: number; done: boolean }>()
    ;(window as unknown as { __layoutWatch: typeof seen }).__layoutWatch = seen
    const tick = (): void => {
      for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-reply-root]'))) {
        const id = root.dataset.replyRoot as string
        if (!root.textContent) continue
        let w = seen.get(id)
        if (!w) {
          w = { heights: [], tops: [], firstHidden: t.audio.revealProgress(id), done: false }
          seen.set(id, w)
        }
        if (w.done) continue
        const r = root.getBoundingClientRect()
        w.heights.push(r.height)
        w.tops.push(r.top)
        if (t.audio.revealLog().some((l) => l.replyId === id)) w.done = true
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

async function collectLayout(page: Page, replyId: string): Promise<{ heights: number[]; tops: number[]; firstHidden: number }> {
  const get = (): Promise<{ heights: number[]; tops: number[]; firstHidden: number; done: boolean } | null> =>
    page.evaluate((id) => (window as unknown as { __layoutWatch: Map<string, { heights: number[]; tops: number[]; firstHidden: number; done: boolean }> }).__layoutWatch.get(id) ?? null, replyId)
  await expect.poll(async () => (await get())?.done ?? false, { timeout: 60_000 }).toBe(true)
  return (await get())!
}

test('held until its audio, letter by letter, last letter within 50 ms of the audio end, no layout jump @R14', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const session = await createSession(pageApi(s.page), 'Reveal')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  await s.hook('audio.unlock')
  await s.hook('chat.armSpeech', session.uid, { charMs: 18, gapMs: 30 })
  await s.hook('audio.clearEvents')
  mock.llm.script({ text: REPLY })
  await startLayoutWatch(s.page)
  await send(s.page, 'Tell me about the lighthouse.')

  await expect.poll(async () => (await s!.hook<{ replyId: string | null } | null>('chat.speechLog'))?.replyId ?? null).not.toBeNull()
  const replyId = (await s.hook<{ replyId: string }>('chat.speechLog')).replyId
  // While held, nothing of the reply is readable yet.
  await expect.poll(async () => (await s!.hook<{ chunks: number }>('chat.speechLog')).chunks).toBeGreaterThan(0)
  const layout = await collectLayout(s.page, replyId)
  expect(layout.firstHidden, 'text visible before its audio').toBeLessThan(0.05)

  const log = (await s.hook<RevealLog[]>('audio.revealLog')).find((l) => l.replyId === replyId)!
  expect(log.status).toBe('done')
  expect(log.audioEndAt).not.toBeNull()
  expect(Math.abs(log.at - (log.audioEndAt as number)), `reveal end ${log.at} vs audio end ${log.audioEndAt}`).toBeLessThanOrEqual(50)

  // The text is laid out in full (transparent) when it arrives; revealing letters never changes the layout.
  expect(layout.heights.length).toBeGreaterThan(10)
  expect(Math.max(...layout.heights) - Math.min(...layout.heights), 'height changed while revealing').toBeLessThanOrEqual(0.5)
  expect(Math.max(...layout.tops) - Math.min(...layout.tops), 'reply moved while revealing').toBeLessThanOrEqual(1)

  // Done: the whole reply is readable and selectable; no highlight ranges are left behind.
  const root = s.page.locator(`[data-reply-root="${replyId}"]`)
  await expect(root).toContainText('the archive')
  await expect(root).not.toHaveAttribute('aria-busy', 'true')
  expect(await s.page.evaluate(() => (CSS.highlights as unknown as Map<string, { size: number }>).get('vesper-unrevealed')?.size ?? 0)).toBe(0)
  // Block elements carry their mdast source offsets (exact chunk boundaries).
  const firstP = root.locator('p').first()
  await expect(firstP).toHaveAttribute('data-src-start', '0')
  await s.assertNoErrors()
})

test('barge-in freezes the reveal; "show rest" shows the whole reply @R14 @R19', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  const session = await createSession(pageApi(s.page), 'Barge-in')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  await s.hook('audio.unlock')
  await s.hook('chat.armSpeech', session.uid, { charMs: 40, gapMs: 60 })
  mock.llm.script({ text: REPLY })
  await send(s.page, 'Tell me about the lighthouse.')
  await expect.poll(async () => (await s!.hook<{ firstAudioAt: number | null } | null>('chat.speechLog'))?.firstAudioAt ?? null).not.toBeNull()
  const replyId = (await s.hook<{ replyId: string }>('chat.speechLog')).replyId
  await expect.poll(() => s!.hook<number>('audio.revealProgress', replyId)).toBeGreaterThan(0.1)
  await s.hook('chat.stopSpeech')
  await expect.poll(() => s!.hook<string | null>('audio.revealState', replyId)).toBe('frozen')
  const frozen = await s.hook<number>('audio.revealProgress', replyId)
  expect(frozen).toBeLessThan(1)
  const marker = s.page.getByRole('button', { name: 'show rest' })
  await expect(marker).toBeVisible()
  await expect(s.page.locator('.msg__interrupted')).toContainText('interrupted')
  await marker.click()
  await expect(marker).toHaveCount(0)
  await expect(s.page.locator(`[data-reply-root="${replyId}"]`)).toContainText('the archive')
  expect(await s.page.evaluate(() => (CSS.highlights as unknown as Map<string, { size: number }>).get('vesper-unrevealed')?.size ?? 0)).toBe(0)
  await s.hook('chat.clearSpeech')
  await s.assertNoErrors()
})

test('server speech (mock TTS): the speaking client reveals the reply with its audio @R14', async () => {
  test.setTimeout(120_000)
  s = await launchServer({ mock })
  const desktop = await s.login('desktop')
  await configureMockLlm(desktop.api, mock.url)
  await desktop.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, autoSpeak: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })
  expect((await desktop.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const session = await createSession(pageApi(s.page), 'Spoken')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  await s.hook('audio.unlock')
  await s.hook('audio.clearEvents')
  mock.llm.script({ text: REPLY })
  await send(s.page, 'Tell me about the lighthouse.')
  await expect(s.page.locator('article.msg--ai')).toHaveCount(1)
  // voice-client feeds the chunks to the engine (useReplySpeech): this client is the speaker.
  await expect.poll(async () => (await s!.hook<Array<{ type: string }>>('audio.events')).some((e) => e.type === 'chunkStart'), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await s!.hook<RevealLog[]>('audio.revealLog')).some((l) => l.status === 'done'), { timeout: 30_000 }).toBe(true)
  const log = (await s.hook<RevealLog[]>('audio.revealLog')).find((l) => l.status === 'done')!
  // The reveal completed on the audio clock (not cut short by a "finished"), its last letter at the audio end.
  expect(log.audioEndAt).not.toBeNull()
  expect(Math.abs(log.at - (log.audioEndAt as number))).toBeLessThanOrEqual(50)
  await expect(s.page.locator('article.msg--ai')).toContainText('the archive')
  await s.assertNoErrors()
})
