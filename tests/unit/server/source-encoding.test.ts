import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Source text is UTF-8. A file that was decoded as cp1252 and saved again turns an em dash, '≤' or '→' into three
 * Latin-1 glyphs starting with 'â' (review NEW-2). This scan catches that damage anywhere in the tracked text sources.
 */
const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['src', 'tests', 'e2e', 'docs', 'build', 'scripts']
const FILES = ['electron-builder.yml', 'package.json']
const EXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|nsh|css|html)$/
// UTF-8 lead bytes E2 / C3 / C2 read as cp1252, followed by a cp1252 continuation glyph. Written with escapes so
// this file does not match itself.
const MOJIBAKE = new RegExp('\u00e2(\u20ac|\u2030|\u2020|\u201e|\u201a)|\u00c3[\u0080-\u00bf\u2018-\u201e\u0160\u0161\u0178\u017d]|\u00c2[\u00a0-\u00bf]')

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
}

describe('source encoding', () => {
  it('the pattern recognises cp1252-decoded UTF-8', () => {
    const damage = (s: string) => Buffer.from(s, 'utf8').toString('latin1').replace(/\u0080/g, '€').replace(/\u0089/g, '‰').replace(/\u0086/g, '†')
    for (const s of ['a — b', 'x ≤ 1', 'a → b', 'C’s', 'more…']) {
      expect(MOJIBAKE.test(s)).toBe(false)
      expect(MOJIBAKE.test(damage(s))).toBe(true)
    }
  })

  it('no tracked text file contains mojibake', () => {
    const files: string[] = []
    for (const d of DIRS) walk(path.join(ROOT, d), files)
    for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f))
    const bad: string[] = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (MOJIBAKE.test(l)) bad.push(`${path.relative(ROOT, f)}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})
