/**
 * `auth.json` in %APPDATA%\Vesper (03 §2): `{version: 1, hash, setUtc}` with the scrypt string from password.ts.
 * Its existence is what the auth core reports as `passwordSet`. Writes are atomic (temp file + rename), so a crash
 * leaves the old or the new password, never a truncated file. An unreadable file still counts as "set" (no sign-in
 * works until the desktop resets it) — never as "no password", which would silently open remote modes.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Log } from '../services'

export interface PasswordStore {
  isSet(): boolean
  /** The stored hash, or null when unset or unreadable. */
  hash(): string | null
  write(hash: string, now: number): Promise<void>
}

export function createPasswordStore(dir: string, log: Log): PasswordStore {
  const file = path.join(dir, 'auth.json')
  // Cached after the first read; this process is the only writer.
  let cache: { hash: string | null } | null = null

  const load = (): { hash: string | null } => {
    if (cache) return cache
    let hash: string | null = null
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { hash?: unknown }
      if (typeof raw.hash === 'string') hash = raw.hash
      else log.warn('auth.json has no password hash')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('auth.json is unreadable', { error: String(e) })
    }
    cache = { hash }
    return cache
  }

  return {
    isSet: () => fs.existsSync(file),
    hash: () => load().hash,
    async write(hash, now) {
      const tmp = `${file}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, hash, setUtc: now }, null, 2), { mode: 0o600 })
      await fs.promises.rename(tmp, file)
      cache = { hash }
    }
  }
}
