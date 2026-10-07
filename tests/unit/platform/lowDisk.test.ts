/**
 * Phase 4b F66: there was no low-disk monitoring (07 C19 "disk < 200 MB → banner, pause downloads/embedding") and a
 * failing daily backup was only logged, retried silently on every tick. Now free space is checked at start, every 15
 * minutes and before each daily backup; below 200 MB daily backups are skipped, memory backfill pauses and the owner is
 * told (SystemHealth.lowDisk, one notification); a failed backup is recorded (SystemHealth.lastBackupError →
 * Settings → Data and a toast; one notification per code and day) and cleared by the next good one. @R20
 */
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SystemHealth } from '@shared/api'
import { contentOf } from '@server/attachments'
import { memoryOf } from '@server/memory/service'
import { setSystemTestDeps, systemOf } from '@server/system'
import { backupErrorInfo, LOW_DISK_BYTES } from '@server/system/health'
import { VesperError } from '@shared/errors'
import { healthNotices } from '../../../src/web/features/health/health.logic'
import { coreOf, startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'

const MB = 1024 * 1024
const DAY = 86_400_000
let free = 1024 * MB
let t: TestServer
const notes: { title: string; body: string }[] = []

beforeAll(async () => {
  setSystemTestDeps({ freeSpace: async () => free })
  t = await startTestServer({
    platform: (p) => {
      p.notify = (title, body) => void notes.push({ title, body })
      return p
    }
  })
  setSystemTestDeps(null)
})
afterAll(async () => {
  await t?.close()
})

const health = (): SystemHealth => systemOf(t.server.ctx)!.health.state()

describe('low disk', () => {
  it('below 200 MB: told once, memory backfill paused, daily backups skipped; above 300 MB everything resumes', async () => {
    const ctx = t.server.ctx
    const h = systemOf(ctx)!.health
    await h.checkDisk()
    expect(health().lowDisk).toBeNull()
    let paused: boolean[] = []
    const mem = memoryOf(ctx)
    const orig = mem.setBackgroundPaused.bind(mem)
    vi.spyOn(mem, 'setBackgroundPaused').mockImplementation((reason, on) => {
      if (reason === 'low-disk') paused.push(on)
      orig(reason, on)
    })
    const cookie = await t.login('desktop')
    const ws = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie })
    await ws.hello()
    try {
      free = 150 * MB
      await h.checkDisk()
      const ev = (await ws.next('health.changed')) as { health: SystemHealth }
      expect(ev.health.lowDisk).toMatchObject({ freeBytes: 150 * MB, thresholdBytes: LOW_DISK_BYTES })
      expect(notes.filter((n) => n.title === 'Your disk is almost full')).toHaveLength(1)
      expect(paused).toEqual([true])
      // Bootstrap carries it; the web shows a warning with a way to Data settings.
      const boot = (await t.inject({ url: '/api/bootstrap', cookie })).json() as { health: SystemHealth }
      expect(healthNotices(boot.health).map((n) => [n.kind, n.title, n.data])).toEqual([['lowDisk', 'Your disk is almost full', true]])
      // Still low (250 MB is under the 300 MB hysteresis): no second notification.
      free = 250 * MB
      await h.checkDisk()
      expect(health().lowDisk?.freeBytes).toBe(250 * MB)
      expect(notes.filter((n) => n.title === 'Your disk is almost full')).toHaveLength(1)

      // No daily backup while the disk is low.
      const c = contentOf(ctx)
      coreOf(ctx).clockOffsetMs = DAY
      await c.runMaintenance(true)
      expect(c.backups.list().some((b) => b.kind === 'daily')).toBe(false)

      free = 400 * MB
      paused = []
      await c.runMaintenance(true)
      expect(health().lowDisk).toBeNull()
      expect(paused).toEqual([false])
      expect(c.backups.list().some((b) => b.kind === 'daily')).toBe(true)
    } finally {
      coreOf(ctx).clockOffsetMs = 0
      ws.close()
      vi.restoreAllMocks()
    }
  })
})

describe('failed backups', () => {
  it('a failing daily backup is recorded, announced once per day, shown on Data; the next good backup clears it', async () => {
    const ctx = t.server.ctx
    const c = contentOf(ctx)
    const cookie = await t.login('desktop')
    const ws = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie })
    await ws.hello()
    // The backups folder can't be written (a file where the folder should be).
    const kept = `${ctx.paths.backups}.kept`
    fs.renameSync(ctx.paths.backups, kept)
    fs.writeFileSync(ctx.paths.backups, 'not a folder')
    coreOf(ctx).clockOffsetMs = 3 * DAY
    try {
      await c.runMaintenance(true)
      const ev = (await ws.next('health.changed')) as { health: SystemHealth }
      expect(ev.health.lastBackupError).toMatchObject({ kind: 'daily', code: 'internal' })
      expect(notes.filter((n) => n.title === "Vesper's daily backup failed")).toHaveLength(1)
      // Retried on the next tick: same code, same day → no new event or notification.
      const before = ws.msgs.filter((m) => m.t === 'health.changed').length
      await c.runMaintenance(true)
      expect(ws.msgs.filter((m) => m.t === 'health.changed').length).toBe(before)
      expect(notes.filter((n) => n.title === "Vesper's daily backup failed")).toHaveLength(1)
      const boot = (await t.inject({ url: '/api/bootstrap', cookie })).json() as { health: SystemHealth }
      const [n] = healthNotices(boot.health)
      expect(n).toMatchObject({ kind: 'backup', tone: 'danger', title: 'The daily backup failed', data: true })

      fs.rmSync(ctx.paths.backups)
      fs.renameSync(kept, ctx.paths.backups)
      const b = await c.backup('manual')
      expect(b.bytes).toBeGreaterThan(0)
      expect(health().lastBackupError).toBeNull()
      expect(((await ws.next('health.changed', (m) => (m as { health: SystemHealth }).health.lastBackupError === null)) as { health: SystemHealth }).health.lastBackupError).toBeNull()
    } finally {
      coreOf(ctx).clockOffsetMs = 0
      if (fs.existsSync(kept)) {
        fs.rmSync(ctx.paths.backups, { force: true })
        fs.renameSync(kept, ctx.paths.backups)
      }
      ws.close()
    }
  })

  it('disk-full errors are named as such', () => {
    expect(backupErrorInfo(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })).code).toBe('disk_full')
    expect(backupErrorInfo(Object.assign(new Error('database or disk is full'), { errcode: 13 })).code).toBe('disk_full')
    expect(backupErrorInfo(new VesperError('disk_full')).code).toBe('disk_full')
    expect(backupErrorInfo(new Error('boom')).code).toBe('internal')
  })
})
