/**
 * memory-ui pure logic: parity with the server where the client mirrors it (Voyage catalogue, protocols validation,
 * the AI manifest line format, import detection/counts), plus timeline rows/filters, diff, formatting, privacy
 * mapping, settings merge and the exact "$5" correction points (07 A1). @R7 @R9 @R11 @R21
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMBED_MODELS, RERANK_MODELS, baseUrlForKey as serverBaseUrlForKey } from '@server/providers/voyage/catalogue'
import { DEFAULT_PROTOCOLS_TEXT, validateProtocols as serverValidate } from '@server/protocols/protocols'
import { formatManifest } from '@server/memory/format'
import { detectSource as serverDetect, readChatGpt, readClaude } from '@server/data/sources'
import { defaultSettings } from '@shared/settings'
import { DISCLOSURES } from '@shared/privacy'
import { fixedZone, ianaZone } from '@shared/time'
import type { Message } from '@shared/types/domain'
import { baseUrlForKey, EMBED_CHOICES, familyOf, needsRebuild, RERANK_CHOICES, voyageKeyProblem } from '../../../src/web/features/memory/voyage.logic'
import { diffHunks, insertAt, lineCount, lineDiff, validateProtocols } from '../../../src/web/features/memory/protocols.logic'
import { aiManifestText, accessible, filterSessions, manifestJson, type ManifestSession } from '../../../src/web/features/memory/manifest.logic'
import {
  activeFilterCount,
  buildRows,
  dayBoundUtc,
  EMPTY_FILTERS,
  hitPasses,
  previewText,
  snippetParts,
  timelineQuery
} from '../../../src/web/features/memory/timeline.logic'
import { dayLabel, errorText, formatDuration, formatSize, formatUsd, plural, tokensAsWords } from '../../../src/web/features/memory/format.logic'
import { detectSource, isDocEntry, previewDoc } from '../../../src/web/features/privacy/importPreview.logic'
import { localOnly, otherDisclosures, servicesInUse, trainingLabel } from '../../../src/web/features/privacy/privacy.logic'
import { canEditPath, mergeSettings } from '../../../src/web/features/memory/settings.logic'
import { backfillDetail, backfillQuestion, statusText } from '../../../src/web/features/memory/MemoryParts.logic'
import { filterPrompts, findPrompt, uniqueName } from '../../../src/web/features/prompts/library.logic'
import { FIVE_DOLLAR_POINTS, VOYAGE_LEGAL_EMAIL, verifiedLabel } from '../../../src/web/features/memory/voyagePrivacy.logic'

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'import')

describe('Voyage choices mirror the server catalogue @R7', () => {
  it('models, prices and families are the same', () => {
    expect(EMBED_CHOICES.map((m) => [m.id, m.usdPerMTok, m.family])).toEqual(EMBED_MODELS.map((m) => [m.id, m.usdPerMTok, m.family]))
    expect(RERANK_CHOICES.filter((r) => r.id !== 'none').map((r) => [r.id, r.usdPerMTok])).toEqual(RERANK_MODELS.map((r) => [r.id, r.usdPerMTok]))
    for (const k of ['pa-abc', 'al-xyz', 'al-eu-1', 'al-us-2', '  al-q ']) expect(baseUrlForKey(k)).toBe(serverBaseUrlForKey(k))
  })
  it('rebuild only on a family or dimension change; key shape checks', () => {
    expect(familyOf('voyage-4-large')).toBe('voyage-4')
    expect(needsRebuild({ model: 'voyage-4-lite', dim: 1024 }, { model: 'voyage-4', dim: 1024 })).toBe(false)
    expect(needsRebuild({ model: 'voyage-4-lite', dim: 1024 }, { model: 'voyage-code-4', dim: 1024 })).toBe(true)
    expect(needsRebuild({ model: 'voyage-4-lite', dim: 1024 }, { model: 'voyage-4-lite', dim: 512 })).toBe(true)
    expect(voyageKeyProblem('pa-123')).toMatch(/too short/)
    expect(voyageKeyProblem('pa-1234567890 abc')).toMatch(/spaces/)
    expect(voyageKeyProblem('pa-1234567890abc')).toBeNull()
  })
})

describe('protocols editor @R9', () => {
  const samples = [
    DEFAULT_PROTOCOLS_TEXT,
    'Hello {{user_name}}',
    '{{#native_mode}}{{#text_mode}}x{{/text_mode}}',
    '{{/text_mode}} {assistant_name} {{ tone_instruction }} memory_search memory_recall',
    `${DEFAULT_PROTOCOLS_TEXT}\n{{favourite}} }}`,
    '{{#bogus}} {{#native_mode}}{{native_function_docs}}{{/native_mode}}{{#text_mode}}{{text_function_docs}}{{/text_mode}}{{tone_instruction}}'
  ]
  it('client warnings equal the server’s', () => {
    for (const t of samples) expect(validateProtocols(t)).toEqual(serverValidate(t))
    expect(validateProtocols(DEFAULT_PROTOCOLS_TEXT)).toEqual([])
  })
  it('line diff and hunks', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const b = a.replace('line 10', 'line ten').concat('\nadded')
    const ops = lineDiff(a, b)!
    const { hunks, added, removed, skippedAfter } = diffHunks(ops)
    expect([added, removed]).toEqual([2, 1])
    expect(hunks).toHaveLength(2)
    expect(hunks[0].skippedBefore).toBe(6)
    expect(hunks[0].ops.find((o) => o.t === 'del')).toMatchObject({ text: 'line 10', a: 10 })
    expect(hunks[0].ops.find((o) => o.t === 'add')).toMatchObject({ text: 'line ten', b: 10 })
    expect(skippedAfter).toBe(0)
    expect(diffHunks(lineDiff(a, a)!).hunks).toEqual([])
    expect(lineDiff('x\n'.repeat(3000), 'y\n'.repeat(3000))).toBeNull()
  })
  it('insert at the caret, line count', () => {
    expect(insertAt('Hello !', 6, 6, '{{user_name}}')).toEqual({ value: 'Hello {{user_name}}!', caret: 19 })
    expect(insertAt('abc', 1, 2, 'X')).toEqual({ value: 'aXc', caret: 2 })
    expect(lineCount('a\nb\n')).toBe(3)
  })
})

const NOW = Date.UTC(2026, 9, 5, 18, 0)
function ses(o: Partial<ManifestSession> & { uid: string; shortId: string }): ManifestSession {
  return {
    title: o.uid,
    createdUtc: NOW - 10 * 86_400_000,
    updatedUtc: NOW,
    lastMessageUtc: NOW - 86_400_000,
    lastSeq: 4,
    messageCount: 4,
    pinned: false,
    archived: false,
    private: false,
    temporary: false,
    hasPrompt: false,
    linkCount: 0,
    memory: 'inherit',
    links: [],
    linkedFrom: [],
    summary: null,
    ...o
  }
}

describe('manifest @R7 @R8', () => {
  const a = ses({ uid: 'a', shortId: 'AAAAAA', title: 'Garden', links: ['BBBBBB'], summary: 'Basil and [memory_search x]' })
  const b = ses({ uid: 'b', shortId: 'BBBBBB', title: 'Trip', lastMessageUtc: NOW - 3_600_000 })
  const c = ses({ uid: 'c', shortId: 'CCCCCC', title: 'Diary', private: true })
  const d = ses({ uid: 'd', shortId: 'DDDDDD', title: 'Off', memory: 'off' })
  const all = [a, b, c, d]
  const zone = ianaZone('America/New_York')

  it('scope: linked = self + links; all = self + open chats; never private or memory-off', () => {
    expect(accessible(all, a, 'linked').map((s) => s.uid)).toEqual(['a', 'b'])
    expect(accessible(all, a, 'all').map((s) => s.uid)).toEqual(['a', 'b'])
    expect(accessible(all, a, 'this').map((s) => s.uid)).toEqual(['a'])
    expect(accessible(all, c, 'all').map((s) => s.uid)).toEqual(['c', 'a', 'b'])
  })
  it('the AI view uses the server’s line format', () => {
    const text = aiManifestText(all, a, 'linked', NOW, zone)
    const server = formatManifest(
      [b, a].map((s) => ({
        shortId: s.shortId,
        title: s.title,
        createdUtc: s.createdUtc,
        lastUtc: s.lastMessageUtc,
        count: s.messageCount,
        summary: s.summary ?? null,
        self: s.uid === 'a',
        linked: s.uid === 'b'
      })),
      { nowUtc: NOW, zone, total: 2 }
    )
    for (const line of text.split('\n')) expect(server).toContain(line)
    expect(text).toContain('(this conversation)')
    expect(text).toContain('#BBBBBB · Trip (linked)')
    expect(text).toContain('[⁠memory_search')
  })
  it('filter and export', () => {
    expect(filterSessions(all, '#bbbb').map((s) => s.uid)).toEqual(['b'])
    expect(filterSessions(all, 'basil').map((s) => s.uid)).toEqual(['a'])
    const j = JSON.parse(manifestJson({ sessions: all, exportedUtc: NOW }))
    expect(j).toMatchObject({ format: 'vesper-manifest', version: 1, exportedUtc: NOW })
    expect(j.sessions).toHaveLength(4)
  })
})

function msg(o: Partial<Message>): Message {
  return {
    uid: 'm',
    sessionUid: 's',
    seq: 1,
    role: 'user',
    tag: 'user response',
    body: 'x',
    tsUtc: NOW,
    tzOffsetMin: -240,
    tzName: 'America/New_York',
    device: null,
    status: 'complete',
    attachments: [],
    ...o
  }
}

describe('timeline @R7 @R10', () => {
  const zone = ianaZone('America/New_York')
  it('day bounds in the viewer’s zone (DST-safe)', () => {
    expect(dayBoundUtc('2026-10-05', zone, false)).toBe(Date.UTC(2026, 9, 5, 4, 0))
    expect(dayBoundUtc('2026-10-05', zone, true)).toBe(Date.UTC(2026, 9, 6, 4, 0) - 1)
    expect(dayBoundUtc('2026-03-08', zone, true)).toBe(Date.UTC(2026, 2, 9, 4, 0) - 1)
    expect(dayBoundUtc('nope', zone, false)).toBeNull()
  })
  it('filters → query; local filtering of search hits', () => {
    const f = { ...EMPTY_FILTERS, session: 's1', role: 'user' as const, from: '2026-10-01', to: '2026-10-05' }
    expect(timelineQuery(f, zone, 't1:2', 20)).toEqual({
      limit: 20,
      session: 's1',
      role: 'user',
      fromUtc: Date.UTC(2026, 9, 1, 4),
      toUtc: Date.UTC(2026, 9, 6, 4) - 1,
      cursor: 't1:2'
    })
    expect(activeFilterCount(f)).toBe(4)
    expect(hitPasses(msg({ role: 'assistant' }), f, zone)).toBe(false)
    expect(hitPasses(msg({ tsUtc: Date.UTC(2026, 8, 1) }), f, zone)).toBe(false)
    expect(hitPasses(msg({ tsUtc: Date.UTC(2026, 9, 3) }), f, zone)).toBe(true)
  })
  it('rows with day separators; duplicates dropped', () => {
    const items = [
      { message: msg({ uid: '1', tsUtc: NOW }), session: { uid: 's', shortId: 'S', title: 't' } },
      { message: msg({ uid: '2', tsUtc: NOW - 3_600_000 }), session: { uid: 's', shortId: 'S', title: 't' } },
      { message: msg({ uid: '2', tsUtc: NOW - 3_600_000 }), session: { uid: 's', shortId: 'S', title: 't' } },
      { message: msg({ uid: '3', tsUtc: NOW - 2 * 86_400_000 }), session: { uid: 's', shortId: 'S', title: 't' } }
    ]
    const rows = buildRows(items, zone, NOW)
    expect(rows.map((r) => (r.kind === 'day' ? `D:${r.label}` : r.key))).toEqual(['D:Today', '1', '2', 'D:Saturday 3 Oct 2026', '3'])
    expect(buildRows(items, zone, NOW, false).every((r) => r.kind === 'item')).toBe(true)
  })
  it('snippets and previews', () => {
    expect(snippetParts('…the «castle» and «tram»')).toEqual([
      { text: '…the ', mark: false },
      { text: 'castle', mark: true },
      { text: ' and ', mark: false },
      { text: 'tram', mark: true }
    ])
    expect(snippetParts('a «b')).toEqual([{ text: 'a «b', mark: false }])
    expect(previewText('a\r\n\n\n\nb')).toEqual({ text: 'a\n\nb', cut: false })
    expect(previewText('x'.repeat(10), 4)).toEqual({ text: 'xxxx…', cut: true })
  })
})

describe('formatting', () => {
  it('numbers, money, durations, sizes, days', () => {
    expect(plural(1, 'chat')).toBe('1 chat')
    expect(plural(1200, 'message')).toBe('1,200 messages')
    expect(formatUsd(0.004)).toBe('under $0.01')
    expect(formatUsd(0.034)).toBe('$0.03')
    expect(formatUsd(0)).toBe('$0')
    expect(formatDuration(12)).toBe('about 10 seconds')
    expect(formatDuration(3 * 3600)).toBe('about 3 hours')
    expect(formatDuration(5 * 86400)).toBe('about 5 days')
    expect(formatDuration(null)).toBe('unknown')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(tokensAsWords(1500)).toBe('~1,130 words')
    expect(dayLabel(NOW - 86_400_000, NOW, fixedZone(0))).toBe('Yesterday')
    expect(errorText({ message: 'Check the form.', fields: { text: 'Write the fact.' } })).toBe('Write the fact.')
    expect(verifiedLabel('2026-10-05')).toBe('5 Oct 2026')
  })
  it('backfill consent text (07 C12) and status words', () => {
    const e = { messages: 1240, sessions: 38, estTokens: 61_000, estUsd: 0.0012, estSeconds: 5400 }
    expect(backfillQuestion(e)).toBe('Index 1,240 messages from 38 chats?')
    expect(backfillDetail(e)).toBe(
      'About 61,000 tokens, ~under $0.01 (likely within your free tokens), about 1.5 hours at your current rate limit. Private and temporary chats are never sent.'
    )
    expect(statusText(null).text).toBe('Checking…')
    expect(statusText({ state: 'ready', queued: 3, indexed: 1, errors: 0, model: null, dim: null, tier: 'free', queueEtaSec: 60 }).text).toBe(
      'Indexing · 3 waiting'
    )
  })
})

describe('the Voyage "$5" correction (07 A1) @R21', () => {
  it('says each required fact', () => {
    const t = FIVE_DOLLAR_POINTS.join(' ')
    expect(t).toMatch(/no \$5 minimum/)
    expect(t).toMatch(/payment method/)
    expect(t).toMatch(/admin/)
    expect(t).toMatch(/Paying alone doesn’t opt you out/)
    expect(t).toMatch(/only covers text sent afterwards/)
    expect(t).toMatch(/free tokens/)
    expect(t).toContain(VOYAGE_LEGAL_EMAIL)
    expect(VOYAGE_LEGAL_EMAIL).toBe('legal@voyageai.com')
  })
})

describe('import preview @R18', () => {
  const read = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'))
  it('agrees with the server readers on the fixtures', () => {
    for (const [file, reader] of [
      ['chatgpt-conversations.json', readChatGpt],
      ['claude-conversations.json', readClaude]
    ] as const) {
      const doc = read(file)
      expect(detectSource(doc)).toBe(serverDetect(doc))
      const stats = { skipped: 0 }
      const convs = [...reader(doc as unknown[], stats)].filter((c) => c.messages.length > 0)
      const p = previewDoc(doc)!
      expect(p.conversations).toBe(convs.length)
      expect(p.messages).toBe(convs.reduce((n, c) => n + c.messages.length, 0))
      expect(p.titles.length).toBeGreaterThan(0)
    }
  })
  it('Vesper exports, unknown files, ZIP entry names', () => {
    const v = previewDoc({
      format: 'vesper-export',
      sessions: [
        {
          title: 'A',
          messages: [
            { role: 'user', tsUtc: 5 },
            { role: 'assistant', tsUtc: 9 }
          ]
        }
      ],
      prompts: [{}],
      facts: [{}, {}]
    })
    expect(v).toMatchObject({ source: 'vesper', conversations: 1, messages: 2, firstUtc: 5, lastUtc: 9, prompts: 1, facts: 2 })
    expect(previewDoc({ hello: 1 })).toBeNull()
    expect(previewDoc([{ nope: 1 }])).toBeNull()
    expect(isDocEntry('conversations.json')).toBe(true)
    expect(isDocEntry('export/conversations.json')).toBe(true)
    expect(isDocEntry('a/b/conversations.json')).toBe(false)
    expect(isDocEntry('vesper-export.json')).toBe(true)
  })
})

describe('privacy dashboard mapping @R21', () => {
  it('maps configured services to their disclosures; every disclosure stays reachable', () => {
    const s = defaultSettings()
    s.llm.profiles = [
      {
        id: 'or',
        label: 'Router',
        preset: 'openrouter',
        adapter: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'x',
        authHeader: '',
        options: { maxTokens: 1000, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false },
        capabilities: {}
      },
      {
        id: 'local',
        label: 'Ollama',
        preset: 'ollama',
        adapter: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3',
        authHeader: '',
        options: { maxTokens: 1000, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false },
        capabilities: {}
      }
    ]
    s.llm.defaultProfile = 'or'
    s.memory.enabled = true
    s.voice.tts.enabled = true
    s.voice.tts.provider = 'elevenlabs'
    s.voice.stt.enabled = true
    s.voice.stt.provider = 'deepgram'
    const used = servicesInUse(s, ['voyage'])
    expect(used.map((u) => u.disclosure.id)).toEqual(['llm.openrouter', 'llm.local', 'voyage', 'elevenlabs', 'stt.deepgram'])
    expect(used.map((u) => u.leaves)).toEqual([true, false, true, true, true])
    expect(used[0].openrouter).toEqual({ noTraining: true, zdr: false })
    expect(used[0].use).toContain('(default)')
    expect(used[4].notes[0]).toContain('mip_opt_out=true')
    const others = otherDisclosures(used)
    expect(new Set([...used.map((u) => u.disclosure.id), ...others.map((d) => d.id), 'welcome', 'updates'])).toEqual(new Set(DISCLOSURES.map((d) => d.id)))
    expect(localOnly(s).map((l) => l.key)).toContain('llm')
    expect(servicesInUse(s, []).find((u) => u.key === 'voyage')?.leaves).toBe(false)
    expect(trainingLabel('yes-by-default').tone).toBe('warning')
  })
})

describe('settings helpers', () => {
  it('deep merge (arrays replace) and remote edit rules (07 B2)', () => {
    const base = defaultSettings()
    const m = mergeSettings(base, { memory: { voyage: { dim: 512 } }, llm: { profiles: [] } })
    expect(m.memory.voyage.dim).toBe(512)
    expect(m.memory.voyage.embedModel).toBe(base.memory.voyage.embedModel)
    expect(m.memory.enabled).toBe(false)
    expect(canEditPath('memory.enabled', true, base)).toBe(true)
    expect(canEditPath('chat.notificationPreviews', false, base)).toBe(false)
    const remote = mergeSettings(base, { access: { remoteMayChangeSettings: true } })
    expect(canEditPath('chat.notificationPreviews', false, remote)).toBe(true)
    expect(canEditPath('memory.enabled', false, remote)).toBe(false)
  })
})

describe('prompt library helpers @R11', () => {
  const list = [
    { id: 1, name: 'Writing coach', body: 'Edit my drafts', createdUtc: 0, updatedUtc: 0 },
    { id: 2, name: 'alpha', body: 'travel planner', createdUtc: 0, updatedUtc: 0 }
  ]
  it('find, filter and unique names', () => {
    expect(findPrompt(list, ' writing COACH ')?.id).toBe(1)
    expect(filterPrompts(list, '').map((p) => p.id)).toEqual([2, 1])
    expect(filterPrompts(list, 'travel').map((p) => p.id)).toEqual([2])
    expect(uniqueName(list, 'Writing coach')).toBe('Writing coach (2)')
    expect(uniqueName(list, 'New')).toBe('New')
  })
})
