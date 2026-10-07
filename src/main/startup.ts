/**
 * Starting the server with a way out when it cannot (07 C19: "bind failure → native dialog, never a blank window").
 * The server itself already tries port+1…+10; when it still fails, the owner chooses: start on any free port now, try
 * again, or quit. Pure orchestration with injected start/ask (tests/unit/main/startup.test.ts).
 */
import type { DialogSpec } from './dialogSpec'

export type StartupFailure = 'port' | 'migration' | 'db_corrupt' | 'disk_full' | 'other'

/**
 * A failure to bind the loopback port (busy or forbidden); a failed database migration (the server already put the
 * pre-migration copy back — retrying can't help, F67); a full disk (SQLITE_FULL / ENOSPC, anywhere in the start:
 * freeing space and trying again helps); or any other startup error.
 */
export function classifyStartupError(e: unknown): StartupFailure {
  if (e && typeof e === 'object') {
    const err = e as { code?: unknown; errcode?: unknown; syscall?: unknown; info?: { code?: unknown }; cause?: unknown }
    if (err.code === 'DB_MIGRATION_FAILED') return 'migration'
    if (err.code === 'DB_CORRUPT') return 'db_corrupt'
    if (err.code === 'DB_DISK_FULL' || err.code === 'ENOSPC' || (Number.isFinite(Number(err.errcode)) && (Number(err.errcode) & 0xff) === 13)) return 'disk_full'
    if (err.info?.code === 'disk_full') return 'disk_full'
    // EACCES from a file (it carries its syscall: open, copyfile…) is not a port problem.
    if (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL' || (err.code === 'EACCES' && (err.syscall === undefined || err.syscall === 'listen' || err.syscall === 'bind'))) return 'port'
    if (err.info?.code === 'port_unavailable') return 'port'
    if (err.cause && err.cause !== e) return classifyStartupError(err.cause)
  }
  return 'other'
}

/** What the owner chose for a damaged database (mirrors the server's DamagedDbChoice). */
export type DbRecoveryChoice = { kind: 'restore'; file: string } | { kind: 'fresh' }

interface CorruptDetails {
  backupsDir?: string
  backups?: { file: string; createdUtc: number }[]
}

function corruptDetails(e: unknown): Required<CorruptDetails> {
  const d = ((e as { details?: CorruptDetails } | null)?.details ?? {}) as CorruptDetails
  return { backupsDir: d.backupsDir ?? 'the backups folder', backups: Array.isArray(d.backups) ? d.backups : [] }
}

export const START_FRESH = 'Start fresh (keep the damaged file)'

/**
 * 07 C19 (F60): the database failed its start-up check. Restore the newest good backup, start with an empty
 * database, or quit — the damaged files are moved aside either way, never deleted.
 */
export function corruptDbDialog(e: unknown, logFile: string | null, formatDate: (utc: number) => string = (u) => new Date(u).toLocaleString()): { spec: DialogSpec; choices: (DbRecoveryChoice | null)[] } {
  const { backupsDir, backups } = corruptDetails(e)
  const newest = backups[0]
  const where = logFile ? `\n\nDetails are in ${logFile}.` : ''
  const restore = newest ? `Restore: your chats as they were on ${formatDate(newest.createdUtc)}; anything newer is lost. ` : 'There is no usable backup to restore. '
  const buttons = [...(newest ? [`Restore the backup from ${formatDate(newest.createdUtc)}`] : []), START_FRESH, 'Quit']
  const choices: (DbRecoveryChoice | null)[] = [...(newest ? [{ kind: 'restore' as const, file: newest.file }] : []), { kind: 'fresh' }, null]
  return {
    spec: {
      type: 'error',
      title: 'Vesper',
      message: "Vesper's database is damaged.",
      detail:
        'Vesper checks its database every time it starts, and this check found damage. Nothing has been changed yet.\n\n' +
        restore +
        'Start fresh: Vesper starts with no chats. Either way the damaged files are kept, moved to a "damaged-…" folder in ' +
        `${backupsDir} — nothing is deleted.\n\n${oneLine(e)}${where}`,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1
    },
    choices
  }
}

function oneLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/\s+/g, ' ').slice(0, 400)
}

export function startupDialog(kind: StartupFailure, e: unknown, logFile: string | null): DialogSpec {
  const where = logFile ? `\n\nDetails are in ${logFile}.` : ''
  if (kind === 'port') {
    return {
      type: 'warning',
      title: 'Vesper',
      message: "Vesper couldn't start: the network port it uses is busy.",
      detail:
        'Another program is using the port Vesper listens on. Choose another port to start Vesper on a free port now ' +
        `(you can pick a fixed one later in Settings → Access & security), or quit.\n\n${oneLine(e)}${where}`,
      buttons: ['Choose another port', 'Quit'],
      defaultId: 0,
      cancelId: 1
    }
  }
  if (kind === 'migration') {
    const restored = (e as { details?: { restored?: boolean } }).details?.restored !== false
    return {
      type: 'error',
      title: 'Vesper',
      message: "Vesper couldn't update its database.",
      detail:
        (restored ? 'Your chats are safe: the database was put back exactly as it was before this update. ' : '') +
        "This version of Vesper can't open it yet. Install the next update, or the version you used before, and start " +
        `Vesper again. Trying again now would fail the same way.\n\n${oneLine(e)}${where}`,
      buttons: ['Quit'],
      defaultId: 0,
      cancelId: 0
    }
  }
  if (kind === 'disk_full') {
    const d = (e as { details?: { restored?: boolean; dbFile?: string } }).details
    const drive = /^([A-Za-z]:)/.exec(d?.dbFile ?? '')?.[1]
    return {
      type: 'warning',
      title: 'Vesper',
      message: "Vesper couldn't start: the disk is full.",
      detail:
        (d?.restored ? 'Your chats are safe: nothing was lost. ' : '') +
        `Free up some space on ${drive ? `drive ${drive}` : "the drive that holds Vesper's data"} (empty the Recycle Bin, ` +
        `remove large files you don't need), then choose Try again.

${oneLine(e)}${where}`,
      buttons: ['Try again', 'Quit'],
      defaultId: 0,
      cancelId: 1
    }
  }
  return {
    type: 'error',
    title: 'Vesper',
    message: "Vesper couldn't start.",
    detail: `${oneLine(e)}${where}`,
    buttons: ['Try again', 'Quit'],
    defaultId: 0,
    cancelId: 1
  }
}

export const MAX_START_ATTEMPTS = 4

/**
 * Calls `start(port)` until it succeeds or the owner quits: `port` is undefined (the configured / test port) at first
 * and 0 (any free port) after "Choose another port". Resolves null when the owner chose Quit or attempts ran out.
 */
export async function startWithRecovery<T>(o: {
  start: (port: number | undefined) => Promise<T>
  ask: (spec: DialogSpec) => Promise<number>
  onError?: (e: unknown, kind: StartupFailure, attempt: number) => void
  logFile?: string | null
  /** Act on the owner's choice for a damaged database (move it aside, copy a backup in); throws when it can't. */
  recoverDb?: (e: unknown, choice: DbRecoveryChoice) => void
  formatDate?: (utc: number) => string
}): Promise<T | null> {
  let port: number | undefined
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      return await o.start(port)
    } catch (e) {
      const kind = classifyStartupError(e)
      o.onError?.(e, kind, attempt)
      if (kind === 'db_corrupt' && o.recoverDb) {
        const { spec, choices } = corruptDbDialog(e, o.logFile ?? null, o.formatDate)
        const choice = choices[await o.ask(spec)] ?? null
        if (!choice) return null
        try {
          o.recoverDb(e, choice)
        } catch (err) {
          o.onError?.(err, 'other', attempt)
          await o.ask({ ...startupDialog('other', err, o.logFile ?? null), message: "Vesper couldn't repair its database.", buttons: ['Quit'], defaultId: 0, cancelId: 0 })
          return null
        }
        // A repair does not use up a start attempt: the next start opens the restored (or new) database.
        attempt--
        continue
      }
      if (attempt === MAX_START_ATTEMPTS) {
        await o.ask({ ...startupDialog('other', e, o.logFile ?? null), buttons: ['Quit'], defaultId: 0, cancelId: 0 })
        return null
      }
      const spec = startupDialog(kind, e, o.logFile ?? null)
      const choice = await o.ask(spec)
      // A failed migration fails the same way every time (and each attempt used to write another full copy).
      if (choice === spec.cancelId || kind === 'migration') return null
      if (kind === 'port') port = 0
    }
  }
  return null
}
