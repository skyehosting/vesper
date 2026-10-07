/**
 * Temp directories for tests. Every directory made here is removed by `removeTempDirs()` and, as a safety net, when
 * the process exits (SQLite/WAL files may stay locked for a moment on Windows, hence the retries).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const made = new Set<string>()

export function tempDir(prefix = 'vesper-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.add(dir)
  return dir
}

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    /* still locked: left for the OS temp cleaner */
  }
  made.delete(dir)
}

export function removeTempDirs(): void {
  for (const d of [...made]) removeTempDir(d)
}

process.once('exit', removeTempDirs)
