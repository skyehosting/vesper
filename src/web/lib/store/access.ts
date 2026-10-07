/**
 * App phase (boot/login/ready), auth state for the login page, the WebSocket connection status, and the access
 * feature's live data: network status (`network.changed`), the devices list (`devices.changed`) and the queue of
 * devices waiting for approval on the desktop (`device.pending`, 07 B16).
 */
import type { AuthState } from '@shared/api'
import type { ApiError } from '@shared/errors'
import type { DeviceInfo, NetworkStatus } from '@shared/types/domain'
import type { WsConnInfo } from '../ws.logic'
import type { SliceCreator } from './types'

export type AppPhase = 'booting' | 'login' | 'ready' | 'error'

/** A paired device the desktop has not allowed or denied yet. */
export interface PendingDevice {
  deviceId: string
  name: string
  ip: string | null
  /** Local time the request arrived (for "asked N s ago"). */
  atMs: number
}

export interface AccessSlice {
  phase: AppPhase
  bootError: ApiError | null
  authState: AuthState | null
  conn: WsConnInfo
  setPhase(phase: AppPhase, error?: ApiError | null): void
  setAuthState(a: AuthState | null): void
  setConn(c: WsConnInfo): void

  /** Latest access status (bootstrap snapshot, then GET/PUT /api/network and `network.changed`). */
  network: NetworkStatus | null
  setNetwork(n: NetworkStatus | null): void
  /** Devices list while a page shows it (null = not loaded). */
  devices: DeviceInfo[] | null
  setDevices(d: DeviceInfo[] | null): void
  /** Desktop only: pending devices to ask about, oldest first. */
  pendingDevices: PendingDevice[]
  pushPendingDevice(p: PendingDevice): void
  dropPendingDevice(deviceId: string): void
}

export const createAccessSlice: SliceCreator<AccessSlice> = (set) => ({
  phase: 'booting',
  bootError: null,
  authState: null,
  conn: { status: 'idle', attempt: 0, nextRetryAt: null, lastCloseCode: null },
  setPhase: (phase, error = null) => set({ phase, bootError: error }),
  setAuthState: (authState) => set({ authState }),
  setConn: (conn) => set({ conn }),

  network: null,
  setNetwork: (network) => set({ network }),
  devices: null,
  setDevices: (devices) => set({ devices }),
  pendingDevices: [],
  pushPendingDevice: (p) =>
    set((s) => (s.pendingDevices.some((x) => x.deviceId === p.deviceId) ? s : { pendingDevices: [...s.pendingDevices, p].slice(-8) })),
  dropPendingDevice: (deviceId) =>
    set((s) => (s.pendingDevices.some((x) => x.deviceId === deviceId) ? { pendingDevices: s.pendingDevices.filter((x) => x.deviceId !== deviceId) } : s))
})
