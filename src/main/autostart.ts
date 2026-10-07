/**
 * "Start with Windows" (research 06 §2.4, 07 D11/E8): `app.setLoginItemSettings({openAtLogin, args:['--background']})`
 * writes the HKCU Run key (no admin); `openAsHidden` no longer exists, so the launch argument starts Vesper in the tray.
 * Applied ONLY when the owner changes `desktop.startWithWindows` — never at startup, and never in dev runs, test runs
 * or the portable build (07 E8 hides the option there), so nothing here can touch the registry by accident.
 */
import type { ServerContext } from '../server/services'

export type AutostartDecision = 'apply' | 'skip-dev' | 'skip-test' | 'skip-portable'

export function autostartDecision(o: { packaged: boolean; test: boolean; portable: boolean }): AutostartDecision {
  if (o.test) return 'skip-test'
  if (!o.packaged) return 'skip-dev'
  if (o.portable) return 'skip-portable'
  return 'apply'
}

export function loginItemSettings(enabled: boolean): { openAtLogin: boolean; args: string[] } {
  return { openAtLogin: enabled, args: ['--background'] }
}

export function installAutostart(
  ctx: ServerContext,
  deps: { packaged: boolean; test: boolean; portable: boolean; set(o: { openAtLogin: boolean; args: string[] }): void; log(msg: string): void }
): () => void {
  return ctx.settings.subscribe('desktop', (next, prev) => {
    if (next.desktop.startWithWindows === prev.desktop.startWithWindows) return
    const d = autostartDecision(deps)
    if (d !== 'apply') {
      deps.log(`start with Windows left unchanged (${d})`)
      return
    }
    try {
      deps.set(loginItemSettings(next.desktop.startWithWindows))
      deps.log(`start with Windows ${next.desktop.startWithWindows ? 'on' : 'off'}`)
    } catch (e) {
      deps.log(`start with Windows could not be changed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
