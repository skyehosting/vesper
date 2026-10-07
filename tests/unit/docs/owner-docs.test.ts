/**
 * The owner's documents tell the truth about the build (phase 5a P25–P37): README.md and docs/OWNER-NOTES.md (shown
 * in the app as Settings → About → Design notes) are checked against the code they describe.
 *
 * - Every quoted UI label ("…" / “…”) must exist in the app's source (not only as a settings-search keyword), and
 *   every "Settings → Section → …" path must start with a real section and name labels that exist.
 * - Owner-facing names are the app's own (P36): the access modes as the mode picker names them, "chat" not "session",
 *   "chat panel", "Remember with Voyage AI".
 * - Specific claims are tied to the code that decides them: temporary-chat lifetime (P25), password sign-in vs
 *   pairing (P26), mic modes (P28), closing the window (P29), live-check cost and variables (P31), logs (P32),
 *   installer and first run (P33), the pairing dialog's sign-in lifetime (P34), and 05-TESTING's scripts (P37).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { defaultSettings } from '@shared/settings'
import { ABSOLUTE_LOOPBACK_BROWSER } from '@server/auth/core'
import { MAX_IDLE_MS, NO_SUBSCRIBER_MS } from '@server/chat/temporary'
import { TEMPORARY_CHAT_BANNER, TEMPORARY_CHAT_PILL_LABEL, TEMPORARY_CHAT_TEXT, TEMPORARY_CHAT_TOOLTIP } from '../../../src/web/features/sessions/temporaryChat.logic'

const ROOT = path.resolve(__dirname, '../../..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')
const norm = (s: string): string =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')

/** Prose only: fenced code, inline code and link targets removed. */
function prose(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
}

const README = read('README.md')
const NOTES = read('docs/OWNER-NOTES.md')
const DOCS = { 'README.md': prose(README), 'docs/OWNER-NOTES.md': prose(NOTES) }

/** The app's own text: src/{web,main,server,shared}, comments left out, and not the settings-search keywords. */
const CORPUS = (() => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && e.name !== 'catalog.logic.ts') {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          const t = line.trim()
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue
          out.push(t)
        }
      }
    }
  }
  for (const d of ['web', 'main', 'server', 'shared']) walk(path.join(ROOT, 'src', d))
  return norm(out.join(' ')).replace(/\{' '\}/g, ' ')
})()

/** Quotes in the docs that are not Vesper's UI: Windows, the NSIS installer, provider terms, the owner's own words. */
const NOT_UI = new Set([
  'Windows protected your PC',
  'Only for me',
  'Anyone who uses this computer',
  'voices',
  'stored within Voyage',
  '$5 to stop Voyage training on your data',
  '$5',
  'natural',
  'Things to check with your own keys' // a README heading
])

const SECTIONS = [...read('src/web/features/settings/sections.ts').matchAll(/title: '([^']+)'/g)].map((m) => m[1])
const MODES = [...read('src/web/features/access/access.logic.ts').matchAll(/\{ id: '(?:local|lan|tailscale)', title: '([^']+)'/g)].map((m) => m[1])

function quotes(text: string): string[] {
  return [...norm(text).matchAll(/"([^"\n]{2,120})"/g)].map((m) => m[1].trim())
}

/** "Settings → A → B" paths, each segment cut at the end of its label. */
function settingsPaths(text: string): string[][] {
  const out: string[][] = []
  const cut = (s: string): string =>
    s.split(/[,.;:()"]|\s(?:or|and|lets|sets|shows|holds|then|where|under|to|if|is|for|with|until|reminds|opens|saves|asks|on|has|was)\s/)[0].trim()
  for (const line of norm(text).split(/(?<=[.!?])\s|\|/)) {
    let at = line.indexOf('Settings → ')
    while (at >= 0) {
      const rest = line.slice(at + 'Settings → '.length)
      // "Windows Settings → Apps" is Windows' own Settings app.
      if (line.slice(0, at).endsWith('Windows ')) {
        at = line.indexOf('Settings → ', at + 1)
        continue
      }
      const segs: string[] = []
      const parts = rest.split(' → ')
      for (let i = 0; i < parts.length; i++) {
        const c = cut(parts[i])
        segs.push(c)
        if (c !== parts[i].trim()) break
      }
      out.push(segs)
      at = line.indexOf('Settings → ', at + 1)
    }
  }
  return out
}

describe('owner docs: labels and paths exist in the app', () => {
  it('the corpus helpers see real labels and not the search-only ones', () => {
    expect(CORPUS).toContain('Where the AI puts the tone')
    expect(CORPUS).not.toContain('Tone tag placement')
    expect(SECTIONS).toContain('Access & security')
    expect(MODES).toEqual(['This PC only', 'Local network', 'Anywhere, with Tailscale'])
  })

  for (const [file, text] of Object.entries(DOCS)) {
    it(`${file}: every quoted label is on screen somewhere`, () => {
      const missing = quotes(text).filter((q) => !NOT_UI.has(q) && !CORPUS.includes(q))
      expect(missing).toEqual([])
    })

    it(`${file}: every Settings → path starts at a real section and names real labels`, () => {
      const bad: string[] = []
      for (const segs of settingsPaths(text)) {
        const [section, ...more] = segs
        // The section title, then the end of the path or ordinary prose ("Settings → Voice in sets how long…").
        if (!SECTIONS.some((t) => section === t || section.startsWith(`${t} `))) bad.push(`section "${section}"`)
        for (const s of more) if (s && !CORPUS.includes(s)) bad.push(`label "${s}" (after ${section})`)
      }
      expect(bad).toEqual([])
    })

    it(`${file}: uses the app's names (P36)`, () => {
      const t = norm(text)
      const retired = [
        /\bsessions?\b/i, // the app says "chat"
        /side panel/i, // "chat panel"
        /Home network \(LAN\)/i,
        /Remote \(Tailscale\)/i,
        /Anywhere with Tailscale/i, // the mode is "Anywhere, with Tailscale"
        /long-term memory/i // the switch is "Remember with Voyage AI"
      ]
      expect(retired.filter((r) => r.test(t)).map(String)).toEqual([])
    })
  }

  it('README names each access mode as the mode picker does', () => {
    for (const m of MODES) expect(norm(DOCS['README.md'])).toContain(m)
  })
})

describe('owner docs: claims match the code', () => {
  const readme = norm(DOCS['README.md'])
  const notes = norm(DOCS['docs/OWNER-NOTES.md'])

  it('P25: temporary chats — one wording, true lifetime, files in a temporary folder', () => {
    const minutes = `${NO_SUBSCRIBER_MS / 60_000} minutes`
    const hours = `${MAX_IDLE_MS / 3_600_000} hours`
    for (const t of [TEMPORARY_CHAT_TEXT, readme]) {
      expect(t).toContain(minutes)
      expect(t).toContain(hours)
      expect(t).toMatch(/when Vesper quits/)
      expect(t).toMatch(/temporary folder/)
    }
    expect(readme).toContain(norm(TEMPORARY_CHAT_TEXT))
    expect(readme).not.toMatch(/never written to disk/i)
    // Settings → Chat and Settings → Privacy show this one text, and there is no "New chat menu".
    const chat = read('src/web/features/settings/pages/Chat.tsx')
    const privacy = read('src/web/features/privacy/SettingsPrivacy.tsx')
    for (const src of [chat, privacy]) expect(src).toMatch(/\{TEMPORARY_CHAT_TEXT\}/)
    expect(chat).not.toMatch(/New chat menu/)
    expect(privacy).not.toMatch(/gone when you close them/)
  })

  it('P26: a password sign-in is announced, only pairing asks for approval, the password comes first', () => {
    expect(readme).not.toMatch(/every new device has to be approved/i)
    expect(readme).not.toMatch(/approve the new device/i)
    expect(readme).toContain('Pair a device')
    expect(readme).toContain('New sign-in to Vesper')
    // The server: login() creates an active device and notifies; only a pairing code makes a pending one.
    const service = read('src/server/auth/service.ts')
    const login = service.slice(service.indexOf('async login('), service.indexOf('async sudo('))
    expect(login).not.toMatch(/pending/)
    expect(login).toContain("'New sign-in to Vesper'")
    expect(readme).toMatch(/Set a password[^.]*first/i)
  })

  it('H-v11-tone: voice tones — the default, the three modes and the command are the ones the app has', () => {
    expect(defaultSettings().voice.tts.toneMode).toBe('conversation')
    for (const t of [notes, readme]) {
      expect(t).toContain('Voice tones')
      expect(t).toMatch(/"Follow the conversation"\**\s*\(the default\)/)
    }
    for (const raw of [README, NOTES]) for (const m of ['off', 'conversation', 'reply']) expect(raw).toContain(`/voice tone ${m}`)
    expect(read('src/web/features/voice/toneCommand.logic.ts')).toMatch(/conversation: \['conversation'/)
    // 1.0.0's "Speak with feeling" switch is gone; the Design notes no longer point at a "Tone" section.
    expect(CORPUS).not.toContain('Speak with feeling')
    expect(notes).not.toMatch(/Voice out → Tone →/)
  })

  it('P27: Design notes are final and promise nothing that does not exist', () => {
    expect(notes).not.toMatch(/draft/i)
    expect(notes).not.toMatch(/documented, not built in/i)
    expect(notes).toMatch(/Where the AI puts the tone/)
    expect(notes).toMatch(/Tap or type/)
    expect(notes).toMatch(/Just start talking/)
    // The Voyage correction (research 02): payment method, no $5 minimum, not retroactive, free tokens may go.
    expect(notes).toMatch(/payment method on file/)
    expect(notes).toMatch(/no \$5 minimum/i)
    expect(notes).toMatch(/liability cap/)
    expect(notes).toMatch(/free tokens/)
  })

  it('P28: the mic button is tap-to-dictate by default; holding is Push to talk', () => {
    expect(defaultSettings().voice.stt.mode).toBe('dictate')
    const voiceIn = readme.slice(readme.indexOf('**Voice in.**'), readme.indexOf('**The Star**'))
    expect(voiceIn).toMatch(/Tap the mic button/)
    for (const s of voiceIn.split(/(?<=[.?!])\s/)) if (/\bhold/i.test(s)) expect(s).toContain('Push to talk')
  })

  it('P29: README says closing the window quits unless the tray switch is on', () => {
    expect(defaultSettings().desktop.closeToTray).toBe(false)
    expect(readme).toMatch(/closing (?:its|the) window quits Vesper/i)
    expect(readme).toContain('Keep running in the tray when closed')
  })

  it('P31: live-check — what it costs, which variables, where it runs', () => {
    const script = read('scripts/live-check.mjs')
    const vars = new Set([...script.matchAll(/\b([A-Z]+_API_KEY)\b/g)].map((m) => m[1]))
    expect(vars.size).toBeGreaterThan(5)
    const section = norm(README.slice(README.indexOf('## Things to check with your own keys'), README.indexOf('## Troubleshooting')))
    expect([...vars].filter((v) => !section.includes(v))).toEqual([])
    expect(section).not.toMatch(/read-only/i)
    expect(section).toMatch(/cents/)
    expect(section).toMatch(/source folder/i)
    expect(section).toMatch(/npm install/)
  })

  it('P32: logs carry message text only while Diagnostic logging is on', () => {
    expect(readme).not.toMatch(/never contain message text/i)
    expect(readme).toContain('Diagnostic logging')
    expect(readme).toMatch(/Diagnostic logging[^.]*24 hours|24 hours[^.]*Diagnostic logging/)
    expect(readme).toContain('Models, logs and caches')
  })

  it('P33: installer scope, portable limits, the provider test and the Voyage switch', () => {
    const yml = read('electron-builder.yml')
    expect(yml).toMatch(/oneClick: false/)
    expect(yml).toMatch(/perMachine: false/)
    // An assisted per-user installer shows the install-mode page and lets you choose the folder.
    expect(readme).toContain('Only for me')
    expect(readme).toMatch(/choose the folder/i)
    expect(readme).not.toMatch(/with no admin prompt\. It adds/)
    // The portable build lacks only Local network access (manager.ts), so Tailscale is not an installer reason.
    expect(read('src/server/net/manager.ts')).toMatch(/portable: "The portable version can't offer Local network access/)
    expect(readme).not.toMatch(/\(LAN or Tailscale\)/)
    expect(readme).toMatch(/Tailscale works in both/)
    expect(readme).not.toMatch(/press \*\*Test\*\*/)
    expect(readme).toContain('Test connection')
    expect(defaultSettings().memory.enabled).toBe(false)
    expect(readme).toContain('Remember with Voyage AI')
  })

  it('P34: the pairing dialog states how long a browser on this PC stays signed in', () => {
    const dialog = read('src/web/features/access/PairDialog.tsx')
    expect(dialog).not.toMatch(/until you sign it out/)
    expect(dialog).toContain(`${ABSOLUTE_LOOPBACK_BROWSER / 86_400_000} days`)
    expect(dialog).toMatch(/less if unused/)
  })

  it('P37: 05-TESTING and README only name scripts that exist, and the coverage status is current', () => {
    for (const doc of ['docs/05-TESTING.md', 'README.md']) {
      const refs = [...read(doc).matchAll(/(?<![\w/])scripts\/([\w.-]+\.(?:mjs|cjs|js|ts))/g)].map((m) => m[1])
      expect(refs.filter((f) => !fs.existsSync(path.join(ROOT, 'scripts', f)))).toEqual([])
    }
    const testing = read('docs/05-TESTING.md')
    const s8 = testing.slice(testing.indexOf('## 8.'), testing.indexOf('## 9.'))
    expect(s8).not.toMatch(/Status\s+after Phase 1/)
    const cov = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/req-coverage.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })) as { missing: string[] }
    expect(cov.missing).toEqual([])
    expect(norm(s8)).toMatch(/every requirement R1–R22 has tagged tests/)
  }, 60_000)
})

describe('second pass: the app says what the docs say', () => {
  it('P36-ui: owner-visible strings use the docs\' names (chat panel, chat ID, Access & security, the two switches)', () => {
    const retired: [RegExp, string][] = [
      [/session panel/i, 'chat panel'],
      [/session IDs?\b/i, 'chat ID'],
      [/No session #/, 'No chat #'],
      [/Settings → Access(?! & security)(?! &amp; security)/, 'Settings → Access & security'],
      [/Turn on long-term memory/i, 'Remember with Voyage AI'], // (the Settings → Memory group stays "Long-term memory")
      [/Keep running in the tray when the window closes/, 'Keep running in the tray when closed']
    ]
    const hits = retired.filter(([r]) => r.test(CORPUS)).map(([r, want]) => `${String(r)} → ${want}`)
    expect(hits).toEqual([])
    // The same switch has the same label wherever it appears: one constant (fix5-ui) whose text is the docs' name.
    expect(read('src/web/features/settings/catalog.logic.ts')).toContain("export const CLOSE_TO_TRAY_LABEL = 'Keep running in the tray when closed'")
    for (const f of ['src/web/features/access/ThisPcCard.tsx', 'src/web/features/settings/pages/General.tsx']) {
      expect(read(f)).toContain('label={CLOSE_TO_TRAY_LABEL}')
    }
    expect(read('src/web/features/wizard/pages/Memory.tsx')).toMatch(/Remember with Voyage AI <LeavesPcBadge/)
  })

  it('P25: the texts inside a temporary chat say when it ends', () => {
    const minutes = `about ${NO_SUBSCRIBER_MS / 60_000} minutes after you leave it`
    for (const t of [TEMPORARY_CHAT_BANNER, TEMPORARY_CHAT_TOOLTIP, TEMPORARY_CHAT_PILL_LABEL]) expect(t).toContain(minutes)
    expect(TEMPORARY_CHAT_TEXT).toContain(minutes)
    expect(read('src/web/features/chat/ChatPage.tsx')).toMatch(/\{TEMPORARY_CHAT_BANNER\}/)
    const header = read('src/web/features/sessions/SessionHeader.tsx')
    expect(header).toMatch(/content=\{TEMPORARY_CHAT_TOOLTIP\}/)
    expect(header).toMatch(/aria-label=\{TEMPORARY_CHAT_PILL_LABEL\}/)
  })

  it('P34: the sign-in lifetime in the pairing dialog stays short (keeps the code above the fold)', () => {
    const dialog = read('src/web/features/access/PairDialog.tsx')
    const step = dialog.split('\n').find((l) => l.includes('Sign-in lasts up to')) ?? ''
    const text = step.replace(/<[^>]+>/g, '').trim()
    expect(text).toContain(`${ABSOLUTE_LOOPBACK_BROWSER / 86_400_000} days`)
    // The step column holds about 30 characters a line at 1138×608 (two lines keep the code above the fold) and about
    // 47 on a 390-wide phone (one line keeps "Open in browser" above it); owner-docs.spec.ts measures both on screen.
    expect(text.length).toBeLessThanOrEqual(48)
  })

  it('P31: the README cost sentence matches the script (free model lists, under 200 Voyage tokens)', () => {
    const script = read('scripts/live-check.mjs')
    expect(script).toMatch(/GET \/models \(free\)/)
    expect(script).toMatch(/< 200 Voyage tokens/)
    const section = norm(README.slice(README.indexOf('## Things to check with your own keys'), README.indexOf('## Troubleshooting')))
    expect(section).not.toMatch(/one small paid request/i)
    expect(section).not.toMatch(/a few hundred Voyage tokens/i)
    expect(section).toMatch(/listing models is free/i)
    expect(section).toMatch(/under 200 Voyage tokens/i)
  })
})
