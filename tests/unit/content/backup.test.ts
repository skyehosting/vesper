/**
 * Backups (07 C20): node:sqlite backup(), retention 7 daily + 4 weekly with an injected clock, the extra folder,
 * restore = check + stage + swap at the next start, pre-migration backups and automatic rollback of a failed
 * migration, the REST API and the daily maintenance tick. @R20
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '@server/app'
import { contentOf } from '@server/attachments'
import { applyPendingRestore, BackupManager, checkBackupFile, dayKey, isoWeek, migrateWithBackup, parseBackupName, retentionVictims } from '@server/data/backup'
import { MIGRATIONS } from '@server/db/migrations'
import { m001Init } from '@server/db/migrations/001_init'
import { migrate, openDb, type Migration } from '@server/db/sqlite'
import { createNodePlatform } from '@server/nodePlatform'
import { fakeLog, tempDir } from '../../fakes'
import { coreOf, startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'

/** The newest schema version (migrations are added over time; tests must not pin a number). */
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version))

const DAY = 86_400_000
const local = (y: number, m: number, d: number, h = 3) => new Date(y, m - 1, d, h, 0, 0).getTime()

describe('names and retention', () => {
  it('parses our names only', () => {
    expect(parseBackupName('vesper-20261005.db')).toMatchObject({ day: '20261005', kind: 'daily' })
    expect(parseBackupName('vesper-20261005-142233.db')).toMatchObject({ kind: 'manual', createdUtc: new Date(2026, 9, 5, 14, 22, 33).getTime() })
    expect(parseBackupName('vesper-20261005-142233-pre-v4.db')?.kind).toBe('premigrate')
    expect(parseBackupName('vesper-20261005-142233-pre-restore.db')?.kind).toBe('prerestore')
    for (const n of ['vesper.db', 'notes.txt', 'vesper-2026.db', 'vesper-20261005.db.part', '../vesper-20261005.db']) expect(parseBackupName(n)).toBeNull()
    expect(isoWeek('20261005')).toBe('2026-W41')
    expect(isoWeek('20210103')).toBe('2020-W53')
  })

  it('keeps 7 daily + 4 weekly + 3 of each pre-* kind (injected clock)', () => {
    const names: string[] = []
    const start = local(2026, 7, 1)
    for (let i = 0; i < 60; i++) names.push(`vesper-${dayKey(start + i * DAY)}.db`)
    names.push(`vesper-${dayKey(start + 59 * DAY)}-180000.db`, `vesper-${dayKey(start + 58 * DAY)}-090000.db`)
    for (let v = 2; v <= 6; v++) names.push(`vesper-${dayKey(start + v * DAY)}-010000-pre-v${v}.db`)
    names.push('unrelated.txt')
    const victims = new Set(retentionVictims(names, { daily: 7, weekly: 4 }))
    const kept = names.filter((n) => !victims.has(n) && n !== 'unrelated.txt')
    expect(victims.has('unrelated.txt')).toBe(false)
    const regular = kept.filter((n) => parseBackupName(n)!.kind === 'daily' || parseBackupName(n)!.kind === 'manual')
    expect(regular).toHaveLength(11)
    // The newest day is represented by its newest backup (the manual one at 18:00).
    expect(regular).toContain(`vesper-${dayKey(start + 59 * DAY)}-180000.db`)
    expect(regular).not.toContain(`vesper-${dayKey(start + 59 * DAY)}.db`)
    const weeks = new Set(regular.map((n) => isoWeek(parseBackupName(n)!.day)))
    expect(weeks.size).toBeGreaterThanOrEqual(5)
    expect(kept.filter((n) => n.includes('-pre-v'))).toEqual(['pre-v4', 'pre-v5', 'pre-v6'].map((s) => names.find((n) => n.includes(s))))
  })
})

describe('BackupManager', () => {
  function setup() {
    const dir = tempDir('vesper-backup-')
    const dbFile = path.join(dir, 'vesper.db')
    const db = openDb(dbFile)
    migrate(db, MIGRATIONS)
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('marker', '"one"')
    let now = local(2026, 10, 5, 3)
    const extra = path.join(dir, 'extra')
    const settings = { daily: 7, weekly: 4, extraDir: '' }
    const mgr = new BackupManager({ db, dir: path.join(dir, 'backups'), dbFile, now: () => now, log: fakeLog(), settings: () => settings, schemaVersion: LATEST })
    return { dir, dbFile, db, mgr, extra, settings, advance: (ms: number) => (now += ms), at: () => now }
  }

  it('daily once per day, manual any time, list newest first, extra folder copies, retention applied', async () => {
    const s = setup()
    try {
      const first = await s.mgr.create('daily')
      expect(first).toMatchObject({ file: 'vesper-20261005.db', kind: 'daily' })
      expect(first!.bytes).toBeGreaterThan(0)
      expect(await s.mgr.create('daily')).toBeNull()
      s.settings.extraDir = s.extra
      s.advance(3600_000)
      const manual = await s.mgr.create('manual')
      expect(manual?.file).toBe('vesper-20261005-040000.db')
      expect(fs.readdirSync(s.extra)).toEqual(['vesper-20261005-040000.db'])
      expect(s.mgr.list().map((b) => b.file)).toEqual(['vesper-20261005-040000.db', 'vesper-20261005.db'].filter((f) => fs.existsSync(path.join(s.dir, 'backups', f))))
      for (let i = 0; i < 45; i++) {
        s.advance(DAY)
        await s.mgr.create('daily')
      }
      const files = fs.readdirSync(path.join(s.dir, 'backups'))
      expect(files.length).toBeLessThanOrEqual(11)
      expect(files).toContain(`vesper-${dayKey(s.at())}.db`)
      expect(fs.readdirSync(s.extra).length).toBeLessThanOrEqual(11)
      // A backup is a consistent, openable database.
      const copy = new DatabaseSync(path.join(s.dir, 'backups', files[files.length - 1]), { readOnly: true })
      expect((copy.prepare("SELECT v FROM kv WHERE k = 'marker'").get() as { v: string }).v).toBe('"one"')
      copy.close()
    } finally {
      s.db.close()
    }
  })

  it('restore: refuses damaged or newer backups, stages a good one, swaps it in before the next open', async () => {
    const s = setup()
    try {
      const b = await s.mgr.create('daily')
      s.db.prepare("UPDATE kv SET v = '\"two\"' WHERE k = 'marker'").run()
      fs.writeFileSync(path.join(s.dir, 'backups', 'vesper-20200101.db'), 'garbage, not sqlite')
      await expect(s.mgr.stageRestore('vesper-20200101.db')).rejects.toMatchObject({ info: { code: 'validation', message: 'That backup is damaged.' } })
      await expect(s.mgr.stageRestore('../vesper.db')).rejects.toMatchObject({ info: { code: 'validation' } })
      await expect(s.mgr.stageRestore('vesper-20200102.db')).rejects.toMatchObject({ info: { code: 'not_found' } })
      const newer = new DatabaseSync(path.join(s.dir, 'backups', 'vesper-20200103.db'))
      newer.exec('PRAGMA user_version = 99')
      newer.close()
      expect(checkBackupFile(path.join(s.dir, 'backups', 'vesper-20200103.db'), LATEST)).toBe('That backup was made by a newer version of Vesper.')

      await s.mgr.stageRestore(b!.file)
      expect(fs.existsSync(`${s.dbFile}.restore`)).toBe(true)
      expect(s.mgr.list().some((x) => x.kind === 'prerestore')).toBe(true)
      s.db.close()
      expect(applyPendingRestore(s.dbFile, path.join(s.dir, 'backups'), fakeLog())).toBe(true)
      expect(applyPendingRestore(s.dbFile, path.join(s.dir, 'backups'), fakeLog())).toBe(false)
      const reopened = openDb(s.dbFile)
      expect((reopened.prepare("SELECT v FROM kv WHERE k = 'marker'").get() as { v: string }).v).toBe('"one"')
      reopened.close()
      const kept = fs.readdirSync(path.join(s.dir, 'backups')).find((f) => f.startsWith('pre-restore-'))!
      expect(fs.readdirSync(path.join(s.dir, 'backups', kept))).toContain('vesper.db')
    } finally {
      try {
        s.db.close()
      } catch {
        /* closed above */
      }
    }
  })
})

describe('migrations with a backup first', () => {
  const failing: Migration = {
    version: LATEST + 1,
    name: 'boom',
    up(db) {
      db.exec('CREATE TABLE half_done (x)')
      throw new Error('migration bug')
    }
  }

  it('a fresh DB is not backed up; an existing one is, and a failing migration is rolled back from it', async () => {
    const dir = tempDir('vesper-migrate-')
    const dbFile = path.join(dir, 'vesper.db')
    const backupsDir = path.join(dir, 'backups')
    let db = openDb(dbFile)
    expect(await migrateWithBackup(db, { dbFile, backupsDir, migrations: [m001Init], log: fakeLog(), now: local(2026, 10, 5) })).toBe(1)
    expect(fs.existsSync(backupsDir)).toBe(false)
    db.prepare("INSERT INTO kv (k, v) VALUES ('keep', '1')").run()

    expect(await migrateWithBackup(db, { dbFile, backupsDir, migrations: MIGRATIONS, log: fakeLog(), now: local(2026, 10, 5) })).toBe(LATEST)
    expect(fs.readdirSync(backupsDir)).toEqual([`vesper-20261005-030000-pre-v${LATEST}.db`])

    await expect(migrateWithBackup(db, { dbFile, backupsDir, migrations: [...MIGRATIONS, failing], log: fakeLog(), now: local(2026, 10, 6) })).rejects.toThrow('migration bug')
    db = openDb(dbFile)
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined()
      expect((db.prepare("SELECT v FROM kv WHERE k = 'keep'").get() as { v: string }).v).toBe('1')
    } finally {
      db.close()
    }
  })
})

describe('REST and maintenance', () => {
  let t: TestServer
  let desktop: string
  beforeAll(async () => {
    t = await startTestServer()
    desktop = await t.login('desktop')
  })
  afterAll(() => t.close())

  it('POST /api/backup, GET /api/backups, POST /api/backups/restore (staged + toast)', async () => {
    const b = (await t.inject({ method: 'POST', url: '/api/backup', cookie: desktop })).json()
    expect(b.file).toMatch(/^vesper-\d{8}-\d{6}\.db$/)
    expect(b.bytes).toBeGreaterThan(0)
    const list = (await t.inject({ url: '/api/backups', cookie: desktop })).json()
    expect(list[0]).toMatchObject({ file: b.file, bytes: b.bytes })
    const ws = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie: desktop })
    await ws.hello()
    try {
      const r = await t.inject({ method: 'POST', url: '/api/backups/restore', cookie: desktop, payload: { file: b.file } })
      expect(r.statusCode).toBe(204)
      expect((await ws.next('toast')).text).toMatch(/next time Vesper starts/)
    } finally {
      ws.close()
    }
    expect(fs.existsSync(path.join(t.server.ctx.paths.roaming, 'vesper.db.restore'))).toBe(true)
    fs.rmSync(path.join(t.server.ctx.paths.roaming, 'vesper.db.restore'))
    expect((await t.inject({ method: 'POST', url: '/api/backups/restore', cookie: desktop, payload: { file: '..\\vesper.db' } })).statusCode).toBe(400)
    expect((await t.inject({ method: 'POST', url: '/api/backups/restore', cookie: desktop, payload: { file: 'vesper-19990101.db' } })).statusCode).toBe(404)
  })

  it('the maintenance tick makes the daily backup when today has none (a manual one counts)', async () => {
    const c = contentOf(t.server.ctx)
    await c.runMaintenance(true)
    expect(c.backups.list().some((b) => b.kind === 'daily')).toBe(false)
    coreOf(t.server.ctx).clockOffsetMs = DAY
    try {
      await c.runMaintenance(true)
      expect(c.backups.list()[0]).toMatchObject({ kind: 'daily', file: `vesper-${dayKey(t.server.ctx.clock.now())}.db` })
    } finally {
      coreOf(t.server.ctx).clockOffsetMs = 0
    }
  })
})

describe('restore across a restart (07 C20 swap + restart)', () => {
  it('a staged restore is applied by the next startServer on the same data dir', async () => {
    process.env.VESPER_TEST = '1'
    const dir = tempDir('vesper-restart-')
    const mk = () => startServer(createNodePlatform({ appDir: dir, version: '0.0.0-test', dataDir: path.join(dir, 'data') }), { port: 0, webDir: dir, workersDir: dir, devRendererUrl: null })
    const s1 = await mk()
    s1.ctx.repos.sessions.create({ title: 'Before backup', now: Date.now() })
    const c = contentOf(s1.ctx)
    const b = await c.backup('manual')
    s1.ctx.repos.sessions.create({ title: 'After backup', now: Date.now() })
    await c.backups.stageRestore(b.file)
    await s1.close()
    const s2 = await mk()
    try {
      const titles = s2.ctx.repos.sessions.list({ limit: 10 }).items.map((s) => s.title)
      expect(titles).toEqual(['Before backup'])
    } finally {
      await s2.close()
    }
  })
})
