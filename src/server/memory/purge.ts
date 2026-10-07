/**
 * The 07 B9 daily purge (F16), run by the idle maintenance tick before the day's backup (so the backup is already
 * clean): chats in the Trash for more than 30 days are hard-deleted with everything hanging off them, and messages
 * deleted more than 30 days ago lose their content (body, attachments, wire turns, vectors, injections, cached
 * recaps); records of them recalled into other chats' wire transcripts say "(deleted)" (engine/redact.ts). The job
 * ends with `wal_checkpoint(TRUNCATE)`; the tick then garbage-collects the attachments it freed, truncates the WAL
 * again (checkpointTruncate) and only then takes the day's backup (07 B9 order).
 * On db.worker (07 C9); on the main connection when no memory worker is available.
 */
import type { ServerContext } from '../services'
import { purgeRows } from './engine/jobs'
import type { JobSpec } from './engine/protocol'
import { Stmts } from './engine/sql'
import { memoryOf } from './service'

/** How long a deleted chat or message can be restored (the Trash and Forget texts say 30 days). */
export const RESTORE_WINDOW_MS = 30 * 24 * 3_600_000
const LAST_RUN_KV = 'memory.purge.lastDay'

const dayOf = (utc: number): string => new Date(utc).toISOString().slice(0, 10)

/** Purge what is past its 30 days, at most once per (UTC) day unless `force`. Returns what went. */
export async function runDailyPurge(ctx: ServerContext, o: { force?: boolean } = {}): Promise<{ ran: boolean; sessions: number; cleared: number }> {
  const now = ctx.clock.now()
  const today = dayOf(now)
  if (!o.force && ctx.repos.kv.get<string>(LAST_RUN_KV) === today) return { ran: false, sessions: 0, cleared: 0 }
  const cutoff = now - RESTORE_WINDOW_MS
  const gone = ctx.db.prepare('SELECT id, uid FROM sessions WHERE deleted_utc IS NOT NULL AND deleted_utc < ?').all(cutoff) as { id: number | bigint; uid: string }[]
  const spec: Extract<JobSpec, { kind: 'purge' }> = { kind: 'purge', sessionIds: gone.map((r) => Number(r.id)), deletedBeforeUtc: cutoff, clearDeletedBodies: true, nowUtc: now }
  let result: { sessions: number; cleared: number }
  try {
    const r = await memoryOf(ctx).runJob(spec)
    result = r.kind === 'purge' ? { sessions: r.sessions, cleared: r.cleared ?? 0 } : { sessions: 0, cleared: 0 }
  } catch (e) {
    // No worker (memory unavailable or its restart budget used up): the same job on the main connection, in
    // ≤ 500-row transactions with yields.
    ctx.log.child('memory').info('daily purge runs on the main thread', { error: e })
    const st = new Stmts(ctx.db)
    try {
      const r = await purgeRows(ctx.db, st, spec, () => undefined, () => undefined, () => undefined)
      result = { sessions: r.sessions, cleared: r.cleared }
      try {
        ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* readers active; the idle checkpoint catches up */
      }
    } finally {
      st.clear()
    }
  }
  for (const r of gone) {
    ctx.services.memory?.onSessionFlagsChanged(BigInt(r.id))
    ctx.hub.dropSession?.(r.uid)
  }
  if (gone.length) ctx.hub.broadcast({ t: 'sessions.changed' })
  ctx.repos.kv.set(LAST_RUN_KV, today)
  return { ran: true, ...result }
}

/**
 * `wal_checkpoint(TRUNCATE)` on db.worker (07 C9), else on the main connection: after the maintenance tick's GC, so
 * the pages that held freed attachment text leave the database file and the WAL before the day's backup (F16).
 */
export async function checkpointTruncate(ctx: ServerContext): Promise<void> {
  try {
    await memoryOf(ctx).runJob({ kind: 'checkpoint', mode: 'TRUNCATE' })
    return
  } catch {
    /* no worker: the main connection */
  }
  try {
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* readers active; the idle checkpoint catches up */
  }
}
