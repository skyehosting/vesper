import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** Read and parse a JSON file; `fallback` when it is missing or corrupt. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/**
 * Atomic write: a temp sibling renamed over the target, so a crash never leaves half a file. On Windows the rename can
 * fail briefly with EPERM/EBUSY while a virus scanner or indexer holds the target open — retried a few times.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`
  await fsp.writeFile(tmp, data, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
        continue
      }
      await fsp.rm(tmp, { force: true })
      throw e
    }
  }
}

export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(data, null, 2))
}
