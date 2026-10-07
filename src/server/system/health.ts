/**
 * What the owner must be told about on the PC side (07 C19/C20, phase 4b F59/F66) — one `SystemHealth` object in
 * Bootstrap.health, re-sent as `health.changed` whenever it changes:
 *   - settingsRecovered: settings.json could not be used as it was (settings/store.ts `recovery`);
 *   - lowDisk: free space on the data drive (roaming or local) is below 200 MB. Checked at start, every 15 minutes and
 *     before every daily backup. While it lasts: daily backups are skipped, memory backfill is paused
 *     (setBackgroundPaused('low-disk')), and one desktop notification says so. It clears above 300 MB (hysteresis).
 *   - lastBackupError: the last backup (daily or manual) failed — cleared by the next one that works. A failing daily
 *     backup is retried on every maintenance tick, so the event and the notification go out once per code and day.
 * Model downloads check free space themselves (models/manager.ts).
 */
import fs from 'node:fs/promises'
import type { SystemHealth } from '@shared/api'
import { VesperError, type ErrorCode } from '@shared/errors'
import { memoryOf } from '../memory/service'
import type { ServerContext } from '../services'
import type { SettingsStoreImpl } from '../settings/store'
import { dayKey } from '../data/backup'

export const LOW_DISK_BYTES = 200 * 1024 * 1024
/** Low disk ends only above this (no flapping around the threshold). */
export const LOW_DISK_CLEAR_BYTES = 300 * 1024 * 1024
const CHECK_EVERY_MS = 15 * 60_000

export interface HealthDeps {
  /** Free bytes on the drive of `dir` (null: unknown). */
  freeSpace?: (dir: string) => Promise<number | null>
  everyMs?: number
}

async function statfsFree(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** A backup error → the catalogue code and a plain sentence for Settings → Data. */
export function backupErrorInfo(e: unknown): { code: ErrorCode; message: string } {
  const err = e as { code?: unknown; errcode?: unknown; message?: unknown; info?: { code?: ErrorCode } } | null
  const text = typeof err?.message === 'string' ? err.message : ''
  const full = err?.code === 'ENOSPC' || err?.errcode === 13 || err?.info?.code === 'disk_full' || /disk is full|no space left/i.test(text)
  if (full) return { code: 'disk_full', message: "There isn't enough free space on the disk for a backup." }
  if (e instanceof VesperError && e.info.code === 'memory_unavailable') return { code: 'memory_unavailable', message: "The backup couldn't run because Vesper's database helper stopped. Restart Vesper." }
  return { code: e instanceof VesperError ? e.info.code : 'internal', message: "The backup couldn't be written. Details are in Vesper's log." }
}

export class HealthMonitor {
  private lowDisk: SystemHealth['lowDisk'] = null
  private backupError: SystemHealth['lastBackupError'] = null
  /** code + day of the last backup failure announced (event + notification once per code and day). */
  private announced: string | null = null
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<void> | null = null
  private closed = false
  private readonly freeSpace: (dir: string) => Promise<number | null>

  constructor(
    private readonly ctx: ServerContext,
    private readonly d: HealthDeps = {}
  ) {
    this.freeSpace = d.freeSpace ?? statfsFree
  }

  start(): void {
    if (this.timer || this.closed) return
    void this.checkDisk()
    this.timer = setInterval(() => void this.checkDisk(), this.d.everyMs ?? CHECK_EVERY_MS)
    this.timer.unref()
  }

  state(): SystemHealth {
    const recovery = (this.ctx.settings as Partial<SettingsStoreImpl>).recovery ?? null
    return {
      settingsRecovered: recovery ? { ...recovery, dropped: [...recovery.dropped] } : null,
      lowDisk: this.lowDisk ? { ...this.lowDisk } : null,
      lastBackupError: this.backupError ? { ...this.backupError } : null
    }
  }

  get isLowDisk(): boolean {
    return this.lowDisk !== null
  }

  private changed(): void {
    if (this.closed) return
    this.ctx.hub.broadcast({ t: 'health.changed', health: this.state() })
  }

  /** Look at free space now (also before every daily backup). */
  checkDisk(): Promise<void> {
    this.checking ??= (async () => {
      try {
        const p = this.ctx.paths
        const sizes = (await Promise.all([this.freeSpace(p.roaming), this.freeSpace(p.local)])).filter((n): n is number => typeof n === 'number')
        if (!sizes.length || this.closed) return
        const free = Math.min(...sizes)
        if (!this.lowDisk && free < LOW_DISK_BYTES) this.setLowDisk({ freeBytes: free, thresholdBytes: LOW_DISK_BYTES, sinceUtc: this.ctx.clock.now() })
        else if (this.lowDisk && free >= LOW_DISK_CLEAR_BYTES) this.setLowDisk(null)
        else if (this.lowDisk) {
          this.lowDisk.freeBytes = free
          // Idempotent: covers a memory service that started after the low disk was first seen.
          this.pauseBackground(true)
        }
      } catch (e) {
        this.ctx.log.warn('free-space check failed', { error: e })
      } finally {
        this.checking = null
      }
    })()
    return this.checking
  }

  private setLowDisk(next: SystemHealth['lowDisk']): void {
    const on = next !== null
    this.lowDisk = next
    this.ctx.log.warn(on ? 'low disk space: backups and memory backfill paused' : 'disk space recovered: backups and memory backfill resume', { freeBytes: next?.freeBytes })
    this.pauseBackground(on)
    if (on) this.ctx.platform.notify('Your disk is almost full', 'Vesper paused backups and memory indexing until there is more free space. Free up some space on this drive.')
    this.changed()
  }

  private pauseBackground(on: boolean): void {
    try {
      memoryOf(this.ctx).setBackgroundPaused('low-disk', on)
    } catch {
      /* no memory service in this context */
    }
  }

  /** A backup failed (daily: from the maintenance tick; manual: Back up now). */
  backupFailed(kind: 'daily' | 'manual', e: unknown): void {
    const { code, message } = backupErrorInfo(e)
    const atUtc = this.ctx.clock.now()
    this.backupError = { code, message, atUtc, kind }
    const key = `${code}:${dayKey(atUtc)}`
    if (key === this.announced) return
    this.announced = key
    if (kind === 'daily') this.ctx.platform.notify("Vesper's daily backup failed", message)
    this.changed()
  }

  backupSucceeded(): void {
    this.announced = null
    if (!this.backupError) return
    this.backupError = null
    this.changed()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
