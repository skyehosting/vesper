/**
 * CSS class ownership (F46). Every stylesheet under src/web is global once loaded, and lazy route chunks are appended
 * later and never unloaded, so two features defining the same class means the later chunk silently restyles the other
 * feature (Settings' `.srow` collapsed every sidebar chat row to 6 px). This scan fails when a BEM block (the part of
 * a class before `__`/`--`) is defined top-level by more than one area (a feature folder, app/, components/, styles/,
 * lib/), or when a feature styles another feature's block from inside its own scope. Components (the kit) and the app shell may be
 * restyled in context (`.spage .badge`), but never re-defined top-level elsewhere. @R22
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../src/web')

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) cssFiles(p, out)
    else if (p.endsWith('.css')) out.push(p)
  }
  return out
}

/** The owning area: `features/<name>` for anything under a feature folder, otherwise the top folder (app, components…). */
function areaOf(file: string): string {
  const parts = path.relative(ROOT, file).split(path.sep)
  return parts[0] === 'features' ? `features/${parts[1]}` : parts[0]
}

/** Every style-rule prelude, descending into conditional group rules and skipping @keyframes/@font-face bodies. */
export function rulePreludes(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  let i = 0
  const skip = (): void => {
    let depth = 1
    while (i < css.length && depth > 0) {
      const c = css[i++]
      if (c === '{') depth++
      else if (c === '}') depth--
    }
  }
  const block = (): void => {
    let buf = ''
    while (i < css.length) {
      const c = css[i++]
      if (c === '{') {
        const pre = buf.trim()
        buf = ''
        if (pre.startsWith('@')) {
          if (/^@(media|supports|container|layer)\b/.test(pre)) block()
          else skip()
        } else {
          out.push(pre)
          skip()
        }
      } else if (c === '}') return
      else if (c === ';') buf = ''
      else buf += c
    }
  }
  block()
  return out
}

/** Comma-separated selectors of a prelude (commas inside :is()/:not() stay put). */
function selectors(prelude: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of prelude) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const blockOf = (cls: string): string => cls.split(/__|--/)[0]
/** Classes of a compound, ignoring anything inside functional pseudo-classes. */
const classes = (compound: string): string[] => [...compound.replace(/\([^)]*\)/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])

export interface Def {
  /** BEM block of the selector's leading class when the rule styles that block (`.srow`, `.srow:hover .srow__link`). */
  owner?: string
  /** BEM blocks styled by the selector's subject compound. */
  subject: string[]
  selector: string
}

export function analyse(selector: string): Def {
  const compounds = selector
    .replace(/\([^)]*\)/g, (m) => m.replace(/[\s>+~]/g, ''))
    .split(/\s*[\s>+~]\s*/)
    .filter(Boolean)
  const subject = [...new Set(classes(compounds[compounds.length - 1] ?? '').map(blockOf))]
  const lead = /^\.(-?[_a-zA-Z][\w-]*)/.exec(selector)
  const owner = lead && subject.includes(blockOf(lead[1])) ? blockOf(lead[1]) : undefined
  return { owner, subject, selector }
}

interface Hit {
  area: string
  file: string
  selector: string
}

function scan(): { owners: Map<string, Hit[]>; subjects: Map<string, Hit[]> } {
  const owners = new Map<string, Hit[]>()
  const subjects = new Map<string, Hit[]>()
  const push = (m: Map<string, Hit[]>, k: string, h: Hit): void => {
    m.set(k, [...(m.get(k) ?? []), h])
  }
  for (const file of cssFiles(ROOT)) {
    const area = areaOf(file)
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    for (const prelude of rulePreludes(fs.readFileSync(file, 'utf8'))) {
      for (const sel of selectors(prelude)) {
        const d = analyse(sel)
        const hit = { area, file: rel, selector: sel }
        if (d.owner) push(owners, d.owner, hit)
        for (const b of d.subject) push(subjects, b, hit)
      }
    }
  }
  return { owners, subjects }
}

describe('css class ownership (F46)', () => {
  it('the analyser finds the leading block and the subject', () => {
    expect(analyse('.srow')).toMatchObject({ owner: 'srow', subject: ['srow'] })
    expect(analyse('.srow.is-current .srow__link::before')).toMatchObject({ owner: 'srow', subject: ['srow'] })
    expect(analyse('.spage .srow')).toMatchObject({ owner: undefined, subject: ['srow'] })
    expect(analyse('.edge-sheet .panel__head')).toMatchObject({ owner: undefined, subject: ['panel'] })
    expect(analyse('.chip:is(.a, .b) > .chip__x')).toMatchObject({ owner: 'chip', subject: ['chip'] })
    expect(rulePreludes('@media (max-width: 9px) { .a { x: 1 } } @keyframes k { from { y: 1 } } .b{}')).toEqual(['.a', '.b'])
  })

  it('no BEM block is defined top-level by two areas', () => {
    const { owners } = scan()
    const clashes: string[] = []
    for (const [block, hits] of owners) {
      const areas = [...new Set(hits.map((h) => h.area))]
      if (areas.length > 1) clashes.push(`.${block}: ${areas.map((a) => `${a} (${hits.find((h) => h.area === a)!.file}: ${hits.find((h) => h.area === a)!.selector})`).join(' vs ')}`)
    }
    expect(clashes, clashes.join('\n')).toEqual([])
  })

  it("no feature styles another feature's block, even scoped", () => {
    const { owners, subjects } = scan()
    const shared = new Set(['components', 'styles', 'app'])
    const leaks: string[] = []
    for (const [block, hits] of subjects) {
      const homes = new Set((owners.get(block) ?? []).map((h) => h.area))
      if (!homes.size || [...homes].some((a) => shared.has(a))) continue
      for (const h of hits) if (!homes.has(h.area)) leaks.push(`.${block} (owned by ${[...homes].join(', ')}) styled by ${h.file}: ${h.selector}`)
    }
    expect(leaks, leaks.join('\n')).toEqual([])
  })
})
