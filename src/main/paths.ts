/**
 * Where Vesper keeps its files (07 E8). Roaming %APPDATA%\Vesper (Electron's userData for productName "Vesper"):
 * settings, secrets, DB, attachments, backups. Local %LOCALAPPDATA%\Vesper: models, logs and Chromium's session data
 * (caches do not belong in a roaming profile). Pure — unit-tested.
 */
import path from 'node:path'
import type { TestEnv } from './env'

export interface Dirs {
  /** Roaming data dir; becomes Electron's userData. */
  dataDir: string
  /** Local data dir (models/, logs/, chromium/). */
  localDir: string
  /** Chromium session data (cookies, caches, localStorage) — `app.setPath('sessionData', …)`. */
  sessionDataDir: string
  /** Chromium HTTP/GPU caches (--disk-cache-dir). */
  cacheDir: string
  logsDir: string
  modelsDir: string
}

export function resolveDirs(o: {
  /** Electron's default userData (%APPDATA%\Vesper). */
  defaultUserData: string
  /** %LOCALAPPDATA% (process.env.LOCALAPPDATA), or null to derive it from `home`. */
  localAppData: string | null
  home: string
  test: TestEnv | null
}): Dirs {
  const dataDir = path.resolve(o.test?.dataDir ?? o.defaultUserData)
  // A test with its own data dir but no local dir keeps everything under that temp dir, never in the real profile.
  const localDir = path.resolve(
    o.test?.localDir ?? (o.test?.dataDir ? path.join(dataDir, 'local') : path.join(o.localAppData ?? path.join(o.home, 'AppData', 'Local'), 'Vesper'))
  )
  return {
    dataDir,
    localDir,
    // Chromium's profile holds 'Local State' (the DPAPI-wrapped safeStorage key): keep it next to secrets.json in the
    // roaming dir, or deleting %LOCALAPPDATA% would make every saved key unreadable. Bulky caches go local
    // (disk-cache-dir switch in index.ts).
    sessionDataDir: dataDir,
    cacheDir: path.join(localDir, 'cache'),
    logsDir: path.join(localDir, 'logs'),
    modelsDir: path.join(localDir, 'models')
  }
}
