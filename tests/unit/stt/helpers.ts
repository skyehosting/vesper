/**
 * Helpers for the voice-in tests: a bundled copy of src/workers/stt.process.ts (so tests do not need
 * `electron-vite build`), forking it the way NodePlatform does, fixtures, frame helpers and a WER measure.
 *
 * The worker bundle lives in a temp dir; NODE_PATH points the child at this repo's node_modules so the external
 * native package (sherpa-onnx-node) resolves exactly as in the built app.
 */
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkerHandle } from '../../../src/server/platform'
import { decodeWav } from '../../../src/server/providers/stt/pcm'

export const REPO = path.resolve(__dirname, '..', '..', '..')
export const VAD_MODEL = path.join(REPO, 'resources', 'models', 'silero_vad.onnx')
export const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'audio')

let built: Promise<string> | null = null

/** Bundle the STT process once per test process (esbuild ships with Vite). */
export function buildSttWorker(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('esbuild')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-stt-worker-'))
    const outfile = path.join(dir, 'stt.process.js')
    await build({
      entryPoints: [path.join(REPO, 'src', 'workers', 'stt.process.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile,
      external: ['sherpa-onnx-node'],
      define: { __VESPER_TEST__: 'true' },
      alias: { '@server': path.join(REPO, 'src', 'server'), '@shared': path.join(REPO, 'src', 'shared') },
      logLevel: 'silent'
    })
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
    return outfile
  })()
  return built
}

export interface ForkedWorkers {
  fork(): WorkerHandle
  /** Every child started so far (pids) — leak tests assert they are all gone. */
  pids(): number[]
  alive(): number[]
  killAll(): void
}

export function workerForker(script: string, env: Record<string, string> = {}): ForkedWorkers {
  const children: import('node:child_process').ChildProcess[] = []
  return {
    fork() {
      const child = fork(script, [], {
        env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules'), ...env },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      children.push(child)
      return {
        postMessage: (m: unknown) => void child.send(m as Parameters<typeof child.send>[0]),
        on(event: 'message' | 'exit', listener: ((m: unknown) => void) | ((code: number) => void)) {
          if (event === 'message') child.on('message', listener as (m: unknown) => void)
          else child.on('exit', (code) => (listener as (c: number) => void)(code ?? 0))
        },
        kill: () => void child.kill(),
        get pid() {
          return child.pid
        }
      } as WorkerHandle
    },
    pids: () => children.map((c) => c.pid ?? -1),
    alive: () => children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => c.pid ?? -1),
    killAll() {
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
    }
  }
}

export function fixture(name: string): { pcm: Int16Array; text: string } {
  const { pcm, sampleRate } = decodeWav(fs.readFileSync(path.join(FIXTURES, `${name}.wav`)))
  if (sampleRate !== 16000) throw new Error(`${name}.wav is not 16 kHz`)
  return { pcm, text: fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8').trim() }
}

export function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * 16000))
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** 512-sample frames (32 ms), like the client's AudioWorklet. */
export function frames(pcm: Int16Array, size = 512): Int16Array[] {
  const out: Int16Array[] = []
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.slice(i, i + size))
  return out
}

/** Real models from the research phase (VESPER_STT_MODEL_DIR) and their audio (`<dir>/../audio`), when present. */
export function realModels(): { dir: string; audio: string } | null {
  const dir = process.env.VESPER_STT_MODEL_DIR
  if (!dir || !fs.existsSync(dir)) return null
  const audio = process.env.VESPER_STT_AUDIO_DIR ?? path.join(dir, '..', 'audio')
  return fs.existsSync(audio) ? { dir, audio } : null
}

function words(s: string): string[] {
  return s
    .replace(/\b7[:.]?45\b/g, 'seven forty five')
    .replace(/\b2\b/g, 'two')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Word error rate with research 05's number normalisation (7:45 = "seven forty five"). */
export function wer(ref: string, hyp: string): number {
  const r = words(ref)
  const h = words(hyp)
  const dp = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array<number>(h.length).fill(0)])
  for (let j = 1; j <= h.length; j++) dp[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  return r.length ? dp[r.length][h.length] / r.length : 0
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000, stepMs = 20): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v: T | undefined | null | false
      try {
        v = fn()
      } catch (e) {
        return reject(e)
      }
      if (v) return resolve(v)
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
