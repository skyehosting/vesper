/**
 * What the server needs from its host. The Electron main process provides the real implementation
 * (src/main/platform.ts: safeStorage secrets, %APPDATA%\Vesper, notifications); tests and the standalone server
 * (src/server/standalone.ts) provide plain-Node ones. The server never imports `electron`.
 */
export interface SecretStore {
  /** Names of secrets that are set (values never leave the main process). */
  list(): Promise<string[]>
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  /** False when OS encryption is unavailable (then secrets cannot be saved). */
  available(): boolean
}

export interface Platform {
  /** Data directory: %APPDATA%\Vesper (or VESPER_DATA_DIR in tests). */
  dataDir: string
  /** Local (non-roaming) data dir: %LOCALAPPDATA%\Vesper — models/, logs/, caches (07 E8). VESPER_LOCAL_DIR in tests. */
  localDir: string
  /** Directory of the built app files (out/), used to find web assets, workers and the protocols default. */
  appDir: string
  /** Directory of bundled resources (resources/: wintts.ps1, icons). */
  resourcesDir: string
  version: string
  isPackaged: boolean
  isTest: boolean
  /** True when a desktop window exists (Electron); false for the standalone server. */
  isDesktop: boolean
  secrets: SecretStore
  /** Show a desktop notification (no-op without Electron). */
  notify(title: string, body: string): void
  /** Open a URL in the user's browser (desktop only). */
  openExternal(url: string): Promise<void>
  /** Spawn a utility process (Electron utilityProcess) or a Node child process (standalone) for a worker script. */
  forkWorker(script: string, args: string[], opts: { name: string; env?: Record<string, string>; execArgv?: string[] }): WorkerHandle
  /** Current time (VESPER_FAKE_NOW in tests). */
  now(): number
  /**
   * Restart the whole app (Electron: app.relaunch() + quit), e.g. to finish restoring a backup (07 C20). Optional:
   * absent for the standalone server, where the owner restarts it.
   */
  restart?(): void
  /**
   * Per-process memory/CPU of the whole app (Electron: `app.getAppMetrics()`), for Settings → Resource use (07 D2).
   * Optional: absent for the standalone server, which reports only its own process.
   */
  metrics?(): AppProcessMetric[]
  /**
   * Open a local folder in Explorer (desktop only: `shell.openPath`). The server only ever passes one of its own fixed
   * folders (POST /api/system/open-folder), never a path from a client. Resolves to an error text, '' on success.
   */
  openPath?(dir: string): Promise<string>
  /**
   * The app's own updater (H-v12-updates; Electron main: src/main/updater.ts). Optional: absent for the standalone
   * server, dev and test runs, which then report 'unsupported'. Assignable, so the main process can attach it after
   * creating the platform (and test builds a fake).
   */
  updater?: PlatformUpdater
}

/** The updater as the server sees it (H-v12-updates): state, three owner actions and a change feed. */
export interface PlatformUpdater {
  status(): import('@shared/api').UpdateStatus
  /** Check now (also while automatic checks are off); resolves with the state after the check. */
  check(): Promise<import('@shared/api').UpdateStatus>
  /** Download the available version ('ask' mode); a no-op in any other state. */
  download(): Promise<import('@shared/api').UpdateStatus>
  /** Install the downloaded version and start again; false when nothing is ready. */
  restart(): boolean
  /** Every state change; returns an unsubscribe. */
  onChange(fn: (s: import('@shared/api').UpdateStatus) => void): () => void
}

/** One process of the app (07 D2 budgets are on the private working set). */
export interface AppProcessMetric {
  pid: number
  /** Electron's process type: Browser, Tab, GPU, Utility, … */
  type: string
  /** Utility processes: their service name ("Vesper Speech recognition"); otherwise Electron's name, if any. */
  name: string | null
  /** Private bytes in KB (Windows), null where the OS does not report it. */
  privateKB: number | null
  workingSetKB: number
  cpuPercent: number
}

/** Minimal message-port style handle common to Electron utilityProcess and node:child_process fork. */
export interface WorkerHandle {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  kill(): void
  readonly pid: number | undefined
}
