/**
 * 07 D12: every leaf of the zod settings schema maps to a UI control (R20 "everything configurable in Settings").
 *
 * Convention (docs/requests/settings-wizard.md): every control's row carries `data-setting="<dot.path>"` — written
 * as a literal `data-setting="…"` or through the bound controls' `setting="…"` prop (features/settings/ui.tsx).
 * Array items use `[]` (llm.profiles[].baseUrl). This test reads the page sources (unit tests run without a DOM).
 *
 * Every owner's leaves are enforced (Phase 4: all pages exist). Voice controls are found by their ids instead:
 * voice-client's VOICE_SETTINGS_UI maps every `voice.*` leaf to the id its Settings → Voice out / Voice in control
 * carries (`id={controlId('<leaf>')}`), and Settings search jumps through the same map. INTERNAL_LEAVES is the
 * reviewed allow-list of leaves Vesper writes itself. The search catalog must name every other leaf, so Settings
 * search can find it.
 * @R20 @R3
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTERNAL_LEAVES, SETTINGS_CATALOG } from '../../../src/web/features/settings/catalog.logic'
import { settingLeaves } from '../../../src/web/features/settings/schema.logic'
import { VOICE_SETTINGS_UI } from '../../../src/web/features/voice/settings/ids.logic'

const ROOT = path.resolve(__dirname, '../../..')
const FEATURES = path.join(ROOT, 'src/web/features')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const CONTROL = /\b(?:data-setting|setting)=["']([a-z][\w.[\]]*)["']/g

/** data-setting paths per source file. */
const controls = new Map<string, Set<string>>()
for (const file of sources(FEATURES)) {
  const text = fs.readFileSync(file, 'utf8')
  const found = new Set<string>()
  for (const m of text.matchAll(CONTROL)) found.add(m[1])
  if (found.size) controls.set(path.relative(ROOT, file).replace(/\\/g, '/'), found)
}
const allControls = new Set([...controls.values()].flatMap((s) => [...s]))

/** Voice leaves whose control id is used on a voice Settings page (not only in the wizard steps). */
const VOICE_CONTROL = /\bcontrolId\(\s*["'](voice\.[\w.]+)["']\s*\)/g
const voiceControls = new Set<string>()
for (const file of sources(path.join(FEATURES, 'voice'))) {
  const rel = path.relative(FEATURES, file).replace(/\\/g, '/')
  if (!/^voice\/(settings\/|Settings)/.test(rel)) continue
  for (const m of fs.readFileSync(file, 'utf8').matchAll(VOICE_CONTROL)) voiceControls.add(m[1])
}
const hasControl = (leaf: string): boolean => allControls.has(leaf) || (leaf in VOICE_SETTINGS_UI && voiceControls.has(leaf))

/** Who builds the page for a leaf (docs/agents/phase3 ownership). */
const OWNERS: { owner: string; prefixes: string[]; files: RegExp }[] = [
  { owner: 'settings-wizard', prefixes: ['profile.', 'llm.', 'chat.', 'appearance.', 'performance.', 'desktop.', 'updates.'], files: /^src\/web\/features\/(settings\/(?!pages\/Data)|wizard\/(?!pages\/Memory))/ },
  { owner: 'memory-ui', prefixes: ['memory.', 'data.'], files: /^src\/web\/features\/(memory|privacy|prompts)\/|settings\/pages\/Data\.tsx|wizard\/pages\/Memory\.tsx/ },
  { owner: 'voice-client', prefixes: ['voice.'], files: /^src\/web\/features\/voice\// },
  { owner: 'access-ui', prefixes: ['access.'], files: /^src\/web\/features\/(access|login|devices|pair)\// }
]

const leaves = settingLeaves()
const userLeaves = leaves.filter((l) => !(l in INTERNAL_LEAVES))

describe('settings schema ↔ UI controls (07 D12)', () => {
  it('walks the schema into leaves, arrays of objects as []', () => {
    expect(leaves).toContain('chat.pageSize')
    expect(leaves).toContain('llm.profiles[].baseUrl')
    expect(leaves).toContain('llm.profiles[].options.openrouterZdr')
    expect(leaves).toContain('privacy.acknowledged')
    expect(leaves).toContain('chat.attachments.maxFileMb')
    expect(leaves.some((l) => l === 'llm.profiles')).toBe(false)
    expect(leaves.length).toBeGreaterThan(100)
  })

  it('the internal allow-list names real leaves only', () => {
    for (const p of Object.keys(INTERNAL_LEAVES)) expect(leaves, p).toContain(p)
  })

  it('every data-setting in the pages is a real leaf (no typos)', () => {
    const bad = [...allControls].filter((p) => !leaves.includes(p))
    expect(bad).toEqual([])
  })

  it('every leaf has an owner', () => {
    const orphan = userLeaves.filter((l) => !OWNERS.some((o) => o.prefixes.some((p) => l.startsWith(p))))
    expect(orphan).toEqual([])
  })

  for (const o of OWNERS) {
    const mine = userLeaves.filter((l) => o.prefixes.some((p) => l.startsWith(p)))
    it(`every ${o.owner} leaf has a control (${mine.length} leaves)`, () => {
      const missing = mine.filter((l) => !hasControl(l))
      expect(missing, `no data-setting / control id for: ${missing.join(', ')}`).toEqual([])
    })
  }

  it("voice-client's control-id map is exactly the voice leaves, with unique ids", () => {
    const voiceLeaves = userLeaves.filter((l) => l.startsWith('voice.')).sort()
    expect(Object.keys(VOICE_SETTINGS_UI).sort()).toEqual(voiceLeaves)
    const ids = Object.values(VOICE_SETTINGS_UI)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Settings search catalog', () => {
  // sections.ts imports the page modules (TSX), so its ids are read from the source.
  const sectionIds = new Set([...fs.readFileSync(path.join(FEATURES, 'settings/sections.ts'), 'utf8').matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]))
  it('covers every leaf a person can change', () => {
    const paths = new Set(SETTINGS_CATALOG.map((e) => e.path))
    expect(userLeaves.filter((l) => !paths.has(l))).toEqual([])
  })
  it('names only real leaves, once, in real sections', () => {
    const seen = new Set<string>()
    for (const e of SETTINGS_CATALOG) {
      expect(leaves, e.path).toContain(e.path)
      expect(e.path in INTERNAL_LEAVES, e.path).toBe(false)
      expect(seen.has(e.path), `duplicate ${e.path}`).toBe(false)
      seen.add(e.path)
      expect(sectionIds.has(e.section), `${e.path} → ${e.section}`).toBe(true)
      expect(e.label.length).toBeGreaterThan(2)
    }
  })
  it('points every entry at a page of its section that has the control (search lands on the row)', () => {
    const sectionFiles: Record<string, RegExp> = {
      general: /settings\/(pages\/General|fields)\.tsx$/,
      providers: /settings\/(pages\/Providers|providers\/ProviderEditor)\.tsx$/,
      chat: /settings\/pages\/Chat\.tsx$/,
      appearance: /settings\/(pages\/Appearance|fields)\.tsx$/,
      performance: /settings\/pages\/Performance\.tsx$/,
      memory: /features\/memory\//,
      privacy: /features\/privacy\//,
      data: /settings\/pages\/Data\.tsx$|features\/privacy\/Data/,
      access: /features\/(access|devices)\//,
      about: /settings\/pages\/(About|UpdatesGroup)\.tsx$/
    }
    for (const e of SETTINGS_CATALOG) {
      if (e.section === 'voice-out' || e.section === 'voice-in') {
        expect(voiceControls.has(e.path), `${e.path} is listed under ${e.section} but no voice page has its control id`).toBe(true)
        continue
      }
      const re = sectionFiles[e.section]
      expect(re, `no page files known for section ${e.section}`).toBeDefined()
      if (!re) continue
      const files = [...controls.entries()].filter(([f, set]) => re.test(f) && set.has(e.path))
      expect(files.length, `${e.path} is listed under ${e.section} but no page of that section shows it`).toBeGreaterThan(0)
    }
  })
})
