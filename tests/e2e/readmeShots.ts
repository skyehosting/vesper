/**
 * README screenshots (opt-in: README_SHOTS=1): the shared half of electron/readme.shots.spec.ts (the desktop window)
 * and browser/readme.shots.spec.ts (the phone). Everything on screen is an invented world (Alex, their sister Nora and
 * the people in their chats) seeded through the API and the mock providers; nothing reaches a real service.
 *
 *   seedWorld(d, mock)         settings that read like a real setup (Claude, Voyage memory, an ElevenLabs voice, speech
 *                              recognition on this PC), eight chats over four weeks with real turns (the server clock
 *                              is shifted with /api/test/clock while creating them), links between chats, facts
 *   heroTurns(d, mock, uid)    the hero conversation: a recall from an earlier chat, then a reply with a short list
 *   realSpeechTts(mock)        ElevenLabs answers with real recorded speech (the fixtures) instead of sine bursts, so
 *                              Talk mode's horizon draws a voice; each sentence end holds while the voice goes on
 *   assertPublishable(page)    the visible text holds no machine detail (paths, ports, names, "mock"…), no toast, no
 *                              error banner, no focus ring, and nothing scrolled part-way
 *   hiDpi(page, scale)         hi-DPI captures through CDP device metrics (the window itself stays as it is), whole
 *                              or a detail (detailClip), optionally laid out taller than the window
 *   publish(shot)              raw PNG → framed review PNG (rounded window, hairline, soft shadow, caption glyphs) →
 *                              docs/images/<name>.webp under the size budget, and its manifest.json entry
 *
 * docs/images holds only the final README images. Raw and review copies land in README_SHOTS_OUT (default: the
 * git-ignored .scratch/readme-shots/).
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import type { MockServer } from '../mocks/server'
import { encodeWav, parseWav } from '../mocks/audio'
import { sendJson } from '../mocks/http'
import { wsTurn } from './helpers'
import type { HookFn } from './hooks'
import { chromiumLaunchOptions, ROOT, type Api } from './launch'
import { AUDIO_FIXTURES } from './stt'

export const IMAGES = path.join(ROOT, 'docs', 'images')
export const SCRATCH = process.env.README_SHOTS_OUT ?? path.join(ROOT, '.scratch', 'readme-shots')
const RAW = path.join(SCRATCH, 'raw')
const REVIEW = path.join(SCRATCH, 'review')
const MANIFEST = path.join(SCRATCH, 'manifest.json')

/** Per image and in total (bytes): the README stays quick to load. */
const IMAGE_BUDGET = 450 * 1024
const TOTAL_BUDGET = 3.5 * 1024 * 1024

/** What both specs drive: a TestApp (Electron) or a TestServer (browser) signed in as the desktop. */
export interface Driver {
  page: Page
  api: Api
  hook: HookFn
  waitReady(): Promise<void>
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ── The world ─────────────────────────────────────────────────────────────────────────────────────

/** A real preset at its real address: test mode sends it to the mock (effectiveBaseUrl), the UI shows Claude. */
const CLAUDE = { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' }

interface ChatPlan {
  key: string
  title: string
  /** How long ago it happened (ms), and how long the reply took (the times on screen differ like real ones). */
  ago: number
  replyAfter: number
  pinned?: boolean
  turns: Array<[user: string, ai: string]>
}

const CHATS: ChatPlan[] = [
  {
    key: 'herbs',
    title: 'Balcony herb garden',
    ago: 26 * DAY + 5 * HOUR + 41 * MIN,
    replyAfter: 2 * MIN,
    turns: [
      [
        'My basil keeps bolting on the balcony. What am I doing wrong?',
        'Basil bolts when it is stressed by heat or not cut often enough. Pinch the tops above a pair of leaves every week, water in the morning rather than the evening, and give it a little afternoon shade. Parsley and mint will be happy in the same box, and the Greek basil at the garden centre on Hartley Street bolts less.'
      ]
    ]
  },
  {
    key: 'lisbon',
    title: 'Lisbon in May',
    ago: 11 * DAY + 3 * HOUR + 12 * MIN,
    replyAfter: 1 * MIN,
    turns: [
      [
        'Four days in Lisbon in May. Which neighbourhood should we stay in?',
        'Príncipe Real or Alfama. Alfama is steep lanes and fado bars, close to the castle; Príncipe Real is calmer, with good cafés and the botanical garden. For four days I would pick Príncipe Real and take tram 28 across town.'
      ]
    ]
  },
  {
    key: 'budget',
    title: 'Budget for the move',
    ago: 6 * DAY + 2 * HOUR + 37 * MIN,
    replyAfter: 3 * MIN,
    turns: [
      [
        'Help me set up a simple budget for moving flats in November.',
        'Keep it to one sheet: a column for each month until the move, and rows for the deposit, the removal van, the overlap in rent and the small things that add up (boxes, cleaning, new keys). Put a 10 % buffer at the bottom; moves always find extra costs.'
      ]
    ]
  },
  {
    key: 'guitar',
    title: 'Guitar: barre chord practice',
    ago: 4 * DAY + 6 * HOUR + 53 * MIN,
    replyAfter: 1 * MIN,
    pinned: true,
    turns: [
      [
        'Ten minutes a day on the F barre chord. How do I stop it buzzing?',
        'Roll your index finger slightly onto its bony side, keep your thumb behind the neck around the middle, and press just behind the fret rather than on top of it. Start at the fifth fret, where the strings sit lower, and walk the shape down to the first.'
      ]
    ]
  },
  {
    key: 'bookclub',
    title: 'Book club: The Remains of the Day',
    ago: 3 * DAY + 4 * HOUR + 23 * MIN,
    replyAfter: 2 * MIN,
    turns: [
      [
        'Notes from book club: everyone loved Stevens, Priya thought the ending was too tidy. Sam wants us to try Cedar & Salt next time, the Lebanese place on Hartley Street.',
        'Saved. Stevens was the favourite, Priya found the ending a little too neat, and Sam suggested dinner at Cedar & Salt on Hartley Street for next month. Shall I keep a list of the places the group recommends?'
      ]
    ]
  },
  {
    key: 'interview',
    title: 'Interview prep: product designer',
    ago: 1 * DAY + 2 * HOUR + 18 * MIN,
    replyAfter: 2 * MIN,
    turns: [
      [
        'I have a product designer interview on Tuesday. Can we practise the portfolio walkthrough?',
        'Gladly. Pick one project and tell it in four beats: the problem, what you tried first, what changed your mind, and the outcome in numbers. Keep it to five minutes, and I will play the hiring manager with follow-up questions.'
      ]
    ]
  },
  {
    // Empty until Talk mode asks its question there, so the captions hold that one exchange.
    key: 'bread',
    title: 'Baking banana bread',
    ago: 47 * MIN,
    replyAfter: 0,
    turns: []
  }
]

/** Facts about Alex, pinned over the past weeks. */
const FACTS: Array<[text: string, ago: number]> = [
  ['Sister Nora lives in Bristol and visits most months', 24 * DAY + 3 * HOUR + 27 * MIN],
  ['Mostly vegetarian', 19 * DAY + 1 * HOUR + 14 * MIN],
  ['Book club meets on the first Thursday of the month', 12 * DAY + 5 * HOUR + 48 * MIN],
  ['Moving flats in November', 6 * DAY + 2 * HOUR + 31 * MIN],
  ['Learning guitar, currently working on barre chords', 4 * DAY + 6 * HOUR + 46 * MIN]
]

export const HERO_TITLE = 'Saturday with Nora'

/** Zones around the world, one per few hours of offset. */
const ZONES = [
  'Pacific/Honolulu',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Atlantic/Azores',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Athens',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Brisbane',
  'Pacific/Noumea',
  'Pacific/Auckland'
]

/**
 * The profile's time zone: the one where it is early evening now, whenever the shots are taken (the chat header
 * shows the time; "Today" then holds the day's chats, and nothing on screen follows the machine's own zone).
 */
export function eveningZone(now = Date.now()): string {
  const minutes = (zone: string): number => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const get = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0)
    return get('hour') * 60 + get('minute')
  }
  const target = 18 * 60 + 40
  return ZONES.reduce((best, z) => (Math.abs(minutes(z) - target) < Math.abs(minutes(best) - target) ? z : best), ZONES[0])
}

export interface World {
  /** Session uid by plan key (plus 'hero'). */
  uid: Record<string, string>
  shortId: Record<string, string>
}

async function ok(r: Promise<{ status: number; text: string }>, what: string): Promise<void> {
  const res = await r
  expect(res.status, `${what} → ${res.status} ${res.text}`).toBeLessThan(300)
}

/** The model as Anthropic's API describes it, so the app reads real-looking capabilities. */
function scriptModelInfo(mock: MockServer): void {
  mock.script({
    method: 'GET',
    path: `/v1/models/${CLAUDE.model}`,
    times: Infinity,
    json: {
      type: 'model',
      id: CLAUDE.model,
      display_name: 'Claude Opus 5.5',
      created_at: '2026-08-01T00:00:00Z',
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { image_input: { supported: true }, pdf_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } } }
    }
  })
}

/**
 * Settings, keys, eight chats with real turns, links and facts. `d` must be signed in as the desktop (providers and
 * keys are desktop-only). The mock answers the scripted replies in order, so nothing else may call the LLM meanwhile
 * (auto titles are off).
 */
export async function seedWorld(d: Driver, mock: MockServer): Promise<World> {
  scriptModelInfo(mock)
  await ok(
    d.api('PATCH', '/api/settings', {
      profile: { userName: 'Alex', assistantName: 'Vesper', timeZone: eveningZone() },
      llm: { profiles: [CLAUDE], defaultProfile: CLAUDE.id },
      chat: { autoTitle: false },
      memory: { enabled: true, voyage: { tier: 'tier1' } },
      voice: {
        tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_flash_v2_5', toneMode: 'off', autoSpeak: true },
        stt: { enabled: true, provider: 'local', mode: 'conversation' }
      },
      // Avatar visibility 150 % (a real setting, 50–200 %): the presence reads at README size behind the messages.
      appearance: { theme: 'dark', accent: 'gold', star: { visibility: 1.5 } },
      performance: { gameMode: 'off' },
      wizard: { completed: true, checklistDismissed: true, skipped: [] }
    }),
    'PATCH /api/settings'
  )
  // Mock keys (the mock accepts any); they are bound to the real services' origins like real ones.
  await ok(d.api('PUT', `/api/secrets/llm:${CLAUDE.id}`, { value: 'sk-ant-readme-0123456789' }), 'llm key')
  await ok(d.api('PUT', '/api/secrets/voyage', { value: 'pa-readme-0123456789' }), 'voyage key')
  await ok(d.api('PUT', '/api/secrets/tts:elevenlabs', { value: 'xi-readme-0123456789' }), 'elevenlabs key')

  const world: World = { uid: {}, shortId: {} }
  for (const c of CHATS) {
    await ok(d.api('POST', '/api/test/clock', { offsetMs: -c.ago }), 'clock')
    const r = await d.api<{ uid: string; shortId: string }>('POST', '/api/sessions', { title: c.title })
    expect(r.status, r.text).toBe(200)
    world.uid[c.key] = r.json.uid
    world.shortId[c.key] = r.json.shortId
    for (const [user, ai] of c.turns) {
      // The reply is stamped when it finishes: once the mock has the request (the question is saved), move the clock
      // on by `replyAfter` while the mock holds its first byte.
      mock.llm.script({ text: ai, firstByteDelayMs: 1200 })
      const turn = wsTurn(d.page, r.json.uid, user)
      await expect.poll(() => mock.llm.pending(), { timeout: 15_000, intervals: [20] }).toBe(0)
      await ok(d.api('POST', '/api/test/clock', { offsetMs: -c.ago + c.replyAfter }), 'clock')
      await turn
    }
    if (c.pinned) await ok(d.api('PATCH', `/api/sessions/${r.json.uid}`, { pinned: true }), 'pin')
  }
  await ok(d.api('POST', '/api/test/clock', { offsetMs: -3 * MIN }), 'clock')
  const hero = (await d.api<{ uid: string; shortId: string }>('POST', '/api/sessions', { title: HERO_TITLE })).json
  world.uid.hero = hero.uid
  world.shortId.hero = hero.shortId
  for (const [text, ago] of FACTS) {
    await ok(d.api('POST', '/api/test/clock', { offsetMs: -ago }), 'clock')
    await ok(d.api('POST', '/api/facts', { text }), 'fact')
  }
  await ok(d.api('POST', '/api/test/clock', { offsetMs: 0 }), 'clock')

  // The hero may read the book club chat (and it reads back); the budget remembers the Lisbon plans.
  await ok(d.api('PUT', `/api/sessions/${hero.uid}/links/${world.shortId.bookclub}`, { bothWays: true }), 'link')
  await ok(d.api('PUT', `/api/sessions/${world.uid.budget}/links/${world.shortId.lisbon}`, {}), 'link')
  return world
}

/**
 * The hero conversation: Vesper recalls the book club chat (a memory search), then (unless `recallOnly`) plans the
 * day in a short list.
 */
export async function heroTurns(d: Driver, mock: MockServer, uid: string, o: { recallOnly?: boolean } = {}): Promise<void> {
  mock.llm.script(
    { text: '', toolCalls: [{ name: 'memory_search', input: { query: 'Lebanese restaurant Sam recommended' } }] },
    {
      // Plain text: the memory viewer's search snippets show a message's raw markdown.
      text: 'It was Cedar & Salt, on Hartley Street. Sam suggested it at book club this week as the place for the group’s next dinner, so it should be a safe bet for you and Nora too.'
    }
  )
  await wsTurn(d.page, uid, 'Nora is coming up on Saturday. What was the Lebanese place Sam recommended?')
  if (o.recallOnly) return
  mock.llm.script({
    text: [
      'Here’s an easy Saturday with room to wander:',
      '',
      '- **10:30** Coffee and the farmers’ market by the canal',
      '- **13:00** Lunch at home, then the botanical gardens',
      '- **17:00** A slow walk back along the river',
      '- **19:30** Dinner at Cedar & Salt',
      '',
      'Weekend tables go quickly, so I’d book for two by Thursday.'
    ].join('\n')
  })
  await wsTurn(d.page, uid, 'Perfect. Can you plan a relaxed day around dinner there?')
}

// ── Real speech ───────────────────────────────────────────────────────────────────────────────────

/** The fixtures' recorded speech (16 kHz mono PCM), joined. */
function speechPcm(): { pcm: Int16Array; rate: number } {
  const parts = ['hello.wav', 'search.wav'].map((f) => parseWav(fs.readFileSync(path.join(AUDIO_FIXTURES, f))))
  const total = parts.reduce((n, p) => n + p.pcm.length, 0)
  const pcm = new Int16Array(total)
  let at = 0
  for (const p of parts) {
    pcm.set(p.pcm, at)
    at += p.pcm.length
  }
  return { pcm, rate: parts[0].sampleRate }
}

/** `ms` of real speech (the fixtures looped) as a WAV. */
function speechWavOf(ms: number): Buffer {
  const src = speechPcm()
  const n = Math.round((ms / 1000) * src.rate)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = src.pcm[i % src.pcm.length]
  return encodeWav(out, src.rate)
}

/** About ten seconds of real speech for `presence.speakWav`. */
export function speechClip(ms = 10_000): { b64: string; ms: number } {
  return { b64: speechWavOf(ms).toString('base64'), ms }
}

// ── Talk mode ─────────────────────────────────────────────────────────────────────────────────────

/** Talk mode's one exchange (desktop and phone): the question the scripted recognizer hears, and the reply. */
export const TALK_QUESTION = 'How long should the banana bread bake for?'
export const TALK_REPLY =
  'About fifty minutes at 175 °C, until a skewer comes out clean. Let it cool in the tin for ten minutes before you turn it out, or it will crack.'
/** The stills catch the caption at the end of this, the reply's first sentence, while the voice goes on. */
const TALK_FIRST = TALK_REPLY.slice(0, TALK_REPLY.indexOf('clean.') + 'clean.'.length)

/**
 * Wait until Talk mode's spoken reply has revealed its first sentence up to the full stop (the words then hold for
 * SENTENCE_PAUSE_MS). Returns when that happened (Date.now()), for `stillInPause`.
 */
export async function firstSentenceShown(hook: HookFn): Promise<number> {
  let replyId = ''
  await expect
    .poll(
      async () => {
        const ev = await hook<Array<{ type: string; replyId?: string }>>('audio.events')
        replyId = ev.find((e) => e.type === 'chunkStart' && e.replyId && !e.replyId.startsWith('presence-'))?.replyId ?? ''
        return replyId
      },
      { timeout: 30_000, intervals: [100] }
    )
    .not.toBe('')
  await expect.poll(() => hook<number>('audio.revealProgress', replyId), { timeout: 20_000, intervals: [25] }).toBeGreaterThanOrEqual(TALK_FIRST.length / TALK_REPLY.length)
  return Date.now()
}

/** The still was taken before the next sentence began (its first word can't have shown yet). */
export function stillInPause(since: number): void {
  expect(Date.now() - since, 'the Talk mode still was taken inside the sentence pause').toBeLessThan(SENTENCE_PAUSE_MS - 300)
}

/** How long a sentence end holds before the next word (and after the last one) while the voice goes on. */
export const SENTENCE_PAUSE_MS = 4500

/**
 * ElevenLabs with-timestamps answered with real recorded speech: about 65 ms per character (an easy speaking pace),
 * the alignment spread evenly so the words appear in step with it. After each sentence the words hold for
 * SENTENCE_PAUSE_MS while the speech goes on, so a still can catch a caption that ends on a full stop.
 */
export function realSpeechTts(mock: MockServer): void {
  mock.script({
    method: 'POST',
    path: /^\/v1\/text-to-speech\/[^/]+\/with-timestamps$/,
    times: Infinity,
    handler: (req, res) => {
      const text = String((req.json as { text?: unknown } | undefined)?.text ?? '')
      const chars = [...text]
      const step = 0.065
      const starts: number[] = []
      let t = 0
      for (let i = 0; i < chars.length; i++) {
        // A word that follows a sentence end waits for the pause.
        if (i > 1 && /\s/.test(chars[i - 1]) && /[.!?]/.test(chars[i - 2])) t += SENTENCE_PAUSE_MS / 1000
        starts.push(t)
        t += step
      }
      const ms = Math.max(900, Math.round(t * 1000) + SENTENCE_PAUSE_MS)
      const alignment = {
        characters: chars,
        character_start_times_seconds: starts,
        character_end_times_seconds: starts.map((s) => s + step)
      }
      sendJson(res, 200, { audio_base64: speechWavOf(ms).toString('base64'), alignment, normalized_alignment: alignment })
    }
  })
}

// ── Clean frames ──────────────────────────────────────────────────────────────────────────────────

/** Nothing in a published image may name the machine, the person who built it, or the harness. */
const FORBIDDEN: RegExp[] = [
  /raven/i,
  /skyehosting/i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /\b(?:10\.0\.0|192\.168)\.\d+/,
  /127\.0\.0\.1|localhost(?::\d+)?/i,
  /[A-Z]:\\Users\\/i,
  /\\AppData\\|\\Temp\\|vesper-e2e/i,
  /\bmock/i,
  /\be2e\b/i,
  /\btest(?:s|ing)?\b/i,
  /fixture/i,
  /readme/i
]

/**
 * The visible text of the page is clean (the FORBIDDEN list), and the frame shows no toast, no error banner and no
 * focus ring (`focus`: one is expected, e.g. the composer while typing). The avatar's canvas carries no words, so only
 * DOM text is scanned.
 */
export async function assertPublishable(page: Page, label: string, o: { focus?: boolean } = {}): Promise<void> {
  const seen = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false
      const cs = getComputedStyle(el)
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.02 && !el.closest('.sr-only, [aria-hidden="true"]')
    }
    const texts: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      const t = n.textContent?.trim()
      if (el && t && visible(el)) texts.push(t)
    }
    for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
      const v = (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder
      if (v && visible(el)) texts.push(v)
    }
    const toasts = Array.from(document.querySelectorAll('.toast')).filter(visible).length
    const banners = Array.from(document.querySelectorAll('.conn-banner, [role="alert"], [data-error-code]')).filter(visible).length
    const focus = document.activeElement && document.activeElement !== document.body ? document.activeElement.matches(':focus-visible') : false
    return { text: texts.join('\n'), toasts, banners, focus }
  })
  const bad = FORBIDDEN.filter((r) => r.test(seen.text)).map((r) => `${r} → ${seen.text.match(r)?.[0]}`)
  expect(bad, `${label}: forbidden text on screen`).toEqual([])
  expect(seen.toasts, `${label}: a toast is showing`).toBe(0)
  expect(seen.banners, `${label}: an error banner is showing`).toBe(0)
  if (!o.focus) expect(seen.focus, `${label}: a focus ring is showing`).toBe(false)
}

/** Park the pointer where it hovers nothing (the top edge of the bar, mid-window) and drop focus. */
export async function calm(page: Page): Promise<void> {
  const w = await page.evaluate(() => window.innerWidth)
  await page.mouse.move(Math.min(700, Math.round(w / 2)), 4)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

/**
 * A still has no text caret and no scrollbars (they read as an overlay scrollbar at rest would): set through the
 * CSSOM, which the page's CSP allows where a <style> tag would not, and undone right after the capture.
 */
async function stillStyle(page: Page, on: boolean): Promise<void> {
  const changed = await page.evaluate((hide) => {
    let n = 0
    if (!hide) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-still]'))) {
        el.style.removeProperty('scrollbar-width')
        el.style.removeProperty('caret-color')
        delete el.dataset.still
        n++
      }
      return n
    }
    const a = document.activeElement as HTMLElement | null
    if (a?.style) {
      a.style.caretColor = 'transparent'
      a.dataset.still = ''
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (el.scrollHeight <= el.clientHeight + 1) continue
      const oy = getComputedStyle(el).overflowY
      if (oy !== 'auto' && oy !== 'scroll') continue
      el.style.scrollbarWidth = 'none'
      el.dataset.still = ''
      n++
    }
    return n
  }, on)
  // The panes reflow by a scrollbar's width: let lists re-measure before the capture.
  if (on && changed) await page.waitForTimeout(250)
}

/**
 * Scroll `selector`'s nearest scrolling ancestor so the element's top sits `offset` px below the pane's top (a still
 * that starts on a clean edge instead of a half-cut row).
 */
export async function scrollIntoPlace(page: Page, selector: string, offset: number): Promise<void> {
  await page.locator(selector).first().evaluate((el, off) => {
    let sc: HTMLElement | null = el.parentElement
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
    if (!sc) return
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - off
  }, offset)
  await page.waitForTimeout(300)
}

/**
 * True when the visible top of the message list (below anything drawn over it, such as a phone's top bar) cuts
 * through a line of text, an icon or a bubble.
 */
export async function cutAtTop(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let sc = document.querySelector('article.msg')?.parentElement ?? null
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
    if (!sc) return false
    const box = sc.getBoundingClientRect()
    const x = box.left + box.width / 2
    let edge = box.top
    while (edge < box.top + 200 && !sc.contains(document.elementFromPoint(x, edge + 1))) edge++
    const straddles = (r: DOMRect): boolean => r.height > 0 && r.top < edge - 1 && r.bottom > edge + 1
    for (const el of Array.from(sc.querySelectorAll('.msg__bubble, svg'))) if (straddles(el.getBoundingClientRect())) return true
    const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) if (straddles(r)) return true
    }
    return false
  })
}

export interface HiDpi {
  /**
   * The page as it is now, at the emulated scale (PNG); `clip` (CSS px) takes a detail of it, measured once the still
   * style is on (hiding the scrollbars reflows the panes).
   */
  capture(clip?: () => Promise<Clip>): Promise<Buffer>
  /** Lay the page out `height` CSS px tall (a detail taller than the window), or back to the window's height. */
  height(height?: number): Promise<void>
  done(): Promise<void>
}

export interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A detail of the page: from the top of the first `top` element to the bottom of the first `bottom` element, as wide
 * as the first `across` element, with `pad` CSS px around it (28; `padTop` / `padBottom` above / below it, to stop
 * short of a neighbour), in whole pixels.
 */
export async function detailClip(page: Page, o: { top: string; bottom: string; across: string; pad?: number; padTop?: number; padBottom?: number }): Promise<Clip> {
  const pad = o.pad ?? 28
  const box = (sel: string): Promise<{ top: number; bottom: number; left: number; right: number }> =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      })
  const [t, b, a] = await Promise.all([box(o.top), box(o.bottom), box(o.across)])
  const x = Math.floor(a.left - pad)
  const y = Math.floor(t.top - (o.padTop ?? pad))
  return { x, y, width: Math.ceil(a.right + pad) - x, height: Math.ceil(b.bottom + (o.padBottom ?? pad)) - y }
}

/**
 * Render the page at `scale` device pixels per CSS pixel through CDP device metrics until done(): the layout keeps its
 * CSS size, the window on the screen is untouched, and the avatar's canvas follows (presence.setDpr).
 */
export async function hiDpi(page: Page, scale: number, hook: HookFn): Promise<HiDpi> {
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const cdp = await page.context().newCDPSession(page)
  const metrics = (h: number): Promise<unknown> => cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: h, deviceScaleFactor: scale, mobile: false })
  await metrics(vp.h)
  await hook('presence.setDpr', scale)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(scale)
  return {
    async capture(clip) {
      await stillStyle(page, true)
      try {
        const c = clip ? await clip() : null
        if (c) expect(c.y + c.height, 'the detail lies inside the layout').toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))
        const shot = (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
          ...(c ? { clip: { ...c, scale: 1 } } : {})
        })) as { data: string }
        return Buffer.from(shot.data, 'base64')
      } finally {
        await stillStyle(page, false)
      }
    },
    async height(h) {
      await metrics(h ?? vp.h)
      await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(h ?? vp.h)
      await page.waitForTimeout(500)
    },
    async done() {
      await hook('presence.setDpr', null).catch(() => undefined)
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
  }
}

// ── Framing and encoding ──────────────────────────────────────────────────────────────────────────

export interface Shot {
  /** File name without extension (docs/images/<name>.webp). */
  name: string
  png: Buffer
  /** CSS size of the captured page and the device scale it was captured at. */
  width: number
  height: number
  scale: number
  /** A whole window (caption glyphs drawn on), a phone, or a detail of the window (just the rounded frame). */
  kind: 'desktop' | 'phone' | 'detail'
  theme: 'dark' | 'light'
  /** What the image shows (manifest) and its README alt text. */
  shows: string
  alt: string
}

/** The CSS size of a capture taken at `scale` (a PNG's own pixel size, from its header). */
export function cssSize(png: Buffer, scale: number): { width: number; height: number } {
  return { width: Math.round(png.readUInt32BE(16) / scale), height: Math.round(png.readUInt32BE(20) / scale) }
}

export interface ManifestEntry {
  file: string
  review_png: string
  width: number
  height: number
  bytes: number
  shows: string
  alt: string
}

let composer: Browser | null = null

async function composerBrowser(): Promise<Browser> {
  composer ??= await chromium.launch({ headless: true, ...chromiumLaunchOptions() })
  return composer
}

export async function closeComposer(): Promise<void> {
  await composer?.close().catch(() => undefined)
  composer = null
}

/** Windows 11 caption glyphs (minimise, maximise, close) in 46×48 cells, drawn in the theme's symbol colour. */
function captionSvg(color: string): string {
  const w = 46
  const cell = (i: number, body: string): string => `<g transform="translate(${i * w + w / 2 - 5} 19)">${body}</g>`
  const stroke = `fill="none" stroke="${color}" stroke-width="1" shape-rendering="geometricPrecision"`
  return `<svg class="caps" width="${3 * w}" height="48" viewBox="0 0 ${3 * w} 48" xmlns="http://www.w3.org/2000/svg">
    ${cell(0, `<path d="M0 5.5H10" ${stroke}/>`)}
    ${cell(1, `<rect x="0.5" y="0.5" width="9" height="9" rx="1.5" ${stroke}/>`)}
    ${cell(2, `<path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" ${stroke}/>`)}
  </svg>`
}

/**
 * The framed image as a page: the capture in a rounded window with a hairline that reads on GitHub's light and dark
 * backgrounds, a soft shadow, and (a whole desktop window) the caption glyphs where Windows draws its buttons.
 * Transparent around.
 */
function frameHtml(s: Shot, symbol: string): string {
  const desktop = s.kind === 'desktop'
  const radius = s.kind === 'phone' ? 34 : 10
  const pad = s.kind === 'phone' ? { t: 16, x: 22, b: 34 } : { t: 18, x: 28, b: 40 }
  const dark = s.theme === 'dark'
  // A dark window's edge is a light hairline, so it stays crisp on GitHub's dark page (#0d1117) as well.
  const outer = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,12,30,0.16)'
  const inner = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.5)'
  const src = `data:image/png;base64,${s.png.toString('base64')}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    .stage { display: inline-block; padding: ${pad.t}px ${pad.x}px ${pad.b}px; }
    .win { position: relative; width: ${s.width}px; height: ${s.height}px; border-radius: ${radius}px; overflow: hidden;
      box-shadow: 0 0 0 1px ${outer}, 0 14px 34px rgba(8,6,20,0.30), 0 3px 10px rgba(8,6,20,0.18); }
    .win img { display: block; width: ${s.width}px; height: ${s.height}px; }
    .caps { position: absolute; top: 0; right: 0; }
    .hair { position: absolute; inset: 0; border-radius: ${radius}px; box-shadow: inset 0 0 0 1px ${inner}; pointer-events: none; }
  </style></head><body><div class="stage"><div class="win"><img src="${src}" alt="">${desktop ? captionSvg(symbol) : ''}<div class="hair"></div></div></div></body></html>`
}

/** Encode the framed PNG as WebP in the page's canvas (quality steps down until the image fits the budget). */
async function encodeWebp(page: Page, png: Buffer): Promise<{ webp: Buffer; quality: number }> {
  for (const quality of [0.9, 0.86, 0.82, 0.78, 0.74]) {
    const b64 = await page.evaluate(
      async ({ src, q }) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        c.getContext('2d')!.drawImage(img, 0, 0)
        return c.toDataURL('image/webp', q).split(',')[1]
      },
      { src: `data:image/png;base64,${png.toString('base64')}`, q: quality }
    )
    const webp = Buffer.from(b64, 'base64')
    if (webp.subarray(0, 4).toString('ascii') !== 'RIFF' || webp.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('the canvas did not encode WebP')
    if (webp.length <= IMAGE_BUDGET) return { webp, quality }
  }
  throw new Error(`${png.length} bytes of PNG do not fit ${IMAGE_BUDGET} bytes of WebP at any quality tried`)
}

/**
 * Raw PNG → framed review PNG → docs/images/<name>.webp, and the manifest entry. `outScale` is the device scale of
 * the published image (the capture is downsampled to it when larger).
 */
export async function publish(s: Shot, o: { outScale?: number; symbol?: string } = {}): Promise<ManifestEntry> {
  for (const d of [RAW, REVIEW, IMAGES]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(RAW, `${s.name}.png`), s.png)
  const browser = await composerBrowser()
  const outScale = o.outScale ?? s.scale
  const context = await browser.newContext({ deviceScaleFactor: outScale, viewport: { width: s.width + 80, height: s.height + 80 } })
  try {
    const page = await context.newPage()
    const symbol = o.symbol ?? (s.theme === 'dark' ? '#f3f1fb' : '#16141f')
    await page.setContent(frameHtml(s, symbol))
    await page.locator('.win img').evaluate((img: HTMLImageElement) => img.decode())
    const framed = await page.locator('.stage').screenshot({ omitBackground: true, animations: 'disabled' })
    const review = path.join(REVIEW, `${s.name}.png`)
    fs.writeFileSync(review, framed)
    const { webp } = await encodeWebp(page, framed)
    const file = path.join(IMAGES, `${s.name}.webp`)
    fs.writeFileSync(file, webp)
    const dims = await page.evaluate(async (src) => {
      const img = new Image()
      img.src = src
      await img.decode()
      return { w: img.naturalWidth, h: img.naturalHeight }
    }, `data:image/webp;base64,${webp.toString('base64')}`)
    const entry: ManifestEntry = { file: path.relative(ROOT, file).replace(/\\/g, '/'), review_png: review, width: dims.w, height: dims.h, bytes: webp.length, shows: s.shows, alt: s.alt }
    writeManifest(entry)
    return entry
  } finally {
    await context.close()
  }
}

/** A capture kept only for review (raw/), e.g. the alternatives to a published image. */
export function keepRaw(name: string, png: Buffer): void {
  fs.mkdirSync(RAW, { recursive: true })
  fs.writeFileSync(path.join(RAW, `${name}.png`), png)
}

/** Add or replace one entry (both specs write here), and check the whole set against the total budget. */
function writeManifest(entry: ManifestEntry): void {
  let all: ManifestEntry[] = []
  try {
    all = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as ManifestEntry[]
  } catch {
    /* first image */
  }
  all = [...all.filter((e) => e.file !== entry.file), entry].sort((a, b) => a.file.localeCompare(b.file))
  fs.writeFileSync(MANIFEST, JSON.stringify(all, null, 2) + '\n')
  const total = all.reduce((n, e) => n + e.bytes, 0)
  expect(total, `README images together: ${total} bytes`).toBeLessThanOrEqual(TOTAL_BUDGET)
}
