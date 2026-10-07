#!/usr/bin/env node
/**
 * Requirement traceability (07 E13): tests carry `@R<n>` tags (in titles or comments); this lists, per requirement
 * of docs/00-BRIEF.md, how many tags point at it and from which files.
 *
 *   node scripts/req-coverage.mjs [--json] [--files]
 * Exit 1 when any of R1–R22 has no tagged test (R23 is the Orrery handoff document, not testable).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const SCAN = ['tests/unit', 'tests/integration', 'tests/e2e', 'tests/soak']
const EXT = /\.(ts|tsx|mts|js|mjs)$/
const REQUIRED = 22
const ALL = 23

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue // never follow links (node_modules junctions)
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
  return out
}

/** Short requirement titles from the brief's checklist table. */
function titles() {
  const map = new Map()
  try {
    const brief = fs.readFileSync(path.join(root, 'docs', '00-BRIEF.md'), 'utf8')
    for (const m of brief.matchAll(/^\|\s*R(\d+)\s*\|\s*(.+?)\s*\|\s*$/gm)) {
      const plain = m[2].replace(/\*\*/g, '').replace(/\s+/g, ' ')
      map.set(Number(m[1]), plain.length > 64 ? `${plain.slice(0, 61)}...` : plain)
    }
  } catch {
    /* brief missing: numbers only */
  }
  return map
}

const hits = new Map()
for (let r = 1; r <= ALL; r++) hits.set(r, { count: 0, files: new Set() })
for (const rel of SCAN) {
  for (const file of walk(path.join(root, rel), [])) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/@R(\d{1,2})\b/g)) {
      const r = Number(m[1])
      const h = hits.get(r)
      if (!h) continue
      h.count++
      h.files.add(path.relative(root, file).replace(/\\/g, '/'))
    }
  }
}

const names = titles()
const rows = [...hits].map(([r, h]) => ({ req: `R${r}`, title: names.get(r) ?? '', tags: h.count, files: [...h.files].sort(), required: r <= REQUIRED }))
const missing = rows.filter((r) => r.required && r.tags === 0).map((r) => r.req)

if (args.has('--json')) {
  console.log(JSON.stringify({ ok: missing.length === 0, missing, rows }, null, 2))
} else {
  const w = Math.max(...rows.map((r) => r.title.length), 11)
  console.log(`${'Req'.padEnd(4)}  ${'Requirement'.padEnd(w)}  Tags  ${args.has('--files') ? 'Files' : 'Files (count)'}`)
  console.log(`${'-'.repeat(4)}  ${'-'.repeat(w)}  ----  ${'-'.repeat(13)}`)
  for (const r of rows) {
    const mark = r.tags === 0 ? (r.required ? '  <- MISSING' : '  (not required)') : ''
    const files = args.has('--files') ? r.files.join(', ') : String(r.files.length)
    console.log(`${r.req.padEnd(4)}  ${r.title.padEnd(w)}  ${String(r.tags).padStart(4)}  ${files}${mark}`)
  }
  console.log(missing.length ? `\nreq-coverage: ${missing.length} requirement(s) without a tagged test: ${missing.join(', ')}` : '\nreq-coverage: every requirement R1-R22 has a tagged test')
}
process.exit(missing.length ? 1 : 0)
