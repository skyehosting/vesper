/**
 * WAL checkpoints off the main thread (07 C9, memory report gap; platform-int). Every Vesper connection runs with
 * `wal_autocheckpoint = 0` (db/sqlite.ts): an automatic checkpoint would run inside whichever COMMIT crossed the
 * threshold — on the main thread, blocking it for the copy. Instead:
 *   - db.worker checkpoints PASSIVE at idle and after bulk work, TRUNCATE when the WAL is over 64 MB and on shutdown;
 *   - this watcher covers the time the worker is not running (it starts lazily, 07 D2): it looks at the WAL file every
 *     minute and asks the worker (starting it if needed) for a PASSIVE checkpoint once the WAL has grown by 8 MB since
 *     the last one, or a TRUNCATE when it is over 64 MB and nobody is looking at Vesper.
 * PASSIVE never blocks writers; it leaves the file's size (SQLite reuses it from the start), hence "grown since".
 */
import fs from 'node:fs'
import type { Log } from '../services'

export const WAL_TRUNCATE_BYTES = 64 * 1024 * 1024
export const WAL_GROWTH_BYTES = 8 * 1024 * 1024
const EVERY_MS = 60_000

export interface WalWatchDeps {
  /** vesper.db (the WAL is `${dbFile}-wal`). */
  dbFile: string
  log: Log
  /** Run db.worker's checkpoint job. */
  checkpoint(mode: 'PASSIVE' | 'TRUNCATE'): Promise<void>
  /** Nobody is looking at Vesper (no visible + focused client). */
  idle(): boolean
  everyMs?: number
  /** Tests: WAL size. */
  walSize?: () => number
}

export class WalWatch {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  /** WAL size right after the last checkpoint we asked for. */
  private base = 0
  checkpoints: Array<'PASSIVE' | 'TRUNCATE'> = []

  constructor(private readonly d: WalWatchDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.d.everyMs ?? EVERY_MS)
    this.timer.unref()
  }

  private size(): number {
    if (this.d.walSize) return this.d.walSize()
    try {
      return fs.statSync(`${this.d.dbFile}-wal`).size
    } catch {
      return 0
    }
  }

  /** One look at the WAL (also called by tests). */
  check(): Promise<void> {
    if (this.running) return this.running
    // Assigned below; read only after the first await.
    let run!: Promise<void>
    run = (async () => {
      // Never settle synchronously: the `finally` below must run after `this.running` is set.
      await Promise.resolve()
      try {
        const size = this.size()
        // The file shrank (TRUNCATE by the worker, or a restart): measure growth from here.
        if (size < this.base) this.base = size
        let mode: 'PASSIVE' | 'TRUNCATE' | null = null
        if (size > WAL_TRUNCATE_BYTES && this.d.idle()) mode = 'TRUNCATE'
        else if (size - this.base >= WAL_GROWTH_BYTES) mode = 'PASSIVE'
        if (!mode) return
        await this.d.checkpoint(mode)
        this.checkpoints.push(mode)
        if (this.checkpoints.length > 20) this.checkpoints.shift()
        this.base = this.size()
      } catch (e) {
        this.d.log.warn('WAL checkpoint failed', { error: e })
      } finally {
        if (this.running === run) this.running = null
      }
    })()
    this.running = run
    return run
  }

  get active(): boolean {
    return this.timer !== null
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running?.catch(() => undefined)
  }
}
