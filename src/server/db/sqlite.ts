/**
 * SQLite via Node's built-in `node:sqlite` (Electron 44: Node 24.21, SQLite 3.53.4, FTS5 compiled in; research 03).
 *
 * Gotcha (research 03 §1): node:sqlite binds every JS `number` as REAL. Ids that take part in comparisons
 * (rowid ranges, keyset paging) must be bound as BigInt or the FTS5 rowid-range optimisation silently disappears.
 * Use `id()` to convert.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type Db = DatabaseSync
export type Stmt = StatementSync

/** Bind an integer id/seq as INTEGER (BigInt). */
export function id(n: number | bigint): bigint {
  return typeof n === 'bigint' ? n : BigInt(Math.trunc(n))
}

/** Read an INTEGER column back as a JS number (node:sqlite returns numbers unless readBigInts is on). */
export function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number)
}

export interface OpenOptions {
  /** Read-only second connection (the memory worker opens its own read-write one). */
  readOnly?: boolean
  /**
   * How long one statement may wait (synchronously, inside SQLite's busy handler) for another connection's lock.
   * Default 5000 ms (db.worker: blocking its own thread is fine). The main connection uses MAIN_BUSY_TIMEOUT_MS.
   */
  busyTimeoutMs?: number
}

/**
 * 07 C9: the main thread never waits more than this for db.worker's write lock (the handler sleeps synchronously, so
 * a long wait would stall every request). Past it a statement fails with SQLITE_BUSY; the hot write paths (a turn's
 * user message + reply placeholder, the finished reply, the embed-queue insert) retry asynchronously (`retryBusy`),
 * everything else answers a retryable `db_error`. db.worker holds the lock ≤ 20 ms per slice; only its idle-time
 * TRUNCATE checkpoint can take longer.
 */
export const MAIN_BUSY_TIMEOUT_MS = 250

/** A lock held by another connection outlasted busy_timeout (SQLITE_BUSY / SQLITE_LOCKED). */
export function isBusy(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as { errcode?: unknown }).errcode
  // Primary result code in the low byte (extended codes such as SQLITE_BUSY_SNAPSHOT keep it).
  if (typeof code === 'number') return (code & 0xff) === 5 || (code & 0xff) === 6
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(e.message)
}

/**
 * Run a synchronous DB step, retrying it after an async pause while it fails with SQLITE_BUSY (07 C9 "async retry,
 * never spin"): the event loop keeps running between attempts. `fn` must be restartable — a single statement, or a
 * `tx()` (BEGIN IMMEDIATE takes the lock before any change, so a busy transaction has done nothing). Gives up after
 * `maxMs` and rethrows the last SQLITE_BUSY.
 */
export async function retryBusy<T>(fn: () => T, o: { maxMs?: number; onRetry?: (attempt: number) => void } = {}): Promise<T> {
  const deadline = Date.now() + (o.maxMs ?? 15_000)
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e
      o.onRetry?.(attempt)
      await sleep(Math.min(250, 10 * 2 ** Math.min(attempt, 5)))
    }
  }
}

export function openDb(file: string, opts: OpenOptions = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file, { readOnly: opts.readOnly ?? false })
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000))}`)
    if (!opts.readOnly) {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA foreign_keys = ON')
      // Deleted message text is overwritten on disk (temporary chats, "forget"); FTS uses its own secure-delete option.
      db.exec('PRAGMA secure_delete = ON')
      // 07 C9: no automatic checkpoints — one would run inside whichever COMMIT crossed the threshold, i.e. on the main
      // thread. db.worker checkpoints (idle / after bulk work / TRUNCATE > 64 MB / shutdown); data/checkpoint.ts asks it
      // to while it is not running.
      db.exec('PRAGMA wal_autocheckpoint = 0')
    }
  } catch (e) {
    // A damaged file fails here (SQLITE_NOTADB): never leave the handle open — Windows would keep the file locked for
    // a restore or a retry (F60).
    try {
      db.close()
    } catch {
      /* already closed */
    }
    throw e
  }
  return db
}

/** SQLITE_CORRUPT (11) or SQLITE_NOTADB (26), extended codes included: the file is damaged, not busy or missing. */
export function isCorruption(e: unknown): boolean {
  const code = Number((e as { errcode?: unknown } | null)?.errcode)
  if (Number.isFinite(code) && ((code & 0xff) === 11 || (code & 0xff) === 26)) return true
  const msg = e instanceof Error ? e.message : ''
  return /database disk image is malformed|file is not a database/i.test(msg)
}

/** SQLite's primary result code of an error from node:sqlite (`errcode & 0xff`), or null for anything else. */
export function sqlitePrimaryCode(e: unknown): number | null {
  const code = Number((e as { errcode?: unknown } | null)?.errcode)
  return Number.isFinite(code) ? code & 0xff : null
}

/** Out of disk space: SQLITE_FULL (13) or ENOSPC from the file system. */
export function isDiskFull(e: unknown): boolean {
  if (sqlitePrimaryCode(e) === 13) return true
  if ((e as { code?: unknown } | null)?.code === 'ENOSPC') return true
  return e instanceof Error && /SQLITE_FULL|database or disk is full|no space left on device/i.test(e.message)
}

/**
 * An error that comes from the PC rather than from the data or the code: I/O error, busy/locked, out of memory,
 * read-only file, can't open (SQLite 10, 5, 6, 7, 8, 14) or a file-system errno (EIO, EBUSY, EPERM…). Trying again later can work.
 */
export function isEnvironmentDbError(e: unknown): boolean {
  const c = sqlitePrimaryCode(e)
  if (c !== null) return [5, 6, 7, 8, 10, 14].includes(c)
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
}

/**
 * `PRAGMA quick_check` on a READ-ONLY connection of its own (07 C19, F60): a damaged file is inspected without
 * writing to it (no journal-mode change, no checkpoint on close). Null when it is fine (or does not exist yet),
 * otherwise what SQLite found. Errors other than corruption (locked, missing permissions) are thrown.
 *
 * `full: false` (07 H12, after a clean quit): only the header and the schema are read — it stops a file that is not a
 * database or whose schema is unreadable, in milliseconds whatever the size; quick_check reads every page.
 */
export function checkDatabaseFile(file: string, o: { full?: boolean } = {}): string | null {
  try {
    if (!fs.statSync(file).size) return null
  } catch {
    return null
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    if (o.full === false) {
      db.prepare('PRAGMA schema_version').get()
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
      return null
    }
    const rows = db.prepare('PRAGMA quick_check(5)').all() as { quick_check: string }[]
    const found = rows.map((r) => String(r.quick_check))
    return found.length === 1 && found[0] === 'ok' ? null : found.join('; ').slice(0, 500) || 'quick_check failed'
  } catch (e) {
    if (isCorruption(e)) return e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    try {
      db?.close()
    } catch {
      /* best effort */
    }
  }
}

/** Run `fn` in a transaction (BEGIN IMMEDIATE so writers queue on busy_timeout instead of failing mid-way). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw e
  }
}

export interface Migration {
  version: number
  name: string
  up: (db: Db) => void
}

/** Apply pending migrations in order; each runs in its own transaction and bumps PRAGMA user_version. */
export function migrate(db: Db, migrations: readonly Migration[]): number {
  const current = num((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  for (const m of pending) {
    tx(db, () => {
      m.up(db)
      db.exec(`PRAGMA user_version = ${m.version}`)
    })
  }
  return pending.length ? pending[pending.length - 1].version : current
}
