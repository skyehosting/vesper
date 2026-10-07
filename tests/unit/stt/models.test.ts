/**
 * Model manager against the mock GitHub release server (07 B12) @R19: download + SHA-256 verify + checked
 * extraction, resume with Range after a dropped connection, a tampered archive and archives with `..` paths or links
 * rejected, redirects only to known hosts, cancel, delete, disk use, progress events.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ModelEntry } from '../../../src/shared/models'
import type { ServerMsg } from '../../../src/shared/ws'
import { checkListing, entryProblem, listArchive, systemTar, type ArchiveEntry } from '../../../src/server/models/archive'
import { ModelManager } from '../../../src/server/models/manager'
import { fakeLog, removeTempDirs, tempDir } from '../../fakes'
import { MOCK_MODEL_DIR } from '../../mocks/github-models'
import { startMockServer, type MockServer } from '../../mocks/server'
import { waitFor } from './helpers'

type Progress = Extract<ServerMsg, { t: 'stt.model.progress' }>

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
beforeEach(() => mock.reset())
afterAll(async () => {
  await mock.close()
  removeTempDirs()
})

function manager(entries: ModelEntry[], o: { free?: number | null } = {}) {
  const dir = path.join(tempDir(), 'models')
  const events: Progress[] = []
  const m = new ModelManager({
    dir,
    catalogue: entries,
    log: fakeLog(),
    emit: (p) => events.push(p),
    allowedOrigins: [new URL(mock.url).origin],
    freeBytes: () => (o.free === undefined ? null : o.free),
    retryDelayMs: 10,
    progressIntervalMs: 0
  })
  return { m, dir, events }
}

describe('downloads @R19', () => {
  it('downloads, verifies and installs; lists state, active model and disk use', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-ok' })
    const { m, dir, events } = manager([e])
    expect(m.list(null)[0]).toMatchObject({ id: 'mock-ok', state: 'not-installed', active: false, downloadBytes: e.files[0].size })
    await m.download('mock-ok')
    const installed = path.join(dir, 'mock-ok')
    expect(fs.readFileSync(path.join(installed, 'tokens.txt'), 'utf8')).toContain('hello 1')
    expect(fs.existsSync(path.join(installed, '.vesper-model.json'))).toBe(true)
    expect(m.resolve('mock-ok')).toEqual({ dir: installed, external: false })
    const info = m.list('mock-ok')[0]
    expect(info).toMatchObject({ state: 'installed', active: true })
    expect(info.diskBytes).toBeGreaterThan(256 * 1024)
    expect(events.map((x) => x.state)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'extracting', 'ready']))
    expect(events.at(-1)).toMatchObject({ state: 'ready', bytes: e.files[0].size, total: e.files[0].size })
    // no leftovers
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([])
    // the real request went through GitHub's redirect to the CDN path
    expect(mock.recorder.all().map((r) => r.path)).toEqual([expect.stringContaining('/releases/download/'), expect.stringContaining('/gh-objects/')])
    // a second download is a no-op
    await m.download('mock-ok')
    expect(mock.recorder.count()).toBe(2)
  })

  it('resumes a dropped download with a Range request (.part file)', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-resume' })
    const { m } = manager([e])
    mock.models.dropNextAfter(100_000)
    await m.download('mock-resume')
    expect(mock.models.rangesRequested()).toEqual([null, 'bytes=100000-'])
    expect(m.list(null)[0].state).toBe('installed')
  })

  it('rejects a tampered archive (SHA-256 mismatch) and deletes it', async () => {
    const ok = mock.models.catalogEntry({ id: 'mock-bad' })
    const bad = mock.models.fixture('tampered')
    const e: ModelEntry = { ...ok, files: [{ ...ok.files[0], url: bad.url }] }
    const { m, dir, events } = manager([e])
    await expect(m.download('mock-bad')).rejects.toMatchObject({ info: { code: 'model_checksum' } })
    expect(fs.existsSync(path.join(dir, 'mock-bad'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([])
    expect(m.list(null)[0]).toMatchObject({ state: 'error', error: { code: 'model_checksum' } })
    expect(events.at(-1)).toMatchObject({ state: 'error', error: { code: 'model_checksum' } })
  })

  it.each(['traversal', 'link'] as const)('refuses an archive with %s entries before writing anything', async (kind) => {
    const e = mock.models.catalogEntry({ id: `mock-${kind}`, kind })
    const { m, dir } = manager([e])
    await expect(m.download(`mock-${kind}`)).rejects.toMatchObject({ info: { code: 'model_unsafe' } })
    expect(fs.existsSync(path.join(dir, `mock-${kind}`))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.tmp', 'escape.txt'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([])
  })

  it('follows redirects only to known hosts and refuses plain http elsewhere', async () => {
    const ok = mock.models.catalogEntry({ id: 'mock-redirect' })
    const e: ModelEntry = { ...ok, files: [{ ...ok.files[0], url: `${mock.url}/redirect-elsewhere/${mock.models.fixture('ok').fileName}` }] }
    const { m } = manager([e])
    await expect(m.download('mock-redirect')).rejects.toMatchObject({ info: { code: 'model_unsafe' } })
    const plain: ModelEntry = { ...ok, id: 'mock-http', files: [{ ...ok.files[0], url: 'http://github.com/x.tar.bz2' }] }
    await expect(manager([plain]).m.download('mock-http')).rejects.toMatchObject({ info: { code: 'model_unsafe' } })
  })

  it('cancels a running download and removes the partial file', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-cancel' })
    const { m, dir, events } = manager([e])
    mock.models.throttle(40_000)
    const p = m.download('mock-cancel')
    await waitFor(() => events.some((x) => x.state === 'downloading' && x.bytes > 0))
    expect(m.list(null)[0].state).toBe('downloading')
    expect(m.list(null)[0].progress?.total).toBe(e.files[0].size)
    expect(await m.cancel('mock-cancel')).toBe(true)
    await expect(p).rejects.toBeTruthy()
    expect(m.list(null)[0].state).toBe('not-installed')
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([])
    expect(await m.cancel('mock-cancel')).toBe(false)
  })

  it('deletes an installed model', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-del' })
    const { m, dir } = manager([e])
    await m.download('mock-del')
    await m.remove('mock-del')
    expect(fs.existsSync(path.join(dir, 'mock-del'))).toBe(false)
    expect(m.list(null)[0].state).toBe('not-installed')
    await expect(m.remove('nope')).rejects.toMatchObject({ info: { code: 'not_found' } })
  })

  it('refuses to start without enough free disk space (07 C19)', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-full' })
    const { m } = manager([e], { free: 10_000 })
    await expect(m.download('mock-full')).rejects.toMatchObject({ info: { code: 'disk_full' } })
    expect(mock.recorder.count()).toBe(0)
  })

  it('reports an upstream 404 and keeps nothing', async () => {
    const e = mock.models.catalogEntry({ id: 'mock-404' })
    const { m } = manager([e])
    mock.models.failNext(404)
    await expect(m.download('mock-404')).rejects.toMatchObject({ info: { code: 'not_found', upstreamStatus: 404 } })
  })

  it('treats a pre-extracted model folder as installed (VESPER_STT_MODEL_DIR)', () => {
    const ext = tempDir()
    fs.mkdirSync(path.join(ext, MOCK_MODEL_DIR))
    const e = mock.models.catalogEntry({ id: 'mock-ext' })
    const m = new ModelManager({ dir: path.join(tempDir(), 'models'), catalogue: [e], log: fakeLog(), emit: () => undefined, externalDirs: [ext] })
    expect(m.resolve('mock-ext')).toEqual({ dir: path.join(ext, MOCK_MODEL_DIR), external: true })
    expect(m.list(null)[0].state).toBe('installed')
  })
})

describe('archive listing checks (07 B12)', () => {
  const ent = (name: string, type = '-', size = 1): ArchiveEntry => ({ name, type, size })

  it('accepts regular files and directories under the model directory only', () => {
    expect(entryProblem(ent('m/'), 'm')).toBeNull()
    expect(entryProblem(ent('m/a/b.onnx'), 'm')).toBeNull()
    expect(entryProblem(ent('./m/a.txt'), 'm')).toBeNull()
    expect(entryProblem(ent('m/../x'), 'm')).not.toBeNull()
    expect(entryProblem(ent('../x'), 'm')).not.toBeNull()
    expect(entryProblem(ent('/etc/passwd'), 'm')).not.toBeNull()
    expect(entryProblem(ent('C:/Windows/x'), 'm')).not.toBeNull()
    expect(entryProblem(ent('m\\..\\x'), 'm')).not.toBeNull()
    expect(entryProblem(ent('m/a.txt:stream'), 'm')).not.toBeNull()
    expect(entryProblem(ent('other/a.txt'), 'm')).not.toBeNull()
    expect(entryProblem(ent('m/link', 'l'), 'm')).not.toBeNull()
    expect(entryProblem(ent('m/hard', 'h'), 'm')).not.toBeNull()
  })

  it('caps the total size and the entry count', () => {
    expect(() => checkListing([ent('m/', 'd', 0), ent('m/a', '-', 10)], { topDir: 'm', maxBytes: 100, maxEntries: 10 })).not.toThrow()
    expect(() => checkListing([ent('m/a', '-', 101)], { topDir: 'm', maxBytes: 100, maxEntries: 10 })).toThrow()
    expect(() => checkListing(Array.from({ length: 11 }, (_, i) => ent(`m/${i}`)), { topDir: 'm', maxBytes: 100, maxEntries: 10 })).toThrow()
    expect(() => checkListing([], { topDir: 'm', maxBytes: 100, maxEntries: 10 })).toThrow()
  })

  it('reads types and sizes from Windows bsdtar listings', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'link.tar.bz2')
    fs.writeFileSync(file, mock.models.fixture('link').bytes)
    const list = await listArchive(systemTar, file)
    expect(list.find((x) => x.name === `${MOCK_MODEL_DIR}/model.int8.onnx`)).toEqual({ name: `${MOCK_MODEL_DIR}/model.int8.onnx`, type: '-', size: 256 * 1024 })
    expect(list.find((x) => x.name.endsWith('/outside'))?.type).toBe('l')
    expect(list.find((x) => x.name === `${MOCK_MODEL_DIR}/`)?.type).toBe('d')
  })
})

describe('free space', () => {
  it('measures the nearest existing folder when the models folder does not exist yet', async () => {
    const { defaultFreeBytes } = await import('../../../src/server/models/manager')
    const free = defaultFreeBytes(path.join(tempDir(), 'not', 'there', 'models'))
    expect(free).toBeGreaterThan(0)
  })
})
