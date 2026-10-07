/**
 * Phase 4b F04/F18/F64: temporary-chat files in %TEMP%\Vesper-<pid> survived a crash, a kill or a Windows shutdown and
 * were never swept. Every start now removes the folders of earlier, dead runs — only Vesper's own (marker file, or the
 * legacy layout), never a link, never a running process' folder. @R21
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markTempDir, pidAlive, sweepStaleTempDirs, TEMP_MARKER } from '@server/system/tempSweep'
import { fakeLog, removeTempDir, tempDir } from '../../fakes'
import { startTestServer } from '../server/helpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDir(d)
  delete process.env.VESPER_TEMP_ROOT
})

function root(): string {
  const d = tempDir('vesper-tsweep-')
  dirs.push(d)
  return d
}

function put(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('sweepStaleTempDirs', () => {
  it('removes dead runs’ folders (marked or legacy), keeps live, own, foreign and linked ones', () => {
    const r = root()
    // A crashed run with a temporary-chat attachment and its marker.
    put(path.join(r, 'Vesper-101', 'attachments', 'abc'))
    markTempDir(path.join(r, 'Vesper-101'), 101, 1)
    // An older build's folder (no marker): only Vesper's own sub-folders.
    put(path.join(r, 'Vesper-102', 'attachments', '.tmp', 'part'))
    put(path.join(r, 'Vesper-102', 'tts', 'a.wav'))
    // Empty leftover.
    fs.mkdirSync(path.join(r, 'Vesper-103'))
    // Same name pattern, but not ours (foreign content, no marker): kept.
    put(path.join(r, 'Vesper-104', 'notes.txt'))
    // A running process' folder: kept.
    put(path.join(r, 'Vesper-105', 'attachments', 'live'))
    markTempDir(path.join(r, 'Vesper-105'), 105, 1)
    // Our own folder: kept.
    put(path.join(r, 'Vesper-106', 'attachments', 'mine'))
    // Other names: kept.
    fs.mkdirSync(path.join(r, 'Vesper-abc'))
    fs.mkdirSync(path.join(r, 'vesper-e2e-data-1'))
    // A junction named like ours, pointing at data that must survive.
    const target = path.join(r, 'precious')
    put(path.join(target, 'attachments', 'keep'))
    fs.symlinkSync(target, path.join(r, 'Vesper-107'), 'junction')

    const log = fakeLog()
    const removed = sweepStaleTempDirs(r, { selfPid: 106, log, alive: (pid) => pid === 105 })
    expect(removed.sort()).toEqual(['Vesper-101', 'Vesper-102', 'Vesper-103'])
    const left = fs.readdirSync(r).sort()
    expect(left).toEqual(['Vesper-104', 'Vesper-105', 'Vesper-106', 'Vesper-107', 'Vesper-abc', 'precious', 'vesper-e2e-data-1'])
    expect(fs.existsSync(path.join(target, 'attachments', 'keep'))).toBe(true)
  })

  it('a missing root is not an error; a marker names the app and the pid', () => {
    expect(sweepStaleTempDirs(path.join(root(), 'nope'), { selfPid: 1, log: fakeLog() })).toEqual([])
    const r = root()
    markTempDir(r, 42, 7)
    expect(JSON.parse(fs.readFileSync(path.join(r, TEMP_MARKER), 'utf8'))).toEqual({ app: 'vesper', pid: 42, startedUtc: 7 })
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
  })
})

describe('at server start', () => {
  it('a stale Vesper-<deadpid> folder from a crashed run is gone after start; ours is marked and removed on close', async () => {
    const r = root()
    process.env.VESPER_TEMP_ROOT = r
    // 999999999 is never a live pid on Windows (pids are multiples of 4 well below this).
    const stale = path.join(r, 'Vesper-999999999')
    put(path.join(stale, 'attachments', 'deadbeef'), 'private scan')
    put(path.join(stale, 'attachments', 'deadbeef.thumb.webp'))
    const t = await startTestServer()
    const own = path.join(r, `Vesper-${process.pid}`)
    try {
      expect(fs.existsSync(stale)).toBe(false)
      expect(t.server.ctx.paths.temp).toBe(own)
      expect(fs.existsSync(path.join(own, TEMP_MARKER))).toBe(true)
    } finally {
      await t.close()
    }
    expect(fs.existsSync(own)).toBe(false)
  })
})
