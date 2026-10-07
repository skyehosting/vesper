/**
 * Access items in the tray menu (research 06 §2.4, 07 B14): "Copy LAN link", the Tailscale state and "Pause remote
 * access". Built from the server's NetworkStatus (the access module emits changes) through the tray's
 * `registerTrayItems` registry. The item model is pure (unit-tested without Electron); clipboard and menu calls are
 * injected by src/main/index.ts.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { NetworkStatus } from '@shared/types/domain'
import { tryAccessOf } from '../server/net'
import type { ServerContext } from '../server/services'

export interface TrayAccessActions {
  copy(text: string): void
  setPaused(paused: boolean): void
}

export function tailscaleLabel(s: NetworkStatus): string {
  const t = s.tailscale
  if (!t) return 'Tailscale: checking…'
  if (!t.installed) return 'Tailscale: not installed'
  if (!t.running) return 'Tailscale: not running'
  if (!t.signedIn) return 'Tailscale: signed out'
  if (t.serving && t.funnel) return 'Tailscale: on — public (Funnel)'
  if (t.serving) return 'Tailscale: on'
  return 'Tailscale: not serving Vesper'
}

export function accessTrayItems(s: NetworkStatus | null, a: TrayAccessActions): MenuItemConstructorOptions[] {
  if (!s || s.mode === 'local') return []
  const items: MenuItemConstructorOptions[] = []
  const paused = !!s.remote?.paused
  const lanUrl = s.lan?.running ? s.lan.url : null
  if (lanUrl) items.push({ label: 'Copy LAN link', click: () => a.copy(lanUrl) })
  if (s.mode === 'tailscale') {
    items.push({ label: tailscaleLabel(s), enabled: false })
    const url = s.tailscale?.url
    if (url && !paused) items.push({ label: 'Copy Tailscale link', click: () => a.copy(url) })
  }
  items.push({ label: 'Pause remote access', type: 'checkbox', checked: paused, click: () => a.setPaused(!paused) })
  return items
}

export function installTrayAccess(
  ctx: ServerContext,
  deps: { register(id: string, provider: () => MenuItemConstructorOptions[]): () => void; refresh(): void; copy(text: string): void; warn?(msg: string, e: unknown): void }
): () => void {
  const access = tryAccessOf(ctx)
  if (!access) return () => undefined
  let status: NetworkStatus | null = access.net.status()
  const off = access.net.onChange((s) => {
    status = s
    deps.refresh()
  })
  const actions: TrayAccessActions = {
    copy: deps.copy,
    setPaused: (p) => void access.net.setPaused(p).catch((e: unknown) => deps.warn?.('pausing remote access failed', e))
  }
  const unregister = deps.register('access', () => accessTrayItems(status, actions))
  return () => {
    off()
    unregister()
    status = null
  }
}
