/**
 * Theme contrast (04: body text ≥ 7:1, secondary ≥ 4.5:1 on every surface; --on-accent ≥ 4.5:1; 07 D9). Reads the
 * real values from src/web/styles/tokens.css, so a token edit that breaks contrast fails here. @R22
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(__dirname, '../../../src/web/styles/tokens.css'), 'utf8')
const badgeCss = fs.readFileSync(path.resolve(__dirname, '../../../src/web/components/Badge.css'), 'utf8')

/** Custom properties declared in every top-level rule whose selector is exactly `selector` (later ones win). */
function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  const head = `\n${selector} {`
  let at = css.indexOf(head)
  if (at < 0) throw new Error(`no rule ${selector}`)
  while (at >= 0) {
    const body = css.slice(at, css.indexOf('}', at))
    for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2]
    at = css.indexOf(head, at + 1)
  }
  return out
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** sRGB `color-mix(in srgb, fg p, bg)` of two opaque hex colors. */
function mix(fg: string, bg: string, p: number): string {
  const ch = (h: string, i: number): number => parseInt(h.slice(i, i + 2), 16)
  return `#${[1, 3, 5].map((i) => Math.round(ch(fg, i) * p + ch(bg, i) * (1 - p)).toString(16).padStart(2, '0')).join('')}`
}

/** A badge tone's `--tone` / `--tone-ink` as written in Badge.css (a token name or a literal hex). */
function badgeTone(tone: string): { tone: string; ink: string } {
  const m = new RegExp(`\\n\\.badge--${tone} \\{([^}]*)\\}`).exec(badgeCss)
  if (!m) throw new Error(`no .badge--${tone}`)
  const read = (prop: string): string => {
    const v = new RegExp(`${prop}:\\s*([^;]+);`).exec(m[1])?.[1].trim() ?? ''
    return v.replace(/^var\((--[\w-]+)\)$/, '$1')
  }
  return { tone: read('--tone'), ink: read('--tone-ink') }
}

const dark = block(':root')
const light = { ...dark, ...block(":root[data-theme='light']") }
const SURFACES = ['--bg-0', '--bg-1', '--bg-2', '--bg-3']

describe('theme contrast', () => {
  for (const [name, t] of [
    ['dark', dark],
    ['light', light]
  ] as const) {
    it(`${name}: primary text ≥ 7:1, secondary ≥ 4.5:1, meta ≥ 4.5:1 on panels`, () => {
      for (const bg of SURFACES) {
        expect(contrast(t['--text-0'], t[bg]), `text-0 on ${bg}`).toBeGreaterThanOrEqual(7)
        expect(contrast(t['--text-1'], t[bg]), `text-1 on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
      for (const bg of ['--bg-0', '--bg-1', '--bg-2']) expect(contrast(t['--text-2'], t[bg]), `text-2 on ${bg}`).toBeGreaterThanOrEqual(4.5)
    })
    it(`${name}: state colors are readable as text on panels`, () => {
      for (const s of ['--success', '--warning', '--danger']) expect(contrast(t[s], t['--bg-2']), s).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['--on-danger'], t['--danger']), 'danger button').toBeGreaterThanOrEqual(4.5)
    })
  }

  it('badges: the ink is ≥ 4.5:1 on its own tint over every surface, every tone, both themes, every accent (F48)', () => {
    const tint = /\n\.badge \{[^}]*background:\s*color-mix\(in srgb, var\(--tone\) (\d+)%, transparent\)/.exec(badgeCss)
    expect(tint, '.badge background is a color-mix tint of --tone').not.toBeNull()
    const p = Number(tint![1]) / 100
    const themes: Array<[string, Record<string, string>]> = [
      ['dark', dark],
      ['light', light]
    ]
    for (const a of ['violet', 'rose', 'aurora', 'ice']) {
      themes.push([`dark/${a}`, { ...dark, ...block(`:root[data-accent='${a}']`) }])
      themes.push([`light/${a}`, { ...light, ...block(`:root[data-accent='${a}']`), ...block(`:root[data-theme='light'][data-accent='${a}']`) }])
    }
    const neutral = { tone: '--text-2', ink: '--text-1' }
    for (const [name, t] of themes) {
      for (const [label, b] of [['neutral', neutral], ...['accent', 'success', 'warning', 'danger', 'info'].map((x) => [x, badgeTone(x)] as const)] as const) {
        const val = (v: string): string => (v.startsWith('#') ? v : t[v])
        const tone = val(b.tone)
        const ink = val(b.ink)
        expect(tone, `${name} ${label} tone ${b.tone}`).toMatch(/^#[0-9a-f]{6}$/i)
        expect(ink, `${name} ${label} ink ${b.ink}`).toMatch(/^#[0-9a-f]{6}$/i)
        for (const bg of SURFACES) expect(contrast(ink, mix(tone, t[bg], p)), `${name} badge--${label} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('the light theme keeps the system-light copy in sync', () => {
    const sys = /@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme='system'\] \{([^}]*)\}/.exec(css)
    expect(sys).not.toBeNull()
    const sysVars = Object.fromEntries([...sys![1].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]))
    const lightOnly = block(":root[data-theme='light']")
    for (const [k, v] of Object.entries(sysVars)) expect(lightOnly[k], k).toBe(v)
  })

  it('text on every accent fill is ≥ 4.5:1, and accent-colored text is readable in both themes', () => {
    const accents: Array<[string, Record<string, string>]> = [['gold', dark]]
    for (const a of ['violet', 'rose', 'aurora', 'ice']) accents.push([a, { ...dark, ...block(`:root[data-accent='${a}']`) }])
    for (const [name, t] of accents) {
      expect(contrast(t['--on-accent'], t['--accent']), `${name} on-accent`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['--accent-ink'], dark['--bg-2']), `${name} ink (dark)`).toBeGreaterThanOrEqual(4.5)
      const lightInk = block(name === 'gold' ? ":root[data-theme='light']" : `:root[data-theme='light'][data-accent='${name}']`)['--accent-ink']
      for (const bg of SURFACES) expect(contrast(lightInk, light[bg]), `${name} ink (light) on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
