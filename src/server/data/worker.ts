/**
 * Content's export and import inside db.worker (07 C9, platform-int): the same `runExport` / `runImport` the routes
 * always used, on the worker's own connection and repositories, so the main thread only receives the result. Called
 * by the memory Engine for the `export` / `import` job kinds (src/server/memory/engine/protocol.ts).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ImportResult } from '@shared/api'
import { createRepos } from '../db/repos/index'
import type { Db } from '../db/sqlite'
import type { ExportJobSpec, ImportJobSpec, JobCalls } from '../memory/engine/protocol'
import type { Log } from '../services'
import { runExport } from './export'
import { runImport } from './import'
import { createJobIO, type ExportOutput } from './jobs'

/** Sleep between work slices so the main connection gets the write lock in between (see createJobIO). */
const LOCK_GAP_MS = 4

export interface DataJobContext {
  signal: AbortSignal
  progress(phase: string, done: number, total: number | null): void
  call<K extends keyof JobCalls>(op: K, args: JobCalls[K]['args']): Promise<JobCalls[K]['result']>
  log: Log
}

/** A clock that starts at the server's time (test clocks included) and runs at real speed. */
function clockFrom(nowUtc: number): () => number {
  const t0 = Date.now()
  return () => nowUtc + (Date.now() - t0)
}

export async function runExportJob(db: Db, spec: ExportJobSpec, c: DataJobContext): Promise<ExportOutput> {
  const io = createJobIO({ signal: c.signal, onProgress: c.progress, pauseMs: LOCK_GAP_MS })
  return runExport(
    {
      db,
      repos: createRepos(db),
      now: clockFrom(spec.nowUtc),
      appVersion: spec.appVersion,
      names: spec.names,
      // Exports never contain temporary chats, so every attachment lives in the store (<root>/<sha[0:2]>/<sha>).
      attachmentPath: (sha) => {
        if (!/^[0-9a-f]{64}$/.test(sha)) return null
        const p = path.join(spec.attachmentsRoot, sha.slice(0, 2), sha)
        try {
          return fs.statSync(p).isFile() ? p : null
        } catch {
          return null
        }
      }
    },
    { format: spec.format, sessionUid: spec.sessionUid, dir: spec.dir },
    io
  )
}

export async function runImportJob(db: Db, spec: ImportJobSpec, c: DataJobContext): Promise<ImportResult> {
  const io = createJobIO({ signal: c.signal, onProgress: c.progress, pauseMs: LOCK_GAP_MS })
  fs.mkdirSync(spec.tempDir, { recursive: true })
  return runImport(
    {
      db,
      repos: createRepos(db),
      now: clockFrom(spec.nowUtc),
      log: c.log,
      zone: spec.zone,
      maxAttachmentBytes: spec.maxAttachmentBytes,
      tempPath: () => path.join(spec.tempDir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`),
      ingestFile: (f) => c.call('ingestFile', f)
    },
    { file: spec.file },
    io
  )
}
