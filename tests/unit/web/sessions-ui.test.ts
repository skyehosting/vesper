/**
 * sessions-ui pure logic (R6, R8, R11; 07 D8/D9/D13): sidebar layout + windowing + roving focus, the top bar chips,
 * palette ranking, shortcut matching, search URL state / snippets / filters, the command-line completion stages.
 */
import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings } from '@shared/settings'
import { fixedZone } from '@shared/time'
import type { SearchHit, Session, SessionSummary } from '@shared/types/domain'
import { applySummary, summaryOf } from '../../../src/web/lib/store/session.logic'
import { flattenGroups, moveFocus, rowOffsets, sessionOrder, VIRTUALIZE_AT, windowRange } from '../../../src/web/features/sessions/sidebar.logic'
import { groupSessions, titleOf } from '../../../src/web/features/sessions/group.logic'
import { effectiveScope, memoryChip, memoryOn, modelChip, shortModel } from '../../../src/web/features/sessions/chips.logic'
import { matchRanges, rank, scoreMatch, splitRuns } from '../../../src/web/features/palette/palette.logic'
import { hasCommandModifier, isTypingTarget, matchesSpec, parseSpec } from '../../../src/web/features/palette/shortcuts.logic'
import { filterHits, parseSearchParams, pastBound, searchPath, snippetRuns, whenFrom, DEFAULT_SEARCH } from '../../../src/web/features/search/search.logic'
import { commandLineState, createCommandRegistry } from '../../../src/web/lib/commands/registry.logic'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 9, 5, 14, 0)

function s(uid: string, ago: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  const t = NOW - ago
  return {
    uid,
    shortId: uid.toUpperCase().padEnd(6, '0').slice(0, 6),
    title: uid,
    createdUtc: t,
    updatedUtc: t,
    lastMessageUtc: t,
    lastSeq: 0,
    messageCount: 0,
    pinned: false,
    archived: false,
    private: false,
    temporary: false,
    hasPrompt: false,
    linkCount: 0,
    memory: 'inherit',
    ...extra
  }
}

describe('sidebar layout and windowing @R6', () => {
  const groups = groupSessions([s('a', H), s('b', 2 * H), s('c', D + H), s('p', 90 * D, { pinned: true }), s('o', 40 * D)], NOW, fixedZone(0))
  const rows = flattenGroups(groups)
  const m = { row: 34, header: 30, gap: 14 }

  it('flattens groups into headings and rows, pinned first', () => {
    expect(rows.map((r) => (r.kind === 'header' ? `#${r.label}` : r.session.uid))).toEqual(['#Pinned', 'p', '#Today', 'a', 'b', '#Yesterday', 'c', '#Older', 'o'])
    expect(rows.filter((r) => r.kind === 'header' && r.first).length).toBe(1)
    expect(sessionOrder(rows).map((x) => x.uid)).toEqual(['p', 'a', 'b', 'c', 'o'])
  })

  it('offsets are exact prefix sums; headings after the first carry the gap', () => {
    const o = rowOffsets(rows, m)
    expect(o[0]).toBe(0)
    expect(o[1]).toBe(30)
    expect(o[2]).toBe(64)
    expect(o[3]).toBe(64 + 44)
    expect(o[rows.length]).toBe(4 * 30 + 3 * 14 + 5 * 34)
  })

  it('renders only the rows near the viewport', () => {
    const many = flattenGroups([{ id: 'today', label: 'Today', items: Array.from({ length: 2000 }, (_, i) => s(`x${i}`, i * 1000)) }])
    const o = rowOffsets(many, m)
    expect(many.length).toBeGreaterThan(VIRTUALIZE_AT)
    const r = windowRange(o, 34 * 1000, 600, 300)
    expect(r).not.toBeNull()
    const [a, b] = r as [number, number]
    expect(b - a).toBeLessThan(40)
    expect(o[a]).toBeLessThanOrEqual(34 * 1000 - 300)
    expect(o[b + 1]).toBeGreaterThanOrEqual(34 * 1000 + 600 + 300)
    expect(windowRange(o, 0, 600, 0)?.[0]).toBe(0)
    expect(windowRange(o, 1e9, 600, 0)?.[1]).toBe(many.length - 1)
    expect(windowRange([0], 0, 600, 0)).toBeNull()
  })

  it('roving focus moves by arrows, Home/End and pages, clamped at the ends', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    expect(moveFocus(order, 'b', 'ArrowDown')).toBe('c')
    expect(moveFocus(order, 'e', 'ArrowDown')).toBe('e')
    expect(moveFocus(order, 'a', 'ArrowUp')).toBe('a')
    expect(moveFocus(order, null, 'ArrowDown')).toBe('a')
    expect(moveFocus(order, 'c', 'Home')).toBe('a')
    expect(moveFocus(order, 'a', 'End')).toBe('e')
    expect(moveFocus(order, 'a', 'PageDown', 3)).toBe('d')
    expect(moveFocus(order, 'e', 'PageUp', 3)).toBe('b')
    expect(moveFocus(order, 'a', 'x')).toBeNull()
    expect(moveFocus([], 'a', 'ArrowDown')).toBeNull()
  })

  it('titles fall back to "New chat" / "Temporary chat"', () => {
    expect(titleOf({ title: '', temporary: false })).toBe('New chat')
    expect(titleOf({ title: '', temporary: true })).toBe('Temporary chat')
    expect(titleOf({ title: 'Lisbon', temporary: true })).toBe('Lisbon')
  })
})

describe('top bar chips (07 B13, D13) @R7 @R21', () => {
  const settings = (patch: (s: Settings) => void): Settings => {
    const st = defaultSettings()
    patch(st)
    return st
  }
  const withProfile = (preset: string, baseUrl: string, model: string): Settings =>
    settings((st) => {
      st.llm.profiles = [{ id: 'p1', label: 'Main', preset: preset as Settings['llm']['profiles'][number]['preset'], adapter: 'openai', baseUrl, model, authHeader: '', options: { maxTokens: 1000, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false }, capabilities: {} }]
      st.llm.defaultProfile = 'p1'
    })

  it('model chip: default model, override, and whether text leaves the PC', () => {
    const cloud = withProfile('openai', 'https://api.openai.com/v1', 'gpt-5')
    expect(modelChip(cloud, null)).toMatchObject({ profileId: 'p1', model: 'gpt-5', overridden: false, leavesPc: true, service: 'Main' })
    expect(modelChip(cloud, { model: 'gpt-5-mini' })).toMatchObject({ model: 'gpt-5-mini', overridden: true })
    expect(modelChip(withProfile('ollama', 'http://127.0.0.1:11434/v1', 'llama3'), null).leavesPc).toBe(false)
    expect(modelChip(withProfile('ollama', 'http://127.0.0.1:11434/v1', 'llama3:cloud'), null).leavesPc).toBe(true)
    expect(modelChip(withProfile('custom', 'http://localhost:1234/v1', 'x'), null).leavesPc).toBe(false)
    expect(modelChip(defaultSettings(), null)).toMatchObject({ profileId: null, model: null, leavesPc: false })
    expect(shortModel('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    expect(shortModel('x'.repeat(40)).length).toBe(32)
  })

  it('memory chip follows the engine rule and the index state', () => {
    // F37: the global switch is Voyage; without it memory works by keywords. Only the chat's own switch turns it off.
    expect(memoryOn(false, 'inherit')).toBe(true)
    expect(memoryOn(false, 'on')).toBe(true)
    expect(memoryOn(true, 'off')).toBe(false)
    expect(memoryOn(false, 'off')).toBe(false)
    expect(memoryChip(false, 'inherit', 'disabled', false)).toMatchObject({ on: true, label: 'Keyword only', tone: 'muted' })
    expect(memoryChip(false, 'inherit', 'disabled', false).detail).toMatch(/Voyage AI is off/)
    expect(memoryChip(false, 'off', 'disabled', false)).toMatchObject({ on: false, label: 'Memory off', tone: 'off' })
    expect(memoryChip(true, 'off', 'ready', false).detail).toMatch(/off for this chat/)
    expect(memoryChip(true, 'inherit', 'keyword-only', false)).toMatchObject({ label: 'Keyword only', tone: 'muted' })
    expect(memoryChip(true, 'inherit', 'ready', false)).toMatchObject({ label: 'Memory', tone: 'on' })
    expect(memoryChip(true, 'inherit', 'error', false).tone).toBe('warn')
    expect(memoryChip(true, 'inherit', 'loading', true).detail).toMatch(/private/)
    expect(memoryChip(false, 'on', 'disabled', false).label).toBe('Keyword only')
  })

  it('scope: the session value, else the Settings default', () => {
    expect(effectiveScope('inherit', 'linked')).toBe('linked')
    expect(effectiveScope(undefined, 'all')).toBe('all')
    expect(effectiveScope('this', 'all')).toBe('this')
  })
})

describe('palette ranking', () => {
  it('prefers whole prefix > word prefix > substring > in-order letters', () => {
    const p = scoreMatch('lis', 'Lisbon trip')
    const w = scoreMatch('lis', 'Planning the Lisbon trip')
    const sub = scoreMatch('isb', 'Planning the Lisbon trip')
    const fz = scoreMatch('pltr', 'Planning the Lisbon trip')
    expect(p).toBeGreaterThan(w)
    expect(w).toBeGreaterThan(sub)
    expect(sub).toBeGreaterThan(fz)
    expect(fz).toBeGreaterThan(0)
    expect(scoreMatch('zzz', 'Lisbon')).toBe(-1)
    expect(scoreMatch('', 'anything')).toBe(0)
  })

  it('every word must match; accents are ignored; later fields weigh less', () => {
    expect(scoreMatch('lisbon trip', 'Planning the Lisbon trip')).toBeGreaterThan(0)
    expect(scoreMatch('lisbon paris', 'Planning the Lisbon trip')).toBe(-1)
    expect(scoreMatch('practica', 'Práctica de español')).toBeGreaterThan(0)
    expect(scoreMatch('k7q', 'Some title', '#K7Q2MX')).toBeGreaterThan(0)
    expect(scoreMatch('memory', 'Memory')).toBeGreaterThan(scoreMatch('memory', 'Privacy', 'Memory'))
  })

  it('rank keeps matches only, best first, with a limit', () => {
    const items = ['Settings', 'New chat', 'New temporary chat', 'Search all messages']
    expect(rank('new', items, (i) => [i])).toEqual(['New chat', 'New temporary chat'])
    expect(rank('s', items, (i) => [i], 1)).toHaveLength(1)
  })

  it('match ranges merge and split into highlight runs', () => {
    expect(matchRanges('lis tr', 'Lisbon trip, Lisbon')).toEqual([
      [0, 3],
      [7, 9],
      [13, 16]
    ])
    expect(splitRuns('Lisbon', [[0, 3]])).toEqual([
      { text: 'Lis', hit: true },
      { text: 'bon', hit: false }
    ])
    expect(splitRuns('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })
})

describe('keyboard shortcuts', () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

  it('Mod is Ctrl on Windows and ⌘ on Apple devices', () => {
    const k = parseSpec('Mod+K')
    expect(matchesSpec(k, ev('k', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesSpec(k, ev('K', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesSpec(k, ev('k', { metaKey: true }), 'other')).toBe(false)
    expect(matchesSpec(k, ev('k', { metaKey: true }), 'mac')).toBe(true)
    expect(matchesSpec(k, ev('k', { ctrlKey: true, shiftKey: true }), 'other')).toBe(false)
    expect(matchesSpec(k, ev('k'), 'other')).toBe(false)
  })

  it('symbols ignore Shift unless the spec names it; named keys and aliases work', () => {
    expect(matchesSpec(parseSpec('?'), ev('?', { shiftKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('?'), ev('?'), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Mod+/'), ev('/', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Alt+Shift+ArrowDown'), ev('ArrowDown', { altKey: true, shiftKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Alt+Shift+Down'), ev('ArrowDown', { altKey: true, shiftKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Alt+Shift+ArrowDown'), ev('ArrowDown', { altKey: true }), 'other')).toBe(false)
    expect(matchesSpec(parseSpec('Mod+Shift+O'), ev('O', { ctrlKey: true, shiftKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Mod+.'), ev('.', { ctrlKey: true }), 'other')).toBe(true)
    expect(matchesSpec(parseSpec('Mod++'), ev('+', { ctrlKey: true }), 'other')).toBe(true)
  })

  it('bare keys never fire while typing; modifier shortcuts do', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(hasCommandModifier(parseSpec('?'))).toBe(false)
    expect(hasCommandModifier(parseSpec('Shift+?'))).toBe(false)
    expect(hasCommandModifier(parseSpec('Mod+K'))).toBe(true)
    expect(hasCommandModifier(parseSpec('Alt+Shift+Up'))).toBe(true)
    expect(hasCommandModifier(parseSpec('F2'))).toBe(true)
  })
})

describe('global search state @R7', () => {
  it('round-trips through the URL, dropping defaults and rejecting junk', () => {
    const st = { q: 'pastel de nata', mode: 'semantic' as const, session: 'u1', role: 'user' as const, when: 'week' as const, order: 'relevance' as const }
    const path = searchPath(st)
    expect(path.startsWith('/search?')).toBe(true)
    expect(parseSearchParams(path.slice('/search'.length))).toEqual(st)
    expect(searchPath(DEFAULT_SEARCH)).toBe('/search')
    expect(searchPath({ ...DEFAULT_SEARCH, q: 'a' })).toBe('/search?q=a')
    expect(parseSearchParams('?mode=evil&role=x&when=forever&order=y')).toEqual(DEFAULT_SEARCH)
    expect(parseSearchParams(`?q=${'x'.repeat(900)}`).q.length).toBe(500)
  })

  it('snippet markers become highlight runs; unbalanced ones stay text', () => {
    expect(snippetRuns('…the best «pastel» de nata «Lisbon»!')).toEqual([
      { text: '…the best ', hit: false },
      { text: 'pastel', hit: true },
      { text: ' de nata ', hit: false },
      { text: 'Lisbon', hit: true },
      { text: '!', hit: false }
    ])
    expect(snippetRuns('a «b c')).toEqual([{ text: 'a «b c', hit: false }])
    expect(snippetRuns('«»x')).toEqual([{ text: 'x', hit: false }])
  })

  it('date presets start at local midnight N days back', () => {
    const z = fixedZone(-240) // UTC−04:00
    const now = Date.UTC(2026, 9, 5, 14, 0) // 10:00 local
    expect(whenFrom('any', now, z)).toBeNull()
    expect(whenFrom('today', now, z)).toBe(Date.UTC(2026, 9, 5, 4, 0))
    expect(whenFrom('week', now, z)).toBe(Date.UTC(2026, 8, 29, 4, 0))
    expect(whenFrom('month', now, z)).toBe(Date.UTC(2026, 8, 6, 4, 0))
  })

  it('role/date filters and the paging stop for newest-first', () => {
    const hit = (role: 'user' | 'assistant', tsUtc: number): SearchHit =>
      ({ message: { uid: `${role}${tsUtc}`, role, tsUtc } as SearchHit['message'], session: { uid: 's', shortId: 'S', title: 't' }, snippet: '', onPath: true })
    const hits = [hit('user', 300), hit('assistant', 200), hit('user', 100)]
    expect(filterHits(hits, 'any', null)).toHaveLength(3)
    expect(filterHits(hits, 'user', null)).toHaveLength(2)
    expect(filterHits(hits, 'any', 150)).toHaveLength(2)
    expect(pastBound(hits, 'recent', 150)).toBe(true)
    expect(pastBound(hits, 'recent', 50)).toBe(false)
    expect(pastBound(hits, 'relevance', 150)).toBe(false)
    expect(pastBound([], 'recent', 150)).toBe(false)
  })
})

describe('command line completion stages @R8 @R11', () => {
  it('tells name-typing from argument-typing', () => {
    expect(commandLineState('/')).toEqual({ stage: 'name', prefix: '' })
    expect(commandLineState('/Con')).toEqual({ stage: 'name', prefix: 'con' })
    expect(commandLineState('/continue ')).toEqual({ stage: 'args', name: 'continue', args: '' })
    expect(commandLineState('  /link #K7 both')).toEqual({ stage: 'args', name: 'link', args: '#K7 both' })
    expect(commandLineState('/prompt use Daily\njournal')).toEqual({ stage: 'args', name: 'prompt', args: 'use Daily\njournal' })
    for (const t of ['hello', '//x', '/ x', '/1a', '']) expect(commandLineState(t)).toBeNull()
  })

  it('commands expose argument suggestions through completeArgs', async () => {
    const reg = createCommandRegistry<{ sessionUid: string | null }>()
    reg.register({
      name: 'memory',
      args: 'on|off',
      help: 'h',
      run: () => undefined,
      completeArgs: (_c, args) => ['on', 'off'].filter((x) => x.startsWith(args)).map((x) => ({ insert: x, label: x, final: true }))
    })
    const def = reg.get('memory')
    expect(await def?.completeArgs?.({ sessionUid: 'x' }, 'o')).toEqual([
      { insert: 'on', label: 'on', final: true },
      { insert: 'off', label: 'off', final: true }
    ])
    expect(await def?.completeArgs?.({ sessionUid: 'x' }, 'of')).toHaveLength(1)
  })
})

describe('session slice logic: list rows and the open chat stay in step @R6', () => {
  const detailOf = (x: SessionSummary): Session => ({ ...x, systemPrompt: 'x', promptId: null, memoryScope: 'inherit', llmProfile: null, model: null, voice: null, toolMode: null, links: [], linkedFrom: [], meta: {}, epoch: null })

  it('upserts rows, mirrors summary fields into the open chat, drops archived/deleted rows', () => {
    const items = [s('a', H), s('b', 2 * H)]
    let r = applySummary(items, detailOf(items[0]), { ...s('a', H), title: 'Renamed', pinned: true })
    expect(r.items.find((x) => x.uid === 'a')?.title).toBe('Renamed')
    expect(r.active?.title).toBe('Renamed')
    expect(r.active?.systemPrompt).toBe('x')
    r = applySummary(r.items, r.active, s('c', 0))
    expect(r.items[0].uid).toBe('c')
    r = applySummary(r.items, r.active, { ...s('b', 2 * H), archived: true })
    expect(r.items.map((x) => x.uid)).toEqual(['c', 'a'])
    const same = applySummary(r.items, r.active, { ...s('zz', 0), deletedUtc: 5 })
    expect(same.items).toBe(r.items)
  })

  it("leaves another chat's detail alone; summaryOf keeps only summary fields", () => {
    const other = detailOf(s('y', 0))
    expect(applySummary([], other, s('z', 0)).active).toBe(other)
    const sum = summaryOf(detailOf(s('z', 0)))
    expect('systemPrompt' in sum).toBe(false)
    expect(sum.uid).toBe('z')
    // An imported chat keeps its "Imported" badge through live updates (session.updated → upsert).
    expect(summaryOf({ ...s('i', 0), imported: 'chatgpt' }).imported).toBe('chatgpt')
    expect(applySummary([], null, { ...s('i', 0), imported: 'claude' }).items[0].imported).toBe('claude')
    expect('imported' in summaryOf(s('n', 0))).toBe(false)
  })
})
