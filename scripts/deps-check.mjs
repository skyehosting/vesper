#!/usr/bin/env node
/**
 * Dependency pin check (07 E9): every version in package.json must be exact (no ^, ~, ranges, tags, URLs), except
 * @types/node. With node_modules present, the installed version must also equal the pin, so a stale install is caught.
 *
 *   node scripts/deps-check.mjs [--no-installed] [--json]
 * Exit 1 on any problem.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const EXCEPTIONS = new Set(['@types/node'])
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const problems = []
const warnings = []
let checked = 0

for (const section of SECTIONS) {
  for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    checked++
    if (EXCEPTIONS.has(name)) continue
    if (!EXACT.test(String(spec))) {
      problems.push({ name, section, spec, problem: 'not an exact version' })
      continue
    }
    if (args.has('--no-installed')) continue
    const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json')
    if (!fs.existsSync(manifest)) {
      if (section !== 'peerDependencies' && section !== 'optionalDependencies') warnings.push({ name, section, spec, problem: 'not installed' })
      continue
    }
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
    if (installed !== spec) problems.push({ name, section, spec, problem: `installed ${installed}` })
  }
}

if (args.has('--json')) {
  console.log(JSON.stringify({ ok: problems.length === 0, checked, problems, warnings }, null, 2))
} else {
  for (const w of warnings) console.warn(`warn  ${w.name}@${w.spec} (${w.section}): ${w.problem}`)
  for (const p of problems) console.error(`FAIL  ${p.name}@${p.spec} (${p.section}): ${p.problem}`)
  console.log(problems.length ? `deps:check failed: ${problems.length} problem(s) in ${checked} dependencies` : `deps:check ok: ${checked} dependencies pinned exactly`)
}
process.exit(problems.length ? 1 : 0)
