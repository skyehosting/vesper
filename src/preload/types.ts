/**
 * The desktop bridge (`window.vesperDesktop`) the preload exposes to the web client — present only inside the Vesper
 * window, never in a browser. Deliberately tiny (07 B11): window controls, the caption-button overlay colors and a
 * validated openExternal. web-shell mirrors this interface (see docs/requests/main-desktop.md).
 */

export interface DesktopWindowState {
  maximized: boolean
  minimized: boolean
  fullscreen: boolean
  focused: boolean
  visible: boolean
}

/** Colors of the native caption buttons (minimize / maximize / close) drawn over the page's title area. */
export interface TitleBarOverlayColors {
  /** Background behind the buttons: a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa); match the title area. */
  color: string
  /** The button glyphs: a hex color. */
  symbolColor: string
}

export interface VesperDesktop {
  readonly isDesktop: true
  readonly platform: 'win32' | 'darwin' | 'linux'
  /**
   * Height (CSS px) of the caption-button overlay at the top right. The page draws its own title area at least this
   * tall; the CSS env vars `titlebar-area-x/-width/-height` give the exact free area left of the buttons.
   */
  readonly titleBarHeight: number
  minimize(): void
  toggleMaximize(): void
  /** Closes the window (hides it to the tray when "close to tray" is on). */
  close(): void
  /** Opens an http(s)/mailto URL in the default browser / mail app; resolves false when the URL was refused. */
  openExternal(url: string): Promise<boolean>
  /** Recolor the caption buttons on theme change. */
  setTitleBarOverlay(colors: TitleBarOverlayColors): void
  /** Called at once with the current state, then on every change. Returns an unsubscribe. */
  onWindowState(cb: (state: DesktopWindowState) => void): () => void
}

/** Caption-button overlay height in DIP (= CSS px at zoom 100 %). */
export const TITLE_BAR_HEIGHT = 48

/** IPC channels between the preload and src/main/ipc.ts. */
export const DESKTOP_IPC = {
  minimize: 'vesper:window:minimize',
  toggleMaximize: 'vesper:window:toggle-maximize',
  close: 'vesper:window:close',
  getState: 'vesper:window:get-state',
  /** main → renderer push of DesktopWindowState. */
  state: 'vesper:window:state',
  setTitleBarOverlay: 'vesper:window:title-bar-overlay',
  openExternal: 'vesper:open-external'
} as const
