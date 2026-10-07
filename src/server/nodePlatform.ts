/**
 * Platform for plain Node (the standalone server, browser e2e, unit tests). No electron import. Secrets are kept as
 * PLAINTEXT JSON only in test mode (test builds + VESPER_TEST=1); otherwise there is no secret store at all
 * (`available() === false`), so a key can never be written unencrypted by accident (BLD-3, 07 B10).
 */
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Platform, SecretStore, WorkerHandle } from './platform'
import { isTestMode, testEnv } from './testMode'

function plaintextTestSecrets(file: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const write = (o: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(o, null, 2))
  }
  return {
    list: async () => Object.keys(read()).sort(),
    get: async (name) => read()[name] ?? null,
    set: async (name, value) => write({ ...read(), [name]: value }),
    delete: async (name) => {
      const o = read()
      delete o[name]
      write(o)
    },
    available: () => true
  }
}

const NO_SECRETS: SecretStore = {
  list: async () => [],
  get: async () => null,
  set: async () => {
    throw new Error('No secret store without Electron')
  },
  delete: async () => undefined,
  available: () => false
}

export interface NodePlatformOptions {
  appDir: string
  version: string
  dataDir?: string
}

export function createNodePlatform(o: NodePlatformOptions): Platform {
  const test = isTestMode()
  const dataDir = o.dataDir ?? testEnv('VESPER_DATA_DIR') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-node-'))
  // VESPER_FAKE_NOW pins the clock's starting point; time still advances so ordering stays real.
  const fakeNow = Number(testEnv('VESPER_FAKE_NOW') ?? NaN)
  const t0 = Date.now()
  const now = Number.isFinite(fakeNow) ? () => fakeNow + (Date.now() - t0) : () => Date.now()

  // Local data: VESPER_LOCAL_DIR (tests), else <dataDir>\\local when a test data dir is set, else %LOCALAPPDATA%\\Vesper.
  const localDir =
    testEnv('VESPER_LOCAL_DIR') ??
    (testEnv('VESPER_DATA_DIR') || o.dataDir ? path.join(path.resolve(dataDir), 'local') : path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Vesper'))

  return {
    dataDir: path.resolve(dataDir),
    localDir: path.resolve(localDir),
    appDir: o.appDir,
    resourcesDir: path.resolve(o.appDir, '..', 'resources'),
    version: o.version,
    isPackaged: false,
    isTest: test,
    isDesktop: false,
    secrets: test ? plaintextTestSecrets(path.join(path.resolve(dataDir), 'secrets.test.json')) : NO_SECRETS,
    notify: () => undefined,
    openExternal: async () => undefined,
    // No `restart`: the standalone server is started by a script or the owner, who restarts it (a staged restore then
    // applies at that start, 07 C20). No `metrics`/`openPath`: there is no desktop.
    forkWorker(script, args, opts): WorkerHandle {
      const child = fork(script, args, {
        env: { ...process.env, ...opts.env },
        // Given execArgv replaces the inherited one (as in Electron); omitted keeps Node's default.
        ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      return {
        postMessage: (m) => void child.send(m as Parameters<typeof child.send>[0]),
        on(event: 'message' | 'exit', listener: (arg: never) => void) {
          if (event === 'message') child.on('message', listener as (m: unknown) => void)
          else child.on('exit', (code) => (listener as (c: number) => void)(code ?? 0))
        },
        kill: () => void child.kill(),
        get pid() {
          return child.pid
        }
      } as WorkerHandle
    },
    now
  }
}
