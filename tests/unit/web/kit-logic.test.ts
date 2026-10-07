/**
 * ui-kit pure logic (R22 polish, 07 D9 keyboard): roving focus, typeahead, slider snapping, popup placement, combobox
 * filtering, file intake, shortcuts and the highlight cache.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstEnabled, lastEnabled, nextIndex } from '../../../src/web/components/internal/roving.logic'
import { emptyTypeahead, foldLabel, isTypeaheadKey, typeahead } from '../../../src/web/components/internal/typeahead.logic'
import { decimals, formatSeconds, keyValue, largeStepOf, ratioOf, snap, valueAtRatio } from '../../../src/web/components/internal/slider.logic'
import { computePosition } from '../../../src/web/components/internal/position.logic'
import { filterItems, highlightParts, matchRank } from '../../../src/web/components/internal/combobox.logic'
import { formatBytes, matchesAccept, partitionFiles, rejectMessage } from '../../../src/web/components/internal/files.logic'
import { detectPlatform, parseShortcut, spokenShortcut } from '../../../src/web/components/internal/kbd.logic'
import { hashString, Lru } from '../../../src/web/components/internal/lru.logic'
import { langLabel, normalizeLang, SUPPORTED_LANGS } from '../../../src/web/components/code/langs.logic'

describe('roving focus', () => {
  const v = { orientation: 'vertical' as const, loop: false }
  it('moves along its axis and ignores the other', () => {
    expect(nextIndex(0, 'ArrowDown', 5, v)).toBe(1)
    expect(nextIndex(1, 'ArrowUp', 5, v)).toBe(0)
    expect(nextIndex(1, 'ArrowRight', 5, v)).toBeNull()
    expect(nextIndex(1, 'a', 5, v)).toBeNull()
    expect(nextIndex(1, 'ArrowRight', 5, { orientation: 'horizontal', loop: false })).toBe(2)
    expect(nextIndex(1, 'ArrowDown', 5, { orientation: 'both', loop: false })).toBe(2)
  })
  it('stops at the ends without loop, wraps with loop', () => {
    expect(nextIndex(4, 'ArrowDown', 5, v)).toBe(4)
    expect(nextIndex(0, 'ArrowUp', 5, v)).toBe(0)
    expect(nextIndex(4, 'ArrowDown', 5, { ...v, loop: true })).toBe(0)
    expect(nextIndex(0, 'ArrowUp', 5, { ...v, loop: true })).toBe(4)
  })
  it('skips disabled items, also for Home/End', () => {
    const isDisabled = (i: number): boolean => i === 0 || i === 2 || i === 4
    expect(nextIndex(1, 'ArrowDown', 5, { ...v, isDisabled })).toBe(3)
    expect(nextIndex(3, 'ArrowDown', 5, { ...v, isDisabled })).toBe(3)
    expect(nextIndex(3, 'ArrowDown', 5, { ...v, loop: true, isDisabled })).toBe(1)
    expect(nextIndex(3, 'Home', 5, { ...v, isDisabled })).toBe(1)
    expect(nextIndex(1, 'End', 5, { ...v, isDisabled })).toBe(3)
    expect(firstEnabled(5, isDisabled)).toBe(1)
    expect(lastEnabled(5, isDisabled)).toBe(3)
    expect(firstEnabled(3, () => true)).toBe(-1)
  })
  it('starts from nothing active', () => {
    expect(nextIndex(-1, 'ArrowDown', 3, v)).toBe(0)
    expect(nextIndex(-1, 'ArrowUp', 3, v)).toBe(2)
  })
  it('pages by pageSize and clamps', () => {
    const p = { ...v, pageSize: 10 }
    expect(nextIndex(0, 'PageDown', 25, p)).toBe(10)
    expect(nextIndex(20, 'PageDown', 25, p)).toBe(24)
    expect(nextIndex(5, 'PageUp', 25, p)).toBe(0)
    expect(nextIndex(5, 'PageDown', 25, v)).toBeNull()
    // Target disabled → nearest enabled in the travel direction.
    expect(nextIndex(0, 'PageDown', 25, { ...p, isDisabled: (i) => i === 10 })).toBe(9)
  })
  it('handles empty lists', () => {
    expect(nextIndex(0, 'ArrowDown', 0, v)).toBeNull()
  })
})

describe('typeahead', () => {
  const labels = ['Gold', 'Violet', 'Rose', 'Aurora', 'Ice', 'Rust', 'Émeraude']
  it('jumps to the first match after the current item', () => {
    const r = typeahead(emptyTypeahead(), 'r', 1000, labels, 0)
    expect(r.index).toBe(2)
  })
  it('cycles with a repeated character', () => {
    let st = emptyTypeahead()
    let cur = 0
    const seen: number[] = []
    for (const t of [1000, 1100, 1200]) {
      const r = typeahead(st, 'r', t, labels, cur)
      st = r.state
      cur = r.index ?? cur
      seen.push(cur)
    }
    expect(seen).toEqual([2, 5, 2])
  })
  it('extends the search string within the timeout and resets after it', () => {
    let r = typeahead(emptyTypeahead(), 'r', 1000, labels, 0)
    r = typeahead(r.state, 'u', 1200, labels, r.index ?? 0)
    expect(r.index).toBe(5)
    const later = typeahead(r.state, 'i', 5000, labels, 5)
    expect(later.state.buffer).toBe('i')
    expect(later.index).toBe(4)
  })
  it('ignores accents and case, skips disabled, returns null with no match', () => {
    expect(typeahead(emptyTypeahead(), 'E', 0, labels, 0).index).toBe(6)
    expect(typeahead(emptyTypeahead(), 'r', 0, labels, 0, (i) => i === 2).index).toBe(5)
    expect(typeahead(emptyTypeahead(), 'z', 0, labels, 0).index).toBeNull()
    expect(foldLabel('  Ünïcode')).toBe('unicode')
  })
  it('knows which keys are typeahead keys', () => {
    expect(isTypeaheadKey('a')).toBe(true)
    expect(isTypeaheadKey(' ')).toBe(false)
    expect(isTypeaheadKey('ArrowDown')).toBe(false)
    expect(isTypeaheadKey('a', { ctrlKey: true })).toBe(false)
  })
})

describe('slider math (silence wait 300–5000 ms, 07 C17) @R19', () => {
  const silence = { min: 300, max: 5000, step: 100 }
  it('snaps to the step grid anchored at min', () => {
    expect(snap(1234, silence)).toBe(1200)
    expect(snap(1250, silence)).toBe(1300)
    expect(snap(299, silence)).toBe(300)
    expect(snap(99999, silence)).toBe(5000)
    expect(snap(Number.NaN, silence)).toBe(300)
    expect(snap(7, { min: 1, max: 10, step: 3 })).toBe(7)
    expect(snap(9.5, { min: 1, max: 10, step: 3 })).toBe(10)
  })
  it('has no float noise', () => {
    const r = { min: 0, max: 1, step: 0.1 }
    expect(snap(0.30000000000000004, r)).toBe(0.3)
    expect(keyValue(0.7, 'ArrowRight', r)).toBe(0.8)
    expect(decimals(0.25)).toBe(2)
    expect(decimals(1e-7)).toBe(7)
    expect(decimals(100)).toBe(0)
  })
  it('maps pointer ratios to values and back', () => {
    expect(valueAtRatio(0, silence)).toBe(300)
    expect(valueAtRatio(1, silence)).toBe(5000)
    expect(valueAtRatio(0.5, silence)).toBe(2700)
    expect(valueAtRatio(-2, silence)).toBe(300)
    expect(ratioOf(2650, silence)).toBeCloseTo(0.5)
    expect(ratioOf(5, { min: 5, max: 5 })).toBe(0)
  })
  it('implements the APG slider keys', () => {
    expect(keyValue(1200, 'ArrowRight', silence)).toBe(1300)
    expect(keyValue(1200, 'ArrowUp', silence)).toBe(1300)
    expect(keyValue(1200, 'ArrowLeft', silence)).toBe(1100)
    expect(keyValue(300, 'ArrowLeft', silence)).toBe(300)
    expect(largeStepOf(silence)).toBe(500)
    expect(keyValue(1200, 'PageUp', silence)).toBe(1700)
    expect(keyValue(1200, 'PageDown', silence)).toBe(700)
    expect(keyValue(1200, 'Home', silence)).toBe(300)
    expect(keyValue(1200, 'End', silence)).toBe(5000)
    expect(keyValue(1200, 'x', silence)).toBeNull()
    expect(largeStepOf({ ...silence, largeStep: 1000 })).toBe(1000)
  })
  it('formats seconds', () => {
    expect(formatSeconds(1200)).toBe('1.2 s')
    expect(formatSeconds(300)).toBe('0.3 s')
  })
})

describe('popup placement', () => {
  const vp = { width: 1000, height: 800 }
  const box = { width: 200, height: 300 }
  it('places below, aligned to the start', () => {
    const p = computePosition({ x: 100, y: 100, width: 80, height: 30 }, box, vp, { placement: 'bottom-start', offset: 6, margin: 8 })
    expect(p).toMatchObject({ x: 100, y: 136, placement: 'bottom-start' })
    expect(p.maxHeight).toBe(800 - 130 - 6 - 8)
  })
  it('flips to the top when the bottom is too short and the top has more room', () => {
    const p = computePosition({ x: 100, y: 700, width: 80, height: 30 }, box, vp, { placement: 'bottom-start', offset: 6, margin: 8 })
    expect(p.placement).toBe('top-start')
    expect(p.y).toBe(700 - 6 - 300)
  })
  it('stays put and limits height when neither side fits fully but its own side is larger', () => {
    const p = computePosition({ x: 100, y: 300, width: 80, height: 30 }, { width: 200, height: 900 }, vp, { placement: 'bottom-start' })
    expect(p.placement).toBe('bottom-start')
    expect(p.maxHeight).toBe(800 - 330 - 6 - 8)
  })
  it('clamps on the cross axis and centers / end-aligns', () => {
    const right = computePosition({ x: 950, y: 100, width: 40, height: 30 }, box, vp, { placement: 'bottom-start' })
    expect(right.x).toBe(1000 - 8 - 200)
    const center = computePosition({ x: 400, y: 100, width: 100, height: 30 }, box, vp, { placement: 'bottom' })
    expect(center.x).toBe(350)
    const end = computePosition({ x: 400, y: 100, width: 100, height: 30 }, box, vp, { placement: 'bottom-end' })
    expect(end.x).toBe(300)
  })
  it('positions at a point (context menu) and on the sides', () => {
    const p = computePosition({ x: 990, y: 790, width: 0, height: 0 }, box, vp, { placement: 'bottom-start', offset: 0 })
    expect(p.placement).toBe('top-start')
    expect(p.x).toBe(792)
    const side = computePosition({ x: 900, y: 100, width: 50, height: 30 }, box, vp, { placement: 'right-start' })
    expect(side.placement).toBe('left-start')
  })
})

describe('combobox filter', () => {
  const voices = [
    { label: 'Rachel', description: 'American, calm' },
    { label: 'Adam', description: 'deep narration' },
    { label: 'Domi (multilingual)', description: 'strong' },
    { label: 'Charlotte', description: 'Swedish accent', keywords: ['eleven_v3'] },
    { label: 'Aria' }
  ]
  it('keeps everything for an empty query', () => {
    expect(filterItems(voices, '  ')).toHaveLength(5)
  })
  it('ranks label prefix, then word prefix, then substring, then description', () => {
    expect(filterItems(voices, 'a').map((v) => v.label)).toEqual(['Adam', 'Aria', 'Rachel', 'Domi (multilingual)', 'Charlotte'])
    expect(filterItems(voices, 'multi').map((v) => v.label)).toEqual(['Domi (multilingual)'])
    expect(filterItems(voices, 'calm').map((v) => v.label)).toEqual(['Rachel'])
    expect(filterItems(voices, 'eleven').map((v) => v.label)).toEqual(['Charlotte'])
    expect(matchRank(voices[0], 'zzz')).toBe(0)
  })
  it('needs every word to match', () => {
    expect(filterItems(voices, 'rachel calm').map((v) => v.label)).toEqual(['Rachel'])
    expect(filterItems(voices, 'rachel deep')).toEqual([])
  })
  it('splits labels for highlighting, accent-insensitively', () => {
    expect(highlightParts('Charlotte', 'arl')).toEqual(['Ch', 'arl', 'otte'])
    expect(highlightParts('Émeraude', 'eme')).toEqual(['', 'Éme', 'raude'])
    expect(highlightParts('Adam', 'x')).toEqual(['Adam', '', ''])
  })
})

describe('file intake (R18, 07 B6)', () => {
  const f = (name: string, type: string, size = 10): { name: string; type: string; size: number } => ({ name, type, size })
  it('matches accept like <input accept>', () => {
    expect(matchesAccept(f('a.png', 'image/png'), 'image/*')).toBe(true)
    expect(matchesAccept(f('a.PDF', ''), '.pdf')).toBe(true)
    expect(matchesAccept(f('a.json', 'application/json'), 'image/*, application/json')).toBe(true)
    expect(matchesAccept(f('a.exe', 'application/x-msdownload'), 'image/*,.pdf')).toBe(false)
    expect(matchesAccept(f('a.exe', ''), '')).toBe(true)
  })
  it('partitions by type, size, count and empties', () => {
    const files = [f('1.png', 'image/png'), f('2.exe', 'x/y'), f('3.png', 'image/png', 5000), f('4.png', 'image/png'), f('5.png', 'image/png'), f('dir', '', 0)]
    const r = partitionFiles(files, { accept: 'image/*', maxBytes: 1000, maxFiles: 2 })
    expect(r.accepted.map((x) => x.name)).toEqual(['1.png', '4.png'])
    expect(r.rejected.map((x) => `${x.file.name}:${x.reason}`)).toEqual(['2.exe:type', '3.png:size', '5.png:count', 'dir:empty'])
    expect(rejectMessage(r.rejected[1], { maxBytes: 1000 })).toBe('3.png is larger than 1 KB.')
  })
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1200)).toBe('1.2 KB')
    expect(formatBytes(25_000_000)).toBe('25 MB')
    expect(formatBytes(640_000_000)).toBe('640 MB')
    expect(formatBytes(1_070_000_000)).toBe('1.07 GB')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('shortcuts', () => {
  it('maps Mod per platform', () => {
    expect(parseShortcut('Mod+Shift+K', 'other')).toEqual(['Ctrl', 'Shift', 'K'])
    expect(parseShortcut('Mod+Shift+K', 'mac')).toEqual(['⌘', '⇧', 'K'])
    expect(parseShortcut('Alt+ArrowUp', 'other')).toEqual(['Alt', '↑'])
    expect(parseShortcut('Ctrl++', 'other')).toEqual(['Ctrl', '+'])
    expect(parseShortcut('Escape', 'other')).toEqual(['Esc'])
  })
  it('speaks symbols as words', () => {
    expect(spokenShortcut(['⌘', '⇧', 'K'])).toBe('Command Shift K')
    expect(spokenShortcut(['Ctrl', 'Enter'])).toBe('Control Enter')
  })
  it('detects Apple platforms', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac')
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe('mac')
    expect(detectPlatform({ platform: 'Win32' })).toBe('other')
  })
})

describe('LRU + hash (07 D7 highlight cache)', () => {
  it('evicts the least recently used entry', () => {
    const c = new Lru<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('a')).toBe(1)
    c.set('c', 3)
    expect(c.keys()).toEqual(['a', 'c'])
    expect(c.has('b')).toBe(false)
    c.set('a', 9)
    expect(c.keys()).toEqual(['c', 'a'])
    expect(c.size).toBe(2)
    expect(() => new Lru(0)).toThrow()
  })
  it('hashes deterministically and spreads similar strings', () => {
    expect(hashString('const x = 1')).toBe(hashString('const x = 1'))
    expect(hashString('const x = 1')).not.toBe(hashString('const x = 2'))
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(hashString(`line ${i}`))
    expect(seen.size).toBe(5000)
  })
})

describe('code fence languages (07 D7)', () => {
  it('normalises fence names and aliases', () => {
    expect(normalizeLang('ts')).toBe('typescript')
    expect(normalizeLang('TypeScript')).toBe('typescript')
    expect(normalizeLang('sh')).toBe('shellscript')
    expect(normalizeLang('c#')).toBe('csharp')
    expect(normalizeLang('python title="x.py"')).toBe('python')
    expect(normalizeLang('{.rust}')).toBe('rust')
    expect(normalizeLang('language-go')).toBe('go')
    expect(normalizeLang('text')).toBeNull()
    expect(normalizeLang('')).toBeNull()
    expect(normalizeLang(undefined)).toBeNull()
  })
  it('labels known languages and keeps unknown fence names', () => {
    expect(langLabel('cpp')).toBe('C++')
    expect(langLabel('sh')).toBe('Shell')
    expect(langLabel('prisma')).toBe('prisma')
    expect(langLabel('')).toBe('Text')
  })
  it('has a loader for every supported language', () => {
    // langs.ts holds dynamic imports (a web-only module); compare its keys as text.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/web/components/code/langs.ts'), 'utf8')
    const keys = [...src.matchAll(/^\s+'?([\w-]+)'?: \(\) => import\('@shikijs\/langs\/([\w-]+)'\)/gm)].map((m) => {
      expect(m[1]).toBe(m[2])
      return m[1]
    })
    expect(keys.sort()).toEqual([...SUPPORTED_LANGS].sort())
  })
})
