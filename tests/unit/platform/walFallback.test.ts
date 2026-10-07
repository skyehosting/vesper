/**
 * Phase 4b F65: with db.worker dead for good (07 C19 restart budget used), WalWatch's only checkpointer rejected with
 * memory_unavailable every minute and the WAL grew without bound. The checkpoint now runs on the main connection
 * then (like 07 H5's export/import/backup fallbacks). @R5
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VesperError } from '@shared/errors'
import { WAL_GROWTH_BYTES } from '@server/data/checkpoint'
import { memoryOf } from '@server/memory/service'
import { systemOf } from '@server/system'
import { startTestServer } from '../server/helpers'

describe('WAL checkpoints without db.worker', () => {
  it('a dead worker: the growing WAL is folded back on the main connection', async () => {
    const t = await startTestServer()
    try {
      const ctx = t.server.ctx
      const mem = memoryOf(ctx)
      // The link has used its restart budget: every job is refused, as link.start() does once `failed` is set.
      vi.spyOn(mem.link, 'dead', 'get').mockReturnValue(true)
      const job = vi.spyOn(mem, 'runJob').mockRejectedValue(new VesperError('memory_unavailable'))
      const dbFile = path.join(ctx.paths.roaming, 'vesper.db')
      ctx.db.exec('CREATE TABLE IF NOT EXISTS pad (x BLOB)')
      const ins = ctx.db.prepare('INSERT INTO pad VALUES (?)')
      for (let i = 0; i < 2600; i++) ins.run(new Uint8Array(4096))
      expect(fs.statSync(`${dbFile}-wal`).size).toBeGreaterThan(WAL_GROWTH_BYTES)
      const sys = systemOf(ctx)!
      await sys.wal.check()
      expect(sys.wal.checkpoints).toEqual(['PASSIVE'])
      expect(job).not.toHaveBeenCalled()
      // The frames are in the database file now.
      expect(fs.statSync(dbFile).size).toBeGreaterThan(10 * 1024 * 1024)
      const r = ctx.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number; checkpointed: number }
      expect(Number(r.log)).toBe(Number(r.checkpointed))
      vi.restoreAllMocks()
    } finally {
      await t.close()
    }
  })

  it('a worker that dies during the checkpoint: the same checkpoint runs here', async () => {
    const t = await startTestServer()
    try {
      const ctx = t.server.ctx
      const mem = memoryOf(ctx)
      let dead = false
      vi.spyOn(mem.link, 'dead', 'get').mockImplementation(() => dead)
      vi.spyOn(mem, 'runJob').mockImplementation(async () => {
        dead = true
        throw new VesperError('memory_unavailable')
      })
      ctx.db.exec('CREATE TABLE IF NOT EXISTS pad (x BLOB)')
      const ins = ctx.db.prepare('INSERT INTO pad VALUES (?)')
      for (let i = 0; i < 2600; i++) ins.run(new Uint8Array(4096))
      const sys = systemOf(ctx)!
      await sys.wal.check()
      expect(sys.wal.checkpoints).toEqual(['PASSIVE'])
      vi.restoreAllMocks()
    } finally {
      await t.close()
    }
  })
})
