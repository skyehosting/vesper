/**
 * fix5-ui P20/P30: no internal build-doc references ("07 A4", "(C14)", "BLD-1", "(R21)", "F52") in text the owner can
 * see. Scans every string literal, template text and JSX text under src/web and src/shared with the TypeScript
 * scanner (comments are not tokens, so code comments may keep their references). The test-only UI-kit gallery
 * (`/gallery`, testOnly route) is a developer page and is skipped, as are GLSL shader sources.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { files, textTokens } from './sourceText'

const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['src/web', 'src/shared']
// GLSL sources are template strings whose comments cite research notes; the GPU reads them, nobody sees them.
const SKIP = [/[\\/]features[\\/]gallery[\\/]/, /[\\/]gl[\\/][^\\/]*Shaders\.ts$/]

/** Doc ids: "07 A4", "07 §H", "03 §5", "(C14)", "(D12)", "BLD-14", "(R21)", "(F52)", "H-ux1", "07-AMENDMENTS". */
export const DOC_REF =
  /\b0[0-7][ -]?(?:§\s?[A-H0-9]|[A-H]\d{1,2}\b)|\((?:[A-H]\d{1,2}|R\d{1,2}|F\d{2}|P\d{2})(?:[/,][^)]*)?\)|\bBLD-\d+|\bH-[a-z]+-?\d+\b|AMENDMENTS|\bOWNER-NOTES\b/

describe('owner-visible text has no internal doc references', () => {
  it('the pattern catches the known shapes and leaves ordinary text alone', () => {
    for (const bad of ['Pin a fact about you that Vesper always knows (07 A4)', 'See 07 §H', 'per BLD-14', 'default 1200 (07 C17)', 'the reveal (C14)', 'polish (F52)', 'privacy (R21)'])
      expect(bad, bad).toMatch(DOC_REF)
    for (const ok of ['Shift+F10', 'F2', 'Ctrl+K', 'voyage-4-lite', 'A4 paper', 'gpt-4o-mini-tts', '(about $0.02)', 'H1 heading', '2026-10-05', 'UTC−04:00'])
      expect(ok, ok).not.toMatch(DOC_REF)
  })

  it('no string literal or JSX text under src/web and src/shared names a build doc', () => {
    const hits: string[] = []
    for (const d of DIRS) {
      for (const f of files(path.join(ROOT, d))) {
        if (SKIP.some((r) => r.test(f))) continue
        for (const t of textTokens(fs.readFileSync(f, 'utf8'), f.endsWith('.tsx'))) {
          if (DOC_REF.test(t)) hits.push(`${path.relative(ROOT, f)}: ${JSON.stringify(t.slice(0, 120))}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})
