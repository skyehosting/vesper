/**
 * Plain-Node `Platform` for tests (src/server/platform.ts): secrets in memory, notifications and opened URLs recorded,
 * workers forked with node:child_process, and a controllable clock.
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import type { AppProcessMetric, Platform, SecretStore, WorkerHandle } from '../../src/server/platform'

export interface FakePlatformOptions {
  /** True to behave like the Electron host (desktop window exists). Default false. */
  isDesktop?: boolean
  /** Simulate DPAPI being unavailable (secrets cannot be saved). */
  secretsUnavailable?: boolean
  /** Fixed clock (ms). */
  now?: number
  appDir?: string
  resourcesDir?: string
  version?: string
  /** Provide `restart()` (like the Electron host). Default false (like the standalone server). */
  restartable?: boolean
  /** Provide `metrics()` with these rows (like the Electron host). */
  metrics?: AppProcessMetric[]
}

export interface FakePlatform extends Platform {
  readonly secretValues: Map<string, string>
  readonly notifications: Array<{ title: string; body: string }>
  readonly opened: string[]
  readonly workers: Array<{ script: string; args: string[]; name: string; execArgv?: string[]; handle: WorkerHandle }>
  /** `restart()` calls (07 C20 restore); only present with `{restartable: true}`. */
  readonly restarts: number
  /** Folders passed to `openPath` (desktop fakes only). */
  readonly openedPaths: string[]
  /** Fix the clock (null = real time). */
  setNow(ms: number | null): void
  /** Move a fixed clock forward (fixes it at the current time first if needed). */
  advance(ms: number): void
}

export function fakePlatform(dataDir: string, o: FakePlatformOptions = {}): FakePlatform {
  const values = new Map<string, string>()
  const secrets: SecretStore = {
    async list() {
      return [...values.keys()]
    },
    async get(name) {
      return values.get(name) ?? null
    },
    async set(name, value) {
      if (o.secretsUnavailable) throw new Error('fake platform: OS encryption unavailable')
      values.set(name, value)
    },
    async delete(name) {
      values.delete(name)
    },
    available: () => !o.secretsUnavailable
  }
  let fixed: number | null = o.now ?? null
  const notifications: Array<{ title: string; body: string }> = []
  const opened: string[] = []
  const workers: FakePlatform['workers'] = []
  const openedPaths: string[] = []
  let restarts = 0
  const p: FakePlatform = {
    dataDir,
    localDir: path.join(dataDir, 'local'),
    appDir: o.appDir ?? path.resolve('out'),
    resourcesDir: o.resourcesDir ?? path.resolve('resources'),
    version: o.version ?? '0.0.0-test',
    isPackaged: false,
    isTest: true,
    isDesktop: o.isDesktop ?? false,
    secrets,
    secretValues: values,
    notifications,
    opened,
    workers,
    notify(title, body) {
      notifications.push({ title, body })
    },
    async openExternal(url) {
      opened.push(url)
    },
    forkWorker(script, args, opts) {
      const child = fork(script, args, {
        env: { ...process.env, ...opts.env },
        ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      const handle: WorkerHandle = {
        postMessage: (m) => {
          child.send(m as Parameters<typeof child.send>[0])
        },
        on(event: 'message' | 'exit', listener: ((m: unknown) => void) | ((code: number) => void)) {
          if (event === 'message') child.on('message', listener as (m: unknown) => void)
          else child.on('exit', (code) => (listener as (c: number) => void)(code ?? 0))
        },
        kill: () => {
          child.kill()
        },
        get pid() {
          return child.pid
        }
      }
      workers.push({ script, args, name: opts.name, ...(opts.execArgv ? { execArgv: opts.execArgv } : {}), handle })
      return handle
    },
    now: () => fixed ?? Date.now(),
    setNow(ms) {
      fixed = ms
    },
    advance(ms) {
      fixed = (fixed ?? Date.now()) + ms
    },
    get restarts() {
      return restarts
    },
    openedPaths
  }
  if (o.restartable) p.restart = () => void restarts++
  if (o.metrics) {
    const rows = o.metrics
    p.metrics = () => rows.map((r) => ({ ...r }))
  }
  if (o.isDesktop) {
    p.openPath = async (dir) => {
      openedPaths.push(dir)
      return ''
    }
  }
  return p
}
