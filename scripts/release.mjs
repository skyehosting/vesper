#!/usr/bin/env node
/**
 * Cut a release (07 H-v12-updates):
 *
 *   npm run release 1.2.0              → bump, commit "Vesper 1.2.0", tag v1.2.0, push main and the tag
 *   npm run release -- 1.2.0 --dry-run → only check and print what it would do
 *
 * Checks first: an x.y.z version above the current one, a clean working tree, the `main` branch, no tag of that name.
 * The bump is `npm version <x.y.z> --no-git-tag-version` (package.json and package-lock.json). Pushing the tag starts
 * .github/workflows/release.yml, which tests, builds and publishes the GitHub Release that installed copies update from.
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const version = args.find((a) => !a.startsWith('-'))

const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
const run = (label, fn) => {
  console.log(`→ ${label}`)
  fn()
}

/** -1 / 0 / 1 for two x.y.z versions. */
function compare(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: npm run release <x.y.z>   (add -- --dry-run to only check: npm run release -- 1.2.0 --dry-run)')
  process.exit(2)
}

const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
const problems = []
if (!/^\d+\.\d+\.\d+$/.test(current) || compare(version, current) <= 0) problems.push(`${version} is not above the current version ${current}`)
let branch = ''
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD')
} catch {
  problems.push('not a git repository')
}
if (branch && branch !== 'main') problems.push(`on branch "${branch}", not main`)
try {
  if (git('status', '--porcelain')) problems.push('the working tree has uncommitted changes')
} catch {
  /* reported above */
}
try {
  git('rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  problems.push(`tag ${tag} already exists`)
} catch {
  /* no such tag: good */
}

console.log(`Vesper ${version} (now ${current})${dryRun ? ' — dry run' : ''}`)
console.log(`  1. npm version ${version} --no-git-tag-version   (package.json, package-lock.json)`)
console.log(`  2. git commit -m "Vesper ${version}"`)
console.log(`  3. git tag ${tag}`)
console.log(`  4. git push --atomic origin main ${tag}`)
console.log('  Then GitHub Actions (.github/workflows/release.yml) tests, builds and publishes the release.')

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
if (dryRun) {
  console.log('✓ ready (dry run: nothing was changed)')
  process.exit(0)
}

// `version` is checked against /^\d+\.\d+\.\d+$/ above, so the shell sees digits and dots only (npm is a .cmd on
// Windows, which Node runs only through a shell).
run(`npm version ${version} --no-git-tag-version`, () => execSync(`npm version ${version} --no-git-tag-version`, { cwd: root, stdio: 'inherit' }))
run(`git commit "Vesper ${version}"`, () => {
  git('add', 'package.json', 'package-lock.json')
  git('commit', '-m', `Vesper ${version}`)
})
run(`git tag ${tag}`, () => git('tag', tag))
run(`git push --atomic origin main ${tag}`, () => execFileSync('git', ['push', '--atomic', 'origin', 'main', tag], { cwd: root, stdio: 'inherit' }))
console.log(`✓ ${tag} pushed. Follow the build under the repository's Actions tab; the release appears when it finishes.`)
