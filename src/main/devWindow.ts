/**
 * Development-only window placement override (ported from Orrery). Never active in packaged builds.
 *
 * While the marker file `%TEMP%\vesper-dev-window.json` exists, every window of an unpackaged build (dev runs,
 * Playwright e2e, scripts/shot.mjs) opens on the chosen display and never takes focus — the owner games on the
 * primary monitor:
 *   {"display":"secondary"}   (or "primary")
 * Delete the file to restore normal placement. Native dialogs and notifications are not shown either while it is
 * active (they would appear on the primary display); see dialogs.ts and platform.ts.
 */
import { app, screen, type BrowserWindow, type Display } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testEnv } from './env'

export const DEV_WINDOW_MARKER = path.join(os.tmpdir(), 'vesper-dev-window.json')

interface DevWindowConfig {
  display: 'secondary' | 'primary'
}

function readConfig(): DevWindowConfig | null {
  if (app.isPackaged) return null
  try {
    const raw = JSON.parse(fs.readFileSync(DEV_WINDOW_MARKER, 'utf8')) as { display?: unknown }
    return { display: raw?.display === 'primary' ? 'primary' : 'secondary' }
  } catch {
    return null
  }
}

/** True in an unpackaged build while the marker exists. */
export function devWindowActive(): boolean {
  return readConfig() !== null
}

function targetDisplay(which: DevWindowConfig['display']): Display {
  const primary = screen.getPrimaryDisplay()
  if (which === 'primary') return primary
  return screen.getAllDisplays().find((d) => d.id !== primary.id) ?? primary
}

function place(win: BrowserWindow, which: DevWindowConfig['display']): void {
  if (win.isDestroyed()) return
  const wa = targetDisplay(which).workArea
  const [minW, minH] = win.getMinimumSize()
  win.setMinimumSize(Math.min(minW, wa.width), Math.min(minH, wa.height))
  const b = win.getBounds()
  const width = Math.min(b.width, wa.width)
  const height = Math.min(b.height, wa.height)
  win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height })
  // The window was first created on the primary display, which may have been too small for the requested test size
  // (Windows shrinks it there). Re-apply the requested content size now that it sits on a display where it fits.
  const requested = testEnv()?.windowSize
  if (requested) {
    win.setContentSize(Math.min(requested.width, wa.width), Math.min(requested.height, wa.height))
    const nb = win.getBounds()
    win.setPosition(wa.x + Math.max(0, Math.round((wa.width - nb.width) / 2)), wa.y + Math.max(0, Math.round((wa.height - nb.height) / 2)))
  }
}

/** Register the override (no-op unless the marker exists when a window is created). */
export function installDevWindowOverride(): void {
  if (app.isPackaged) return
  app.on('browser-window-created', (_e, win) => {
    const cfg = readConfig()
    if (!cfg) return
    // Move (keeping the size the app chose) once the window has its final bounds, before it is first shown.
    win.once('ready-to-show', () => place(win, cfg.display))
    // Never steal focus from whatever the user is doing on the main monitor.
    const showInactive = win.showInactive.bind(win)
    win.show = (): void => showInactive()
    win.focus = (): void => undefined
    // The app may position/maximize itself before showing: move it back to the target display once shown.
    win.once('show', () => {
      if (win.isDestroyed()) return
      if (win.isMaximized()) {
        win.unmaximize()
        place(win, cfg.display)
        win.maximize()
      } else place(win, cfg.display)
    })
  })
}
