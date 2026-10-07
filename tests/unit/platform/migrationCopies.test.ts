/**
 * Phase 4b F67: every failed start after a failing migration wrote another full pre-migration copy of the database
 * (4 per launch through "Try again", more on every relaunch), never pruned. Now each migration keeps only the 2 newest
 * pre-migration copies, the failure is typed (DB_MIGRATION_FAILED, data restored), and the desktop shows a
 * dialog that says the data is safe — with Quit only, no "Try again" that would fail the same way. @R20
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEEP_PRE_MIGRATION, migrateWithBackup, StartupDbError } from '@server/data/backup'
import { MIGRATIONS } from '@server/db/migrations'
import { openDb, type Migration } from '@server/db/sqlite'
import type { DialogSpec } from '../../../src/main/dialogSpec'
import { classifyStartupError, startupDialog, startWithRecovery } from '../../../src/main/startup'
import { fakeLog, tempDir } from '../../fakes'

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version))
const failing: Migration = {
  version: LATEST + 1,
  name: 'boom',
  up() {
    throw new Error('migration bug')
  }
}

describe('pre-migration copies', () => {
  it('a migration that fails on every start leaves at most 2 copies (plus other backups untouched); data intact', async () => {
    const dir = tempDir('vesper-f67-')
    const dbFile = path.join(dir, 'vesper.db')
    const backupsDir = path.join(dir, 'backups')
    let db = openDb(dbFile)
    await migrateWithBackup(db, { dbFile, backupsDir, migrations: MIGRATIONS, log: fakeLog(), now: Date.now() })
    db.prepare("INSERT INTO kv (k, v) VALUES ('keep', '1')").run()
    fs.mkdirSync(backupsDir, { recursive: true })
    fs.writeFileSync(path.join(backupsDir, 'vesper-20260101.db'), 'daily')
    db.close()
    const t0 = new Date(2026, 9, 5, 10, 0, 0).getTime()
    let last: unknown = null
    // Four launches × "Try again" would be 16 attempts; 6 make the point.
    for (let i = 0; i < 6; i++) {
      db = openDb(dbFile)
      try {
        await migrateWithBackup(db, { dbFile, backupsDir, migrations: [...MIGRATIONS, failing], log: fakeLog(), now: t0 + i * 60_000 })
      } catch (e) {
        last = e
      }
      try {
        db.close()
      } catch {
        /* closed by the rollback */
      }
    }
    const pre = fs.readdirSync(backupsDir).filter((n) => n.includes('-pre-v'))
    expect(pre).toHaveLength(KEEP_PRE_MIGRATION)
    expect(pre.sort()).toEqual([`vesper-20261005-100400-pre-v${LATEST + 1}.db`, `vesper-20261005-100500-pre-v${LATEST + 1}.db`])
    expect(fs.existsSync(path.join(backupsDir, 'vesper-20260101.db'))).toBe(true)
    expect(last).toBeInstanceOf(StartupDbError)
    expect(last).toMatchObject({ code: 'DB_MIGRATION_FAILED', message: 'migration bug', details: { restored: true } })
    db = openDb(dbFile)
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST)
      expect((db.prepare("SELECT v FROM kv WHERE k = 'keep'").get() as { v: string }).v).toBe('1')
    } finally {
      db.close()
    }
  })

  it('the copy just written is never pruned, even when older copies carry later dates (clock was ahead / now behind)', async () => {
    const dir = tempDir('vesper-f67b-')
    const dbFile = path.join(dir, 'vesper.db')
    const backupsDir = path.join(dir, 'backups')
    let db = openDb(dbFile)
    await migrateWithBackup(db, { dbFile, backupsDir, migrations: MIGRATIONS, log: fakeLog(), now: Date.now() })
    db.prepare("INSERT INTO kv (k, v) VALUES ('keep', '1')").run()
    db.close()
    const future = ['vesper-20270101-100000-pre-v5.db', 'vesper-20270102-100000-pre-v6.db']
    fs.mkdirSync(backupsDir, { recursive: true })
    for (const n of future) fs.writeFileSync(path.join(backupsDir, n), 'old copy')
    const now = new Date(2026, 9, 5, 10, 0, 0).getTime()
    const fresh = `vesper-20261005-100000-pre-v${LATEST + 1}.db`

    // A failing migration: the fresh copy is still there to put back, so the failure is typed and the data intact.
    db = openDb(dbFile)
    let err: unknown = null
    try {
      await migrateWithBackup(db, { dbFile, backupsDir, migrations: [...MIGRATIONS, failing], log: fakeLog(), now })
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'DB_MIGRATION_FAILED', details: { restored: true } })
    expect(fs.readdirSync(backupsDir).sort()).toEqual([fresh, future[1]].sort())

    // A migration that succeeds keeps the copy taken before it (07 C20) plus the newest other one.
    const ok: Migration = { version: LATEST + 1, name: 'ok', up: (d) => d.exec('CREATE TABLE f67_ok (x)') }
    fs.rmSync(path.join(backupsDir, fresh))
    fs.writeFileSync(path.join(backupsDir, future[0]), 'old copy')
    db = openDb(dbFile)
    try {
      expect(await migrateWithBackup(db, { dbFile, backupsDir, migrations: [...MIGRATIONS, ok], log: fakeLog(), now })).toBe(LATEST + 1)
    } finally {
      db.close()
    }
    expect(fs.readdirSync(backupsDir).sort()).toEqual([fresh, future[1]].sort())
    const copy = openDb(path.join(backupsDir, fresh))
    try {
      expect((copy.prepare("SELECT v FROM kv WHERE k = 'keep'").get() as { v: string }).v).toBe('1')
    } finally {
      copy.close()
    }
  })

  describe('a migration that fails for a reason outside the migration', () => {
    async function failWith(up: Migration['up']): Promise<unknown> {
      const dir = tempDir('vesper-f67c-')
      const dbFile = path.join(dir, 'vesper.db')
      const backupsDir = path.join(dir, 'backups')
      let db = openDb(dbFile)
      await migrateWithBackup(db, { dbFile, backupsDir, migrations: MIGRATIONS, log: fakeLog(), now: Date.now() })
      db.close()
      db = openDb(dbFile)
      try {
        await migrateWithBackup(db, { dbFile, backupsDir, migrations: [...MIGRATIONS, { version: LATEST + 1, name: 'x', up }], log: fakeLog(), now: Date.now() })
      } catch (e) {
        return e
      } finally {
        try {
          db.close()
        } catch {
          /* closed by the rollback */
        }
      }
      throw new Error('the migration did not fail')
    }

    it('disk full (a real SQLITE_FULL, errcode 13): typed DB_DISK_FULL; the dialog says to free space and offers Try again', async () => {
      const err = await failWith((d) => {
        const pages = Number((d.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
        d.exec(`PRAGMA max_page_count = ${pages + 2}`)
        d.exec('CREATE TABLE f67_big (b BLOB)')
        d.exec('INSERT INTO f67_big VALUES (randomblob(1000000))')
      })
      expect((err as { cause?: { errcode?: number } }).cause?.errcode).toBe(13)
      expect(err).toBeInstanceOf(StartupDbError)
      expect(err).toMatchObject({ code: 'DB_DISK_FULL', details: { restored: true } })
      expect(classifyStartupError(err)).toBe('disk_full')
      const spec = startupDialog('disk_full', err, null)
      expect(spec.buttons).toEqual(['Try again', 'Quit'])
      expect(spec.message).toMatch(/disk/i)
      expect(spec.detail).toMatch(/free up (some )?space/i)
      expect(spec.detail).not.toMatch(/Install the next update|version you used before/)
    })

    it('ENOSPC from the file system is disk full too, wherever it comes from', () => {
      const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      expect(classifyStartupError(e)).toBe('disk_full')
      expect(classifyStartupError(Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }))).toBe('disk_full')
    })

    it('I/O errors and a busy database are not "this version can\'t open it": the generic dialog with Try again', async () => {
      for (const errcode of [10, 266, 5, 6]) {
        const err = await failWith(() => {
          throw Object.assign(new Error(`sqlite ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode })
        })
        expect(err).not.toMatchObject({ code: 'DB_MIGRATION_FAILED' })
        expect(classifyStartupError(err)).toBe('other')
        expect(startupDialog('other', err, null).buttons).toEqual(['Try again', 'Quit'])
      }
    })

    it('Try again after freeing space starts normally', async () => {
      const err = new StartupDbError('DB_DISK_FULL', 'database or disk is full', { dbFile: 'x', backupsDir: 'y', restored: true })
      let starts = 0
      const r = await startWithRecovery({
        start: async () => {
          if (++starts === 1) throw err
          return 'up'
        },
        ask: async () => 0
      })
      expect(r).toBe('up')
      expect(starts).toBe(2)
    })
  })

  it('the desktop dialog says the data is safe and offers only Quit (no retry that writes another copy)', async () => {
    const err = new StartupDbError('DB_MIGRATION_FAILED', 'migration bug', { dbFile: 'x', backupsDir: 'y', restored: true })
    expect(classifyStartupError(err)).toBe('migration')
    const asked: DialogSpec[] = []
    let starts = 0
    const r = await startWithRecovery({
      start: async () => {
        starts++
        throw err
      },
      ask: async (spec) => (asked.push(spec), 0),
      logFile: 'C:\\logs\\main.log'
    })
    expect(r).toBeNull()
    expect(starts).toBe(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ message: "Vesper couldn't update its database.", buttons: ['Quit'] })
    expect(asked[0].detail).toContain('Your chats are safe')
  })
})
