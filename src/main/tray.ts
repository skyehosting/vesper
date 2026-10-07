/**
 * The tray icon: Open / (registered items) / Quit. Other parts of the shell add their own entries through
 * `registerTrayItems` (access-server: "Copy LAN link", "Pause network access", …) and call `refreshTrayMenu()` when
 * their items change; the menu is rebuilt from every provider each time.
 */
import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createLog } from './log'
import { buildTrayTemplate, starPixels, trayTooltip, withMicDot, type TrayItemsProvider } from './trayModel'

export type { TrayItemsProvider }

const log = createLog('tray')

const providers = new Map<string, TrayItemsProvider>()
let tray: Tray | null = null
let base: { onOpen(): void; onQuit(): void } | null = null
let images: { plain: NativeImage; mic: NativeImage } | null = null
let micDevices: string[] = []

/** Add (or replace) the items of `id`, shown between Open and Quit in registration order. Returns an unregister. */
export function registerTrayItems(id: string, provider: TrayItemsProvider): () => void {
  providers.set(id, provider)
  refreshTrayMenu()
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id)
      refreshTrayMenu()
    }
  }
}

export function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed() || !base) return
  const template = buildTrayTemplate(base, providers.entries(), (id, e) => log.warn(`tray items "${id}" failed`, e))
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function trayImage(resourcesDir: string): NativeImage {
  for (const f of [path.join(resourcesDir, 'icons', 'tray.png'), path.join(resourcesDir, 'tray.png')]) {
    try {
      if (fs.existsSync(f)) {
        const img = nativeImage.createFromPath(f)
        if (!img.isEmpty()) return img
      }
    } catch {
      /* fall through to the drawn icon */
    }
  }
  // 32 px drawn for a 16 DIP tray slot (scale factor 2): crisp at 100–200 %, slightly upscaled at 225 %.
  return nativeImage.createFromBitmap(starPixels(32), { width: 32, height: 32, scaleFactor: 2 })
}

/** Window / taskbar icon: resources/icon.png when present, else the drawn star (dev builds run as electron.exe). */
export function appIcon(resourcesDir: string): NativeImage {
  const f = path.join(resourcesDir, 'icon.png')
  try {
    if (fs.existsSync(f)) {
      const img = nativeImage.createFromPath(f)
      if (!img.isEmpty()) return img
    }
  } catch {
    /* fall through */
  }
  return nativeImage.createFromBitmap(starPixels(64), { width: 64, height: 64 })
}

export function createTray(o: { resourcesDir: string; onOpen(): void; onQuit(): void }): Tray {
  if (tray && !tray.isDestroyed()) return tray
  base = { onOpen: o.onOpen, onQuit: o.onQuit }
  const plain = trayImage(o.resourcesDir)
  images = { plain, mic: micImage(plain) }
  tray = new Tray(micDevices.length ? images.mic : plain)
  tray.setToolTip(trayTooltip(micDevices))
  tray.on('click', () => o.onOpen())
  tray.on('double-click', () => o.onOpen())
  refreshTrayMenu()
  return tray
}

/** The same icon with the red mic dot, at every scale factor the icon has. */
function micImage(plain: NativeImage): NativeImage {
  try {
    const out = nativeImage.createEmpty()
    for (const scaleFactor of plain.getScaleFactors()) {
      const { width, height } = plain.getSize(scaleFactor)
      const bitmap = plain.toBitmap({ scaleFactor })
      if (bitmap.length !== width * height * 4) continue
      out.addRepresentation({ scaleFactor, width, height, buffer: withMicDot(bitmap, width, height) })
    }
    return out.isEmpty() ? plain : out
  } catch (e) {
    log.warn('could not draw the mic dot', e)
    return plain
  }
}

/**
 * 07 B17 (F21): a red dot on the tray icon (and the device names in its tooltip) while any device streams mic audio
 * to this PC.
 */
export function setTrayMic(devices: readonly string[]): void {
  micDevices = [...devices]
  if (!tray || tray.isDestroyed() || !images) return
  tray.setImage(micDevices.length ? images.mic : images.plain)
  tray.setToolTip(trayTooltip(micDevices))
}

/** Tests: is the dot shown, and the tooltip. */
export function trayMicState(): { dot: boolean; tooltip: string } {
  return { dot: micDevices.length > 0, tooltip: trayTooltip(micDevices) }
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  images = null
}
