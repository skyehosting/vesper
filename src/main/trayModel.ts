/**
 * Pure parts of the tray (no Electron at runtime — unit-tested in tests/unit/main/trayModel.test.ts).
 */
import type { MenuItemConstructorOptions } from 'electron'

export type TrayItemsProvider = () => MenuItemConstructorOptions[]

/** The full menu template from the providers (a failing provider is skipped, never breaks the menu). */
export function buildTrayTemplate(
  actions: { onOpen(): void; onQuit(): void },
  sections: Iterable<[string, TrayItemsProvider]>,
  onProviderError?: (id: string, e: unknown) => void
): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [{ label: 'Open Vesper', click: () => actions.onOpen() }]
  for (const [id, provider] of sections) {
    let items: MenuItemConstructorOptions[] = []
    try {
      items = provider()
    } catch (e) {
      onProviderError?.(id, e)
    }
    if (items.length) out.push({ type: 'separator' }, ...items)
  }
  out.push({ type: 'separator' }, { label: 'Quit Vesper', click: () => actions.onQuit() })
  return out
}

/**
 * RGBA → premultiplied BGRA pixels of a four-pointed star (Vesper, the evening star) in Vesper gold with a white core
 * — the tray icon when resources/ has none.
 */
export function starPixels(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const half = size / 2
  const gold = [245, 184, 76]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - c) / half
      const v = (y - c) / half
      const r2 = u * u + v * v
      const core = Math.exp(-r2 / 0.06)
      const rayX = Math.exp(-(v * v) / 0.006) * Math.max(0, 1 - Math.abs(u))
      const rayY = Math.exp(-(u * u) / 0.006) * Math.max(0, 1 - Math.abs(v))
      const a = Math.min(1, core + 0.95 * Math.max(rayX, rayY))
      const white = Math.exp(-r2 / 0.015)
      const [rr, gg, bb] = gold.map((g) => g + (255 - g) * white)
      const i = (y * size + x) * 4
      buf[i] = Math.round(bb * a)
      buf[i + 1] = Math.round(gg * a)
      buf[i + 2] = Math.round(rr * a)
      buf[i + 3] = Math.round(255 * a)
    }
  }
  return buf
}

/**
 * 07 B17 (F21): the tray icon with a red dot in its lower-right corner while any device streams mic audio to this PC.
 * `bgra` is a premultiplied BGRA bitmap (nativeImage.toBitmap()); returns a new buffer, the input is untouched.
 */
export function withMicDot(bgra: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(bgra)
  const r = Math.max(2, Math.round(Math.min(width, height) * 0.22))
  const cx = width - r - 0.5
  const cy = height - r - 0.5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy)
      // A dark ring keeps the dot readable on light and dark taskbars.
      const ring = d <= r + 1 && d > r
      if (d > r + 1) continue
      const i = (y * width + x) * 4
      const [b, g, rr] = ring ? [20, 20, 28] : [56, 48, 235]
      out[i] = b
      out[i + 1] = g
      out[i + 2] = rr
      out[i + 3] = 255
    }
  }
  return out
}

/** The tray tooltip: the device names while their mic streams to this PC. */
export function trayTooltip(micDevices: readonly string[]): string {
  if (!micDevices.length) return 'Vesper'
  const names = [...new Set(micDevices)]
  return `Vesper — microphone in use: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`.slice(0, 127)
}
