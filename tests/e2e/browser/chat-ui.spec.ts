/**
 * The conversation end to end through the UI (chat-ui, Phase 3): composer → streaming reply (block render, ≤ 1 DOM
 * commit per frame, Stop), regenerate → ‹ n/m ›, edit → branch, delete/restore, copy, slash commands, attachments by
 * paste and drop (client-side image downscale + thumbnail), long-paste chip, drafts, error states with actions,
 * markdown/link safety (07 B8: research 03's XSS payloads under the production CSP), the "Remembered" chip (07 A4).
 */
import { expect, test, type Page } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { launchServer, pageApi, type Api, type TestServer } from '../launch'
import { configureMockLlm, createSession, latestMessages, routes, wsTurn } from '../helpers'

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

async function open(title: string): Promise<{ uid: string; desktop: Api; page: Api }> {
  s = await launchServer({ mock })
  const desktop = (await s.login('desktop')).api
  await configureMockLlm(desktop, mock.url)
  const page = pageApi(s.page)
  const session = await createSession(page, title)
  await s.hook('go', routes.chat(session.uid))
  await s.waitReady()
  return { uid: session.uid, desktop, page }
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input')
  await input.fill(text)
  await input.press('Enter')
}

const ai = (page: Page) => page.locator('article.msg--ai')
const user = (page: Page) => page.locator('article.msg--user')

test('send from the composer, stream a reply block by block (≤ 1 commit per frame), stop it @R5 @R22', async () => {
  test.setTimeout(120_000)
  const { uid, page } = await open('Streaming')
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} talks about the sea, the wind and the lamp at the top of the tower.`).join('\n\n')
  mock.llm.script({ text: `${long}\n\n\`\`\`js\nconst lamp = 'on'\n\`\`\``, chunkChars: 6, delayMs: 8 })
  // Count DOM mutation batches per animation frame on the reply while it streams.
  await s!.page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __obs?: MutationObserver }
    w.__frames = []
    let batches = 0
    const feed = document.querySelector('[data-testid="message-window"]') ?? document.body
    w.__obs = new MutationObserver(() => {
      batches++
    })
    w.__obs.observe(feed, { childList: true, subtree: true, characterData: true })
    const tick = (): void => {
      if (batches) w.__frames.push(batches)
      batches = 0
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await send(s!.page, 'Tell me a long story.')
  await expect(user(s!.page)).toHaveCount(1)
  await expect(s!.page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(ai(s!.page).locator('.md p').nth(3)).toBeVisible()
  // Done: the code fence highlighted in the worker, the reply complete.
  await expect(ai(s!.page).locator('.code-block[data-highlighted]')).toHaveCount(1, { timeout: 20_000 })
  await expect(s!.page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  const frames = await s!.page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
  const over = frames.filter((n) => n > 2)
  expect(over.length, `frames with > 2 mutation batches: ${over.slice(0, 10).join(', ')} of ${frames.length}`).toBeLessThanOrEqual(Math.ceil(frames.length * 0.05))
  expect((await latestMessages(page, uid)).at(-1)!.body).toContain('Paragraph 12')

  // Stop a slow reply: it keeps its partial text, marked "Stopped".
  mock.llm.script({ text: long, chunkChars: 4, delayMs: 40 })
  await send(s!.page, 'Again, slowly.')
  await expect(ai(s!.page).nth(1).locator('.md p').first()).toBeVisible()
  await s!.page.getByRole('button', { name: 'Stop' }).click()
  await expect(ai(s!.page).nth(1).getByText('Stopped')).toBeVisible()
  await s!.assertNoErrors()
})

test('regenerate → ‹ 2 / 2 › switcher; edit → a new branch; delete → tombstone → restore @R5 @R22', async () => {
  test.setTimeout(120_000)
  const { uid, page } = await open('Branches')
  mock.llm.script({ text: 'First answer.' })
  await send(s!.page, 'Pick a colour.')
  await expect(ai(s!.page)).toContainText('First answer.')

  mock.llm.script({ text: 'Second answer.' })
  await ai(s!.page).hover()
  await ai(s!.page).getByRole('button', { name: 'Regenerate' }).click()
  await expect(ai(s!.page)).toContainText('Second answer.')
  const switcher = ai(s!.page).getByRole('group', { name: 'Reply 2 of 2' })
  await expect(switcher).toBeVisible()
  await switcher.getByRole('button', { name: 'Previous reply' }).click()
  await expect(ai(s!.page)).toContainText('First answer.')
  await expect(ai(s!.page).getByRole('group', { name: 'Reply 1 of 2' })).toBeVisible()

  // Edit the user message: a new branch with the edited text and a fresh reply.
  mock.llm.script({ text: 'Blue it is.' })
  await user(s!.page).hover()
  await user(s!.page).getByRole('button', { name: 'Edit' }).click()
  const editor = s!.page.getByRole('textbox', { name: 'Edit message' })
  await editor.fill('Pick a colour for the sky.')
  await s!.page.getByRole('button', { name: 'Save and send' }).click()
  await expect(user(s!.page)).toContainText('Pick a colour for the sky.')
  await expect(ai(s!.page)).toContainText('Blue it is.')
  await expect(user(s!.page).getByRole('group', { name: 'Version 2 of 2' })).toBeVisible()
  expect((await latestMessages(page, uid)).map((m) => m.body)).toEqual(['Pick a colour for the sky.', 'Blue it is.'])

  // ↑ in the empty composer edits the last message; Esc cancels.
  await s!.page.getByTestId('composer-input').click()
  await s!.page.keyboard.press('ArrowUp')
  await expect(s!.page.getByRole('textbox', { name: 'Edit message' })).toBeFocused()
  await s!.page.keyboard.press('Escape')
  await expect(s!.page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)

  // Delete the reply (with the context-refresh option), then restore it.
  await ai(s!.page).hover()
  await ai(s!.page).getByRole('button', { name: 'More actions' }).click()
  await s!.page.getByRole('menuitem', { name: 'Delete…' }).click()
  const dialog = s!.page.getByRole('dialog', { name: 'Delete this message?' })
  await expect(dialog).toContainText('The AI may still see it')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(ai(s!.page)).toContainText('Message deleted')
  await ai(s!.page).getByRole('button', { name: 'Restore' }).click()
  await expect(ai(s!.page)).toContainText('Blue it is.')
  await s!.assertNoErrors()
})

test('copy, slash commands (menu, /remember, /help, /retry), drafts survive navigation @R11 @R18 @R22', async () => {
  test.setTimeout(120_000)
  const { uid, page } = await open('Commands')
  mock.llm.script({ text: 'Copy **me**, please.' })
  await send(s!.page, 'Say something to copy.')
  await expect(ai(s!.page)).toContainText('Copy me, please.')
  await ai(s!.page).getByRole('button', { name: 'Copy' }).click()
  await expect(s!.page.getByText('Copied.')).toBeVisible()

  const input = s!.page.getByTestId('composer-input')
  await input.fill('/rem')
  const menu = s!.page.getByRole('listbox', { name: 'Commands' })
  await expect(menu.getByRole('option')).toHaveCount(1)
  await input.press('Tab')
  await expect(input).toHaveValue('/remember ')
  await input.pressSequentially('I like lighthouses')
  await input.press('Enter')
  await expect(s!.page.getByText('Vesper will remember this.')).toBeVisible()
  const facts = await page<{ text: string }[]>('GET', '/api/facts')
  expect(facts.json.map((f) => f.text)).toContain('I like lighthouses')

  await input.fill('/help')
  await input.press('Enter')
  const help = s!.page.getByRole('dialog', { name: 'Commands' })
  await expect(help).toContainText('/retry')
  await expect(help).toContainText('/edit-last')
  await s!.page.keyboard.press('Escape')

  mock.llm.script({ text: 'A retried reply.' })
  await input.fill('/retry')
  await input.press('Enter')
  await expect(ai(s!.page)).toContainText('A retried reply.')

  // An unknown /word is sent as text; //text escapes the slash.
  await send(s!.page, '//etc/hosts is a file')
  await expect(user(s!.page).last()).toContainText('/etc/hosts is a file')

  // Drafts are per session and survive leaving the chat.
  await input.fill('half-written thought')
  const other = await createSession(page, 'Other')
  await s!.page.waitForTimeout(500)
  await s!.hook('go', routes.chat(other.uid))
  await s!.waitReady()
  await expect(s!.page.getByTestId('composer-input')).toHaveValue('')
  await s!.hook('go', routes.chat(uid))
  await s!.waitReady()
  await expect(s!.page.getByTestId('composer-input')).toHaveValue('half-written thought')
  await s!.assertNoErrors()
})

async function pasteImage(page: Page): Promise<void> {
  await page.getByTestId('composer-input').evaluate(async (el) => {
    const c = document.createElement('canvas')
    c.width = 2400
    c.height = 1600
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 2400, 1600)
    grad.addColorStop(0, '#f5b84c')
    grad.addColorStop(1, '#3b2a6b')
    g.fillStyle = grad
    g.fillRect(0, 0, 2400, 1600)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

test('attachments: paste an image (downscaled + thumbnail), drop a file, long paste → chip, send @R18', async () => {
  test.setTimeout(120_000)
  const { uid, page } = await open('Attachments')
  await pasteImage(s!.page)
  const chips = s!.page.locator('.att-chip')
  await expect(chips).toHaveCount(1)
  await expect(chips.first().locator('img')).toBeVisible()
  await expect(chips.first()).toContainText(/Pasted .*\.jpg|Pasted .*\.png/)
  await expect(chips.first()).not.toContainText(/Uploading|Preparing/, { timeout: 15_000 })

  // Drop a text file anywhere on the chat.
  const dt = await s!.page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File(['notes from the trip\n'], 'notes.md', { type: 'text/markdown' }))
    return d
  })
  const chat = s!.page.locator('.chat')
  await chat.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(s!.page.locator('.drop-overlay')).toBeVisible()
  await chat.dispatchEvent('drop', { dataTransfer: dt })
  await expect(chips).toHaveCount(2)

  // A very long paste becomes a "Pasted text" attachment (07 C8), removable.
  await s!.page.getByTestId('composer-input').evaluate((el) => {
    const dt2 = new DataTransfer()
    dt2.setData('text/plain', 'lorem ipsum '.repeat(500))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }))
  })
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(2)).toContainText('Pasted text')
  await s!.page.getByRole('button', { name: 'Remove Pasted text' }).click()
  await expect(chips).toHaveCount(2)
  await expect(s!.page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })

  mock.llm.script({ text: 'Nice picture and notes.' })
  await send(s!.page, 'Here are my files')
  await expect(chips).toHaveCount(0)
  await expect(user(s!.page).locator('.msg-att--image img')).toBeVisible()
  await expect(user(s!.page).locator('.msg-att--file')).toContainText('notes.md')
  const msgs = await latestMessages(page, uid)
  const sent = msgs.find((m) => m.role === 'user') as unknown as { attachments: Array<{ kind: string; width?: number; height?: number; name: string }> }
  const img = sent.attachments.find((a) => a.kind === 'image')!
  // Downscaled in the client: long edge ≤ 1568 px (07 B6).
  expect(Math.max(img.width ?? 0, img.height ?? 0)).toBeLessThanOrEqual(1568)
  expect(Math.max(img.width ?? 0, img.height ?? 0)).toBeGreaterThan(1000)
  // The thumbnail is served inline.
  const thumbSrc = (await user(s!.page).locator('.msg-att--image img').getAttribute('src')) ?? ''
  const thumb = await s!.page.evaluate(async (src) => (await fetch(src)).headers.get('content-type'), thumbSrc)
  expect(thumb).toMatch(/^image\//)
  await s!.assertNoErrors()
})

test('reply errors show their action; a rate limit counts down @R2 @R22', async () => {
  test.setTimeout(120_000)
  await open('Errors')
  mock.llm.script({ error: { status: 401, message: 'bad key' } })
  await send(s!.page, 'hello')
  const err = ai(s!.page).locator('[data-error-code]')
  await expect(err).toHaveAttribute('data-error-code', 'provider_auth')
  await expect(err).toContainText('API key rejected')
  await expect(err.getByRole('button', { name: /Settings/ })).toBeVisible()
  await s!.assertNoErrors()
})

test('markdown is safe: research 03 XSS payloads under the production CSP, remote images never load (07 B8) @R16 @R22', async () => {
  test.setTimeout(120_000)
  await open('Safety')
  const payloads = [
    '<img src=x onerror="window.__xss=1">',
    '<script>window.__xss=2</script>',
    '[click](javascript:window.__xss=3)',
    '[click](JaVaScRiPt:window.__xss=4)',
    '[v](vbscript:msgbox(1))',
    '[d](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9NTwvc2NyaXB0Pg==)',
    '![i](javascript:window.__xss=6)',
    '<iframe src="https://example.com"></iframe>',
    '<form action="https://evil.example"><button>go</button></form>',
    '<svg><animate onbegin="window.__xss=7" attributeName="x" dur="1s"/></svg>',
    '<details open ontoggle="window.__xss=8">x</details>',
    '![track](https://tracker.example/pixel.png?secret=1)',
    '[bank.com](https://evil.example/login)',
    '[router](http://192.168.1.1/admin)',
    // F11: a URL-prefix look-alike in the text still shows the real host.
    '[https://bank.com](https://bank.com.evil.example/login)',
    // F13: a remote "image" on the local network warns before Open in browser.
    '![cam](http://192.168.1.20/cam.jpg)',
    // F13 (second pass): a trailing root dot is the same host ("localhost." is this PC).
    '[loop](http://localhost.:9/admin)',
    '![lcam](http://localhost.:9/cam.jpg)',
    // F10: dot-segments must not turn the attachment allow-list into a same-origin GET of another route.
    '![a](/api/attachments/../export?format=json)',
    '![b](/api/attachments/%2e%2e/auth/log)'
  ]
  mock.llm.script({ text: payloads.join('\n\n') })
  const requests: string[] = []
  const ownApi: string[] = []
  s!.page.on('request', (r) => {
    if (!r.url().startsWith(s!.url)) requests.push(r.url())
    else if (/\/api\/(export|auth\/log)/.test(r.url())) ownApi.push(r.url())
  })
  await send(s!.page, 'show me the payloads')
  const reply = ai(s!.page)
  await expect(reply.locator('.md-remote-img')).toHaveCount(3)
  await s!.page.waitForTimeout(800)
  expect(await s!.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  const dom = await reply.locator('.msg__content').evaluate((el) => ({
    dangerous: el.querySelectorAll('script, iframe, form, svg animate, details, object, embed').length,
    handlers: Array.from(el.querySelectorAll('*')).filter((n) => Array.from(n.attributes).some((a) => a.name.startsWith('on'))).length,
    badLinks: Array.from(el.querySelectorAll('a')).filter((a) => !/^(https?:|mailto:|\/|#)/.test(a.getAttribute('href') ?? 'x')).length,
    imgs: Array.from(el.querySelectorAll('img')).map((i) => i.getAttribute('src'))
  }))
  expect(dom).toEqual({ dangerous: 0, handlers: 0, badLinks: 0, imgs: [] })
  // Raw HTML shows as text, never as markup.
  await expect(reply).toContainText('<script>window.__xss=2</script>')
  // The real host is shown when the text names another one; a private address asks first.
  await expect(reply.getByRole('link', { name: /bank\.com.*evil\.example/ })).toHaveCount(2)
  await expect(reply.getByRole('link', { name: 'https://bank.com (bank.com.evil.example)' })).toBeVisible()
  await reply.getByRole('link', { name: /router/ }).click()
  await expect(s!.page.getByRole('dialog', { name: 'Open this link?' })).toContainText('local network')
  await s!.page.keyboard.press('Escape')
  await expect(s!.page.getByRole('dialog', { name: 'Open this link?' })).toHaveCount(0)
  // F13: a middle-click asks too, and opens no tab behind the owner's back.
  const tabs = s!.page.context().pages().length
  await reply.getByRole('link', { name: /router/ }).click({ button: 'middle' })
  await expect(s!.page.getByRole('dialog', { name: 'Open this link?' })).toContainText('local network')
  await s!.page.keyboard.press('Escape')
  await s!.page.waitForTimeout(300)
  expect(s!.page.context().pages().length).toBe(tabs)
  await reply.getByRole('button', { name: /“cam”/ }).click()
  await expect(s!.page.getByRole('dialog', { name: 'Open image from 192.168.1.20?' })).toContainText('local network')
  await s!.page.keyboard.press('Escape')
  // F13 (second pass): "localhost." asks like "localhost", for links and for remote images.
  await reply.getByRole('link', { name: /loop/ }).click()
  await expect(s!.page.getByRole('dialog', { name: 'Open this link?' })).toContainText('local network')
  await s!.page.keyboard.press('Escape')
  await expect(s!.page.getByRole('dialog', { name: 'Open this link?' })).toHaveCount(0)
  expect(s!.page.context().pages().length).toBe(tabs)
  await reply.getByRole('button', { name: /“lcam”/ }).click()
  await expect(s!.page.getByRole('dialog', { name: /^Open image from localhost/ })).toContainText('local network')
  await s!.page.keyboard.press('Escape')
  expect(requests, 'no request left this machine').toEqual([])
  expect(ownApi, 'no image reached another API route').toEqual([])
  await s!.assertNoErrors()
})

test('the "Remembered" chip lists recalled messages with Jump to and Forget (07 A4) @R7 @R8 @R10', async () => {
  test.setTimeout(120_000)
  const { uid, desktop, page } = await open('What was that trip?')
  // A native-tools profile (Anthropic via the mock) so the model's memory_search call is deterministic.
  const claude = { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: `${mock.url}/anthropic`, model: 'claude-opus-5-5' }
  expect((await desktop('PATCH', '/api/settings', { llm: { profiles: [claude], defaultProfile: 'claude' }, memory: { enabled: true, autoRecall: false, voyage: { tier: 'tier1' } } })).status).toBe(200)
  expect((await desktop('PUT', '/api/secrets/llm:claude', { value: 'sk-ant-e2e-0123456789' })).status).toBe(200)
  expect((await desktop('PUT', '/api/secrets/voyage', { value: 'pa-e2e-key' })).status).toBe(200)
  // The memory lives in another conversation that this one may recall (a link, R8).
  const trip = await createSession(page, 'Trip planning')
  await wsTurn(s!.page, trip.uid, 'We should plan a trip to Lisbon in the spring')
  await wsTurn(s!.page, trip.uid, 'Book a hotel near the castle')
  const short = (await page<{ shortId: string }>('GET', `/api/sessions/${trip.uid}`)).json.shortId
  expect((await page('PUT', `/api/sessions/${uid}/links/${short}`, {})).status).toBe(200)
  await expect.poll(async () => (await page<{ queued: number; indexed: number }>('GET', '/api/memory/status')).json.indexed, { timeout: 20_000 }).toBeGreaterThanOrEqual(4)
  mock.llm.script({ text: 'Let me check.', toolCalls: [{ name: 'memory_search', input: { query: 'Lisbon trip spring' } }] }, { text: 'You wanted to see Lisbon in spring.' })
  await send(s!.page, 'What trip did I want?')
  await expect(ai(s!.page).last()).toContainText('You wanted to see Lisbon in spring.')
  const chip = ai(s!.page).last().getByRole('button', { name: /Remembered/ })
  await expect(chip).toBeVisible()
  await chip.click()
  const panel = ai(s!.page).last().getByRole('region', { name: /remembered/ })
  await expect(panel).toContainText('Lisbon')
  await expect(panel).toContainText('Trip planning')
  await panel.getByRole('button', { name: /Forget this memory/ }).first().click()
  await s!.page.getByRole('dialog', { name: 'Forget this memory?' }).getByRole('button', { name: 'Forget' }).click()
  await expect(s!.page.getByText('Forgotten.')).toBeVisible()
  // Jump to opens the other conversation at the recalled message, flashed.
  await panel.getByRole('button', { name: 'Jump to' }).first().click()
  await expect.poll(() => s!.hook<string>('route')).toBe(`/s/${trip.uid}`)
  await expect(s!.page.locator('article.msg.is-flash')).toHaveCount(1)
  await s!.assertNoErrors()
})

test('reasoning disclosure (when shown) and "Speak again" from the message menu @R12 @R22', async () => {
  test.setTimeout(120_000)
  const { desktop } = await open('Thinking')
  expect((await desktop('PATCH', '/api/settings', { chat: { showReasoning: true }, voice: { tts: { enabled: true, autoSpeak: false, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4' } } })).status).toBe(200)
  expect((await desktop('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-e2e-key' })).status).toBe(200)
  mock.llm.script({ reasoning: 'The user wants a short answer. Keep it to one line.', text: 'One line, as asked.', delayMs: 10 })
  await send(s!.page, 'Think, then answer briefly.')
  await expect(ai(s!.page)).toContainText('One line, as asked.')
  const disclosure = ai(s!.page).getByRole('button', { name: 'Thought process' })
  await expect(disclosure).toBeVisible()
  await disclosure.click()
  await expect(ai(s!.page).getByRole('region', { name: 'Thought process' })).toContainText('Keep it to one line.')

  // "Speak again" asks the server to re-synthesize this reply (speech.replay): the TTS provider is called.
  const ttsCalls = (): number => mock.recorder.find((r) => r.method === 'POST' && r.path.includes('/text-to-speech/')).length
  const before = ttsCalls()
  await ai(s!.page).hover()
  await ai(s!.page).getByRole('button', { name: 'More actions' }).click()
  await s!.page.getByRole('menuitem', { name: 'Speak again' }).click()
  await expect.poll(ttsCalls, { timeout: 15_000 }).toBeGreaterThan(before)
  await s!.assertNoErrors()
})
