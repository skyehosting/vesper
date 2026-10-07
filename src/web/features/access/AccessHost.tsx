/**
 * App-level access wiring, mounted once while the app is ready (App.tsx). Small and eager; the dialogs it may show
 * load lazily.
 *  - `network.changed` → store.network (the Access page and tray-like badges read it live).
 *  - `devices.changed` → refetch the devices list if a page shows it; drop approval prompts that were settled.
 *  - `device.pending` (desktop only, 07 B16) → queue an approval dialog "Pair '<device>' from <ip>?".
 *  - `notify {deviceId}` (desktop only) → a toast with one-click Revoke for a new sign-in. Notifications that carry a
 *    sessionUid belong to chat and are left alone.
 *  - the api client's sudo hook → the password prompt (07 B2).
 * Every subscription is released on unmount (counted by `accessHostStats` for the leak test).
 */
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import type { NetworkStatus } from '@shared/types/domain'
import { toast } from '../../components/Toast'
import { kitStats } from '../../components/internal/stats'
import { setApiHooks } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { getLocation, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { registerTestHooks } from '../../lib/testHooks'
import { ws } from '../../lib/ws'
import { deviceWatchers, loadDevices, reloadDevicesIfWatched, revokeDevice } from './data'
import { requestSudo, resolveSudo, sudoListeners, sudoOpen, useSudoOpen } from './sudo'

const ApprovalDialog = lazy(() => import('../devices/ApprovalDialog'))
const SudoDialog = lazy(() => import('./SudoDialog'))

let mounted = 0
/** The page a pending password prompt was asked on. */
let sudoAskedOn: string | null = null

export function AccessHost(): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const hasPending = useStore((s) => s.pendingDevices.length > 0)
  const sudo = useSudoOpen()
  // A pending password prompt belongs to the page that asked: leaving it (a link, a phone's back gesture) cancels the
  // prompt and its retry instead of leaving the sheet over the next page (F49).
  const { pathname } = useLocation()
  useEffect(() => {
    if (sudoOpen() && sudoAskedOn !== null && sudoAskedOn !== pathname) resolveSudo(false)
  }, [pathname])

  useEffect(() => {
    mounted++
    const st = useStore.getState
    const boot = st().bootstrap
    if (boot) st().setNetwork(boot.network)
    const offs = [
      ws.on('network.changed', (m) => st().setNetwork(m.network)),
      ws.on('devices.changed', () => {
        void reloadDevicesIfWatched()
        // A pending device may have been settled elsewhere (devices list, expiry): drop its prompt.
        if (st().pendingDevices.length) {
          void loadDevices()
            .then((list) => {
              for (const p of st().pendingDevices) if (!list.some((d) => d.id === p.deviceId && d.pending)) st().dropPendingDevice(p.deviceId)
            })
            .catch(() => undefined)
        }
      }),
      ws.on('device.pending', (m) => {
        if (!st().bootstrap?.desktop) return
        st().pushPendingDevice({ deviceId: m.deviceId, name: m.name, ip: m.ip, atMs: Date.now() })
      }),
      ws.on('notify', (m) => {
        if (m.sessionUid) return
        const id = m.deviceId
        // The approval dialog already asks about a pending device.
        if (id && st().pendingDevices.some((p) => p.deviceId === id)) return
        toast.info(m.body, {
          title: m.title,
          id: id ? `access-notify-${id}` : undefined,
          durationMs: id ? 12_000 : 8_000,
          action: id
            ? {
                label: 'Revoke',
                onClick: () => {
                  revokeDevice(id)
                    .then(() => toast.success('That device was signed out.'))
                    .catch((e: unknown) => toast.error(toApiError(e).message))
                }
              }
            : undefined
        })
      })
    ]
    setApiHooks({
      onSudoRequired: () => {
        if (!sudoOpen()) sudoAskedOn = getLocation().pathname
        return requestSudo()
      }
    })
    return () => {
      mounted--
      for (const off of offs) off()
      setApiHooks({ onSudoRequired: undefined })
    }
  }, [])

  return (
    <Suspense fallback={null}>
      {desktop && hasPending ? <ApprovalDialog /> : null}
      {sudo ? <SudoDialog /> : null}
    </Suspense>
  )
}

/** Leak checks (07 D14): hosts mounted, sudo-prompt subscribers, device-list watchers. */
export function accessHostStats(): { hosts: number; sudoListeners: number; deviceWatchers: number } {
  return { hosts: mounted, sudoListeners: sudoListeners(), deviceWatchers: deviceWatchers() }
}

if (__VESPER_TEST__) {
  registerTestHooks('access', {
    hostStats: accessHostStats,
    /** Screenshots: render a network state the test server can't produce (Tailscale, Funnel, firewall blocked). */
    fakeNetwork: (patch: Partial<NetworkStatus>) => {
      const cur = useStore.getState().network
      if (cur) useStore.getState().setNetwork({ ...cur, ...patch })
    },
    pendingCount: () => useStore.getState().pendingDevices.length,
    /** The kit's live listeners/timers/layers (leak checks). */
    kitStats
  })
}
