/**
 * Access data layer: REST calls for network status, devices, pairing, password and the audit log, each keeping the
 * store in step. Pages call these; live updates come from AccessHost (`network.changed`, `devices.changed`).
 *
 * Devices are fetched only while something shows them: `watchDevices()` is ref-counted, and `devices.changed`
 * refetches only when a watcher exists (no background polling).
 */
import type { EndpointRes, NetworkPut, PairTarget } from '@shared/api'
import type { DeviceInfo, NetworkStatus } from '@shared/types/domain'
import type { DeepPartial, Settings } from '@shared/settings'
import { api } from '../../lib/api'
import { useStore } from '../../lib/store'

const st = useStore.getState

export async function refreshNetwork(signal?: AbortSignal): Promise<NetworkStatus> {
  const n = await api('GET /api/network', { signal })
  st().setNetwork(n)
  return n
}

export async function updateNetwork(put: NetworkPut): Promise<NetworkStatus> {
  const n = await api('PUT /api/network', { body: put })
  st().setNetwork(n)
  return n
}

export async function allowFirewall(publicToo: boolean): Promise<NetworkStatus> {
  const n = await api('POST /api/network/firewall/allow', { body: { publicToo } })
  st().setNetwork(n)
  return n
}

export async function setTailscaleServe(on: boolean, funnel: boolean): Promise<NetworkStatus> {
  const n = await api('POST /api/network/tailscale/serve', { body: { on, funnel } })
  st().setNetwork(n)
  return n
}

export async function patchSettings(patch: DeepPartial<Settings>): Promise<void> {
  const s = await api('PATCH /api/settings', { body: patch })
  st().applySettings(s)
}

export async function setPassword(body: { current?: string; next: string }): Promise<void> {
  await api('POST /api/auth/password', { body })
  // The password unlocks LAN/Tailscale (the server reconciles); show the new state.
  await refreshNetwork().catch(() => undefined)
  await reloadDevicesIfWatched()
}

export function createPairing(target: PairTarget | undefined): Promise<EndpointRes<'POST /api/auth/pair'>> {
  return api('POST /api/auth/pair', { body: target ? { target } : {} })
}

// ── devices ──────────────────────────────────────────────────────────────────────────────────

let watchers = 0
let loadSeq = 0

export async function loadDevices(): Promise<DeviceInfo[]> {
  const seq = ++loadSeq
  const list = await api('GET /api/auth/devices')
  // A newer load (from a later event) wins.
  if (seq === loadSeq && watchers > 0) st().setDevices(list)
  return list
}

/** Keep `store.devices` fresh while the returned function is not called (ref-counted). */
export function watchDevices(): () => void {
  watchers++
  let released = false
  return () => {
    if (released) return
    released = true
    watchers--
    if (watchers === 0) {
      loadSeq++
      st().setDevices(null)
    }
  }
}

export function deviceWatchers(): number {
  return watchers
}

export async function reloadDevicesIfWatched(): Promise<void> {
  if (watchers > 0) await loadDevices().catch(() => undefined)
}

export async function approveDevice(id: string, allow: boolean): Promise<void> {
  try {
    await api('POST /api/auth/devices/:id/approve', { params: { id }, body: { allow } })
  } finally {
    st().dropPendingDevice(id)
  }
}

export async function revokeDevice(id: string): Promise<void> {
  await api('DELETE /api/auth/devices/:id', { params: { id } })
  const cur = st().devices
  if (cur) st().setDevices(cur.filter((d) => d.id !== id))
  st().dropPendingDevice(id)
}

export function loadAuthLog(): Promise<EndpointRes<'GET /api/auth/log'>> {
  return api('GET /api/auth/log')
}
