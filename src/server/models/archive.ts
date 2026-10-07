/**
 * Safe extraction of model archives (07 B12). Decision: Windows' own bsdtar (%SystemRoot%\System32\tar.exe, 3.8.8 with
 * bz2lib, research 05 §3.12) does the work — the npm `tar` package reads gzip/brotli/zstd but not bzip2, and every
 * sherpa model is a .tar.bz2. The runner is injectable so tests never depend on a real archive tool.
 *
 * Before anything is written the LISTING is checked: regular files and directories only (no symlinks, hard links,
 * devices), no absolute paths, drive letters, `..` segments, backslashes or `:` (alternate data streams), everything
 * under the expected top directory, an entry-count cap and a total-size cap. bsdtar itself also refuses `..` and
 * absolute paths without -P (defence in depth). After extraction (into a staging dir next to the target) the tree is
 * walked again: no links/junctions, sizes within the cap. Only then is the directory renamed into place.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { VesperError } from '@shared/errors'

export interface TarRunner {
  run(args: string[], o: { cwd: string; timeoutMs: number }): Promise<string>
}

export function systemTarPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

export const systemTar: TarRunner = {
  run(args, o) {
    return new Promise((resolve, reject) => {
      execFile(systemTarPath(), args, { cwd: o.cwd, timeout: o.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
  }
}

export interface ArchiveEntry {
  name: string
  /** First character of the `-tv` mode column: '-' file, 'd' dir, 'l' symlink, 'h' hard link, … */
  type: string
  size: number
}

const VERBOSE = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/

/** The archive's entries (names from `-tf`, types and sizes from `-tvf`, same order). */
export async function listArchive(tar: TarRunner, file: string): Promise<ArchiveEntry[]> {
  const o = { cwd: path.dirname(file), timeoutMs: 10 * 60_000 }
  const base = path.basename(file)
  const names = (await tar.run(['-tf', base], o)).split(/\r?\n/).filter((l) => l.length > 0)
  const verbose = (await tar.run(['-tvf', base], o)).split(/\r?\n/).filter((l) => l.length > 0)
  if (names.length !== verbose.length) throw new VesperError('model_unsafe', { status: 422 })
  return names.map((name, i) => {
    const m = VERBOSE.exec(verbose[i])
    if (!m) throw new VesperError('model_unsafe', { status: 422 })
    return { name, type: m[1], size: Number(m[2]) }
  })
}

export interface ListingLimits {
  /** Every entry must be this directory or inside it. */
  topDir: string
  maxBytes: number
  maxEntries: number
}

/** Why an entry is refused, or null. Exported for tests. */
export function entryProblem(e: ArchiveEntry, topDir: string): string | null {
  if (e.type !== '-' && e.type !== 'd') return 'not a regular file or directory'
  const n = e.name
  if (!n || n.includes('\0') || n.includes('\\')) return 'bad characters'
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return 'absolute path'
  const parts = n.replace(/^\.\//, '').split('/').filter((p, i, a) => p !== '' || i < a.length - 1)
  if (parts.some((p) => p === '..' || p === '.' || p.includes(':'))) return 'path escapes the model directory'
  if (parts[0] !== topDir) return 'outside the model directory'
  return null
}

export function checkListing(entries: ArchiveEntry[], l: ListingLimits): void {
  if (!entries.length || entries.length > l.maxEntries) throw new VesperError('model_unsafe', { status: 422 })
  let total = 0
  for (const e of entries) {
    if (entryProblem(e, l.topDir)) throw new VesperError('model_unsafe', { status: 422 })
    total += e.size
    if (total > l.maxBytes) throw new VesperError('model_unsafe', { status: 422 })
  }
}

/** Walk an extracted tree: no links of any kind, total size within the cap. Returns the byte total. */
export function checkTree(dir: string, maxBytes: number): number {
  let total = 0
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) throw new VesperError('model_unsafe', { status: 422 })
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) {
        total += st.size
        if (total > maxBytes) throw new VesperError('model_unsafe', { status: 422 })
      } else throw new VesperError('model_unsafe', { status: 422 })
    }
  }
  walk(dir)
  return total
}

/** Bytes used by a directory tree (0 when absent). */
export function treeBytes(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of list) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          /* vanished */
        }
      }
    }
  }
  walk(dir)
  return total
}

/** Check the listing, extract into `stagingDir` (relative to the archive's folder) and check the result. */
export async function extractChecked(tar: TarRunner, file: string, stagingDir: string, l: ListingLimits): Promise<string> {
  checkListing(await listArchive(tar, file), l)
  const cwd = path.dirname(file)
  fs.rmSync(path.join(cwd, stagingDir), { recursive: true, force: true })
  fs.mkdirSync(path.join(cwd, stagingDir), { recursive: true })
  await tar.run(['-xf', path.basename(file), '-C', stagingDir], { cwd, timeoutMs: 30 * 60_000 })
  const root = path.join(cwd, stagingDir)
  checkTree(root, l.maxBytes)
  const top = path.join(root, l.topDir)
  if (!fs.existsSync(top) || !fs.lstatSync(top).isDirectory()) throw new VesperError('model_unsafe', { status: 422 })
  return top
}
