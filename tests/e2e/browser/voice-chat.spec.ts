/**
 * The conversation + voice + presence seams end to end, through the REAL UI (Phase 4 integration; R14, R19, 07 C14,
 * C15, C16, D6). Mock LLM + mock ElevenLabs (real WAV with exact alignment) + VESPER_STT_FAKE (the real Silero VAD
 * over Chromium's fake microphone):
 *
 *   - synced reveal from the composer: the speaking browser shows nothing of a reply before its audio, then letter by
 *     letter, the last letter at the audio end; a second browser (not speaking) gets the text as deltas long before;
 *     barge-in by typing and by Stop freezes the reveal with "— interrupted · show rest", the server records how far
 *     the voice got (even after synthesis finished) and the next turn carries the 07 C15 note; "Speak again" reveals
 *     the stored reply again with its audio; a failing voice falls back to text (snapshot + deltas);
 *   - the client-side 6 s rule asks for the text at once (speech.textFirst) instead of waiting for the reply to end;
 *   - Talk mode on voice-client's mic session: one getUserMedia track for the visit, final → reply spoken (frames held
 *     while it plays) → re-arm → the next utterance, Interrupt, Mute, Hold/Resume, End; and barge-in by voice.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, routes } from '../helpers'
import { hookCaller, waitForReady, collectPageErrors, clientErrors } from '../hooks'
import { launchServer, pageApi, sameOriginHeaders, type TestServer } from '../launch'
import { HELLO_WAV } from '../voice'

let mock: MockServer
let s: TestServer | null = null
const tmpFiles: string[] = []

test.beforeAll(async () => {
  mock = await startMockServer()
})
test.afterEach(async () => {
  await s?.close()
  s = null
  mock.reset()
  mock.tts.setDelay(0)
})
test.afterAll(async () => {
  await mock?.close()
  for (const f of tmpFiles) fs.rmSync(f, { force: true })
})

const SHORT = 'The harbour lights came on one by one. Then the ferry sounded its horn.'
const STORY =
  'Once upon a time there was a lighthouse keeper who loved the storms. Every night she climbed the hundred steps and lit the lamp. ' +
  'The ships passed safely, and the sea sang to her in a low and patient voice. One winter a small boat came too close to the rocks.'

interface RevealLog {
  replyId: string
  status: string
  at: number
  audioEndAt: number | null
}

interface ReplySpeech {
  state: string
  heldText: string | null
}

/** Record the JSON messages a page receives and sends on its WebSockets (before the app boots). */
async function recordWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __wsIn: Array<Record<string, unknown>>; __wsOut: Array<Record<string, unknown>> }
    w.__wsIn = []
    w.__wsOut = []
    const Orig = window.WebSocket
    const send = Orig.prototype.send
    Orig.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string') {
        try {
          w.__wsOut.push(JSON.parse(data) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      return send.call(this, data)
    }
    class Recorded extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', (e: MessageEvent) => {
          if (typeof e.data !== 'string') return
          try {
            const m = JSON.parse(e.data) as Record<string, unknown>
            if (m.t !== 'ping') w.__wsIn.push(m)
          } catch {
            /* not JSON */
          }
        })
      }
    }
    window.WebSocket = Recorded
  })
}

async function wsIn(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __wsIn: Array<Record<string, unknown>> }).__wsIn)
}

async function wsOut(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as { __wsOut: Array<Record<string, unknown>> }).__wsOut)
}

/** Count getUserMedia calls (07 D6: one mic track per Talk visit). */
async function countGetUserMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gum: number }
    w.__gum = 0
    const md = navigator.mediaDevices
    if (!md?.getUserMedia) return
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      w.__gum++
      return orig(c)
    }
  })
}

async function gumCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gum: number }).__gum)
}

async function setupVoice(o: { fakeMic?: string; env?: Record<string, string>; stt?: Record<string, unknown> } = {}): Promise<{ uid: string }> {
  s = await launchServer({ mock, login: 'desktop', open: false, ...(o.fakeMic ? { fakeMic: o.fakeMic } : {}), env: o.env })
  await recordWs(s.page)
  await countGetUserMedia(s.page)
  const api = s.api
  await configureMockLlm(api, mock.url)
  expect((await api('PATCH', '/api/settings', { voice: { tts: { enabled: true, autoSpeak: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', perDevice: 'sender', reveal: 'synced' }, ...(o.stt ? { stt: o.stt } : {}) } })).status).toBe(200)
  expect((await api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  const session = await createSession(api, 'Voice seams')
  await s.page.goto(s.url)
  await s.waitReady()
  await s.waitHook('ws.connected')
  return { uid: session.uid }
}

/** A second signed-in browser (another device) with its own page. */
async function secondBrowser(srv: TestServer): Promise<{ page: Page; hook: ReturnType<typeof hookCaller>; errors: string[] }> {
  const ctx = await srv.browser.newContext({ baseURL: srv.url, viewport: { width: 1138, height: 608 } })
  const r = await ctx.request.post(`${srv.url}/api/test/login-as`, { data: { kind: 'browser' }, headers: sameOriginHeaders(srv.url, '') })
  expect(r.ok()).toBe(true)
  const page = await ctx.newPage()
  const errors: string[] = []
  collectPageErrors(page, errors)
  await recordWs(page)
  await page.goto(srv.url)
  await waitForReady(page)
  return { page, hook: hookCaller(page), errors }
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input')
  await input.fill(text)
  await input.press('Enter')
}

/** The replyId this page newly expects to speak (speechIds it did not know before). */
async function newSpeech(srv: TestServer, known: string[]): Promise<string> {
  let id: string | undefined
  await expect.poll(async () => (id = (await srv.hook<string[]>('voice.speechIds')).find((x) => !known.includes(x)) ?? undefined), { timeout: 10_000 }).toBeTruthy()
  return id as string
}

async function speechOf(srv: TestServer, replyId: string): Promise<ReplySpeech | null> {
  return srv.hook<ReplySpeech | null>('voice.speech', replyId)
}

/**
 * Sample the reply root every frame until its reveal completes or freezes: the share revealed whenever the root has
 * text, and the wall clock (Date.now) of the end.
 */
function watchReveal(page: Page, replyId: string): Promise<{ first: number; values: number[]; endWall: number; mono: boolean }> {
  return page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const t = window.__vesperTest as unknown as { audio: { revealProgress(id: string): number; revealLog(): Array<{ replyId: string }> } }
        const values: number[] = []
        let mono = true
        const tick = (): void => {
          const root = document.querySelector<HTMLElement>(`[data-reply-root="${id}"]`)
          if (root && root.textContent) {
            const p = t.audio.revealProgress(id)
            if (values.length && p + 1e-9 < values[values.length - 1]) mono = false
            values.push(p)
          }
          if (t.audio.revealLog().some((l) => l.replyId === id)) resolve({ first: values[0] ?? -1, values, endWall: Date.now(), mono })
          else requestAnimationFrame(tick)
        }
        tick()
      }),
    replyId
  )
}

/** hello.wav, a pause, hello.wav again (and a quiet tail): two utterances from one fake-mic track. */
function twoUtterances(gapSec: number): string {
  const src = fs.readFileSync(HELLO_WAV)
  let off = 12
  let fmt: Buffer | null = null
  let data: Buffer | null = null
  while (off + 8 <= src.length) {
    const id = src.toString('ascii', off, off + 4)
    const size = src.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = src.subarray(off + 8, off + 8 + size)
    if (id === 'data') data = src.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('hello.wav: no fmt/data chunk')
  const byteRate = fmt.readUInt32LE(8)
  const align = fmt.readUInt16LE(12)
  const silence = (sec: number): Buffer => Buffer.alloc(Math.round((byteRate * sec) / align) * align)
  const pcm = Buffer.concat([data, silence(gapSec), data, silence(2)])
  const head = Buffer.alloc(12 + 8 + fmt.length + 8)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(head.length - 8 + pcm.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(fmt.length, 16)
  fmt.copy(head, 20)
  head.write('data', 20 + fmt.length, 'ascii')
  head.writeUInt32LE(pcm.length, 24 + fmt.length)
  const file = path.join(os.tmpdir(), `vesper-e2e-two-utterances-${process.pid}-${gapSec}.wav`)
  fs.writeFileSync(file, Buffer.concat([head, pcm]))
  tmpFiles.push(file)
  return file
}

test('synced reveal through the chat: held until its audio, letter by letter, the other browser gets deltas; typing, Stop and "Speak again" @R14 @R19', async () => {
  test.setTimeout(180_000)
  const { uid } = await setupVoice()
  const other = await secondBrowser(s!)
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await other.hook('go', routes.chat(uid))
  await waitForReady(other.page)
  await s!.hook('audio.unlock')

  // ── 1. A spoken reply from the composer: nothing before its audio, then letter by letter to the audio end. ──
  mock.llm.script({ text: SHORT })
  await send(s!.page, 'Describe the harbour at dusk.')
  const r1 = await newSpeech(s!, [])
  const watched = watchReveal(s!.page, r1)
  // The other browser (not the speaker) is sent the text as it streams (deltas), long before the audio ends.
  const otherReply = other.page.locator('article.msg--ai').last()
  await expect(otherReply).toContainText('Then the ferry sounded its horn.', { timeout: 15_000 })
  const otherHasText = await other.page.evaluate(() => Date.now())
  const w = await watched
  expect(w.first, 'text visible before its audio').toBeLessThan(0.05)
  expect(w.mono, 'the reveal went backwards').toBe(true)
  expect(new Set(w.values.map((v) => v.toFixed(3))).size, 'not revealed letter by letter').toBeGreaterThan(20)
  const log1 = (await s!.hook<RevealLog[]>('audio.revealLog')).find((l) => l.replyId === r1)!
  expect(log1.status).toBe('done')
  expect(log1.audioEndAt).not.toBeNull()
  expect(Math.abs(log1.at - (log1.audioEndAt as number)), 'last letter vs audio end').toBeLessThanOrEqual(50)
  expect(otherHasText, 'the other browser had the text before the voice finished').toBeLessThan(w.endWall - 1500)
  // The speaker got no deltas for it; the other browser got them and no audio.
  expect((await wsIn(s!.page)).some((m) => m.t === 'reply.delta' && m.replyId === r1)).toBe(false)
  expect((await wsIn(other.page)).filter((m) => m.t === 'reply.delta' && m.replyId === r1).length).toBeGreaterThan(0)
  expect(await other.hook<string[]>('voice.speechIds')).not.toContain(r1)
  await expect(s!.page.locator(`[data-reply-root="${r1}"]`)).toHaveText(SHORT)

  // ── 2. Barge-in by typing, after synthesis finished (the audio still plays): frozen, "show rest", recorded. ──
  mock.llm.script({ text: STORY })
  await send(s!.page, 'Tell me a story.')
  const r2 = await newSpeech(s!, [r1])
  await expect.poll(() => s!.hook<number>('audio.revealProgress', r2), { timeout: 15_000 }).toBeGreaterThan(0.25)
  // Every chunk was synthesized and sent by now (synthesis outruns playback): this is the post-synthesis barge-in.
  await expect.poll(async () => (await wsIn(s!.page)).some((m) => m.t === 'speech.end' && m.replyId === r2), { timeout: 15_000 }).toBe(true)
  await s!.page.getByTestId('composer-input').pressSequentially('w')
  await expect.poll(async () => (await speechOf(s!, r2))?.state).toBe('interrupted')
  expect(await s!.hook('audio.revealState', r2)).toBe('frozen')
  const frozenAt = await s!.hook<number>('audio.revealProgress', r2)
  expect(frozenAt).toBeGreaterThan(0.2)
  expect(frozenAt).toBeLessThan(0.95)
  const row2 = s!.page.locator('article.msg--ai').last()
  await expect(row2.locator('.msg__interrupted')).toContainText('interrupted')
  const cancel = (await s!.hook<Array<{ replyId: string; spokenChars: number }>>('voice.cancels')).find((c) => c.replyId === r2)!
  expect(cancel.spokenChars).toBeGreaterThan(20)
  // The server marked the stored reply interrupted at that point (07 C15) and told the clients.
  const uid2 = await row2.getAttribute('data-uid')
  await expect
    .poll(async () => (await wsIn(other.page)).some((m) => m.t === 'message.updated' && (m.message as { uid: string; interrupted?: boolean }).uid === uid2 && (m.message as { interrupted?: boolean }).interrupted))
    .toBe(true)
  await row2.getByRole('button', { name: 'show rest' }).click()
  await expect(row2.locator(`[data-reply-root]`)).toContainText('came too close to the rocks.')
  // The next turn tells the AI where it was interrupted.
  await s!.page.getByTestId('composer-input').fill('')
  mock.llm.script({ text: 'Sorry, go ahead.' })
  const before = mock.recorder.all().length
  await send(s!.page, 'Sorry, what was that?')
  await expect.poll(() => mock.recorder.all().slice(before).filter((r) => r.method === 'POST' && /chat\/completions$/.test(r.path)).length, { timeout: 15_000 }).toBe(1)
  const req = mock.recorder.all().slice(before).find((r) => r.method === 'POST' && /chat\/completions$/.test(r.path))!
  expect(JSON.stringify(req.json)).toMatch(/interrupted your previous reply after: '.*'/)
  const r3 = await newSpeech(s!, [r1, r2])
  await expect.poll(async () => (await speechOf(s!, r3))?.state, { timeout: 20_000 }).toBe('done')

  // ── 3. Barge-in by Stop (the composer's Stop also stops a reply's voice). ──
  mock.llm.script({ text: STORY })
  await send(s!.page, 'Again, please.')
  const r4 = await newSpeech(s!, [r1, r2, r3])
  await expect.poll(() => s!.hook<number>('audio.revealProgress', r4), { timeout: 15_000 }).toBeGreaterThan(0.1)
  await s!.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await speechOf(s!, r4))?.state).toBe('interrupted')
  expect(await s!.hook('audio.revealState', r4)).toBe('frozen')
  await expect(s!.page.locator('article.msg--ai').last().getByRole('button', { name: 'show rest' })).toBeVisible()
  await expect.poll(async () => (await s!.hook<{ playing: number }>('audio.stats')).playing).toBe(0)

  // ── 4. "Speak again" on the first reply: revealed again with its own audio, to the end. ──
  const first = s!.page.locator('article.msg--ai').first()
  await first.hover()
  await first.getByRole('button', { name: 'More actions' }).click()
  await s!.page.getByRole('menuitem', { name: 'Speak again' }).click()
  let replay = ''
  await expect.poll(async () => (replay = (await s!.hook<string[]>('voice.speechIds')).find((x) => x.startsWith('rp_')) ?? ''), { timeout: 10_000 }).not.toBe('')
  await expect(first.locator(`[data-reply-root="${replay}"]`)).toBeAttached({ timeout: 10_000 })
  await expect.poll(async () => (await s!.hook<RevealLog[]>('audio.revealLog')).find((l) => l.replyId === replay)?.status, { timeout: 30_000 }).toBe('done')
  await expect(first.locator('[data-reply-root]')).toHaveText(SHORT)
  // A replay that is not interrupted leaves the stored reply as it was.
  await expect(first.locator('.msg__interrupted')).toHaveCount(0)

  expect(other.errors).toEqual([])
  expect(await clientErrors(other.page)).toEqual([])
  await s!.assertNoErrors()
})

test('a failing voice falls back to text: one snapshot then deltas, the whole reply readable, "Voice unavailable" @R14', async () => {
  test.setTimeout(120_000)
  const { uid } = await setupVoice()
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  mock.tts.failNext(500, 20)
  mock.llm.script({ text: STORY, chunkChars: 8, delayMs: 15 })
  await send(s!.page, 'Tell me a story.')
  const r = await newSpeech(s!, [])
  await expect.poll(async () => (await speechOf(s!, r))?.state, { timeout: 15_000 }).toBe('failed')
  await expect(s!.page.getByText(/Voice unavailable/)).toBeVisible()
  await expect(s!.page.locator('article.msg--ai').last()).toContainText('came too close to the rocks.', { timeout: 15_000 })
  const msgs = await wsIn(s!.page)
  expect(msgs.filter((m) => m.t === 'reply.snapshot' && (m.reply as { replyId: string }).replyId === r)).toHaveLength(1)
  expect(msgs.filter((m) => m.t === 'reply.delta' && m.replyId === r).length).toBeGreaterThan(0)
  expect(await s!.hook('audio.revealState', r)).not.toBe('revealing')
  await s!.assertNoErrors()
})

test('F31: typing right after sending (before any audio) cancels the voice only — the whole reply arrives as text, not interrupted @R14', async () => {
  test.setTimeout(120_000)
  const { uid } = await setupVoice()
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  mock.tts.setDelay(15_000)
  mock.llm.script({ text: STORY, chunkChars: 6, delayMs: 20 })
  await send(s!.page, 'Tell me a story.')
  const r = await newSpeech(s!, [])
  // "Preparing voice": nothing has been heard yet. A follow-up word in the composer…
  await s!.page.getByTestId('composer-input').pressSequentially('w')
  await expect.poll(async () => (await speechOf(s!, r))?.state, { timeout: 5_000 }).toBe('cancelled')
  const cancel = (await s!.hook<Array<{ replyId: string; beforeAudio: boolean }>>('voice.cancels')).find((c) => c.replyId === r)
  expect(cancel?.beforeAudio).toBe(true)
  // …does not discard the answer: it streams in as text and is stored complete, not interrupted.
  const row = s!.page.locator('article.msg--ai').last()
  await expect(row).toContainText('came too close to the rocks.', { timeout: 20_000 })
  await expect(row).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
  await expect(row.locator('[data-reply-root]')).toHaveText(STORY)
  await expect(row.locator('.msg__interrupted')).toHaveCount(0)
  const done = (await wsIn(s!.page)).find((m) => m.t === 'reply.done' && m.replyId === r) as { message: { status: string; interrupted?: boolean } } | undefined
  expect(done?.message.status).toBe('complete')
  expect(done?.message.interrupted ?? false).toBe(false)
  await expect(s!.page.getByText(/Voice unavailable/)).toHaveCount(0)
  await expect.poll(async () => (await s!.hook<{ playing: number }>('audio.stats')).playing).toBe(0)
  await s!.assertNoErrors()
})

test('F32: "wait for the tone" — a reply that streams for more than 6 s is still spoken (the 6 s clock starts when its voice is being made) @R14 @R13', async () => {
  test.setTimeout(120_000)
  const { uid } = await setupVoice()
  expect((await s!.api('PATCH', '/api/settings', { voice: { tts: { toneMode: 'conversation', waitForTone: true } } })).status).toBe(200)
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  // ≈ 8 s of streaming before the server may make any audio (07 A2: it waits for the whole reply and its tag).
  mock.llm.script({ text: `[tone=calm] ${STORY}`, chunkChars: 4, delayMs: 120 })
  await send(s!.page, 'Tell me a story, slowly.')
  const r = await newSpeech(s!, [])
  await expect.poll(async () => (await wsIn(s!.page)).some((m) => m.t === 'reply.done' && m.replyId === r), { timeout: 30_000 }).toBe(true)
  expect((await wsIn(s!.page)).some((m) => m.t === 'speech.preparing' && m.replyId === r)).toBe(true)
  await expect.poll(async () => (await speechOf(s!, r))?.state, { timeout: 15_000 }).toMatch(/speaking|done/)
  expect(await s!.hook<Array<{ replyId: string }>>('voice.failures')).toEqual([])
  expect((await wsOut(s!.page)).some((m) => m.t === 'speech.textFirst')).toBe(false)
  await expect(s!.page.getByText(/Voice unavailable/)).toHaveCount(0)
  await s!.assertNoErrors()
})

test('H-v11-tone: "Voice tones" in Settings, then a voiced conversation — the tone changes only when the conversation’s does, never in Off @R13 @R14', async () => {
  test.setTimeout(150_000)
  const { uid } = await setupVoice()
  // Only the replies below reach the mock LLM (no title requests in between).
  expect((await s!.api('PATCH', '/api/settings', { chat: { autoTitle: false } })).status).toBe(200)
  const page = s!.page
  // Settings → Voice out: the mode sits under the voice, "Follow the conversation" by default, with its sentence.
  await s!.hook('go', '/settings/voice-out')
  await s!.waitReady()
  const modes = page.locator('#vs-tts-tone-mode')
  await expect(modes.getByText('Voice tones', { exact: true })).toBeVisible()
  await expect(modes.getByRole('radio', { name: 'Follow the conversation' })).toBeChecked()
  await expect(modes.getByText('keeps it from reply to reply')).toBeVisible()
  await expect(page.getByTestId('vs-tone-support')).toHaveAttribute('data-supported', 'true')
  await modes.getByRole('radio', { name: 'Every reply' }).click()
  await expect(modes.getByText('fresh tone for every spoken reply')).toBeVisible()
  await expect.poll(async () => (await s!.api<{ voice: { tts: { toneMode: string } } }>('GET', '/api/settings')).json.voice.tts.toneMode).toBe('reply')
  await modes.getByRole('radio', { name: 'Follow the conversation' }).click()
  await expect.poll(async () => (await s!.api<{ voice: { tts: { toneMode: string } } }>('GET', '/api/settings')).json.voice.tts.toneMode).toBe('conversation')

  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  const known: string[] = []
  /** One spoken reply: the tones ElevenLabs (v4: an audio-tag prefix) was given for it. */
  const say = async (text: string, reply: string): Promise<Array<string | null>> => {
    const before = mock.tts.synthTexts().length
    mock.llm.script({ text: reply, chunkChars: 8, delayMs: 10 })
    await send(page, text)
    const r = await newSpeech(s!, known)
    known.push(r)
    await expect.poll(async () => (await speechOf(s!, r))?.state, { timeout: 30_000 }).toBe('done')
    const row = page.locator('article.msg--ai').last()
    await expect(row.locator('[data-reply-root]')).not.toContainText('[tone')
    const sent = mock.tts.synthTexts().slice(before)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((x) => !x.text.includes('[tone'))).toBe(true)
    return sent.map((x) => x.tone)
  }
  const one = (tones: Array<string | null>): string | null => {
    expect(new Set(tones).size).toBe(1)
    return tones[0]
  }
  expect(one(await say('Hi there!', `[tone=warm] ${SHORT}`))).toBe('warm')
  // No tag in the next reply: the voice keeps the conversation's tone.
  expect(one(await say('Tell me more.', 'The fishing boats came home early that evening.'))).toBe('warm')
  expect(one(await say('What happened then?', '[tone=excited] And then the whole town came out to watch the fireworks!'))).toBe('excited')
  const lastSystem = (): string => JSON.stringify((mock.recorder.find(/\/chat\/completions$/, 'POST').at(-1)?.json as { messages?: unknown[] })?.messages?.[0] ?? '')
  expect(lastSystem()).toContain('only when the emotional tone of the conversation really shifts')

  // Off: no tone reaches the voice, even when the AI writes a stray tag (it is stripped, never shown).
  await s!.hook('go', '/settings/voice-out')
  await s!.waitReady()
  await page.locator('#vs-tts-tone-mode').getByRole('radio', { name: 'Off' }).click()
  await expect.poll(async () => (await s!.api<{ voice: { tts: { toneMode: string } } }>('GET', '/api/settings')).json.voice.tts.toneMode).toBe('off')
  await expect(page.getByTestId('vs-tone-support')).toHaveCount(0)
  await expect(page.locator('#vs-tts-tone-placement').getByRole('radio', { name: 'At the end' })).toBeDisabled()
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  expect(one(await say('And now?', '[tone=sad] The lights went out one by one.'))).toBeNull()
  const last = JSON.stringify(mock.recorder.find(/\/chat\/completions$/, 'POST').at(-1)?.json ?? {})
  expect(last).toContain('turned voice tones off: from now on, do not write tone tags.')
  expect(one(await say('Goodnight.', 'Goodnight, sleep well.'))).toBeNull()
  await s!.assertNoErrors()
})

test('the 6 s rule asks for the text at once (speech.textFirst): text while the reply is still being written @R14', async () => {
  test.setTimeout(120_000)
  const { uid } = await setupVoice()
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await s!.hook('audio.unlock')
  mock.tts.setDelay(15_000)
  const long = `${STORY} ${STORY} ${STORY}`
  mock.llm.script({ text: long, chunkChars: 4, delayMs: 45 })
  await send(s!.page, 'Tell me a long story.')
  const r = await newSpeech(s!, [])
  await expect.poll(async () => (await speechOf(s!, r))?.state, { timeout: 12_000 }).toBe('failed')
  expect((await s!.hook<Array<{ replyId: string; reason: string }>>('voice.failures')).find((f) => f.replyId === r)?.reason).toBe('timeout')
  expect((await wsOut(s!.page)).some((m) => m.t === 'speech.textFirst' && m.replyId === r)).toBe(true)
  // The text arrives now (a targeted snapshot, then deltas) — while the reply is still being written.
  const row = s!.page.locator('article.msg--ai').last()
  await expect(row).toContainText('Once upon a time', { timeout: 5_000 })
  expect(await row.getAttribute('aria-busy')).toBe('true')
  await expect(row).toContainText('came too close to the rocks.', { timeout: 30_000 })
  await expect(row).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
  await expect(row.locator('[data-reply-root]')).toHaveText(long)
  await s!.assertNoErrors()
})

test('Talk mode on the voice client\'s mic: one track, final → spoken reply (held) → re-arm → next turn; Interrupt, Mute, Hold, End @R19 @R14 @R15', async () => {
  test.setTimeout(180_000)
  // Utterance 1, then silence for the whole spoken reply, then utterance 2: heard only because the mic re-armed.
  const wav = twoUtterances(9)
  const { uid } = await setupVoice({
    fakeMic: wav,
    env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Hello Vesper, can you hear me?|Tell me a story now' },
    stt: { enabled: true, silenceMs: 800, bargeIn: 'tap' }
  })
  mock.llm.script({ text: 'Yes, loud and clear.' }, { text: STORY })
  await s!.hook('go', `/talk/${uid}`)
  await s!.waitReady()
  await expect.poll(async () => (await wsOut(s!.page)).map((m) => m.t)).toEqual(expect.arrayContaining(['tts.prewarm', 'stt.prewarm', 'stt.start']))
  // One mic pipeline: voice-client's session, persistent, in conversation mode.
  await expect.poll(async () => (await s!.hook<{ mic: { active: boolean; persistent: boolean } }>('voice.stats')).mic).toMatchObject({ active: true, persistent: true })

  // Turn 1: your words, then the reply, spoken (Talk replies always speak when a voice is set up).
  const captions = s!.page.locator('.talk__captions')
  await expect(captions).toContainText('Hello Vesper, can you hear me?', { timeout: 20_000 })
  await expect(captions).toContainText('Yes, loud and clear.', { timeout: 20_000 })
  const send1 = (await wsOut(s!.page)).find((m) => m.t === 'chat.send')!
  expect(send1).toMatchObject({ text: 'Hello Vesper, can you hear me?', speak: true, talk: true })
  // While it speaks the mic frames are held (bargeIn 'tap'); the reveal in the captions runs on its audio.
  await expect.poll(async () => (await s!.hook<{ micHeld: boolean; ttsActive: boolean }>('voice.state')).ttsActive, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await s!.hook<{ micHeld: boolean }>('voice.state')).micHeld).toBe(true)
  await expect(s!.page.getByRole('status').filter({ hasText: 'Speaking' })).toBeVisible()
  // Re-arm after the audio: utterance 2 (spoken into the silence after the reply) is heard and sent.
  await expect(captions).toContainText('Tell me a story now', { timeout: 30_000 })
  await expect.poll(async () => (await wsOut(s!.page)).filter((m) => m.t === 'chat.send').length, { timeout: 15_000 }).toBe(2)
  const r1Done = (await s!.hook<RevealLog[]>('audio.revealLog')).some((l) => l.status === 'done')
  expect(r1Done, 'the first reply revealed to the end of its audio').toBe(true)

  // Interrupt the second (long) reply: the voice stops, the reveal freezes, the server is told how far it got.
  await expect(s!.page.getByRole('status').filter({ hasText: 'Speaking' })).toBeVisible({ timeout: 20_000 })
  await s!.page.getByRole('button', { name: 'Interrupt' }).click()
  await expect(s!.page.getByRole('status').filter({ hasText: /Listening|Warming/ })).toBeVisible()
  await expect.poll(async () => (await s!.hook<Array<{ spokenChars: number }>>('voice.cancels')).length).toBe(1)
  await expect.poll(async () => (await s!.hook<{ playing: number }>('audio.stats')).playing).toBe(0)
  await expect(captions.locator('.msg__interrupted')).toContainText('interrupted')

  // Mute: the track stays, nothing is heard.
  await s!.page.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(s!.page.getByText('Muted — Vesper isn’t listening')).toBeVisible()
  expect((await s!.hook<{ muted: boolean }>('voice.state')).muted).toBe(true)
  await s!.page.getByRole('button', { name: 'Unmute' }).first().click()
  // Hold keeps the track (07 D6): the server's STT session closes, the capture stays; Resume reopens it.
  const starts = (await wsOut(s!.page)).filter((m) => m.t === 'stt.start').length
  await s!.page.getByRole('button', { name: 'Hold' }).click()
  await expect(s!.page.getByRole('status').filter({ hasText: 'On hold' })).toBeVisible()
  expect(await s!.hook<{ active: boolean }>('audio.micStats')).toMatchObject({ active: true })
  expect((await s!.hook<{ mic: { held: boolean } }>('voice.stats')).mic.held).toBe(true)
  await s!.page.getByRole('button', { name: 'Resume' }).click()
  await expect(s!.page.getByRole('status').filter({ hasText: /Listening|Warming/ })).toBeVisible()
  await expect.poll(async () => (await wsOut(s!.page)).filter((m) => m.t === 'stt.start').length).toBe(starts + 1)

  // End: back to the chat, everything released; one getUserMedia track for the whole visit.
  await s!.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${uid}`)
  await expect.poll(async () => (await s!.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)
  await expect.poll(async () => (await s!.hook<{ mic: { active: boolean; listeners: number; timers: number } }>('voice.stats')).mic).toMatchObject({ active: false, listeners: 0, timers: 0 })
  expect(await gumCalls(s!.page)).toBe(1)
  await s!.assertNoErrors()
})

test('F35: Talk mode with a cloud recognizer survives a failed transcription — the next utterance is heard and sent @R19', async () => {
  test.setTimeout(120_000)
  const wav = twoUtterances(3)
  const { uid } = await setupVoice({ fakeMic: wav, stt: { enabled: true, provider: 'openai', model: 'gpt-4o-transcribe', silenceMs: 800, bargeIn: 'tap' } })
  expect((await s!.api('PUT', '/api/secrets/stt:openai', { value: 'sk-test-e2e-0000000000', forUrl: mock.url })).status).toBe(200)
  // The first utterance fails twice (upload + its one retry); the second one is transcribed.
  mock.stt.failNext(500, 2)
  mock.stt.script('Second time lucky')
  mock.llm.script({ text: 'Got it.' })
  await s!.hook('go', `/talk/${uid}`)
  await s!.waitReady()
  await expect.poll(async () => (await s!.hook<{ mic: { active: boolean; persistent: boolean } }>('voice.stats')).mic).toMatchObject({ active: true, persistent: true })
  await expect(s!.page.getByText(/please say it again/)).toBeVisible({ timeout: 20_000 })
  // Talk mode is still on and listening: the next utterance goes through.
  await expect.poll(async () => (await wsOut(s!.page)).find((m) => m.t === 'chat.send')?.text, { timeout: 20_000 }).toBe('Second time lucky')
  expect((await s!.hook<{ mic: { active: boolean } }>('voice.stats')).mic.active).toBe(true)
  await expect(s!.page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  // Each failure ended that server session cleanly: the client opened a fresh one.
  expect((await wsOut(s!.page)).filter((m) => m.t === 'stt.start').length).toBeGreaterThanOrEqual(2)
  await s!.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${uid}`)
  await s!.assertNoErrors()
})

test('Talk mode barge-in by voice: speaking over the reply stops it and sends what you said @R19 @R14', async () => {
  test.setTimeout(150_000)
  // Utterance 2 starts while the long reply is still being spoken.
  const wav = twoUtterances(3.5)
  const { uid } = await setupVoice({
    fakeMic: wav,
    env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'Tell me a long story please|Wait, stop for a second' },
    stt: { enabled: true, silenceMs: 800, bargeIn: 'voice' }
  })
  mock.llm.script({ text: `${STORY} ${STORY}` }, { text: 'Of course, I stopped.' })
  await s!.hook('go', `/talk/${uid}`)
  await s!.waitReady()
  const captions = s!.page.locator('.talk__captions')
  await expect(captions).toContainText('Tell me a long story please', { timeout: 20_000 })
  await expect(s!.page.getByRole('status').filter({ hasText: 'Speaking' })).toBeVisible({ timeout: 20_000 })
  // Your voice over the reply (07 C15 'voice'): the reply stops where it was and your words are sent.
  await expect.poll(async () => (await s!.hook<Array<{ spokenChars: number }>>('voice.cancels')).length, { timeout: 20_000 }).toBe(1)
  await expect(captions.locator('.msg__interrupted').first()).toContainText('interrupted')
  await expect(captions).toContainText('Of course, I stopped.', { timeout: 20_000 })
  const sends = (await wsOut(s!.page)).filter((m) => m.t === 'chat.send')
  expect(sends[1]).toMatchObject({ text: 'Wait, stop for a second', talk: true, interrupt: true })
  await s!.page.getByRole('button', { name: 'End' }).click()
  await expect.poll(async () => (await s!.hook<{ active: boolean }>('audio.micStats')).active).toBe(false)
  expect(await gumCalls(s!.page)).toBe(1)
  await s!.assertNoErrors()
})

test('chat details: #ID session chips open that chat; the first chat shows the setup checklist; avatars mirror the Star @R8 @R15', async () => {
  test.setTimeout(120_000)
  const { uid } = await setupVoice()
  const api = pageApi(s!.page)
  // The first chat's empty state lists the setup steps skipped in the wizard (desktop only, dismissible).
  await api('PATCH', '/api/settings', { wizard: { skipped: ['memory', 'voice-in'], checklistDismissed: false } })
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  const checklist = s!.page.getByRole('region', { name: 'Finish setting up' }).or(s!.page.locator('.checklist'))
  await expect(checklist.first()).toBeVisible()
  await s!.page.getByRole('button', { name: 'Hide the setup checklist' }).click()
  await expect(s!.page.locator('.checklist')).toHaveCount(0)

  const target = await createSession(api, 'Lisbon plans')
  const short = (await api<{ shortId: string }>('GET', `/api/sessions/${target.uid}`)).json.shortId
  await api('PATCH', '/api/settings', { voice: { tts: { enabled: false } } })
  mock.llm.script({ text: `We talked about it in #${short} last spring. A colour like #FF0000 stays text.` })
  await send(s!.page, 'Where did we talk about Lisbon?')
  const chip = s!.page.locator('article.msg--ai').last().getByRole('link', { name: new RegExp(`#${short}, open the chat “Lisbon plans”`) })
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await expect(s!.page.locator('article.msg--ai').last().locator('a.md-session')).toHaveCount(1)
  // The newest reply's avatar mirrors the Star's state (07 D5); idle once the reply is done.
  await expect(s!.page.locator('article.msg--ai.is-newest .msg__avatar')).toHaveCount(1)
  await chip.click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${target.uid}`)
  await s!.assertNoErrors()
})
