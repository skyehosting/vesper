/**
 * Phase 4b F60: a damaged vesper.db just stopped the app ("file is not a database", Try again / Quit), and lighter
 * page damage passed start-up unnoticed. Now (07 C19) `PRAGMA quick_check` runs on a read-only connection before
 * anything opens the file for writing; damage stops the start with a typed error listing the usable backups; the
 * desktop asks "Restore the backup from <date>" / "Start fresh (keep the damaged file)" / "Quit", and the damaged files
 * are moved aside, never deleted or written to. @R20
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '@server/app'
import { contentOf } from '@server/attachments'
import { assertDatabaseUsable, recoverDamagedDatabase, StartupDbError } from '@server/data/backup'
import { MIGRATIONS } from '@server/db/migrations'
import { checkDatabaseFile, isCorruption } from '@server/db/sqlite'
import { createNodePlatform } from '@server/nodePlatform'
import { CLEAN_MARKER, markDatabaseAtRest, takeCleanMarker, writeCleanMarker } from '@server/system/cleanShutdown'
import type { DialogSpec } from '../../../src/main/dialogSpec'
import { classifyStartupError, corruptDbDialog, START_FRESH, startWithRecovery } from '../../../src/main/startup'
import { fakeLog, removeTempDir, tempDir } from '../../fakes'

process.env.VESPER_TEST = '1'
const SCHEMA = Math.max(...MIGRATIONS.map((m) => m.version))
const made: string[] = []
afterAll(() => {
  for (const d of made) removeTempDir(d)
})

function boot(dir: string) {
  return startServer(createNodePlatform({ appDir: dir, version: '0.0.0-test', dataDir: path.join(dir, 'data') }), { port: 0, webDir: dir, workersDir: dir, devRendererUrl: null })
}

/** A data dir with one session, a manual backup holding it, then a second session after the backup. */
async function seeded(): Promise<{ dir: string; dbFile: string; backupsDir: string; backup: string }> {
  const dir = tempDir('vesper-f60-')
  made.push(dir)
  const s = await boot(dir)
  s.ctx.repos.sessions.create({ title: 'In the backup', now: Date.now() })
  const b = await contentOf(s.ctx).backup('manual')
  s.ctx.repos.sessions.create({ title: 'After the backup', now: Date.now() })
  await s.close()
  return { dir, dbFile: path.join(dir, 'data', 'vesper.db'), backupsDir: path.join(dir, 'data', 'backups'), backup: b.file }
}

async function startError(dir: string): Promise<StartupDbError> {
  try {
    const s = await boot(dir)
    await s.close()
  } catch (e) {
    return e as StartupDbError
  }
  throw new Error('the server started on a damaged database')
}

describe('detection at start', () => {
  it('random bytes: a typed corruption error with the usable backups; the file is not touched', async () => {
    const { dir, dbFile, backup } = await seeded()
    const junk = crypto.randomBytes(100 * 1024)
    fs.writeFileSync(dbFile, junk)
    const e = await startError(dir)
    expect(e).toBeInstanceOf(StartupDbError)
    expect(e.code).toBe('DB_CORRUPT')
    expect(e.message).toMatch(/damaged/)
    expect(e.details.backups?.map((b) => b.file)).toEqual([backup])
    expect(classifyStartupError(e)).toBe('db_corrupt')
    // Read-only safety: not a byte changed, nothing deleted.
    expect(fs.readFileSync(dbFile).equals(junk)).toBe(true)
  })

  it('page damage that still opens (a table root page garbled) is caught by quick_check', async () => {
    const { dir, dbFile } = await seeded()
    const ro = new DatabaseSync(dbFile, { readOnly: true })
    const root = Number((ro.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'facts'").get() as { rootpage: number }).rootpage)
    const pageSize = Number((ro.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    ro.close()
    for (const f of ['-wal', '-shm']) fs.rmSync(`${dbFile}${f}`, { force: true })
    const fd = fs.openSync(dbFile, 'r+')
    fs.writeSync(fd, crypto.randomBytes(pageSize), 0, pageSize, (root - 1) * pageSize)
    fs.closeSync(fd)
    expect(checkDatabaseFile(dbFile)).not.toBeNull()
    const e = await startError(dir)
    expect(e.code).toBe('DB_CORRUPT')
  })

  it('a healthy database (or none yet) passes', async () => {
    const { dbFile } = await seeded()
    expect(checkDatabaseFile(dbFile)).toBeNull()
    expect(checkDatabaseFile(path.join(path.dirname(dbFile), 'missing.db'))).toBeNull()
    expect(isCorruption(Object.assign(new Error('x'), { errcode: 26 }))).toBe(true)
    expect(isCorruption(Object.assign(new Error('x'), { errcode: 11 | (1 << 8) }))).toBe(true)
    expect(isCorruption(Object.assign(new Error('database is locked'), { errcode: 5 }))).toBe(false)
  })
})

/**
 * NEW-2: the full quick_check reads the whole file (GBs for a long-time user: messages, FTS5, vectors) and ran on every
 * launch before the tray and window. Now it runs only when the last run did not close cleanly (or the file changed
 * since); after a clean quit a cheap read-only open + schema read still catches a file that is not a database.
 */
describe('when the full check runs', () => {
  const markerOf = (dir: string) => path.join(dir, 'data', 'local', CLEAN_MARKER)
  /** Garble the facts table's root page in place (same size), as if it happened while Vesper was not running. */
  function garblePageQuietly(dir: string, dbFile: string): void {
    const ro = new DatabaseSync(dbFile, { readOnly: true })
    const root = Number((ro.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'facts'").get() as { rootpage: number }).rootpage)
    const pageSize = Number((ro.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    ro.close()
    const fd = fs.openSync(dbFile, 'r+')
    fs.writeSync(fd, crypto.randomBytes(pageSize), 0, pageSize, (root - 1) * pageSize)
    fs.closeSync(fd)
    // The marker describes the file as it is now (the clean quit came after; the damage is invisible to it).
    for (const f of ['-wal', '-shm']) fs.rmSync(`${dbFile}${f}`, { force: true })
    writeCleanMarker(markerOf(dir), dbFile, Date.now())
  }

  it('a clean quit leaves a marker for this exact file; a running server has consumed it (a crash leaves none)', async () => {
    const { dir, dbFile } = await seeded()
    expect(fs.existsSync(markerOf(dir))).toBe(true)
    const s = await boot(dir)
    try {
      expect(fs.existsSync(markerOf(dir))).toBe(false)
    } finally {
      await s.close()
    }
    expect(takeCleanMarker(markerOf(dir), dbFile, fakeLog())).toBe(true)
    // Taken once: the next start (without a clean quit in between) runs the full check.
    expect(takeCleanMarker(markerOf(dir), dbFile, fakeLog())).toBe(false)
  })

  it('a Windows session end (killed, no close) checkpoints and marks the file at rest; a write after that voids it', async () => {
    const { dir, dbFile } = await seeded()
    const s = await boot(dir)
    try {
      s.ctx.repos.sessions.create({ title: 'Before the session end', now: Date.now() })
      expect(markDatabaseAtRest(s.ctx)).toBe(true)
      expect(fs.statSync(`${dbFile}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0)
      // Killed here: the next start would take the cheap path.
      expect(takeCleanMarker(markerOf(dir), dbFile, fakeLog())).toBe(true)
      // The session went on instead: a write leaves the marker stale.
      expect(markDatabaseAtRest(s.ctx)).toBe(true)
      s.ctx.repos.sessions.create({ title: 'After', now: Date.now() })
      expect(takeCleanMarker(markerOf(dir), dbFile, fakeLog())).toBe(false)
    } finally {
      await s.close()
    }
  })

  it('the marker only vouches for the file it was written for (size, modification time, no WAL left over)', async () => {
    const { dir, dbFile } = await seeded()
    const m = markerOf(dir)
    const fresh = () => writeCleanMarker(m, dbFile, Date.now())
    fresh()
    fs.appendFileSync(dbFile, Buffer.alloc(4096))
    expect(takeCleanMarker(m, dbFile, fakeLog())).toBe(false)
    fresh()
    const st = fs.statSync(dbFile)
    fs.utimesSync(dbFile, st.atime, new Date(st.mtimeMs + 5000))
    expect(takeCleanMarker(m, dbFile, fakeLog())).toBe(false)
    fresh()
    fs.writeFileSync(`${dbFile}-wal`, Buffer.alloc(1024))
    expect(takeCleanMarker(m, dbFile, fakeLog())).toBe(false)
    fs.rmSync(`${dbFile}-wal`)
    fs.writeFileSync(m, '{ not json')
    expect(takeCleanMarker(m, dbFile, fakeLog())).toBe(false)
  })

  it('after a clean quit the gate is cheap (no full scan); without the marker the full quick_check runs', async () => {
    const { dir, dbFile, backupsDir } = await seeded()
    garblePageQuietly(dir, dbFile)
    expect(takeCleanMarker(markerOf(dir), dbFile, fakeLog())).toBe(true)
    expect(checkDatabaseFile(dbFile, { full: false })).toBeNull()
    expect(assertDatabaseUsable(dbFile, backupsDir, SCHEMA, fakeLog(), { full: false })).toBe('quick')
    expect(() => assertDatabaseUsable(dbFile, backupsDir, SCHEMA, fakeLog(), { full: true })).toThrow(StartupDbError)
    // The start after a crash (no marker): the full check finds the quiet damage.
    const e = await startError(dir)
    expect(e.code).toBe('DB_CORRUPT')
  })

  it('the cheap gate still stops a file that is not a database, even with a valid marker', async () => {
    const { dir, dbFile } = await seeded()
    fs.writeFileSync(dbFile, crypto.randomBytes(fs.statSync(dbFile).size))
    writeCleanMarker(markerOf(dir), dbFile, Date.now())
    expect(checkDatabaseFile(dbFile, { full: false })).not.toBeNull()
    expect(() => assertDatabaseUsable(dbFile, path.join(dir, 'data', 'backups'), SCHEMA, fakeLog(), { full: false })).toThrow(StartupDbError)
    expect(fs.existsSync(markerOf(dir))).toBe(true)
    const e = await startError(dir)
    expect(e.code).toBe('DB_CORRUPT')
  })
})

describe('recovery', () => {
  it('restore: the backup is copied in and the damaged files are kept in backups/damaged-*', async () => {
    const { dir, dbFile, backupsDir, backup } = await seeded()
    const junk = crypto.randomBytes(64 * 1024)
    fs.writeFileSync(dbFile, junk)
    const e = await startError(dir)
    const kept = recoverDamagedDatabase(dbFile, backupsDir, { kind: 'restore', file: e.details.backups![0].file }, { schemaVersion: SCHEMA, log: fakeLog() })
    expect(path.basename(kept)).toMatch(/^damaged-\d{8}-\d{6}$/)
    expect(fs.readFileSync(path.join(kept, 'vesper.db')).equals(junk)).toBe(true)
    expect(fs.existsSync(path.join(backupsDir, backup))).toBe(true)
    const s = await boot(dir)
    try {
      expect(s.ctx.repos.sessions.list({ limit: 10 }).items.map((x) => x.title)).toEqual(['In the backup'])
    } finally {
      await s.close()
    }
  })

  it('start fresh: an empty database, the damaged one kept', async () => {
    const { dir, dbFile, backupsDir } = await seeded()
    fs.writeFileSync(dbFile, crypto.randomBytes(64 * 1024))
    await startError(dir)
    const kept = recoverDamagedDatabase(dbFile, backupsDir, { kind: 'fresh' }, { schemaVersion: SCHEMA, log: fakeLog() })
    expect(fs.existsSync(path.join(kept, 'vesper.db'))).toBe(true)
    const s = await boot(dir)
    try {
      expect(s.ctx.repos.sessions.list({ limit: 10 }).items).toEqual([])
    } finally {
      await s.close()
    }
  })

  it('a backup that is not ours or is damaged is refused', async () => {
    const { dbFile, backupsDir } = await seeded()
    expect(() => recoverDamagedDatabase(dbFile, backupsDir, { kind: 'restore', file: '..\\vesper.db' }, { schemaVersion: SCHEMA, log: fakeLog() })).toThrow()
    fs.writeFileSync(path.join(backupsDir, 'vesper-20200101.db'), crypto.randomBytes(8192))
    expect(() => recoverDamagedDatabase(dbFile, backupsDir, { kind: 'restore', file: 'vesper-20200101.db' }, { schemaVersion: SCHEMA, log: fakeLog() })).toThrow(/damaged/)
    expect(fs.existsSync(dbFile)).toBe(true)
  })
})

describe('the desktop dialog', () => {
  const err = new StartupDbError('DB_CORRUPT', "Vesper's database is damaged (file is not a database).", {
    dbFile: 'C:\\data\\vesper.db',
    backupsDir: 'C:\\data\\backups',
    backups: [{ file: 'vesper-20261004.db', createdUtc: 1 }]
  })

  it('offers Restore <date> / Start fresh / Quit and says nothing is deleted', () => {
    const { spec, choices } = corruptDbDialog(err, 'C:\\logs\\main.log', () => 'Oct 4')
    expect(spec.message).toBe("Vesper's database is damaged.")
    expect(spec.buttons).toEqual(['Restore the backup from Oct 4', START_FRESH, 'Quit'])
    expect(spec.cancelId).toBe(2)
    expect(spec.detail).toContain('nothing is deleted')
    expect(choices).toEqual([{ kind: 'restore', file: 'vesper-20261004.db' }, { kind: 'fresh' }, null])
    const none = corruptDbDialog(new StartupDbError('DB_CORRUPT', 'x', { dbFile: 'a', backupsDir: 'b', backups: [] }), null)
    expect(none.spec.buttons).toEqual([START_FRESH, 'Quit'])
    expect(none.spec.detail).toContain('no usable backup')
  })

  for (const [answer, expected] of [
    [0, { kind: 'restore', file: 'vesper-20261004.db' }],
    [1, { kind: 'fresh' }]
  ] as const) {
    it(`answer ${answer}: recovers, then starts again (no attempt used up)`, async () => {
      const asked: DialogSpec[] = []
      const recovered: unknown[] = []
      let starts = 0
      const r = await startWithRecovery({
        start: async () => {
          if (++starts === 1) throw err
          return 'running'
        },
        ask: async (spec) => (asked.push(spec), answer),
        recoverDb: (_e, choice) => void recovered.push(choice)
      })
      expect(r).toBe('running')
      expect(recovered).toEqual([expected])
      expect(asked).toHaveLength(1)
    })
  }

  it('Quit: nothing is changed', async () => {
    const recovered: unknown[] = []
    const r = await startWithRecovery({
      start: async () => {
        throw err
      },
      ask: async (spec) => spec.cancelId,
      recoverDb: (_e, c) => void recovered.push(c)
    })
    expect(r).toBeNull()
    expect(recovered).toEqual([])
  })
})
