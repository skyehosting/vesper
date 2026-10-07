/**
 * The app's single WebSocket (same origin, /ws), wired to the browser. Logic lives in ws.logic.ts.
 *
 *   const off = ws.on('reply.delta', (m) => …)       // typed by message type; returns unsubscribe
 *   const unsub = ws.subscribe(sessionUid)           // ref-counted; resumes after reconnects
 *   await ws.request({ t: 'chat.send', … })          // resolves with the ack
 */
import { WS_PATH, type ClientState } from '@shared/ws'
import { WsClient, type SocketHandle, type SocketHandlers } from './ws.logic'

let audioUnlocked = false
let reportError: (err: unknown) => void = () => undefined

function domSocket(url: string, h: SocketHandlers): SocketHandle {
  const s = new WebSocket(url)
  s.binaryType = 'arraybuffer'
  s.onopen = () => h.open()
  s.onmessage = (e: MessageEvent) => h.message(e.data)
  s.onclose = (e: CloseEvent) => h.close(e.code, e.reason)
  s.onerror = () => h.error()
  return {
    send: (data) => s.send(data),
    close: (code, reason) => {
      s.onopen = s.onmessage = s.onclose = s.onerror = null
      try {
        s.close(code, reason)
      } catch {
        s.close()
      }
    }
  }
}

function currentClientState(): ClientState {
  return { visible: document.visibilityState === 'visible', focused: document.hasFocus(), audioUnlocked }
}

function zoneName(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

export const ws = new WsClient({
  url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`,
  createSocket: domSocket,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
  now: () => Date.now(),
  random: () => Math.random(),
  clientState: currentClientState,
  zone: () => ({ tz: zoneName(), tzOffset: -new Date().getTimezoneOffset() }),
  reportError: (e) => reportError(e)
})

/** Where listener exceptions go (the test-hook error list in test builds, the console otherwise). */
export function setWsErrorReporter(fn: (err: unknown) => void): void {
  reportError = fn
}

/** audio-core calls this after the first user gesture unlocked the AudioContext; the server routes speech by it. */
export function setAudioUnlocked(v: boolean): void {
  audioUnlocked = v
  ws.updateClientState()
}

/** The sender's clock for chat.send / regenerate / edit (07 C2: the server stamps with its own clock). */
export function clientClock(): { ts: number; tzOffset: number; tzName: string | null } {
  return { ts: Date.now(), tzOffset: -new Date().getTimezoneOffset(), tzName: zoneName() }
}

/**
 * Keep the server informed about visibility/focus (07 C16 `client.state`) and reconnect promptly when the network
 * or the tab comes back. Returns a cleanup.
 */
export function installWsDomListeners(): () => void {
  const onState = (): void => ws.updateClientState()
  const onVisible = (): void => {
    ws.updateClientState()
    if (document.visibilityState === 'visible' && ws.status === 'reconnecting') ws.retryNow()
  }
  const onOnline = (): void => ws.retryNow()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onState)
  window.addEventListener('blur', onState)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onState)
    window.removeEventListener('blur', onState)
    window.removeEventListener('online', onOnline)
  }
}

export type { WsConnInfo, WsStatus, Ack, MsgOf, RequestBody } from './ws.logic'
