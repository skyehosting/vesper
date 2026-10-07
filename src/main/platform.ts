/**
 * The Electron implementation of the server's Platform (src/server/platform.ts): paths, safeStorage secrets,
 * notifications, validated openExternal and utilityProcess workers. Create it after app `ready` (safeStorage and
 * utilityProcess need it).
 */
import { app, Notification, safeStorage, shell, utilityProcess } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppProcessMetric, Platform, WorkerHandle } from '@server/platform'
import { devWindowActive } from './devWindow'
import type { TestEnv } from './env'
import { createLog } from './log'
import { createFileSecretStore, type SecretCipher } from './secrets'
import { validateExternalUrl } from './urls'

const log = createLog('platform')

/**
 * Platform plus `localDir` (%LOCALAPPDATA%\Vesper: models, logs, Chromium data — 07 E8), requested as a Platform field
 * in docs/requests/main-desktop.md. `forkWorker` also accepts `execArgv` (e.g. `--max-old-space-size=512`, 07 B6).
 */
export interface DesktopPlatform extends Platform {
  localDir: string
  forkWorker(script: string, args: string[], opts: { name: string; env?: Record<string, string>; execArgv?: string[] }): WorkerHandle
  /** Called when the owner clicks a notification (the shell opens the window). */
  onNotificationClick(fn: () => void): void
}

const safeStorageCipher: SecretCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: (buf) => safeStorage.decryptStringAsync(buf)
}

/** Out of the box, notifications show on the primary display: not during tests or while the dev marker is set. */
function notificationsSuppressed(test: TestEnv | null): boolean {
  return !!test || devWindowActive()
}

function wrapUtility(child: Electron.UtilityProcess): WorkerHandle {
  return {
    postMessage: (message) => child.postMessage(message),
    on(event: 'message' | 'exit', listener: (arg: never) => void): void {
      if (event === 'message') child.on('message', listener as (m: unknown) => void)
      else child.on('exit', listener as (code: number) => void)
    },
    kill: () => {
      child.kill()
    },
    get pid() {
      return child.pid
    }
  } as WorkerHandle
}

export function createElectronPlatform(o: { dataDir: string; localDir: string; test: TestEnv | null }): DesktopPlatform {
  const appDir = path.resolve(__dirname, '..')
  // Unpackaged, this bundle is <repo>/out/main/index.js (app.getAppPath() would be out/main for `electron out/main/…`).
  const resourcesDir = app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.resolve(__dirname, '..', '..', 'resources')
  const clickHandlers = new Set<() => void>()
  /** Live notifications: Windows drops click handlers of garbage-collected Notification objects. */
  const live = new Set<Notification>()
  // VESPER_FAKE_NOW sets where the clock starts; it then runs at real speed, so timeouts and idle timers built on
  // now() still elapse while dates stay deterministic.
  const fakeNow = o.test?.fakeNow ?? null
  const fakeBase = Date.now()

  return {
    dataDir: o.dataDir,
    localDir: o.localDir,
    appDir,
    resourcesDir,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    isTest: !!o.test,
    isDesktop: true,
    secrets: createFileSecretStore(path.join(o.dataDir, 'secrets.json'), safeStorageCipher, (m) => log.warn(m)),

    notify(title, body) {
      if (__VESPER_TEST__ && notificationsSuppressed(o.test)) {
        process.stdout.write(`VESPER_NOTIFY ${JSON.stringify({ title, body })}\n`)
        return
      }
      if (!Notification.isSupported()) return
      const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), silent: false })
      live.add(n)
      const drop = (): void => void live.delete(n)
      n.on('click', () => {
        drop()
        for (const fn of clickHandlers) fn()
      })
      n.on('close', drop)
      n.on('failed', drop)
      n.show()
    },

    onNotificationClick(fn) {
      clickHandlers.add(fn)
    },

    async openExternal(url) {
      // The server already validates; check again here, where the URL meets the OS (07 B8).
      const safe = validateExternalUrl(url)
      if (!safe) {
        log.warn('openExternal refused a URL')
        return
      }
      await shell.openExternal(safe, { activate: true })
    },

    forkWorker(script, args, opts) {
      const file = path.isAbsolute(script) ? script : path.join(appDir, 'main', script)
      const child = utilityProcess.fork(file, args, {
        serviceName: `Vesper ${opts.name}`,
        env: { ...process.env, ...opts.env },
        // Electron throws "Invalid value for execArgv" on undefined; [] = no extra V8/Node flags.
        execArgv: opts.execArgv ?? [],
        stdio: 'inherit'
      })
      return wrapUtility(child)
    },

    now: () => (fakeNow != null ? fakeNow + (Date.now() - fakeBase) : Date.now()),

    restart() {
      // 07 C20: a staged restore is applied by the next start. Test runs never relaunch: the new instance would escape
      // the harness (Playwright tracks only this process), so they quit and print a marker instead.
      if (__VESPER_TEST__ && o.test) {
        process.stdout.write('VESPER_RESTART\n')
        app.quit()
        return
      }
      log.info('restarting')
      // A login-item launch keeps --background off the relaunch: the owner is looking at the window right now.
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--background') })
      app.quit()
    },

    metrics(): AppProcessMetric[] {
      return app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.serviceName ?? m.name ?? null,
        // Electron reports KB; privateBytes exists on Windows only.
        privateKB: typeof m.memory.privateBytes === 'number' ? m.memory.privateBytes : null,
        workingSetKB: m.memory.workingSetSize,
        cpuPercent: m.cpu.percentCPUUsage
      }))
    },

    async openPath(dir) {
      // Folders only (the server passes its own fixed set): shell.openPath on a file would RUN it.
      try {
        if (!fs.statSync(dir).isDirectory()) return 'not a folder'
      } catch {
        return 'missing'
      }
      return shell.openPath(dir)
    }
  }
}
