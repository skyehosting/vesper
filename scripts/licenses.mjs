/**
 * THIRD_PARTY_NOTICES.txt generator (07 E7). Walks every package that ends up in the shipped app — the production
 * `dependencies` (loaded from node_modules inside app.asar) and the devDependencies that the build bundles into
 * out/main and out/web (React, three, the Markdown stack, fonts, fflate …), each with its transitive dependencies —
 * and writes their licence texts, then the licences of shipped and downloadable models
 * (resources/licenses/models.json).
 *
 * Build-only tools (bundlers, test runners, type packages, Electron itself — whose LICENSE and Chromium notices
 * electron-builder ships next to the exe) are excluded.
 *
 * Used by electron.vite.config.ts after every build (out/web/THIRD_PARTY_NOTICES.txt → served at
 * /THIRD_PARTY_NOTICES.txt; out/THIRD_PARTY_NOTICES.txt → shipped next to Vesper.exe via electron-builder
 * extraFiles). CLI: `node scripts/licenses.mjs [outFile…]` (default: both of the above).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** devDependencies that never reach the shipped app (build, test and type tooling). */
export const BUILD_ONLY = new Set([
  '@axe-core/playwright',
  '@playwright/test',
  '@vitejs/plugin-react',
  'cross-env',
  'electron',
  'electron-builder',
  'electron-vite',
  'esbuild',
  'typescript',
  'vite',
  'vitest'
])

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Node's lookup: <from>/node_modules/<name>, then each parent's node_modules. */
function findPackageDir(name, fromDir, root) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name)
    if (fs.existsSync(path.join(p, 'package.json'))) return p
    if (d === root || path.dirname(d) === d) return null
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')
  return 'UNKNOWN'
}

function repoOf(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return r ? String(r).replace(/^git\+/, '').replace(/\.git$/, '') : pkg.homepage || null
}

function licenseTexts(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile())
  } catch {
    names = []
  }
  return names.sort().map((n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim())
}

/**
 * Every shipped package, sorted by name@version: {name, version, license, repository, texts[]}. The roots are the
 * production dependencies and the bundled devDependencies; dependencies and installed optionalDependencies follow.
 */
export function collectPackages(root) {
  const top = readJson(path.join(root, 'package.json'))
  const roots = [
    ...Object.keys(top.dependencies ?? {}),
    ...Object.keys(top.devDependencies ?? {}).filter((n) => !BUILD_ONLY.has(n) && !n.startsWith('@types/'))
  ]
  const seen = new Map()
  const queue = roots.map((name) => ({ name, from: root }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const dir = findPackageDir(name, from, root)
    if (!dir) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) continue
    const texts = licenseTexts(dir)
    const license = licenseOf(pkg)
    seen.set(key, { name: pkg.name, version: pkg.version, license: license === 'UNKNOWN' && texts.length ? 'see the licence text below' : license, repository: repoOf(pkg), texts })
    for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) })) queue.push({ name: dep, from: dir })
  }
  return [...seen.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)))
}

const RULE = '-'.repeat(80)

/** The full notices text. */
export function renderNotices(root) {
  const top = readJson(path.join(root, 'package.json'))
  const pkgs = collectPackages(root)
  const models = readJson(path.join(root, 'resources', 'licenses', 'models.json'))
  const out = []
  out.push(`${top.productName ?? top.name} ${top.version} — third-party notices`)
  out.push('')
  out.push('Vesper includes the software and models listed below. Each is used under its own licence, reproduced here.')
  out.push('Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html next to Vesper.exe.')
  out.push('')
  out.push(`Packages: ${pkgs.length}`)
  out.push('')
  out.push(RULE)
  out.push('MODELS AND NATIVE COMPONENTS')
  out.push(RULE)
  for (const m of models.shipped) out.push('', `${m.name} — ${m.license}`, `  Files: ${m.files}`, `  ${m.attribution}`)
  out.push('', 'Speech models you can download in Settings → Voice in (not included in the installer):')
  for (const m of models.downloadable) out.push('', `${m.name} (${m.id}) — ${m.license}`, `  ${m.attribution}`)
  out.push('', RULE, 'PACKAGES', RULE)
  for (const p of pkgs) {
    out.push('', `${p.name} ${p.version} — ${p.license}`)
    if (p.repository) out.push(`  ${p.repository}`)
    if (p.texts.length) for (const t of p.texts) out.push('', t)
    else out.push('', `  (The package ships no licence file; its package.json declares ${p.license}.)`)
    out.push('', RULE)
  }
  return `${out.join('\n')}\n`
}

/** Write the notices to each of `outFiles` (folders created). Returns the package count. */
export async function writeNotices({ root, outFiles }) {
  const text = renderNotices(root)
  for (const f of outFiles) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text, 'utf8')
  }
  return collectPackages(root).length
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const root = path.resolve(path.dirname(self), '..')
  const outs = process.argv.slice(2)
  const files = outs.length ? outs.map((f) => path.resolve(f)) : [path.join(root, 'out', 'web', 'THIRD_PARTY_NOTICES.txt'), path.join(root, 'out', 'THIRD_PARTY_NOTICES.txt')]
  void writeNotices({ root, outFiles: files }).then((n) => console.log(`THIRD_PARTY_NOTICES.txt: ${n} packages → ${files.join(', ')}`))
}
