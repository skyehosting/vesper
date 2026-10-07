/**
 * Disk use of Vesper's data for Settings → Data (GET /api/data/usage — memory-ui, Phase 3). Sizes come from walking
 * the data folders asynchronously (never blocking the event loop for long) and are cached for a few seconds so a page
 * that re-renders doesn't walk the attachment store again. Read-only: nothing here touches the database connection.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DataUsage } from '@shared/types/domain'

export interface UsagePaths {
  roaming: string
  local: string
  attachments: string
  models: string
  logs: string
  backups: string
  exports: string
}

const CACHE_MS = 5_000
/** Directory walks stop after this many entries (a sane upper bound; the number is then a lower bound). */
const MAX_ENTRIES = 500_000

async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

/** Total bytes and file count under `dir` (missing dir = 0). Symlinks are not followed. */
export async function dirSize(dir: string, filter?: (name: string) => boolean): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  let seen = 0
  const stack = [dir]
  while (stack.length && seen < MAX_ENTRIES) {
    const d = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      seen++
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && (!filter || filter(e.name))) {
        bytes += await fileSize(p)
        files++
      }
    }
  }
  return { bytes, files }
}

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export function createUsageReader(paths: UsagePaths, dbFile: string): () => Promise<DataUsage> {
  let cached: { at: number; value: Promise<DataUsage> } | null = null
  const read = async (): Promise<DataUsage> => {
    const [database, wal, attachments, backups, exportsDir, models, logs, freeDisk] = await Promise.all([
      fileSize(dbFile),
      fileSize(`${dbFile}-wal`),
      // Thumbnails and the tmp/ staging dir are part of the store's footprint too.
      dirSize(paths.attachments),
      dirSize(paths.backups, (n) => n.endsWith('.db')),
      dirSize(paths.exports),
      dirSize(paths.models),
      dirSize(paths.logs),
      freeSpace(path.dirname(dbFile))
    ])
    return {
      database,
      wal,
      attachments: attachments.bytes,
      attachmentCount: attachments.files,
      backups: backups.bytes,
      backupCount: backups.files,
      exports: exportsDir.bytes,
      models: models.bytes,
      logs: logs.bytes,
      freeDisk
    }
  }
  return () => {
    const now = Date.now()
    if (!cached || now - cached.at > CACHE_MS) {
      const value = read()
      cached = { at: now, value }
      // A failed walk must not be served from the cache.
      value.catch(() => {
        if (cached?.value === value) cached = null
      })
    }
    return cached.value
  }
}
