/**
 * LAN addresses for Listener B (research 06 §3.2). The default bind address is the source IP of the default route —
 * NOT "the first non-internal IPv4", which on the owner's PC is Hamachi. A UDP `connect()` makes the OS pick the
 * route without sending a packet. Link-local (169.254/16) addresses are never offered.
 */
import dgram from 'node:dgram'
import os from 'node:os'
import QRCode from 'qrcode'
import type { NetworkInterfaceInfo } from '@shared/types/domain'

export interface Iface {
  address: string
  name: string
}

export function listIpv4(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): Iface[] {
  const out: Iface[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      out.push({ address: a.address, name })
    }
  }
  return out
}

/** Source address of the default route, or null (offline). No packet leaves the machine. */
export function defaultRouteAddress(timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    let done = false
    const finish = (v: string | null) => {
      if (done) return
      done = true
      clearTimeout(t)
      try {
        s.close()
      } catch {
        /* already closed */
      }
      resolve(v)
    }
    const t = setTimeout(() => finish(null), timeoutMs)
    t.unref()
    s.once('error', () => finish(null))
    try {
      s.connect(53, '1.1.1.1', () => {
        try {
          finish(s.address().address)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}

export function isPrivateIpv4(a: string): boolean {
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
}

/** Interfaces for the picker: the default-route one first and `recommended`. */
export function interfaceInfo(list: Iface[], recommended: string | null): NetworkInterfaceInfo[] {
  return list
    .map((i) => ({ address: i.address, name: i.name, recommended: i.address === recommended }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended))
}

export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
}
