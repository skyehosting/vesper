/**
 * Clean-shutdown marker for vesper.db (07 H12, phase 4c NEW-2). The full `PRAGMA quick_check` reads the whole database
 * file — messages, two FTS5 indexes, the vectors — which is GBs for a long-time user, so it can't run on every launch
 * (07: cold launch to latest messages within 1.5 s; the --background tray start). RunningServer.close() writes this
 * marker after the database is closed, and so does a Windows session end (markDatabaseAtRest: the process is killed
 * then); the next start takes it (reads and deletes it). The full check runs only when
 * there is no marker (a crash, a kill, a power cut, the first start of this build) or the marker does not describe
 * the file as it is now (size, modification time, a WAL left over). With a valid marker a cheap read-only open and
 * schema read still stops a file that is not a database.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../db/sqlite'
import type { Log } from '../services'

/** In the local data dir (%LOCALAPPDATA%\Vesper): it describes this PC's last run, not the roaming data. */
export const CLEAN_MARKER = 'db-clean.json'
/** The database file in the roaming data dir. */
export const DB_FILE = 'vesper.db'

interface Marker {
  v: 1
  size: number
  mtimeMs: number
  closedUtc: number
}

/** After the database was closed cleanly: remember exactly which file state that was. Best effort. */
export function writeCleanMarker(markerFile: string, dbFile: string, now: number, log?: Log): void {
  try {
    const st = fs.statSync(dbFile)
    const m: Marker = { v: 1, size: st.size, mtimeMs: st.mtimeMs, closedUtc: now }
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    fs.writeFileSync(markerFile, JSON.stringify(m))
  } catch (e) {
    log?.warn('could not write the clean-shutdown marker', { error: e })
  }
}

/**
 * At start, before the database is opened: true when the last run closed this exact file cleanly. The marker is
 * removed either way, so a run that does not reach close() leaves none and the next start checks in full.
 */
export function takeCleanMarker(markerFile: string, dbFile: string, log: Log): boolean {
  let text: string
  try {
    text = fs.readFileSync(markerFile, 'utf8')
  } catch {
    return false
  }
  try {
    fs.rmSync(markerFile, { force: true })
  } catch (e) {
    // It still describes the old size and time: the first write of this run makes it stale.
    log.warn('could not remove the clean-shutdown marker', { error: e })
  }
  try {
    const m = JSON.parse(text) as Partial<Marker>
    if (m.v !== 1 || typeof m.size !== 'number' || typeof m.mtimeMs !== 'number') return false
    const st = fs.statSync(dbFile)
    if (st.size !== m.size || st.mtimeMs !== m.mtimeMs) return false
    const wal = fs.statSync(`${dbFile}-wal`, { throwIfNoEntry: false })
    return !wal || wal.size === 0
  } catch {
    return false
  }
}

/**
 * Windows is ending the session (shutdown, restart, log off): the process is killed without close(), which used to
 * mean a full quick_check on the next cold launch after every reboot. Checkpoint the WAL into the main file and write
 * the marker now; any write after this changes the file's time (or leaves a WAL), which voids the marker, so a kill
 * right after costs nothing and a run that goes on is checked in full as usual. False when the checkpoint could not
 * complete (a reader in the way): no marker then.
 */
export function markDatabaseAtRest(ctx: { db: Db; paths: { roaming: string; local: string }; log: Log; clock: { now(): number } }): boolean {
  try {
    const r = ctx.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    if (Number(r?.busy ?? 1) !== 0) return false
    writeCleanMarker(path.join(ctx.paths.local, CLEAN_MARKER), path.join(ctx.paths.roaming, DB_FILE), ctx.clock.now(), ctx.log)
    return true
  } catch (e) {
    ctx.log.warn('could not checkpoint the database for the session end', { error: e })
    return false
  }
}
