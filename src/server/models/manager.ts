/**
 * STT model manager (07 B12, D11 step 5): the pinned catalogue (src/shared/models.ts), resumable downloads, size +
 * SHA-256 verification BEFORE extraction, checked extraction, progress events, delete and disk usage.
 *
 * Layout under `<local>\models` (07 E8):
 *   <id>\                      the model's files (the archive's top directory, renamed)
 *   <id>\.vesper-model.json    install marker {id, sha256, installedUtc}; without it a folder is not "installed"
 *   .tmp\<id>-<n>.part         partial download (kept across restarts → resume)
 *   .tmp\<id>.staging\         extraction scratch (removed on success, failure and at startup)
 */
import fs from 'node:fs'
import path from 'node:path'
import { VesperError, type ApiError } from '@shared/errors'
import { MODEL_DOWNLOAD_HOSTS, type ModelEntry, type SttModelInfo } from '@shared/models'
import type { ServerMsg } from '@shared/ws'
import type { Log } from '../services'
import { extractChecked, systemTar, treeBytes, type TarRunner } from './archive'
import { downloadResumable, sha256File } from './download'

type Progress = Extract<ServerMsg, { t: 'stt.model.progress' }>

export interface ModelManagerOptions {
  dir: string
  catalogue: readonly ModelEntry[]
  log: Log
  emit(p: Progress): void
  /** Folders holding pre-extracted models by their archive directory name (VESPER_STT_MODEL_DIR, test builds). */
  externalDirs?: readonly string[]
  tar?: TarRunner
  fetchImpl?: typeof fetch
  /** Origins allowed over plain http (test builds: the mock GitHub server). */
  allowedOrigins?: readonly string[]
  /** Free bytes on the models volume (null = unknown). */
  freeBytes?(dir: string): number | null
  retryDelayMs?: number
  progressIntervalMs?: number
}

interface Job {
  state: 'downloading' | 'verifying' | 'extracting'
  bytes: number
  total: number
  ctrl: AbortController
  promise: Promise<void>
  lastEmit: number
}

interface Marker {
  id: string
  sha256: string
  installedUtc: number
}

const MARKER = '.vesper-model.json'
const ATTEMPTS = 3
/** Room kept free beyond the model itself (07 C19: < 200 MB → pause downloads). */
const DISK_MARGIN = 200 * 1024 * 1024

/** Free bytes on the volume of `dir` (or of its nearest existing parent: the models folder may not exist yet). */
export function defaultFreeBytes(dir: string): number | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try {
      const s = fs.statfsSync(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      if (path.dirname(d) === d) return null
    }
  }
}

export class ModelManager {
  private readonly jobs = new Map<string, Job>()
  private readonly errors = new Map<string, ApiError>()
  private readonly tmp: string
  private readonly tar: TarRunner

  constructor(private readonly o: ModelManagerOptions) {
    this.tmp = path.join(o.dir, '.tmp')
    this.tar = o.tar ?? systemTar
    // Leftover extraction scratch from a crash; .part files stay for resume. Nothing is created until a download.
    for (const n of this.tmpEntries()) if (n.endsWith('.staging')) fs.rmSync(path.join(this.tmp, n), { recursive: true, force: true })
  }

  get catalogue(): readonly ModelEntry[] {
    return this.o.catalogue
  }

  entry(id: string): ModelEntry | undefined {
    return this.o.catalogue.find((m) => m.id === id)
  }

  private installDir(id: string): string {
    return path.join(this.o.dir, id)
  }

  private marker(id: string): Marker | null {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.installDir(id), MARKER), 'utf8')) as Marker
      return m && m.id === id ? m : null
    } catch {
      return null
    }
  }

  /** Where the model's files are, or null when it is not installed (a catalogue digest change means "reinstall"). */
  resolve(id: string): { dir: string; external: boolean } | null {
    const e = this.entry(id)
    if (!e) return null
    const m = this.marker(id)
    if (m && m.sha256 === e.files.map((f) => f.sha256).join(',')) return { dir: this.installDir(id), external: false }
    for (const ext of this.o.externalDirs ?? []) {
      const d = path.join(ext, e.dir)
      if (fs.existsSync(d)) return { dir: d, external: true }
    }
    return null
  }

  list(activeId: string | null): SttModelInfo[] {
    return this.o.catalogue.map((e) => {
      const job = this.jobs.get(e.id)
      const at = this.resolve(e.id)
      const err = this.errors.get(e.id)
      const info: SttModelInfo = {
        id: e.id,
        label: e.label,
        description: e.description,
        languages: e.languages,
        downloadBytes: e.files.reduce((n, f) => n + f.size, 0),
        ramMB: e.ramMB,
        license: e.license,
        attribution: e.attribution,
        state: job ? job.state : at ? 'installed' : err ? 'error' : 'not-installed',
        active: e.id === activeId,
        ...(e.recommended ? { recommended: true } : {})
      }
      if (job) info.progress = { bytes: job.bytes, total: job.total }
      if (at && !at.external && !job) info.diskBytes = treeBytes(at.dir)
      if (!job && !at && err) info.error = err
      return info
    })
  }

  downloading(id: string): boolean {
    return this.jobs.has(id)
  }

  /** Download + verify + install. Joins a running job; resolves at once when installed. */
  download(id: string): Promise<void> {
    const e = this.entry(id)
    if (!e) return Promise.reject(new VesperError('not_found'))
    const running = this.jobs.get(id)
    if (running) return running.promise
    if (this.resolve(id) && !this.resolve(id)?.external) return Promise.resolve()
    const total = e.files.reduce((n, f) => n + f.size, 0)
    const job: Job = { state: 'downloading', bytes: 0, total, ctrl: new AbortController(), promise: Promise.resolve(), lastEmit: 0 }
    this.errors.delete(id)
    this.jobs.set(id, job)
    job.promise = this.run(e, job).then(
      () => {
        this.jobs.delete(id)
        this.emit(id, job, 'ready', true)
        this.o.log.info('model installed', { id })
      },
      (err: unknown) => {
        this.jobs.delete(id)
        const cancelled = job.ctrl.signal.aborted
        const api = err instanceof VesperError ? err.info : new VesperError('internal').info
        if (!cancelled) {
          this.errors.set(id, api)
          this.o.log.warn('model download failed', { id, code: api.code })
        }
        this.o.emit({ t: 'stt.model.progress', id, bytes: job.bytes, total: job.total, state: 'error', error: cancelled ? new VesperError('conflict', { message: 'Download cancelled.' }).info : api })
        throw err
      }
    )
    // The HTTP route does not await the job; failures are reported through progress events and list().
    job.promise.catch(() => undefined)
    return job.promise
  }

  /** Cancel a running download (the .part file is removed). False when nothing was running. */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job) return false
    job.ctrl.abort(new VesperError('conflict', { message: 'Download cancelled.' }))
    await job.promise.catch(() => undefined)
    this.removePartials(id)
    return true
  }

  /** Cancel and delete a model (installed files and partial downloads). */
  async remove(id: string): Promise<void> {
    if (!this.entry(id)) throw new VesperError('not_found')
    await this.cancel(id)
    this.removePartials(id)
    this.errors.delete(id)
    fs.rmSync(this.installDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  async close(): Promise<void> {
    const running = [...this.jobs.values()]
    for (const j of running) j.ctrl.abort(new VesperError('stt_unavailable'))
    await Promise.all(running.map((j) => j.promise.catch(() => undefined)))
  }

  private tmpEntries(): string[] {
    try {
      return fs.readdirSync(this.tmp)
    } catch {
      return []
    }
  }

  private removePartials(id: string): void {
    for (const n of this.tmpEntries()) if (n.startsWith(`${id}-`) && n.endsWith('.part')) fs.rmSync(path.join(this.tmp, n), { force: true })
    fs.rmSync(path.join(this.tmp, `${id}.staging`), { recursive: true, force: true })
  }

  private emit(id: string, job: Job, state: Progress['state'], force = false): void {
    const now = Date.now()
    if (!force && now - job.lastEmit < (this.o.progressIntervalMs ?? 250)) return
    job.lastEmit = now
    this.o.emit({ t: 'stt.model.progress', id, bytes: job.bytes, total: job.total, state })
  }

  private setState(id: string, job: Job, state: Job['state']): void {
    job.state = state
    this.emit(id, job, state, true)
  }

  private async run(e: ModelEntry, job: Job): Promise<void> {
    const signal = job.ctrl.signal
    const free = (this.o.freeBytes ?? defaultFreeBytes)(this.o.dir)
    if (free !== null && free < job.total + e.unpackedSize + DISK_MARGIN) throw new VesperError('disk_full', { status: 507 })
    fs.mkdirSync(this.tmp, { recursive: true })
    this.setState(e.id, job, 'downloading')
    const parts: string[] = []
    let before = 0
    for (const [i, f] of e.files.entries()) {
      const part = path.join(this.tmp, `${e.id}-${i}.part`)
      parts.push(part)
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadResumable({
            url: f.url,
            part,
            size: f.size,
            signal,
            allowedHosts: MODEL_DOWNLOAD_HOSTS,
            allowedOrigins: this.o.allowedOrigins,
            fetchImpl: this.o.fetchImpl,
            onProgress: (b) => {
              job.bytes = before + b
              this.emit(e.id, job, 'downloading')
            }
          })
          break
        } catch (err) {
          // Connection trouble resumes from the .part file; anything else (bad host, size) is final.
          if (signal.aborted || attempt >= ATTEMPTS || !(err instanceof VesperError && err.info.code === 'network')) throw err
          await sleep(this.o.retryDelayMs ?? 1000, signal)
        }
      }
      before += f.size
    }
    this.setState(e.id, job, 'verifying')
    for (const [i, f] of e.files.entries()) {
      const digest = await sha256File(parts[i], signal)
      if (digest !== f.sha256) {
        fs.rmSync(parts[i], { force: true })
        throw new VesperError('model_checksum', { status: 502 })
      }
    }
    this.setState(e.id, job, 'extracting')
    const staging = `${e.id}.staging`
    try {
      for (const [i, f] of e.files.entries()) {
        if (f.archive) {
          await extractChecked(this.tar, parts[i], staging, { topDir: e.dir, maxBytes: Math.ceil(e.unpackedSize * 1.25) + 1024 * 1024, maxEntries: 1000 })
        } else {
          const to = path.join(this.tmp, staging, e.dir, path.basename(new URL(f.url).pathname))
          fs.mkdirSync(path.dirname(to), { recursive: true })
          fs.copyFileSync(parts[i], to)
        }
        if (signal.aborted) throw signal.reason
      }
      const from = path.join(this.tmp, staging, e.dir)
      const marker: Marker = { id: e.id, sha256: e.files.map((x) => x.sha256).join(','), installedUtc: Date.now() }
      fs.writeFileSync(path.join(from, MARKER), JSON.stringify(marker))
      const dest = this.installDir(e.id)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(from, dest)
    } catch (err) {
      // An archive that failed the safety check is deleted, not kept for a retry.
      if (err instanceof VesperError && err.info.code === 'model_unsafe') for (const p of parts) fs.rmSync(p, { force: true })
      throw err
    } finally {
      fs.rmSync(path.join(this.tmp, staging), { recursive: true, force: true })
    }
    for (const p of parts) fs.rmSync(p, { force: true })
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
