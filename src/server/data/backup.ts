/**
 * Backups (07 C20): `node:sqlite` backup() of the live database to `backups/` — daily at idle, before every
 * migration, before a restore, and on demand ("Back up now"). Secrets are never in the DB, so never in a backup.
 *
 * Names (local time of the PC): `vesper-YYYYMMDD.db` (daily), `vesper-YYYYMMDD-HHMMSS.db` (manual),
 * `vesper-YYYYMMDD-HHMMSS-pre-v<N>.db` (before migrating to version N), `vesper-YYYYMMDD-HHMMSS-pre-restore.db`.
 * Retention: the newest backup of each of the last `daily` days with one, plus the newest of each of the `weekly`
 * ISO weeks before those; the 3 newest pre-migration and pre-restore backups. The same rules apply to the optional
 * extra folder (Settings → data.backupExtraDir), which receives a copy of every daily/manual backup.
 *
 * Restore = swap + restart: the chosen backup is checked (quick_check, schema not newer than this app), copied to
 * `vesper.db.restore`, and applied by `applyPendingRestore()` at the next start, before the DB is opened; the current
 * files are kept in `backups/pre-restore-<stamp>/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { VesperError } from '@shared/errors'
import { checkDatabaseFile, isDiskFull, isEnvironmentDbError, migrate, num, type Db, type Migration } from '../db/sqlite'
import type { Log } from '../services'

export type BackupKind = 'daily' | 'manual' | 'premigrate' | 'prerestore'

export interface BackupInfo {
  file: string
  bytes: number
  createdUtc: number
  kind: BackupKind
}

const NAME_RE = /^vesper-(\d{8})(?:-(\d{6}))?(?:-(pre-v\d+|pre-restore))?\.db$/
const KEEP_PRE = 3
/**
 * Pre-migration copies kept when a migration writes a new one (F67): the new one and the one before. A migration that
 * fails on every start (each "Try again", each relaunch) used to add a full copy of the database every time.
 */
export const KEEP_PRE_MIGRATION = 2

/** A startup failure the desktop shell explains with its own dialog (src/main/startup.ts). */
export class StartupDbError extends Error {
  constructor(
    readonly code: 'DB_MIGRATION_FAILED' | 'DB_CORRUPT' | 'DB_DISK_FULL',
    message: string,
    readonly details: { dbFile: string; backupsDir: string; restored?: boolean; backups?: { file: string; createdUtc: number }[] },
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'StartupDbError'
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

export function dayKey(utc: number): string {
  const d = new Date(utc)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function timeKey(utc: number): string {
  const d = new Date(utc)
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Parse a backup file name; null for anything that is not ours (never touched by retention). */
export function parseBackupName(name: string): { day: string; createdUtc: number; kind: BackupKind } | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  const [, day, time, pre] = m
  const y = Number(day.slice(0, 4))
  const mo = Number(day.slice(4, 6))
  const d = Number(day.slice(6, 8))
  const t = time ?? '000000'
  const createdUtc = new Date(y, mo - 1, d, Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6))).getTime()
  if (!Number.isFinite(createdUtc)) return null
  const kind: BackupKind = pre === 'pre-restore' ? 'prerestore' : pre ? 'premigrate' : time ? 'manual' : 'daily'
  return { day, createdUtc, kind }
}

/** ISO week id "YYYY-Www" of a local calendar day "YYYYMMDD". */
export function isoWeek(day: string): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))))
  const dow = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${pad(week)}`
}

/** Which of `names` to delete under the retention rules. Pure (unit-tested with an injected clock via names). */
export function retentionVictims(names: readonly string[], keep: { daily: number; weekly: number }): string[] {
  const parsed = names.map((n) => ({ n, p: parseBackupName(n) })).filter((x): x is { n: string; p: NonNullable<ReturnType<typeof parseBackupName>> } => x.p !== null)
  const victims: string[] = []
  const regular = parsed.filter((x) => x.p.kind === 'daily' || x.p.kind === 'manual').sort((a, b) => b.p.createdUtc - a.p.createdUtc)
  const repByDay = new Map<string, string>()
  for (const x of regular) if (!repByDay.has(x.p.day)) repByDay.set(x.p.day, x.n)
  const days = [...repByDay.keys()].sort().reverse()
  const kept = new Set<string>()
  for (const day of days.slice(0, keep.daily)) kept.add(repByDay.get(day) as string)
  const weeksKept = new Set<string>()
  for (const day of days.slice(keep.daily)) {
    if (weeksKept.size >= keep.weekly) break
    const w = isoWeek(day)
    if (weeksKept.has(w)) continue
    weeksKept.add(w)
    kept.add(repByDay.get(day) as string)
  }
  for (const x of regular) if (!kept.has(x.n)) victims.push(x.n)
  for (const kind of ['premigrate', 'prerestore'] as const) {
    const list = parsed.filter((x) => x.p.kind === kind).sort((a, b) => b.p.createdUtc - a.p.createdUtc)
    for (const x of list.slice(KEEP_PRE)) victims.push(x.n)
  }
  return victims
}

/** Back up `db` to `file` atomically (`.part` then rename). */
export function backupTo(db: Db, file: string): Promise<number> {
  return backupWith(async (part) => void (await sqliteBackup(db, part)), file)
}

/** Write a backup through `copy` (to a `.part` file) and rename it into place; returns its size. */
export async function backupWith(copy: (part: string) => Promise<void>, file: string): Promise<number> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const part = `${file}.part`
  fs.rmSync(part, { force: true })
  try {
    await copy(part)
    fs.renameSync(part, file)
  } catch (e) {
    fs.rmSync(part, { force: true })
    throw e
  }
  return fs.statSync(file).size
}

export interface BackupManagerOptions {
  db: Db
  /** ctx.paths.backups */
  dir: string
  /** The live database file (vesper.db). */
  dbFile: string
  now(): number
  log: Log
  settings(): { daily: number; weekly: number; extraDir: string }
  /** Highest schema version this app knows (restores of newer backups are refused). */
  schemaVersion: number
  /** How to copy the live database to a file (db.worker's 'backup' job); default: node:sqlite backup() on `db`. */
  copy?: (file: string) => Promise<void>
}

export class BackupManager {
  constructor(private readonly o: BackupManagerOptions) {}

  /** Make a backup; a daily one is skipped (null) when today's exists already. */
  async create(kind: 'daily' | 'manual' | 'prerestore'): Promise<BackupInfo | null> {
    const now = this.o.now()
    const day = dayKey(now)
    const name = kind === 'daily' ? `vesper-${day}.db` : `vesper-${day}-${timeKey(now)}${kind === 'prerestore' ? '-pre-restore' : ''}.db`
    const file = path.join(this.o.dir, name)
    if (kind === 'daily' && fs.existsSync(file)) return null
    const bytes = this.o.copy ? await backupWith(this.o.copy, file) : await backupTo(this.o.db, file)
    this.o.log.info('backup written', { kind, file: name, bytes })
    const extra = this.o.settings().extraDir.trim()
    if (extra && kind !== 'prerestore') {
      try {
        fs.mkdirSync(extra, { recursive: true })
        fs.copyFileSync(file, path.join(extra, name))
      } catch (e) {
        this.o.log.warn('could not copy the backup to the extra folder', { error: e })
      }
    }
    this.prune()
    return { file: name, bytes, createdUtc: (parseBackupName(name) as { createdUtc: number }).createdUtc, kind }
  }

  list(): BackupInfo[] {
    const out: BackupInfo[] = []
    for (const name of safeReaddir(this.o.dir)) {
      const p = parseBackupName(name)
      if (!p) continue
      try {
        out.push({ file: name, bytes: fs.statSync(path.join(this.o.dir, name)).size, createdUtc: p.createdUtc, kind: p.kind })
      } catch {
        /* removed meanwhile */
      }
    }
    return out.sort((a, b) => b.createdUtc - a.createdUtc)
  }

  /** Apply retention in the backup dir and the extra folder. */
  prune(): string[] {
    const s = this.o.settings()
    const removed: string[] = []
    for (const dir of [this.o.dir, s.extraDir.trim()].filter(Boolean)) {
      for (const victim of retentionVictims(safeReaddir(dir), { daily: s.daily, weekly: s.weekly })) {
        try {
          fs.rmSync(path.join(dir, victim), { force: true })
          removed.push(victim)
        } catch (e) {
          this.o.log.warn('could not delete an old backup', { error: e })
        }
      }
    }
    return removed
  }

  /**
   * Check a backup and stage it for the next start. The current DB is backed up first (pre-restore), so a restore can
   * itself be undone.
   */
  async stageRestore(name: string): Promise<void> {
    if (!parseBackupName(name) || path.basename(name) !== name) throw new VesperError('validation', { fields: { file: 'Not a Vesper backup' } })
    const src = path.join(this.o.dir, name)
    if (!fs.existsSync(src)) throw new VesperError('not_found')
    const problem = checkBackupFile(src, this.o.schemaVersion)
    if (problem) throw new VesperError('validation', { message: problem })
    await this.create('prerestore')
    const staged = `${this.o.dbFile}.restore`
    fs.copyFileSync(src, `${staged}.part`)
    fs.renameSync(`${staged}.part`, staged)
    this.o.log.info('backup staged for restore', { file: name })
  }
}

/** A message for a backup that must not be restored, or null when it is fine. */
export function checkBackupFile(file: string, schemaVersion: number): string | null {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const ok = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check
    if (ok !== 'ok') return 'That backup is damaged.'
    const v = num((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (v > schemaVersion) return 'That backup was made by a newer version of Vesper.'
    if (v < 1) return "That file isn't a Vesper database."
    return null
  } catch {
    return 'That backup is damaged.'
  } finally {
    db?.close()
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * At startup, BEFORE the database is opened: swap in a staged restore. The current files move to
 * `backups/pre-restore-<stamp>/` (never deleted here). Returns true when a restore was applied.
 */
export function applyPendingRestore(dbFile: string, backupsDir: string, log: Log, now = Date.now()): boolean {
  const staged = `${dbFile}.restore`
  if (!fs.existsSync(staged)) return false
  const keepDir = path.join(backupsDir, `pre-restore-${dayKey(now)}-${timeKey(now)}`)
  fs.mkdirSync(keepDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbFile}${suffix}`
    if (fs.existsSync(f)) fs.renameSync(f, path.join(keepDir, path.basename(f)))
  }
  fs.renameSync(staged, dbFile)
  log.warn('restored the database from a backup', { previous: keepDir })
  return true
}

/**
 * Run pending migrations with a backup first (07 C20): skipped for a brand-new database. If a migration fails, the
 * pre-migration backup is copied back over the database and the error is rethrown (startup then fails cleanly with
 * the old data intact). The caller closes `db` on error.
 *
 * What the desktop is told depends on the cause (H12): a full disk is `DB_DISK_FULL` (free space, Try again); an
 * error from the PC (I/O, busy, locked…) is rethrown as it is (the generic dialog with Try again); only the rest is a
 * real migration failure, `DB_MIGRATION_FAILED` (this version can't open the data, Quit only).
 */
export async function migrateWithBackup(db: Db, o: { dbFile: string; backupsDir: string; migrations: readonly Migration[]; log: Log; now: number }): Promise<number> {
  const current = num((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const pending = o.migrations.filter((m) => m.version > current)
  if (!pending.length) return current
  let backupFile: string | null = null
  if (current > 0) {
    const target = Math.max(...pending.map((m) => m.version))
    backupFile = path.join(o.backupsDir, `vesper-${dayKey(o.now)}-${timeKey(o.now)}-pre-v${target}.db`)
    try {
      await backupTo(db, backupFile)
    } catch (e) {
      o.log.error('the pre-migration backup could not be written', { error: e })
      // Nothing has been changed yet: the database is exactly as it was.
      if (isDiskFull(e)) throw new StartupDbError('DB_DISK_FULL', e instanceof Error ? e.message : String(e), { dbFile: o.dbFile, backupsDir: o.backupsDir, restored: true }, { cause: e })
      throw e
    }
    o.log.info('pre-migration backup written', { file: path.basename(backupFile), from: current, to: target })
    // Never the copy just written (NEW-1): it is what a failed migration is undone from.
    prunePreMigration(o.backupsDir, o.log, path.basename(backupFile))
  }
  try {
    return migrate(db, o.migrations)
  } catch (e) {
    o.log.error('migration failed', { error: e })
    let restored = false
    if (backupFile) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      try {
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${o.dbFile}${suffix}`, { force: true })
        fs.copyFileSync(backupFile, o.dbFile)
        restored = true
        o.log.warn('database restored from the pre-migration backup', { file: path.basename(backupFile) })
      } catch (re) {
        // Each migration commits on its own: the file is consistent at the last version that went through.
        o.log.error('the pre-migration backup could not be put back', { error: re, file: path.basename(backupFile) })
      }
    }
    const details = { dbFile: o.dbFile, backupsDir: o.backupsDir, restored }
    const message = e instanceof Error ? e.message : String(e)
    if (isDiskFull(e)) throw new StartupDbError('DB_DISK_FULL', message, details, { cause: e })
    if (isEnvironmentDbError(e)) throw e
    // Deterministic: trying again can't help. The shell says so instead of offering "Try again" (F67).
    throw new StartupDbError('DB_MIGRATION_FAILED', message, details, { cause: e })
  }
}

/**
 * Keep the KEEP_PRE_MIGRATION newest pre-migration copies in `dir` (other backups are untouched). `keep` (the copy just
 * written) is never removed and counts as one of them, whatever the dates in the other names say: a clock that was
 * ahead (or is now behind) must not make the fresh copy look like the oldest.
 */
export function prunePreMigration(dir: string, log: Log, keep?: string): string[] {
  const pre = safeReaddir(dir)
    .map((n) => ({ n, p: parseBackupName(n) }))
    .filter((x) => x.p?.kind === 'premigrate' && x.n !== keep)
    .sort((a, b) => (b.p as { createdUtc: number }).createdUtc - (a.p as { createdUtc: number }).createdUtc || b.n.localeCompare(a.n))
  const keepOthers = keep && safeReaddir(dir).includes(keep) ? KEEP_PRE_MIGRATION - 1 : KEEP_PRE_MIGRATION
  const removed: string[] = []
  for (const x of pre.slice(Math.max(0, keepOthers))) {
    try {
      fs.rmSync(path.join(dir, x.n), { force: true })
      removed.push(x.n)
    } catch (e) {
      log.warn('could not delete an old pre-migration backup', { error: e })
    }
  }
  if (removed.length) log.info('old pre-migration backups removed', { count: removed.length })
  return removed
}

/**
 * The newest backups in `dir` that pass checkBackupFile (07 C19/C20, F60): restore candidates for a damaged database,
 * newest first. Checks at most `maxChecked` files (each check reads the whole file).
 */
export function usableBackups(dir: string, schemaVersion: number, o: { max?: number; maxChecked?: number } = {}): { file: string; createdUtc: number }[] {
  const all = safeReaddir(dir)
    .map((n) => ({ file: n, p: parseBackupName(n) }))
    .filter((x): x is { file: string; p: NonNullable<ReturnType<typeof parseBackupName>> } => x.p !== null)
    .sort((a, b) => b.p.createdUtc - a.p.createdUtc || b.file.localeCompare(a.file))
  const out: { file: string; createdUtc: number }[] = []
  for (const x of all.slice(0, o.maxChecked ?? 8)) {
    if (out.length >= (o.max ?? 3)) break
    if (!checkBackupFile(path.join(dir, x.file), schemaVersion)) out.push({ file: x.file, createdUtc: x.p.createdUtc })
  }
  return out
}

/**
 * At startup (07 C19, F60): check the database read-only before anything opens it for writing. A damaged file throws
 * a StartupDbError('DB_CORRUPT') listing the usable backups; nothing has been written to it. `full: false` (the last
 * run closed this file cleanly, 07 H12) reads only the header and schema instead of every page. Returns which ran.
 */
export function assertDatabaseUsable(dbFile: string, backupsDir: string, schemaVersion: number, log: Log, o: { full?: boolean } = {}): 'full' | 'quick' {
  const mode = o.full === false ? 'quick' : 'full'
  const t0 = performance.now()
  let problem: string | null
  try {
    problem = checkDatabaseFile(dbFile, { full: mode === 'full' })
  } catch (e) {
    log.warn('the database check could not run', { error: e })
    return mode
  }
  log.info('database checked', { mode, ms: Math.round(performance.now() - t0) })
  if (!problem) return mode
  log.error('the database is damaged', { problem })
  throw new StartupDbError('DB_CORRUPT', `Vesper's database is damaged (${problem}).`, {
    dbFile,
    backupsDir,
    backups: usableBackups(backupsDir, schemaVersion)
  })
}

/** What the owner chose for a damaged database. */
export type DamagedDbChoice = { kind: 'restore'; file: string } | { kind: 'fresh' }

/**
 * Act on the owner's choice for a damaged database (before the next start): the damaged files (vesper.db, -wal, -shm)
 * move to `backups/damaged-<stamp>/` — never deleted — and, for a restore, the chosen backup (checked again) is
 * copied in. Returns the folder that keeps the damaged files.
 */
export function recoverDamagedDatabase(dbFile: string, backupsDir: string, choice: DamagedDbChoice, o: { schemaVersion: number; log: Log; now?: number }): string {
  const now = o.now ?? Date.now()
  let src: string | null = null
  if (choice.kind === 'restore') {
    if (!parseBackupName(choice.file) || path.basename(choice.file) !== choice.file) throw new VesperError('validation', { fields: { file: 'Not a Vesper backup' } })
    src = path.join(backupsDir, choice.file)
    const problem = checkBackupFile(src, o.schemaVersion)
    if (problem) throw new VesperError('validation', { message: problem })
  }
  let keepDir = path.join(backupsDir, `damaged-${dayKey(now)}-${timeKey(now)}`)
  for (let i = 2; fs.existsSync(keepDir); i++) keepDir = path.join(backupsDir, `damaged-${dayKey(now)}-${timeKey(now)}-${i}`)
  fs.mkdirSync(keepDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbFile}${suffix}`
    if (fs.existsSync(f)) fs.renameSync(f, path.join(keepDir, path.basename(f)))
  }
  if (src) {
    fs.copyFileSync(src, `${dbFile}.part`)
    fs.renameSync(`${dbFile}.part`, dbFile)
    o.log.warn('damaged database replaced by a backup', { backup: choice.kind === 'restore' ? choice.file : null, kept: keepDir })
  } else {
    o.log.warn('damaged database moved aside; starting with an empty one', { kept: keepDir })
  }
  return keepDir
}
