/**
 * Main-side handlers of the desktop bridge (src/preload). Every call must come from the main frame of the Vesper
 * window while it shows our loopback origin — a navigated-away page, an iframe or any other WebContents gets nothing.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC, TITLE_BAR_HEIGHT, type DesktopWindowState } from '../preload/types'
import { createLog } from './log'
import { isHexColor, isSameOrigin, validateExternalUrl } from './urls'
import { getWindowState } from './window'

const log = createLog('ipc')

export interface DesktopIpcDeps {
  /** The Vesper window, or null while it does not exist. */
  window(): BrowserWindow | null
  allowedOrigin(): string | null
  /** Close button: the shell decides (hide to tray or quit). */
  close(): void
  openExternal(url: string): Promise<void>
}

export function registerDesktopIpc(d: DesktopIpcDeps): () => void {
  /** The window when the call is legitimate, else null. */
  const trusted = (e: IpcMainInvokeEvent): BrowserWindow | null => {
    const win = d.window()
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return null
    const frame = e.senderFrame
    if (!frame || frame !== e.sender.mainFrame || !isSameOrigin(frame.url, d.allowedOrigin())) return null
    return win
  }
  const handle = (channel: string, fn: (win: BrowserWindow, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      const win = trusted(e)
      if (!win) {
        log.warn(`refused ${channel} from an untrusted frame`)
        return null
      }
      return fn(win, ...args)
    })
  }

  handle(DESKTOP_IPC.minimize, (win) => void win.minimize())
  handle(DESKTOP_IPC.toggleMaximize, (win) => void (win.isMaximized() ? win.unmaximize() : win.maximize()))
  handle(DESKTOP_IPC.close, () => void d.close())
  handle(DESKTOP_IPC.getState, (win): DesktopWindowState => getWindowState(win))
  handle(DESKTOP_IPC.setTitleBarOverlay, (win, raw) => {
    const c = raw as { color?: unknown; symbolColor?: unknown } | null
    if (!c || !isHexColor(c.color) || !isHexColor(c.symbolColor)) return false
    win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: TITLE_BAR_HEIGHT })
    return true
  })
  handle(DESKTOP_IPC.openExternal, async (_win, raw) => {
    const safe = validateExternalUrl(raw)
    if (!safe) return false
    await d.openExternal(safe)
    return true
  })

  return () => {
    for (const ch of Object.values(DESKTOP_IPC)) ipcMain.removeHandler(ch)
  }
}
