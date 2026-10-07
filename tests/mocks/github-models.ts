/**
 * Mock GitHub release downloads for the STT model manager (owner: voice-in-server; foundation version by test-infra).
 *
 * Small `.tar.bz2` archives are generated once per machine (a deterministic ustar written here, compressed by
 * Windows' bsdtar, %SystemRoot%\System32\tar.exe) and cached in %TEMP%. Variants:
 *   ok        — a valid model directory
 *   tampered  — the ok archive with one byte flipped (same size, SHA-256 mismatch)
 *   traversal — contains `../escape.txt` (07 B12: the archive listing must be rejected)
 *   link      — contains a symlink pointing outside the target directory
 *
 * Routes (prefix `/gh` optional): GET /k2-fsa/sherpa-onnx/releases/download/asr-models/<file> → 302 to
 * /gh-objects/<file> (as GitHub redirects to its CDN), which serves bytes with Range support for `.part` resume.
 * GET /redirect-elsewhere/<file> → 302 to a host outside MODEL_DOWNLOAD_HOSTS.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { ModelEntry } from '../../src/shared/models'
import { header, sendJson, sleep, type MockRequest } from './http'
import type { MockModule } from './module'

export type ModelFixtureKind = 'ok' | 'tampered' | 'traversal' | 'link'

export interface ModelFixture {
  kind: ModelFixtureKind
  fileName: string
  /** GitHub-style release URL on the mock (answers 302 → CDN path). */
  url: string
  /** Direct CDN-style URL on the mock (answers 200/206). */
  directUrl: string
  size: number
  sha256: string
  bytes: Buffer
  /** Directory inside the archive. */
  dir: string
  /** File paths inside the archive (files only). */
  files: string[]
}

export interface GithubModelsMock {
  fixture(kind?: ModelFixtureKind): ModelFixture
  /** A catalogue entry (shared/models.ts shape) whose file is the `ok` archive on this mock. */
  catalogEntry(o?: { kind?: ModelFixtureKind; id?: string }): ModelEntry
  /** Serve at most this many bytes per second (cancel / progress tests); 0 = unlimited. */
  throttle(bytesPerSec: number): void
  /** Cut the connection after `bytes` bytes on the next download (resume tests). */
  dropNextAfter(bytes: number): void
  failNext(status: 403 | 404 | 500 | 503, count?: number): void
  /** Byte ranges requested, in order (`null` = full download). */
  rangesRequested(): Array<string | null>
}

export const MOCK_MODEL_DIR = 'sherpa-onnx-mock-model'
const RELEASE_PATH = '/k2-fsa/sherpa-onnx/releases/download/asr-models/'
const CDN_PATH = '/gh-objects/'
/** Bump when the archive contents change so the cache is rebuilt. */
const FIXTURE_VERSION = 1
const MTIME = 1767225600 // 2026-01-01T00:00:00Z: fixed so the archives are byte-identical on every build

interface TarEntry {
  name: string
  type: 'file' | 'dir' | 'symlink'
  data?: Buffer
  link?: string
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`
}

/** A POSIX ustar archive with fixed owner/time fields (deterministic bytes). */
export function ustar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const data = e.type === 'file' ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0)
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100, 'utf8')
    h.write(octal(e.type === 'dir' ? 0o755 : 0o644, 8), 100, 'ascii')
    h.write(octal(0, 8), 108, 'ascii')
    h.write(octal(0, 8), 116, 'ascii')
    h.write(octal(data.length, 12), 124, 'ascii')
    h.write(octal(MTIME, 12), 136, 'ascii')
    h.write('        ', 148, 'ascii')
    h.write(e.type === 'dir' ? '5' : e.type === 'symlink' ? '2' : '0', 156, 'ascii')
    if (e.link) h.write(e.link, 157, 100, 'utf8')
    h.write('ustar\0', 257, 'ascii')
    h.write('00', 263, 'ascii')
    h.write('vesper', 265, 'ascii')
    h.write('vesper', 297, 'ascii')
    let sum = 0
    for (const byte of h) sum += byte
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** Deterministic pseudo-random bytes (incompressible, so the archive is big enough to show progress). */
function noise(size: number, seed: number): Buffer {
  const b = Buffer.alloc(size)
  let x = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    b[i] = x & 0xff
  }
  return b
}

function contents(kind: Exclude<ModelFixtureKind, 'tampered'>): TarEntry[] {
  const d = MOCK_MODEL_DIR
  const base: TarEntry[] = [
    { name: `${d}/`, type: 'dir' },
    { name: `${d}/model.int8.onnx`, type: 'file', data: noise(256 * 1024, 7) },
    { name: `${d}/tokens.txt`, type: 'file', data: Buffer.from('<blk> 0\nhello 1\nworld 2\n') },
    { name: `${d}/README.md`, type: 'file', data: Buffer.from('Vesper mock STT model (test fixture, not a real model).\n') }
  ]
  if (kind === 'traversal') base.push({ name: '../escape.txt', type: 'file', data: Buffer.from('outside the target directory\n') })
  if (kind === 'link') base.push({ name: `${d}/outside`, type: 'symlink', link: '../../outside.txt' })
  return base
}

function tarExe(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

const built = new Map<ModelFixtureKind, Buffer>()

/** Build (or load from the %TEMP% cache) the archive bytes for a fixture. */
export function fixtureBytes(kind: ModelFixtureKind): Buffer {
  const hit = built.get(kind)
  if (hit) return hit
  if (kind === 'tampered') {
    const ok = Buffer.from(fixtureBytes('ok'))
    ok[Math.floor(ok.length / 2)] ^= 0xff
    built.set(kind, ok)
    return ok
  }
  const cacheDir = path.join(os.tmpdir(), `vesper-mock-models-v${FIXTURE_VERSION}`)
  const out = path.join(cacheDir, `${kind}.tar.bz2`)
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true })
    const tmp = `${out}.${process.pid}.${Date.now()}`
    fs.writeFileSync(`${tmp}.tar`, ustar(contents(kind)))
    // `@archive` re-packs the entries as they are (names included, -P keeps `..`), bzip2 adds no timestamps.
    execFileSync(tarExe(), ['-cjf', path.basename(`${tmp}.tbz`), '-P', `@${path.basename(`${tmp}.tar`)}`], { cwd: cacheDir, stdio: 'pipe', windowsHide: true })
    fs.rmSync(`${tmp}.tar`, { force: true })
    try {
      fs.renameSync(`${tmp}.tbz`, out)
    } catch {
      fs.rmSync(`${tmp}.tbz`, { force: true }) // another process won the race; its file is identical
    }
  }
  const bytes = fs.readFileSync(out)
  built.set(kind, bytes)
  return bytes
}

const FILE_NAMES: Record<ModelFixtureKind, string> = {
  ok: `${MOCK_MODEL_DIR}.tar.bz2`,
  tampered: `${MOCK_MODEL_DIR}-tampered.tar.bz2`,
  traversal: `${MOCK_MODEL_DIR}-traversal.tar.bz2`,
  link: `${MOCK_MODEL_DIR}-link.tar.bz2`
}

export function createGithubModelsMock(): GithubModelsMock & MockModule & { attach(base: string): void } {
  let base = ''
  let rate = 0
  let dropAfter: number | null = null
  let failures: number[] = []
  let ranges: Array<string | null> = []

  function fixture(kind: ModelFixtureKind = 'ok'): ModelFixture {
    const bytes = fixtureBytes(kind)
    const fileName = FILE_NAMES[kind]
    const files = contents(kind === 'tampered' ? 'ok' : kind)
      .filter((e) => e.type === 'file')
      .map((e) => e.name)
    return {
      kind,
      fileName,
      url: `${base}${RELEASE_PATH}${fileName}`,
      directUrl: `${base}${CDN_PATH}${fileName}`,
      size: bytes.length,
      // The tampered archive keeps the ok archive's published digest: that is the point of the test.
      sha256: createHash('sha256').update(kind === 'tampered' ? fixtureBytes('ok') : bytes).digest('hex'),
      bytes,
      dir: MOCK_MODEL_DIR,
      files
    }
  }

  async function serve(req: MockRequest, res: ServerResponse, fileName: string): Promise<void> {
    const kind = (Object.keys(FILE_NAMES) as ModelFixtureKind[]).find((k) => FILE_NAMES[k] === fileName)
    if (!kind) return sendJson(res, 404, { message: 'Not Found' })
    const fail = failures.shift()
    if (fail) return sendJson(res, fail, { message: `Mock failure ${fail}` })
    const bytes = fixtureBytes(kind)
    const range = header(req, 'range') ?? null
    ranges.push(range)
    let start = 0
    let end = bytes.length - 1
    let status = 200
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!m || Number(m[1]) >= bytes.length) {
        res.writeHead(416, { 'content-range': `bytes */${bytes.length}` })
        return void res.end()
      }
      start = Number(m[1])
      end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
      status = 206
    }
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag: `"${createHash('sha1').update(bytes).digest('hex')}"`
    }
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`
    res.writeHead(status, headers)
    if (req.method === 'HEAD') return void res.end()
    const cut = dropAfter
    dropAfter = null
    const step = rate > 0 ? Math.max(1, Math.floor(rate / 20)) : 64 * 1024
    let sent = 0
    for (let off = start; off <= end && !res.destroyed; off += step) {
      let chunk = bytes.subarray(off, Math.min(end + 1, off + step))
      if (cut !== null && sent + chunk.length > cut) {
        chunk = chunk.subarray(0, Math.max(0, cut - sent))
        if (chunk.length) res.write(chunk)
        await sleep(20)
        res.socket?.destroy()
        return
      }
      if (!res.write(chunk)) await new Promise<void>((r) => res.once('drain', () => r()))
      sent += chunk.length
      if (rate > 0) await sleep(50)
    }
    res.end()
  }

  return {
    name: 'github-models',
    prefixes: ['gh'],
    attach(b) {
      base = b
    },
    fixture,
    catalogEntry(o = {}) {
      const f = fixture(o.kind ?? 'ok')
      return {
        id: o.id ?? 'mock-model',
        kind: 'stt',
        label: 'Mock model (tests)',
        description: 'A tiny archive served by the mock provider server.',
        languages: 'English',
        files: [{ url: f.url, size: f.size, sha256: f.sha256, archive: 'tar.bz2' }],
        unpackedSize: f.files.length * 1024 + 256 * 1024,
        ramMB: 1,
        license: 'MIT',
        attribution: 'Vesper test fixture.',
        family: 'moonshine',
        dir: f.dir
      }
    },
    throttle(bps) {
      rate = bps
    },
    dropNextAfter(bytes) {
      dropAfter = bytes
    },
    failNext(status, count = 1) {
      for (let i = 0; i < count; i++) failures.push(status)
    },
    rangesRequested() {
      return [...ranges]
    },
    reset() {
      rate = 0
      dropAfter = null
      failures = []
      ranges = []
    },
    async handle(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const p = req.path
      if (p.startsWith(RELEASE_PATH)) {
        res.writeHead(302, { location: `${req.base}${CDN_PATH}${p.slice(RELEASE_PATH.length)}` })
        res.end()
        return true
      }
      if (p.startsWith('/redirect-elsewhere/')) {
        res.writeHead(302, { location: `http://untrusted.example.invalid/${p.slice('/redirect-elsewhere/'.length)}` })
        res.end()
        return true
      }
      if (p.startsWith(CDN_PATH)) {
        await serve(req, res, decodeURIComponent(p.slice(CDN_PATH.length)))
        return true
      }
      return false
    }
  }
}
