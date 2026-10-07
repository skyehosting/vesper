/**
 * WebSocket upgrades on a listener (research 06 §5.5): Host allow-list, exact Origin (a missing Origin is refused —
 * browsers always send it), then the session cookie. Bad Host/Origin are refused before the handshake; a missing or
 * invalid session completes the handshake and closes with 4401 so the client knows to sign in rather than retry.
 * Non-/ws upgrades go to the Vite HMR proxy in dev and are refused otherwise.
 */
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocketServer } from 'ws'
import { WS_CLOSE, WS_PATH } from '@shared/ws'
import type { AuthCore } from '../auth/core'
import type { DevProxy } from '../http/devProxy'
import { hostProblem, originOk, type ListenerGuardState } from '../http/guards'
import type { HubImpl } from './hub'

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request' }

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export function createUpgradeHandler(o: { guard: ListenerGuardState; auth: AuthCore; hub: HubImpl; wss: WebSocketServer; dev: DevProxy | null }) {
  return (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy())
    const p = (req.url ?? '/').split('?')[0]
    const host = hostProblem(o.guard, req.headers.host)
    if (host !== null) return reject(socket, host)
    if (!originOk(o.guard, req.headers.origin)) return reject(socket, 403)
    if (p === WS_PATH) {
      const ip = req.socket.remoteAddress ?? null
      const auth = o.auth.resolve(req.headers.cookie, o.guard.name, ip)
      o.wss.handleUpgrade(req, socket, head, (ws) => {
        if (!auth || auth.pending) {
          ws.close(WS_CLOSE.auth, 'unauthorized')
          return
        }
        o.hub.attach(ws, {
          device: { id: auth.deviceId, kind: auth.kind, name: auth.name, listener: auth.deviceListener },
          listener: o.guard.name,
          isDesktop: auth.isDesktop,
          ip
        })
      })
      return
    }
    if (o.dev) return o.dev.upgrade(req, socket, head)
    reject(socket, 404)
  }
}
