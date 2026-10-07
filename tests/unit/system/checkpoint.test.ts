/**
 * WAL checkpoints off the main thread (07 C9): no connection autocheckpoints; the watcher asks db.worker for a
 * PASSIVE checkpoint after 8 MB of growth and a TRUNCATE above 64 MB when idle; a real server checkpoints through the
 * worker job and the WAL frames land in the database. @R5
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '@server/db/sqlite'
import { WalWatch, WAL_GROWTH_BYTES, WAL_TRUNCATE_BYTES } from '@server/data/checkpoint'
import { memoryOf } from '@server/memory/service'
import { systemOf } from '@server/system'
import { fakeLog, removeTempDir, tempDir } from '../../fakes'
import { startTestServer } from '../server/helpers'

describe('connections', () => {
  const dir = tempDir('vesper-ckpt-')
  afterAll(() => removeTempDir(dir))
  it('every read-write connection has wal_autocheckpoint = 0 (WAL mode, secure_delete on)', () => {
    const db = openDb(path.join(dir, 'a.db'))
    expect(db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 0 })
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    // 2 MB of writes stay in the WAL (an autocheckpoint at 1000 pages would have copied them on this thread).
    db.exec('CREATE TABLE t (x BLOB)')
    const ins = db.prepare('INSERT INTO t VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run(new Uint8Array(4096))
    expect(fs.statSync(path.join(dir, 'a.db-wal')).size).toBeGreaterThan(2 * 1024 * 1024)
    expect(fs.statSync(path.join(dir, 'a.db')).size).toBeLessThan(64 * 1024)
    db.close()
  })
})

describe('WalWatch', () => {
  it('PASSIVE after 8 MB of growth, TRUNCATE above 64 MB only when idle, nothing otherwise', async () => {
    let size = 0
    let idle = false
    const asked: string[] = []
    const w = new WalWatch({ dbFile: 'x.db', log: fakeLog(), walSize: () => size, idle: () => idle, checkpoint: async (m) => void asked.push(m) })
    await w.check()
    size = WAL_GROWTH_BYTES - 1
    await w.check()
    expect(asked).toEqual([])
    size = WAL_GROWTH_BYTES
    await w.check()
    expect(asked).toEqual(['PASSIVE'])
    // Same size again (the file is reused after a checkpoint): nothing to do.
    await w.check()
    expect(asked).toEqual(['PASSIVE'])
    size = WAL_TRUNCATE_BYTES + 1
    await w.check()
    expect(asked).toEqual(['PASSIVE', 'PASSIVE'])
    idle = true
    size = WAL_TRUNCATE_BYTES + 2
    await w.check()
    expect(asked).toEqual(['PASSIVE', 'PASSIVE', 'TRUNCATE'])
    // Truncated to 0: growth is measured from there.
    size = 0
    await w.check()
    size = WAL_GROWTH_BYTES
    await w.check()
    expect(asked).toEqual(['PASSIVE', 'PASSIVE', 'TRUNCATE', 'PASSIVE'])
    w.start()
    expect(w.active).toBe(true)
    await w.close()
    expect(w.active).toBe(false)
  })

  it('a failing checkpoint is logged, not thrown', async () => {
    const log = fakeLog()
    const w = new WalWatch({ dbFile: 'x.db', log, walSize: () => WAL_GROWTH_BYTES * 2, idle: () => true, checkpoint: async () => Promise.reject(new Error('worker gone')) })
    await w.check()
    expect(log.entries.some((e) => e.msg === 'WAL checkpoint failed')).toBe(true)
  })
})

describe('in the server', () => {
  it('a growing WAL is checkpointed by the db.worker job (the main thread never copies pages)', async () => {
    const t = await startTestServer()
    try {
      const ctx = t.server.ctx
      const wal = path.join(ctx.paths.roaming, 'vesper.db-wal')
      ctx.db.exec('CREATE TABLE IF NOT EXISTS pad (x BLOB)')
      const ins = ctx.db.prepare('INSERT INTO pad VALUES (?)')
      for (let i = 0; i < 2600; i++) ins.run(new Uint8Array(4096))
      expect(fs.statSync(wal).size).toBeGreaterThan(WAL_GROWTH_BYTES)
      const sys = systemOf(ctx)!
      await sys.wal.check()
      expect(sys.wal.checkpoints).toEqual(['PASSIVE'])
      expect(memoryOf(ctx).link.started).toBe(true)
      // Everything was copied into the database file: a fresh checkpoint has nothing left to do.
      const r = ctx.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number }
      expect(Number(r.log)).toBe(Number(r.checkpointed))
      expect(fs.statSync(path.join(ctx.paths.roaming, 'vesper.db')).size).toBeGreaterThan(10 * 1024 * 1024)
    } finally {
      await t.close()
    }
  })
})
