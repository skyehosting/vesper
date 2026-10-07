/**
 * Preload of the Vesper window (sandboxed: only `electron`'s renderer modules are available). Exposes the tiny desktop
 * bridge of ./types.ts; main validates every call's sender frame (src/main/ipc.ts), so the bridge grants nothing to a
 * frame that is not our loopback origin.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { DESKTOP_IPC, TITLE_BAR_HEIGHT, type DesktopWindowState, type TitleBarOverlayColors, type VesperDesktop } from './types'

const bridge: VesperDesktop = {
  isDesktop: true,
  platform: process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32',
  titleBarHeight: TITLE_BAR_HEIGHT,
  minimize: () => void ipcRenderer.invoke(DESKTOP_IPC.minimize).catch(() => undefined),
  toggleMaximize: () => void ipcRenderer.invoke(DESKTOP_IPC.toggleMaximize).catch(() => undefined),
  close: () => void ipcRenderer.invoke(DESKTOP_IPC.close).catch(() => undefined),
  openExternal: (url: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.openExternal, String(url)).then(
      (ok: unknown) => ok === true,
      () => false
    ),
  setTitleBarOverlay: (colors: TitleBarOverlayColors) =>
    void ipcRenderer
      .invoke(DESKTOP_IPC.setTitleBarOverlay, { color: String(colors?.color ?? ''), symbolColor: String(colors?.symbolColor ?? '') })
      .catch(() => undefined),
  onWindowState(cb: (state: DesktopWindowState) => void): () => void {
    let active = true
    const listener = (_e: IpcRendererEvent, state: DesktopWindowState): void => {
      if (active) cb(state)
    }
    ipcRenderer.on(DESKTOP_IPC.state, listener)
    void ipcRenderer.invoke(DESKTOP_IPC.getState).then(
      (state: DesktopWindowState | null) => {
        if (active && state) cb(state)
      },
      () => undefined
    )
    return () => {
      active = false
      ipcRenderer.removeListener(DESKTOP_IPC.state, listener)
    }
  }
}

contextBridge.exposeInMainWorld('vesperDesktop', bridge)
