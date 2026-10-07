/// <reference types="vite/client" />

/**
 * The desktop bridge exposed by the preload (07 B11: window controls + openExternal only). It exists only in the
 * Electron window, so every use is feature-detected (`window.vesperDesktop?.…`). The shape below is the web client's
 * expectation; main-desktop owns the real one (see docs/requests/web-shell.md).
 */
interface VesperDesktopBridge {
  readonly isDesktop: true
  readonly platform?: string
  minimize?(): void
  toggleMaximize?(): void
  close?(): void
  openExternal?(url: string): Promise<void> | void
  /** Native caption-button colours (hex), so they follow the app theme (src/preload/types.ts). */
  setTitleBarOverlay?(colors: { color: string; symbolColor: string }): void
}

/** Test hooks (05 §3), present only in test builds running with VESPER_TEST=1. */
interface VesperTestApi {
  ready(): boolean
  notReady(): string | null
  route(): string
  go(path: string): void
  errors: string[]
  ws: { connected(): boolean; [k: string]: unknown }
  [ns: string]: unknown
}

interface Window {
  vesperDesktop?: VesperDesktopBridge
  __vesperTest?: VesperTestApi
}
