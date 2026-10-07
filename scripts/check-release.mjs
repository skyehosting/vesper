/**
 * Release-build check (07 B10, Phase 4 packaging prep): builds the app with VESPER_BUILD_TEST=0 into a separate
 * folder (never touching out/, which the e2e runs use) and greps every bundle for test hooks, test routes and test
 * switches. Everything gated by `__VESPER_TEST__` must be gone; the notices file must be there.
 *
 *   node scripts/check-release.mjs [outDir]      (default: out/release-check) — exit code 1 on any finding.
 *
 * Markers are matched as code (string literals or `.PROPERTY` access), so comments in the unminified main bundle
 * that mention a switch do not count.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** What must never appear in a release bundle. */
export const FORBIDDEN = [
  { what: 'a VESPER_* test switch', re: /(['"`]|\.)(VESPER_[A-Z0-9_]+)/g },
  { what: 'the window.__vesperTest hooks', re: /__vesperTest/g },
  { what: 'a /api/test/* route', re: /['"`]\/api\/test\/[a-z-]*/g },
  { what: 'a test-only page route', re: /['"`]\/(voice-lab|presence-lab|gallery|__test\/access-wizard|test\/memory-ui)\b/g },
  { what: 'the test login', re: /['"`][^'"`]*login-as/g }
]

/** Names that look like switches but are not (stdout markers of the headless server, identifiers). */
export const ALLOWED = new Set(['VESPER_READY', 'VESPER_EXPORT_FORMAT', 'VESPER_EXPORT_JSON', 'VESPER_EXPORT_VERSION', 'VESPER_MESSAGES'])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(c|m)?js$|\.html$/.test(e.name)) out.push(p)
  }
  return out
}

/** Findings `{file, what, match}` in the bundles under `outDir` (main, preload, web). */
export function scanBundles(outDir) {
  const findings = []
  for (const sub of ['main', 'preload', 'web']) {
    const dir = path.join(outDir, sub)
    if (!fs.existsSync(dir)) {
      findings.push({ file: dir, what: 'a missing build folder', match: sub })
      continue
    }
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const f of FORBIDDEN) {
        for (const m of text.matchAll(f.re)) {
          const name = m[2] ?? m[0]
          if (ALLOWED.has(name)) continue
          findings.push({ file: path.relative(outDir, file), what: f.what, match: m[0] })
        }
      }
    }
  }
  return findings
}

/** Build the release flavour into `outDir`; returns the child's exit status and output. */
export function buildRelease(outDir) {
  const cli = path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const r = spawnSync(process.execPath, [cli, 'build'], {
    cwd: ROOT,
    env: { ...process.env, VESPER_BUILD_TEST: '0', VESPER_OUT_DIR: outDir },
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'out', 'release-check'))
  fs.rmSync(outDir, { recursive: true, force: true })
  const b = buildRelease(outDir)
  if (b.status !== 0) {
    console.error(b.output)
    console.error('release build FAILED')
    process.exit(1)
  }
  const findings = scanBundles(outDir)
  if (!fs.existsSync(path.join(outDir, 'web', 'THIRD_PARTY_NOTICES.txt'))) findings.push({ file: 'web/THIRD_PARTY_NOTICES.txt', what: 'a missing notices file', match: '' })
  for (const f of findings) console.error(`${f.file}: ${f.what} (${f.match})`)
  console.log(findings.length ? `release check FAILED: ${findings.length} finding(s)` : `release check OK: ${outDir}`)
  process.exit(findings.length ? 1 : 0)
}
