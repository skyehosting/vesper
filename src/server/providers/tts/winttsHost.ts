/**
 * Client of the persistent Windows voice host (resources/wintts.ps1, spike S2 in 07 §F): one hidden
 * `powershell.exe -File wintts.ps1` speaking JSON lines over stdio. Started lazily on the first request, reused for
 * every later one, restarted after a crash (supervised: ≤ 3 starts per 5 minutes, 07 C19), stopped after 10 minutes
 * idle (07 D2) and on close — by closing its stdin (the script exits on EOF), then killing it if it lingers, so no
 * powershell.exe is ever orphaned. The process runner is injectable so tests can drive crashes without Windows.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { VesperError } from '@shared/errors'
import type { Log } from '../../services'
import { abortError } from './http'

export interface HostProcess {
  readonly pid?: number | undefined
  readonly stdin: { write(s: string): boolean; end(): void; on(ev: 'error', cb: (e: Error) => void): unknown }
  readonly stdout: NodeJS.EventEmitter & { setEncoding(e: BufferEncoding): unknown }
  readonly stderr: NodeJS.EventEmitter & { setEncoding(e: BufferEncoding): unknown }
  on(ev: 'exit', cb: (code: number | null) => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
  kill(): boolean
}

export type HostSpawn = (command: string, args: string[]) => HostProcess

export const defaultSpawn: HostSpawn = (command, args) =>
  nodeSpawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams

export interface WinVoice {
  id: string
  name: string
  language: string
  gender: string
}

export interface WordCue {
  text: string
  startMs: number
  durMs: number
  pos: number
  end: number
}

export interface HostOptions {
  script: string
  /** Where WAV files are written and read back (removed after each read). */
  tempDir: string
  log: Log
  spawn?: HostSpawn
  idleMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  maxStarts?: number
  startWindowMs?: number
  now?: () => number
}

interface Pending {
  resolve(v: Record<string, unknown>): void
  reject(e: unknown): void
  timer: NodeJS.Timeout
  /** WAV this request writes; deleted when the request is abandoned. */
  out?: string
  abandoned: boolean
  cleanup(): void
}

export class WinTtsHost {
  private child: HostProcess | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''
  private idleTimer: NodeJS.Timeout | null = null
  private starts: number[] = []
  private closing = false
  /** Exit promise per spawned process (removed when it exits). */
  private exits = new Map<HostProcess, Promise<void>>()
  /** Number of processes spawned (tests: "spawn once, reuse"). */
  spawned = 0
  private readonly o: Required<Omit<HostOptions, 'spawn' | 'now'>> & { spawn: HostSpawn; now: () => number }

  constructor(given: HostOptions) {
    // An option passed as `undefined` (createTtsProviders forwards `hostIdleMs` as is) keeps its default: spread, it
    // used to become setTimeout(undefined) — the host quit after every request (soak finding).
    const o = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as unknown as HostOptions
    this.o = {
      idleMs: 10 * 60_000,
      readyTimeoutMs: 15_000,
      requestTimeoutMs: 20_000,
      maxStarts: 3,
      startWindowMs: 5 * 60_000,
      ...o,
      spawn: o.spawn ?? defaultSpawn,
      now: o.now ?? Date.now
    }
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get running(): boolean {
    return this.child !== null
  }

  stats(): { running: boolean; pid: number | undefined; pending: number; spawned: number; idleTimer: boolean } {
    return { running: this.running, pid: this.pid, pending: this.pending.size, spawned: this.spawned, idleTimer: this.idleTimer !== null }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    if (this.closing) return Promise.reject(new VesperError('tts_failed'))
    const now = this.o.now()
    this.starts = this.starts.filter((t) => now - t < this.o.startWindowMs)
    if (this.starts.length >= this.o.maxStarts) return Promise.reject(new VesperError('tts_failed', { message: 'Windows voices keep failing; try again in a few minutes.' }))
    this.starts.push(now)
    let child: HostProcess
    try {
      child = this.o.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.o.script])
    } catch {
      return Promise.reject(new VesperError('tts_failed'))
    }
    this.spawned++
    this.child = child
    this.buf = ''
    let markExited!: () => void
    this.exits.set(
      child,
      new Promise<void>((r) => (markExited = r)).then(() => void this.exits.delete(child))
    )
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new VesperError('tts_failed', { message: 'Windows voices did not start in time.' }))
        this.kill(child)
      }, this.o.readyTimeoutMs)
      // id 0 is the host's ready line.
      this.pending.set(0, {
        resolve: () => {
          clearTimeout(t)
          resolve()
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        },
        timer: t,
        abandoned: false,
        cleanup: () => undefined
      })
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(child, d))
    child.stderr.on('data', (d: string) => this.o.log.debug('wintts stderr', { bytes: d.length }))
    // EPIPE after the host died must not become an unhandled stream error.
    child.stdin.on('error', (e) => this.o.log.debug('wintts stdin', { error: e.message }))
    child.on('error', (e) => {
      this.o.log.warn('wintts host failed to run', { error: e.message })
      this.onExit(child, null)
      markExited()
    })
    child.on('exit', (code) => {
      this.onExit(child, code)
      markExited()
    })
    this.ready = ready
    ready.catch(() => undefined)
    return ready
  }

  private onData(child: HostProcess, d: string): void {
    if (child !== this.child) return
    this.buf += d
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.o.log.warn('wintts host wrote a malformed line')
        continue
      }
      const id = typeof msg.id === 'number' ? msg.id : -1
      const p = this.pending.get(id)
      if (!p) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.cleanup()
      if (p.abandoned) {
        if (p.out) fs.rm(p.out, { force: true }, () => undefined)
        continue
      }
      if (msg.ok === true) p.resolve(msg)
      else p.reject(new VesperError('tts_failed'))
    }
    if (this.buf.length > 64 * 1024 * 1024) this.buf = '' // never grow without bound on a broken host
    if (this.pending.size === 0) this.armIdle()
  }

  private onExit(child: HostProcess, code: number | null): void {
    if (child !== this.child) return
    this.child = null
    this.ready = null
    this.buf = ''
    if (!this.closing && code !== null) this.o.log.warn('wintts host exited', { code })
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.cleanup()
      if (p.out) fs.rm(p.out, { force: true }, () => undefined)
      if (!p.abandoned) p.reject(new VesperError('tts_failed', { message: 'Windows voices stopped unexpectedly.' }))
    }
    this.pending.clear()
    this.clearIdle()
  }

  private armIdle(): void {
    this.clearIdle()
    if (!this.child || this.closing) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size === 0) void this.stop()
    }, this.o.idleMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private kill(child: HostProcess): void {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  async request(op: string, args: Record<string, unknown>, signal?: AbortSignal, out?: string): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw abortError()
    await this.start()
    const child = this.child
    if (!child) throw new VesperError('tts_failed')
    this.clearIdle()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(id)
        if (!p) return
        // The host cannot cancel a synthesis; its late answer is dropped (and its file removed) when it arrives.
        p.abandoned = true
        p.cleanup()
        reject(abortError())
      }
      const timer = setTimeout(() => {
        const p = this.pending.get(id)
        if (!p) return
        p.abandoned = true
        p.cleanup()
        reject(new VesperError('tts_failed', { message: 'Windows voices did not answer in time.' }))
        // A stuck host is replaced on the next request.
        this.kill(child)
      }, this.o.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer, out, abandoned: false, cleanup: () => signal?.removeEventListener('abort', onAbort) })
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  async voices(signal?: AbortSignal): Promise<WinVoice[]> {
    const r = await this.request('voices', {}, signal)
    const list: unknown[] = Array.isArray(r.voices) ? r.voices : r.voices && typeof r.voices === 'object' ? [r.voices] : []
    return list.flatMap((v) => {
      if (!v || typeof v !== 'object') return []
      const o = v as Record<string, unknown>
      return typeof o.name === 'string' ? [{ id: String(o.id ?? o.name), name: o.name, language: String(o.language ?? ''), gender: String(o.gender ?? '') }] : []
    })
  }

  async speak(a: { text: string; voice: string | null; rate: number; pitch: number; volume: number }, signal?: AbortSignal): Promise<{ wav: Uint8Array; words: WordCue[] }> {
    fs.mkdirSync(this.o.tempDir, { recursive: true })
    const out = path.join(this.o.tempDir, `wintts-${randomBytes(6).toString('hex')}.wav`)
    try {
      const r = await this.request('speak', { text: a.text, voice: a.voice ?? '', rate: a.rate, pitch: a.pitch, volume: a.volume, out }, signal, out)
      const wav = new Uint8Array(await fs.promises.readFile(out))
      const raw: unknown[] = Array.isArray(r.words) ? r.words : r.words && typeof r.words === 'object' ? [r.words] : []
      const words = raw.flatMap((w): WordCue[] => {
        const o = (w ?? {}) as Record<string, unknown>
        const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : NaN)
        const cue = { text: String(o.text ?? ''), startMs: n('startMs'), durMs: n('durMs'), pos: n('pos'), end: n('end') }
        return [cue.startMs, cue.durMs, cue.pos, cue.end].every(Number.isFinite) ? [cue] : []
      })
      return { wav, words }
    } finally {
      await fs.promises.rm(out, { force: true })
    }
  }

  /** End the host (stdin EOF; kill after 2 s). It is detached first, so a new request starts a fresh host. */
  private async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.onExit(child, null)
    // A host stopped on purpose (idle, game mode, "Unload voice models now", close) was healthy: its start does not
    // count against the crash budget (07 C19), or game mode's unloads would lock the Windows voice out for 5 minutes.
    this.starts = []
    try {
      child.stdin.end()
    } catch {
      /* closed */
    }
    const exited = this.exits.get(child) ?? Promise.resolve()
    let t: NodeJS.Timeout | null = null
    const timeout = new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), 2000)))
    if ((await Promise.race([exited.then(() => 'exited' as const), timeout])) === 'timeout') {
      this.kill(child)
      let t2: NodeJS.Timeout | null = null
      await Promise.race([exited, new Promise((r) => (t2 = setTimeout(r, 2000)))])
      if (t2) clearTimeout(t2)
    }
    if (t) clearTimeout(t)
  }

  /**
   * Exit the host now if it is idle ("Unload voice models now" and game mode, 07 D2/D3; added by platform-int). The
   * next request starts a fresh one. True when a host was stopped.
   */
  async release(): Promise<boolean> {
    if (!this.child || this.pending.size > 0) return false
    this.clearIdle()
    await this.stop()
    return true
  }

  async close(): Promise<void> {
    this.closing = true
    this.clearIdle()
    await this.stop()
  }
}
