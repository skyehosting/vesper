/**
 * Temporary-chat files live in `%TEMP%\Vesper-<pid>` (07 B9): attachments of temporary chats, their upload staging and
 * Windows TTS audio. A clean quit removes the folder (RunningServer.close); a crash, a Task Manager kill or a Windows
 * shutdown (Electron emits no will-quit then) leaves it behind. So every start sweeps the folders of earlier runs
 * (07 H10, phase 4b F04/F18/F64): only `Vesper-<digits>` directories (never links), only Vesper's own (our marker
 * file inside, or — folders made before the marker existed — nothing but Vesper's own sub-folders), and only when
 * that pid is not running.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Log } from '../services'

/** Written into every temp folder at start: says the folder is Vesper's and which process made it. */
export const TEMP_MARKER = '.vesper-temp'
const NAME_RE = /^Vesper-(\d+)$/
/** What older Vesper builds put into the folder (before the marker existed). */
const LEGACY_ENTRIES = new Set(['attachments', 'tts'])

/** Is `pid` a running process? EPERM = it runs but belongs to someone else (alive, keep its folder). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The per-process temp folder name. */
export function tempDirName(pid: number): string {
  return `Vesper-${pid}`
}

/** Mark `dir` (already created) as this process' Vesper temp folder. Best effort. */
export function markTempDir(dir: string, pid: number, now: number): void {
  try {
    fs.writeFileSync(path.join(dir, TEMP_MARKER), `${JSON.stringify({ app: 'vesper', pid, startedUtc: now })}\n`, 'utf8')
  } catch {
    /* the sweep then treats it like a legacy folder */
  }
}

function isVespers(dir: string): boolean {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  if (entries.includes(TEMP_MARKER)) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, TEMP_MARKER), 'utf8')) as { app?: unknown }
      return m.app === 'vesper'
    } catch {
      // A torn marker (crash while writing it): the folder is still ours when nothing foreign is in it.
      return entries.every((e) => e === TEMP_MARKER || LEGACY_ENTRIES.has(e))
    }
  }
  return entries.every((e) => LEGACY_ENTRIES.has(e))
}

export interface SweepOptions {
  /** This process (its folder is never swept). */
  selfPid: number
  log: Log
  /** Tests: liveness check. */
  alive?: (pid: number) => boolean
}

/**
 * Remove stale `Vesper-<pid>` folders under `root` (os.tmpdir()). Returns the names removed. Never throws: a folder
 * that cannot be removed (a file still open) is logged and tried again at the next start.
 */
export function sweepStaleTempDirs(root: string, o: SweepOptions): string[] {
  const alive = o.alive ?? pidAlive
  const removed: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return removed
  }
  for (const name of names) {
    const m = NAME_RE.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === o.selfPid) continue
    const dir = path.join(root, name)
    try {
      // lstat: a link (symlink, junction) named like ours is never followed or removed.
      if (!fs.lstatSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (alive(pid)) continue
    if (!isVespers(dir)) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      removed.push(name)
    } catch (e) {
      o.log.warn('could not remove an old temporary folder', { folder: name, error: e })
    }
  }
  if (removed.length) o.log.info('removed temporary folders left by earlier runs', { count: removed.length })
  return removed
}
