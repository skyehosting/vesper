/**
 * settings.json store (03 §2, 07 E1/E12). The shared zod schema is the only source of defaults and ranges; unknown
 * keys are dropped; an invalid file is salvaged leaf by leaf (a bad value falls back to its default instead of
 * resetting everything). Writes are atomic (temp file, fsync, rename) and serialized, so a crash leaves either the old
 * or the new file, never half of one; every write also refreshes settings.json.bak, the last saved copy.
 *
 * A file that can't be used as it is (07 C19, phase 4b F59) is never lost and never replaced silently: its exact bytes
 * are kept as `settings.json.bad-<YYYYMMDD-HHMMSS>` (the 5 newest are kept; an identical copy is not made twice), an
 * unreadable or unparsable file falls back to settings.json.bak, and only without one to defaults. A repaired or
 * restored file is written back at once, so the owner is told once, not on every start. `recovery` says
 * what happened; it reaches the owner through SystemHealth (Bootstrap.health → a toast and a Settings banner, and the
 * desktop opens Settings instead of re-running the wizard).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SettingsRecovery } from '@shared/api'
import { djson } from '@shared/djson'
import { VesperError } from '@shared/errors'
import { migrateLegacyStarStyle, migrateSettingsInput, settingsSchema, type DeepPartial, type Settings } from '@shared/settings'
import type { Log, SettingsPath, SettingsStore } from '../services'

export interface SettingsStoreImpl extends SettingsStore {
  /** Every successful change (after the file is written): the hub broadcasts `settings.changed` from here. */
  onChange(cb: (next: Settings, prev: Settings, by: string | undefined) => void): () => void
  /** Wait for pending writes. */
  flush(): Promise<void>
  /** How the file was recovered at load (null: it was fine or absent). */
  readonly recovery: SettingsRecovery | null
}

/** Copies of damaged settings files kept next to settings.json. */
export const KEEP_BAD_COPIES = 5
const BAD_RE = /^settings\.json\.bad-\d{8}-\d{6}(?:-\d+)?$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep merge for PATCH: objects merge, arrays and scalars replace, `undefined` is ignored. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
  const out: Obj = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

/** Value at a dotted path ('voice.tts'). */
export function getPath(obj: unknown, p: string): unknown {
  let cur: unknown = obj
  for (const k of p.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

function deleteAt(obj: Obj, keys: PropertyKey[]): boolean {
  let cur: unknown = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string | number
    if (Array.isArray(cur)) cur = cur[k as number]
    else if (isObj(cur)) cur = cur[k as string]
    else return false
  }
  const last = keys[keys.length - 1] as string | number
  if (Array.isArray(cur) && typeof last === 'number' && last < cur.length) {
    cur.splice(last, 1)
    return true
  }
  if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, last)) {
    delete cur[last as string]
    return true
  }
  return false
}

/** Parse untrusted file content into valid settings, dropping only the offending leaves. */
export function salvageSettings(raw: unknown): { settings: Settings; dropped: string[] } {
  // Retired keys of older files are rewritten first (voice.tts.tone → toneMode, H-v11-tone), never "dropped"; a 1.0
  // file that kept the 1.0 default style gets the 1.1 default (H-v11-presence) — checked before `tone` goes.
  let obj: Obj = isObj(raw) ? (JSON.parse(JSON.stringify(migrateSettingsInput(migrateLegacyStarStyle(raw)))) as Obj) : {}
  const dropped: string[] = []
  for (let i = 0; i < 200; i++) {
    const r = settingsSchema.safeParse(obj)
    if (r.success) return { settings: r.data, dropped }
    // One issue at a time: deleting a container can resolve (or move) the others.
    let keys = [...r.error.issues[0].path]
    // A leaf that is missing (required without default) cannot be deleted: drop its container instead.
    while (keys.length && !deleteAt(obj, keys)) keys = keys.slice(0, -1)
    if (!keys.length) obj = {}
    dropped.push(keys.join('.') || '(root)')
  }
  return { settings: settingsSchema.parse({}), dropped }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  // fsync before the rename: after a power cut the file is the old or the new one, never a torn or empty one.
  const fh = await fs.promises.open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  // Windows can briefly refuse the rename while another process (indexer, antivirus) has the file open.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file)
      return
    } catch (e) {
      if (attempt >= 5) {
        await fs.promises.rm(tmp, { force: true })
        throw e
      }
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
    }
  }
}

export function zodFields(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const i of issues) fields[i.path.map(String).join('.') || '(root)'] = i.message
  return fields
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local-time stamp like the backups' names: YYYYMMDD-HHMMSS. */
function stamp(utc: number): string {
  const d = new Date(utc)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** JSON text → a settings object, or null when it is not JSON or not an object (empty, truncated, `null`, `[]`). */
function parseObject(text: string): Obj | null {
  try {
    const v = JSON.parse(text) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Keep the exact bytes of a damaged settings file next to it; returns the copy's name (null when it can't be copied).
 * An identical newest copy is reused (a file that stays damaged across starts is kept once); old copies are pruned.
 */
async function keepDamaged(file: string, now: number, log: Log): Promise<string | null> {
  const dir = path.dirname(file)
  let bytes: Buffer
  try {
    bytes = await fs.promises.readFile(file)
  } catch (e) {
    log.warn('the damaged settings.json could not be read to keep a copy', { error: e })
    return null
  }
  const existing = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => BAD_RE.test(n)).sort()
  const newest = existing[existing.length - 1]
  if (newest) {
    const prev = await fs.promises.readFile(path.join(dir, newest)).catch(() => null)
    if (prev && prev.equals(bytes)) return newest
  }
  let name = `settings.json.bad-${stamp(now)}`
  for (let i = 2; existing.includes(name); i++) name = `settings.json.bad-${stamp(now)}-${i}`
  try {
    await fs.promises.writeFile(path.join(dir, name), bytes, { flag: 'wx' })
  } catch (e) {
    log.warn('could not keep a copy of the damaged settings.json', { error: e })
    return null
  }
  for (const old of [...existing, name].sort().slice(0, -KEEP_BAD_COPIES)) await fs.promises.rm(path.join(dir, old), { force: true }).catch(() => undefined)
  return name
}

export async function createSettingsStore(file: string, log: Log, o: { now?: () => number } = {}): Promise<SettingsStoreImpl> {
  const now = o.now ?? Date.now
  let current: Settings = settingsSchema.parse({})
  let recovery: SettingsRecovery | null = null
  /** Restored from settings.json.bak or repaired: written back right away, so the next start reads a good file. */
  let writeBack = false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text: string | null = null
  let missing = false
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing = true
    else log.warn('settings.json unreadable', { error: e })
  }
  if (!missing) {
    const raw = text === null ? null : parseObject(text)
    if (raw) {
      const { settings, dropped } = salvageSettings(raw)
      current = settings
      if (dropped.length) {
        log.warn('settings.json had invalid values; defaults used for them', { dropped })
        recovery = { kind: 'repaired', copy: await keepDamaged(file, now(), log), dropped, atUtc: now() }
        // Saved right away (the original bytes are in the copy): otherwise every start would repair — and report — again.
        writeBack = true
      }
    } else {
      // Not JSON, empty, truncated or unreadable: keep it, then use the last saved copy — defaults only without one.
      const copy = await keepDamaged(file, now(), log)
      const bak = parseObject(await fs.promises.readFile(`${file}.bak`, 'utf8').catch(() => ''))
      if (bak) {
        current = salvageSettings(bak).settings
        recovery = { kind: 'restored', copy, dropped: [], atUtc: now() }
        writeBack = true
        log.warn('settings.json could not be read; the last saved copy (settings.json.bak) is in use', { copy })
      } else {
        recovery = { kind: 'reset', copy, dropped: [], atUtc: now() }
        log.warn('settings.json could not be read and there is no saved copy; defaults are in use', { copy })
      }
    }
  }

  const subs = new Set<{ path: SettingsPath; cb: (next: Settings, prev: Settings) => void }>()
  const changeCbs = new Set<(next: Settings, prev: Settings, by: string | undefined) => void>()
  let chain: Promise<void> = Promise.resolve()

  /** settings.json, then settings.json.bak (the copy a damaged settings.json falls back to). */
  const save = async (next: Settings): Promise<void> => {
    const json = `${JSON.stringify(next, null, 2)}\n`
    await writeAtomic(file, json)
    await writeAtomic(`${file}.bak`, json).catch((e: unknown) => log.warn('could not refresh settings.json.bak', { error: e }))
  }
  if (writeBack) {
    const recovered = current
    chain = save(recovered).catch((e: unknown) => log.warn('could not write back the recovered settings', { error: e }))
  }

  const store: SettingsStoreImpl = {
    recovery,
    get: () => current,
    async patch(partial, opts) {
      const prev = current
      const r = settingsSchema.safeParse(deepMerge(prev, migrateSettingsInput(partial) as DeepPartial<Settings>))
      if (!r.success) throw new VesperError('validation', { fields: zodFields(r.error.issues) })
      const next = r.data
      current = next
      const write = chain.then(() => save(next))
      chain = write.catch(() => undefined)
      try {
        await write
      } catch (e) {
        if (current === next) current = prev
        log.error('settings write failed', { error: e })
        throw new VesperError('internal', { message: "Vesper couldn't save your settings." })
      }
      for (const s of subs) {
        if (djson(getPath(prev, s.path)) === djson(getPath(next, s.path))) continue
        try {
          s.cb(next, prev)
        } catch (e) {
          log.error('settings subscriber failed', { path: s.path, error: e })
        }
      }
      for (const cb of changeCbs) {
        try {
          cb(next, prev, opts?.by)
        } catch (e) {
          log.error('settings change listener failed', { error: e })
        }
      }
      return next
    },
    subscribe(p, cb) {
      const entry = { path: p, cb }
      subs.add(entry)
      return () => subs.delete(entry)
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    flush: () => chain
  }
  return store
}
