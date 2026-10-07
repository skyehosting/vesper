/**
 * Packaging prep (Phase 4, 07 B10/E7/E8): the release build (VESPER_BUILD_TEST=0) still builds and contains no test
 * hooks, test routes or test switches (grepped in every bundle); THIRD_PARTY_NOTICES.txt is generated with every
 * shipped package and model licence, served at /THIRD_PARTY_NOTICES.txt and shipped next to the exe; the PowerShell
 * hosts and the VAD model are in extraResources. @R20
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { STT_MODELS } from '@shared/models'
import { BUILD_ONLY, collectPackages, renderNotices } from '../../../scripts/licenses.mjs'
import { startTestServer } from '../server/helpers'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }

interface Finding {
  file: string
  what: string
  match: string
}
// The .mjs helper has no types of its own; this is its surface.
const release = (await import('../../../scripts/check-release.mjs' as string)) as {
  buildRelease(outDir: string): { status: number | null; output: string }
  scanBundles(outDir: string): Finding[]
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-release-'))
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }))

describe('release build (VESPER_BUILD_TEST=0)', () => {
  it('builds, and no bundle contains a test hook, route or switch; the notices are there', { timeout: 300_000 }, () => {
    const b = release.buildRelease(outDir)
    expect(b.status, b.output.slice(-2000)).toBe(0)
    expect(release.scanBundles(outDir)).toEqual([])
    for (const f of ['main/index.js', 'main/server-node.js', 'main/db.worker.js', 'web/index.html']) expect(fs.existsSync(path.join(outDir, f)), f).toBe(true)
    const notices = fs.readFileSync(path.join(outDir, 'web', 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    expect(fs.readFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(notices)
    expect(notices).toContain('react ')
    // The same grep finds the hooks in a test build (so an empty result above means something).
    const testBuild = path.join(ROOT, 'out')
    if (fs.existsSync(path.join(testBuild, 'web', 'index.html'))) {
      const kinds = new Set(release.scanBundles(testBuild).map((f) => f.what))
      expect(kinds.has('the window.__vesperTest hooks') && kinds.has('a VESPER_* test switch') && kinds.has('a /api/test/* route')).toBe(true)
    }
  })
})

describe('THIRD_PARTY_NOTICES.txt', () => {
  it('covers every production dependency and the bundled devDependencies, never build tools', () => {
    const pkgs = collectPackages(ROOT)
    const names = new Set(pkgs.map((p) => p.name))
    for (const d of Object.keys(pkg.dependencies)) expect(names.has(d), d).toBe(true)
    for (const d of ['react', 'react-dom', 'three', '@react-three/fiber', 'zustand', 'react-markdown', 'katex', 'shiki', 'fflate', '@fontsource-variable/inter', 'lucide-react']) expect(names.has(d), d).toBe(true)
    // (cross-env is excepted: @react-three/drei declares it as a runtime dependency, so it is listed — over-inclusive.)
    for (const d of BUILD_ONLY) if (d !== 'cross-env') expect(names.has(d), d).toBe(false)
    expect(names.has('typescript')).toBe(false)
    // (@types/* packages appear only where a runtime package declares them as dependencies, e.g. react-markdown.)
    // Every package states a licence (a text, or at least its package.json declaration).
    expect(pkgs.filter((p) => p.license === 'UNKNOWN').map((p) => p.name)).toEqual([])
  })

  it('lists the shipped models and native parts and every downloadable model of the catalogue', () => {
    const text = renderNotices(ROOT)
    for (const s of ['Silero VAD', 'ONNX Runtime', 'sherpa-onnx', 'espeak-ng', 'GPL-3.0', 'OFL-1.1', 'LICENSES.chromium.html']) expect(text, s).toContain(s)
    const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'licenses', 'models.json'), 'utf8')) as { downloadable: { id: string; license: string }[] }
    expect(models.downloadable.map((m) => m.id).sort()).toEqual(STT_MODELS.map((m) => m.id).sort())
    for (const m of STT_MODELS) expect(models.downloadable.find((x) => x.id === m.id)?.license).toBe(m.license)
  })

  it('is served at /THIRD_PARTY_NOTICES.txt from the web root', async () => {
    const t = await startTestServer()
    try {
      const web = path.join(t.dir, 'web')
      fs.mkdirSync(web, { recursive: true })
      fs.writeFileSync(path.join(web, 'THIRD_PARTY_NOTICES.txt'), 'notices here')
      const r = await t.inject({ method: 'GET', url: '/THIRD_PARTY_NOTICES.txt' })
      expect(r.statusCode).toBe(200)
      expect(r.headers['content-type']).toMatch(/^text\/plain/)
      expect(r.body).toBe('notices here')
    } finally {
      await t.close()
    }
  })
})

describe('electron-builder config', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')

  it('ships resources/ (both PowerShell hosts, the VAD model, model licences) and the notices next to the exe', () => {
    expect(yml).toMatch(/extraResources:\s*\n(\s*#.*\n)*\s*- from: resources\s*\n\s*to: resources/)
    for (const f of ['wintts.ps1', 'sysstate.ps1', 'models/silero_vad.onnx', 'licenses/models.json']) expect(fs.existsSync(path.join(ROOT, 'resources', f)), f).toBe(true)
    expect(yml).toMatch(/extraFiles:\s*\n(\s*#.*\n)*\s*- from: out\/THIRD_PARTY_NOTICES\.txt\s*\n\s*to: THIRD_PARTY_NOTICES\.txt/)
  })

  it('keeps unit-test worker bundles and the release check out of the package', () => {
    expect(yml).toContain("'!out/test-workers/**'")
    expect(yml).toContain("'!out/release-check/**'")
  })
})
