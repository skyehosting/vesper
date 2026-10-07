/**
 * Phase 5b fix5-client regressions (docs/review/phase5a-findings.md) through the real UI: mock LLM + mock ElevenLabs.
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { RICH_REPLY } from '../chatFixtures'
import { configureMockLlm, createSession, routes } from '../helpers'
import { launchServer, pageApi, type Api, type TestServer } from '../launch'

let mock: MockServer
let s: TestServer | null = null

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
})

const ai = (page: Page) => page.locator('article.msg--ai')

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input')
  await input.fill(text)
  await input.press('Enter')
}

/** Record the JSON messages the page receives on its WebSockets (before the app boots). */
async function recordWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __wsIn: Array<Record<string, unknown>> }
    w.__wsIn = []
    const Orig = window.WebSocket
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

/** A desktop-signed-in page with the mock LLM; with `voice`, mock ElevenLabs speaks replies on this device. */
async function open(o: { voice?: boolean; title?: string } = {}): Promise<{ uid: string; api: Api }> {
  s = await launchServer({ mock, login: 'desktop', open: false })
  await recordWs(s.page)
  await configureMockLlm(s.api, mock.url)
  if (o.voice) {
    expect((await s.api('PATCH', '/api/settings', { voice: { tts: { enabled: true, autoSpeak: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', perDevice: 'sender', reveal: 'synced' } } })).status).toBe(200)
    expect((await s.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  }
  const session = await createSession(s.api, o.title ?? 'Fix5 client')
  await s.page.goto(s.url)
  await s.waitReady()
  await s.waitHook('ws.connected')
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  return { uid: session.uid, api: s.api }
}

test('P02: a finished reply waiting for its voice says "Preparing voice…" — shimmer, no actions, Star preparing, Stop cancels the voice @R14', async () => {
  test.setTimeout(120_000)
  await open({ voice: true })
  await s!.hook('audio.unlock')
  mock.tts.setDelay(4000)
  const REPLY = 'The harbour lights came on one by one. Then the ferry sounded its horn.'
  mock.llm.script({ text: REPLY })
  await send(s!.page, 'Tell me about the harbour.')
  // The text is complete (reply.done) but the voice is still being made.
  let replyId = ''
  await expect
    .poll(async () => {
      const done = (await wsIn(s!.page)).find((m) => m.t === 'reply.done') as { replyId: string } | undefined
      replyId = done?.replyId ?? ''
      return replyId
    })
    .not.toBe('')
  expect((await s!.hook<{ state: string } | null>('voice.speech', replyId))?.state).toBe('waiting')
  const row = ai(s!.page).last()
  await expect(row.getByTestId('voice-wait')).toContainText('Preparing voice')
  await expect(row).toHaveAttribute('aria-busy', 'true')
  await expect(row.getByRole('button', { name: 'Copy' })).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Regenerate' })).toHaveCount(0)
  await expect(s!.page.locator('.chat-backdrop')).toHaveAttribute('data-state', 'preparing-voice')
  // The composer keeps Stop: it cancels the pending voice and the text arrives at once (F31: not "interrupted").
  const stop = s!.page.getByRole('button', { name: 'Stop' })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', replyId))?.state).toBe('cancelled')
  await expect(row.locator('[data-reply-root]')).toHaveText(REPLY)
  await expect(row.getByTestId('voice-wait')).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(row.locator('.msg__interrupted')).toHaveCount(0)
  await expect(s!.page.locator('.chat-backdrop')).toHaveAttribute('data-state', 'idle')
  await expect(stop).toHaveCount(0)
  await s!.assertNoErrors()
})

test('P13: light theme — ticked and unticked task boxes in a reply are clearly different @R22', async () => {
  test.setTimeout(90_000)
  await open()
  await s!.hook('presence.appearance', { theme: 'light' })
  mock.llm.script({ text: RICH_REPLY })
  await send(s!.page, 'Show me everything.')
  const done = ai(s!.page).last().locator('li > input[type="checkbox"]').first()
  const todo = ai(s!.page).last().locator('li > input[type="checkbox"]').nth(1)
  await expect(done).toBeChecked()
  await expect(todo).not.toBeChecked()
  const look = (l: typeof done) => l.evaluate((el) => {
    const cs = getComputedStyle(el)
    const page = getComputedStyle(el.closest('.msg') ?? document.body)
    return { bg: cs.backgroundColor, border: cs.borderTopColor, appearance: cs.appearance, pageBg: page.backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }
  })
  const a = await look(done)
  const b = await look(todo)
  expect(a.appearance).toBe('none')
  // Ticked: filled with the accent (gold #f5b84c by default); unticked: an outlined box, not the accent.
  expect(a.bg).toBe('rgb(245, 184, 76)')
  expect(b.bg).not.toBe(a.bg)
  expect(b.border).not.toBe(b.bg)
  await s!.assertNoErrors()
})

test('P17: a command that opens another chat is not left behind as the draft of the chat it was typed in @R18', async () => {
  test.setTimeout(90_000)
  const { uid } = await open({ title: 'Where I typed it' })
  const input = s!.page.getByTestId('composer-input')
  for (const cmd of ['/new Stargazing ideas', '/temp']) {
    await input.fill(cmd)
    // The draft is saved 400 ms after typing stops: let that happen first, as when the owner pauses before Enter.
    await s!.page.waitForTimeout(700)
    await input.press('Enter')
    await expect.poll(() => s!.hook<string>('route')).not.toBe(routes.chat(uid))
    await s!.hook('go', routes.chat(uid))
    await s!.waitReady()
    await expect(s!.page.getByTestId('composer-input')).toHaveValue('')
    expect(await s!.page.evaluate((u) => localStorage.getItem(`vesper.draft.${u}`), uid)).toBeNull()
  }
  await s!.assertNoErrors()
})

test('P18: Stop during a long voiced reply keeps only the spoken part — no blank block; the same as after a reload @R14 @R19', async () => {
  test.setTimeout(120_000)
  const { uid } = await open({ voice: true })
  await s!.hook('audio.unlock')
  // Long enough to leave most of it unspoken; streamed like a model (a reply that arrives at once outruns the socket's
  // audio budget and degrades to text, which is not what this test is about).
  const LONG = [
    'Once upon a time there was a lighthouse keeper who loved the storms. Every night she climbed the hundred steps and lit the lamp.',
    'The ships passed safely, and the sea sang to her in a low and patient voice. One winter a small boat came too close to the rocks.',
    'She rang the bell until her arms ached, and the boat turned just in time. The fisherman came back in spring with a basket of oranges.'
  ].join('\n\n')
  mock.llm.script({ text: LONG, chunkChars: 6, delayMs: 20 })
  await send(s!.page, 'Tell me a long story.')
  let replyId = ''
  await expect.poll(async () => (replyId = (await s!.hook<string[]>('voice.speechIds'))[0] ?? '')).not.toBe('')
  await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', replyId))?.state, { timeout: 20_000 }).toBe('speaking')
  await s!.page.waitForTimeout(1500)
  await s!.page.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', replyId))?.state).toBe('interrupted')
  const row = ai(s!.page).last()
  const marker = row.locator('.msg__interrupted')
  await expect(marker).toContainText('interrupted')
  expect(await s!.hook('audio.revealState', replyId)).toBe('frozen')
  const root = row.locator('.msg__content')
  // The marker sits right under the spoken text, not under the hidden rest.
  const gap = async (): Promise<number> => {
    const r = await root.boundingBox()
    const m = await marker.boundingBox()
    return (m?.y ?? 0) - ((r?.y ?? 0) + (r?.height ?? 0))
  }
  await expect.poll(gap).toBeLessThan(24)
  const liveHeight = (await root.boundingBox())!.height
  // After a reload the stored cut renders about the same.
  await s!.page.reload()
  await s!.waitReady()
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  const after = ai(s!.page).last().locator('.msg__content')
  await expect(ai(s!.page).last().locator('.msg__interrupted')).toBeVisible()
  const storedHeight = (await after.boundingBox())!.height
  expect(Math.abs(storedHeight - liveHeight), `live ${liveHeight} px vs stored ${storedHeight} px`).toBeLessThan(12)
  // "show rest" still shows the whole reply — far taller than the spoken part.
  await ai(s!.page).last().getByRole('button', { name: 'show rest' }).click()
  await expect(after).toContainText('basket of oranges')
  expect((await after.boundingBox())!.height).toBeGreaterThan(liveHeight * 1.8)
  await s!.assertNoErrors()
})

test('P18: Stop exactly at the end of a paragraph leaves no blank line before "interrupted" @R14 @R19', async () => {
  test.setTimeout(90_000)
  const { uid } = await open()
  await s!.hook('audio.unlock')
  // The synthetic speaker (real AudioEngine + RevealController): the second paragraph's text is held (in the DOM, hidden)
  // 8 s before its audio is queued, so the reveal rests exactly at the first paragraph's end when Stop is pressed.
  const P1 = 'The lighthouse keeper loved the storms.'
  const P2 = 'She climbed the hundred steps every night and lit the lamp for the ships.'
  await s!.hook('chat.armSpeech', uid, { charMs: 30, gapMs: 60, audioLagMs: 8000 })
  mock.llm.script({ text: `${P1}\n\n${P2}` })
  await send(s!.page, 'Tell me a story.')
  await expect.poll(async () => (await s!.hook<{ firstAudioAt: number | null } | null>('chat.speechLog'))?.firstAudioAt ?? null, { timeout: 20_000 }).not.toBeNull()
  const replyId = (await s!.hook<{ replyId: string }>('chat.speechLog')).replyId
  const row = ai(s!.page).last()
  await expect(row.locator('.msg__content p')).toHaveCount(2)
  // Stop once the first paragraph is fully shown (in the page, frame by frame).
  const frozenAt = await s!.page.evaluate(
    async ({ id, chars }) => {
      const t = window.__vesperTest as unknown as { audio: { revealProgress(id: string): number; revealLog(): Array<{ replyId: string; status: string; chars: number }> }; chat: { stopSpeech(): void } }
      const root = document.querySelector<HTMLElement>(`[data-reply-root="${id}"]`)!
      const total = root.textContent!.length
      for (;;) {
        if (t.audio.revealProgress(id) * total >= chars) break
        await new Promise((r) => requestAnimationFrame(r))
      }
      t.chat.stopSpeech()
      for (;;) {
        const f = t.audio.revealLog().find((l) => l.replyId === id && l.status === 'frozen')
        if (f) return f.chars
        await new Promise((r) => requestAnimationFrame(r))
      }
    },
    { id: replyId, chars: P1.length }
  )
  expect(frozenAt, 'frozen exactly at the paragraph boundary').toBe(P1.length)
  const marker = row.locator('.msg__interrupted')
  await expect(marker).toContainText('interrupted')
  const root = row.locator('.msg__content')
  // The root ends at the first paragraph's line (plus the collapse's few px of leading) — not a hidden line further down.
  const excess = (): Promise<number> => root.evaluate((el) => el.getBoundingClientRect().bottom - el.querySelector('p')!.getBoundingClientRect().bottom)
  await expect.poll(excess).toBeLessThan(8)
  const r = (await root.boundingBox())!
  const m = (await marker.boundingBox())!
  expect(m.y - (r.y + r.height)).toBeLessThan(24)
  await s!.hook('chat.clearSpeech')
  await s!.assertNoErrors()
})

test('P21: opening a search result in a short chat does not leave "Jump to latest" on screen @R5 @R6', async () => {
  test.setTimeout(90_000)
  const { uid } = await open({ title: 'Mount Rainier' })
  mock.llm.script({ text: 'Rainier is about 4,392 metres high.' })
  await send(s!.page, 'How tall is Mount Rainier?')
  await expect(ai(s!.page)).toContainText('4,392 metres')
  const msgs = (await s!.api<{ items: Array<{ uid: string; role: string }> }>('GET', `/api/sessions/${uid}/messages?mode=latest&limit=10`)).json.items
  expect(msgs).toHaveLength(2)
  for (const m of msgs) {
    await s!.hook('go', '/')
    await s!.waitReady()
    // The search page's result link: /s/:uid?m=<message> (the newest, then the first message).
    await s!.hook('go', `${routes.chat(uid)}?m=${m.uid}`)
    await s!.waitReady()
    await expect.poll(() => s!.hook<string>('route')).toBe(routes.chat(uid))
    await expect(s!.page.getByTestId('jump-latest')).toHaveCount(0)
    expect((await s!.hook<{ atBottom: boolean }>('chat.window')).atBottom).toBe(true)
  }
  await s!.assertNoErrors()
})

test('P24: a temporary chat\'s start marker says "Temporary chat", like its header @R11', async () => {
  test.setTimeout(90_000)
  await open()
  const input = s!.page.getByTestId('composer-input')
  await input.fill('/temp')
  await input.press('Enter')
  await expect(s!.page.getByText('Temporary chat: not saved and not remembered.', { exact: false })).toBeVisible()
  mock.llm.script({ text: 'Nothing here is kept.' })
  await send(s!.page, 'Is this saved?')
  await expect(ai(s!.page)).toContainText('Nothing here is kept.')
  await expect(s!.page.locator('.chat-start__title')).toHaveText('The beginning of “Temporary chat”')
  await expect.poll(() => s!.page.title()).toBe('Temporary chat · Vesper')
  await s!.assertNoErrors()
})

/** Voice a reply in a chat, then `/continue` it; the opener must be synthesized and spoken on this page. */
async function continueSpoken(o: { perDevice: 'sender' | 'all'; fromOtherChat: boolean }): Promise<void> {
  const { uid } = await open({ voice: true, title: 'Garden plans' })
  if (o.perDevice !== 'sender') expect((await s!.api('PATCH', '/api/settings', { voice: { tts: { perDevice: o.perDevice } } })).status).toBe(200)
  await s!.hook('audio.unlock')
  mock.llm.script({ text: 'Tomatoes by the fence, herbs by the door.' })
  await send(s!.page, 'Where should the tomatoes go?')
  await expect(ai(s!.page).last()).toContainText('herbs by the door', { timeout: 20_000 })
  await expect.poll(async () => (await s!.hook<string[]>('voice.speechIds')).length).toBe(1)
  const first = (await s!.hook<string[]>('voice.speechIds'))[0]
  const shortId = (await s!.api<{ shortId: string }>('GET', `/api/sessions/${uid}`)).json.shortId
  let from = uid
  if (o.fromOtherChat) {
    // The usual `/continue #ID`: typed in another chat (its completions leave the current chat out).
    await expect.poll(async () => (await s!.hook<{ state: string } | null>('voice.speech', first))?.state, { timeout: 20_000 }).toBe('done')
    from = (await createSession(s!.api, 'Elsewhere')).uid
    await s!.hook('go', routes.chat(from))
    await s!.waitReady()
  }
  const before = mock.tts.synthTexts().length
  mock.llm.script({ text: 'They planned tomatoes and herbs.', match: { lastUserIncludes: 'Updated recap:' } }, { text: 'Welcome back! Shall we finish the garden plan?' })
  const input = s!.page.getByTestId('composer-input')
  // Typed while the first reply may still be speaking: the barge-in must not eat what was typed.
  await input.fill(`/continue #${shortId}`)
  await expect(input).toHaveValue(`/continue #${shortId}`)
  await input.press('Enter')
  await expect.poll(() => s!.hook<string>('route')).not.toBe(routes.chat(from))
  // The opener went to the voice provider and this page speaks it with the synced reveal.
  await expect.poll(() => mock.tts.synthTexts().slice(before).map((t) => t.text).join(' '), { timeout: 20_000 }).toContain('Welcome back!')
  await expect
    .poll(async () => {
      const opener = (await s!.hook<string[]>('voice.speechIds')).find((id) => id !== first)
      return opener ? (await s!.hook<{ state: string } | null>('voice.speech', opener))?.state : null
    }, { timeout: 20_000 })
    .toMatch(/speaking|done/)
  expect(await s!.hook<Array<{ replyId: string }>>('voice.failures')).toEqual([])
  await expect(ai(s!.page).last()).toContainText('Shall we finish the garden plan?', { timeout: 20_000 })
  await s!.assertNoErrors()
}

test('P22: with voice replies on, the /continue opening reply is spoken like any other @R14 @R11', async () => {
  test.setTimeout(120_000)
  await continueSpoken({ perDevice: 'sender', fromOtherChat: false })
})

test("P22: voice per device 'all' — the /continue opener is still spoken on the tab that asked @R14 @R11", async () => {
  test.setTimeout(120_000)
  await continueSpoken({ perDevice: 'all', fromOtherChat: false })
})

test('P22: /continue #ID typed in a different chat speaks the opener too @R14 @R11', async () => {
  test.setTimeout(120_000)
  await continueSpoken({ perDevice: 'sender', fromOtherChat: true })
})

test("Voice out: switching the voice service while the old service's voices load never saves the old service's voice @R12", async () => {
  // Found as a flake of the Guided setup run (ElevenLabs chosen, a Windows voice saved): the first-voice auto-pick for
  // the old service went out after the switch had reached the server. Ordered here on purpose.
  test.setTimeout(60_000)
  const { api } = await open()
  expect((await api('PATCH', '/api/settings', { voice: { tts: { provider: 'windows', voiceId: null } } })).status).toBe(200)
  const page = s!.page
  let releaseVoices!: () => void
  const voicesHeld = new Promise<void>((r) => (releaseVoices = r))
  await page.route(/\/api\/tts\/voices\?.*provider=windows/, async (route) => {
    await voicesHeld
    await route.fulfill({ json: { voices: [{ id: 'win-old', name: 'Old Windows voice', provider: 'windows', previewable: false }], models: [] } })
  })
  // Hold every settings PATCH; forward the provider switch first, then anything else.
  const held: Array<{ body: string; go: () => void }> = []
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await new Promise<void>((go) => held.push({ body: route.request().postData() ?? '', go }))
    await route.continue()
  })
  await s!.hook('go', '/settings/voice-out')
  // (not waitReady: the voices request is held on purpose)
  await expect(page.getByRole('heading', { name: 'Voice out', level: 1 })).toBeVisible()
  await page.locator('label.radio-card', { hasText: 'ElevenLabs' }).click()
  await expect.poll(() => held.length).toBe(1)
  expect(held[0].body).toContain('elevenlabs')
  // The old service's voices arrive while the switch is in flight.
  releaseVoices()
  await page.waitForTimeout(1000)
  held[0].go()
  await expect.poll(async () => (await api<{ voice: { tts: { provider: string } } }>('GET', '/api/settings')).json.voice.tts.provider).toBe('elevenlabs')
  // Anything sent meanwhile (the bug: the old service's auto-picked voice) reaches the server after the switch.
  for (const h of held.slice(1)) h.go()
  await page.unroute('**/api/settings')
  await page.waitForTimeout(500)
  const tts = (await api<{ voice: { tts: { provider: string; voiceId: string | null } } }>('GET', '/api/settings')).json.voice.tts
  expect(tts).toMatchObject({ provider: 'elevenlabs', voiceId: null })
  await expect(page.getByRole('radio', { name: /ElevenLabs/ })).toBeChecked()
  await s!.assertNoErrors()
})
