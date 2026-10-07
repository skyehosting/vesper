/**
 * Pure decisions of the window lifecycle (tests/unit/main/lifecycle.test.ts).
 */

/** Launch argument of "Start with Windows" (research 06 §2.4: `openAsHidden` is gone, an argument is the way). */
export const BACKGROUND_ARG = '--background'

export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_ARG)
}

/**
 * What the window's close button does: hide to the tray when "close to tray" is on — or when Vesper was started in the
 * background (it lives in the tray by design) — otherwise close and quit. While quitting, windows just close.
 */
export function closeAction(o: { quitting: boolean; closeToTray: boolean; background: boolean }): 'hide' | 'close' {
  if (o.quitting) return 'close'
  return o.closeToTray || o.background ? 'hide' : 'close'
}

/**
 * How long a hidden window is kept before its renderer is destroyed (07 D2, `desktop.keepWindowWarmSec`): null =
 * never (−1), otherwise milliseconds (0 = at once). Reopening after that recreates the window.
 */
export function warmDelayMs(keepWindowWarmSec: number | undefined): number | null {
  const sec = keepWindowWarmSec ?? 30
  if (!Number.isFinite(sec) || sec < 0) return null
  return Math.round(sec * 1000)
}

/** Window background / caption colors for a theme setting. */
export function isDarkTheme(theme: 'dark' | 'light' | 'system' | undefined, systemDark: boolean): boolean {
  if (theme === 'light') return false
  if (theme === 'system') return systemDark
  return true
}
