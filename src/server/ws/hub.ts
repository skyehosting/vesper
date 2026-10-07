/**
 * WebSocket hub (03 §4, 07 C16): one socket per client at /ws, authenticated on upgrade (see ./upgrade.ts).
 *
 * Protocol: the first frame must be `hello` with protocol === WS_PROTOCOL (else close 4409) → `ready`. Session events
 * get a per-session `evSeq` and go into a ring of EVENT_RING_SIZE; `subscribe {sinceEvSeq}` replays from the ring when
 * the gap is still covered, otherwise replays nothing and the client refetches (it can tell from
 * `sinceEvSeq + replayed !== evSeq`). Liveness: app-level `ping` every PING_INTERVAL_MS, terminate after 2 missed
 * `pong`s; the device session is re-validated on the same tick (revocation closes with 4401). A token bucket per
 * socket closes floods with 4429. Audio frames respect AUDIO_BACKPRESSURE_BYTES.
 */
import { randomBytes } from 'node:crypto'
import type { WebSocket, RawData } from 'ws'
import { apiError, VesperError, type ApiError } from '@shared/errors'
import type { InflightReply } from '@shared/types/domain'
import {
  AUDIO_BACKPRESSURE_BYTES,
  BIN_KIND,
  EVENT_RING_SIZE,
  PING_INTERVAL_MS,
  WS_CLOSE,
  WS_PROTOCOL,
  decodeBinary,
  encodeBinary,
  type ClientMsg,
  type ClientState,
  type ServerMsg,
  type SpeechChunkHeader
} from '@shared/ws'
import type { DeviceInfo, Listener } from '@shared/types/domain'
import type { Hub, Log, WsClient } from '../services'

const OPEN = 1
const MAX_SUBSCRIPTIONS = 100
/** The ring of a session nobody watches is dropped after this long (events AND counter; see `floor`). */
const RING_IDLE_MS = 10 * 60_000
/** At most this many rings; beyond it the least recently used unwatched ring goes (LRU). */
const MAX_RINGS = 2048

export interface HubDeps {
  now(): number
  log: Log
  toApiError(e: unknown): ApiError
  /** Can this session be subscribed to (exists and not deleted)? */
  sessionExists(uid: string): boolean
  /** Is the device session behind this socket still valid (not revoked, still approved, within its lifetime)? */
  stillValid(c: WsClient): boolean
  /**
   * The client sent something (any frame but a `pong`): it counts as activity for the idle limit (F01). Optional;
   * the implementation throttles its writes. It checks the session before writing and returns `false` when the
   * session is no longer valid (nothing written); the hub then closes with 4401 and drops the frame. Without it the
   * hub checks `stillValid` on every frame.
   */
  seen?(c: WsClient, ip: string | null): boolean
}

export interface HubOptions {
  pingIntervalMs?: number
  helloTimeoutMs?: number
  ringSize?: number
  /** Ring bounds (tests use small values): idle age of an unwatched ring, and the LRU cap. */
  ringIdleMs?: number
  maxRings?: number
  /** Token bucket: burst size and refill per second (binary mic frames count too: ~31/s). */
  rateBurst?: number
  ratePerSec?: number
}

export interface AttachInfo {
  device: Pick<DeviceInfo, 'id' | 'kind' | 'name' | 'listener'>
  listener: Listener
  isDesktop: boolean
  /** The peer address, recorded with activity (devices.last_ip). */
  ip?: string | null
}

export interface HubImpl extends Hub {
  /** The chat engine reports in-flight replies for `subscribed` (07 C16). */
  setInflightProvider(fn: (sessionUid: string) => InflightReply[]): void
  /** Answer a request that carried an `id`. */
  ack(client: WsClient, msg: { id?: string }, extra?: { replyId?: string; messageUid?: string }): void
  /** Send an error for a request (with its id when it had one). */
  fail(client: WsClient, msg: { id?: string }, e: unknown): void
  attach(ws: WebSocket, info: AttachInfo): WsClient
  stats(): { clients: number; subscriptions: number; rings: number }
  dropSession(sessionUid: string): void
  close(): void
}

interface Ring {
  evSeq: number
  events: (ServerMsg & { evSeq: number })[]
  lastUsed: number
}

class Client implements WsClient {
  readonly id = `c_${randomBytes(8).toString('base64url')}`
  state: ClientState = { visible: true, focused: true, audioUnlocked: false }
  tz: string | null = null
  tzOffset = 0
  readonly subs = new Set<string>()
  ready = false
  awaitingPong = false
  missedPongs = 0
  tokens: number
  lastRefill: number
  helloTimer: NodeJS.Timeout | null = null

  constructor(
    readonly ws: WebSocket,
    readonly device: AttachInfo['device'],
    readonly listener: Listener,
    readonly isDesktop: boolean,
    readonly ip: string | null,
    burst: number,
    now: number
  ) {
    this.tokens = burst
    this.lastRefill = now
  }

  get subscriptions(): ReadonlySet<string> {
    return this.subs
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount
  }

  send(msg: ServerMsg): void {
    if (this.ws.readyState === OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendSpeech(header: SpeechChunkHeader, audio: Uint8Array): boolean {
    if (this.ws.readyState !== OPEN || this.ws.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) return false
    this.ws.send(encodeBinary(BIN_KIND.speechChunk, header, audio), { binary: true })
    return true
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === OPEN || this.ws.readyState === 0) this.ws.close(code, reason.slice(0, 120))
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

export function createHub(deps: HubDeps, o: HubOptions = {}): HubImpl {
  const pingMs = o.pingIntervalMs ?? PING_INTERVAL_MS
  const helloMs = o.helloTimeoutMs ?? 10_000
  const ringSize = o.ringSize ?? EVENT_RING_SIZE
  const ringIdleMs = o.ringIdleMs ?? RING_IDLE_MS
  const maxRings = o.maxRings ?? MAX_RINGS
  const burst = o.rateBurst ?? 120
  const perSec = o.ratePerSec ?? 60
  const log = deps.log.child('ws')

  const clients = new Map<string, Client>()
  /** Insertion order = least recently used first (a used ring is moved to the end). */
  const rings = new Map<string, Ring>()
  /**
   * The highest evSeq of any dropped ring. A ring created later (also for a uid seen before) starts here, so a client
   * resuming with a `sinceEvSeq` from before the drop sees `head - since > replayed` (or head == since only when it had
   * seen everything) and refetches; evSeq values never repeat with different events within one boot.
   */
  let floor = 0
  const handlers: { prefix: string; fn: (c: WsClient, m: ClientMsg) => void | Promise<void> }[] = []
  const binHandlers = new Map<number, (c: WsClient, header: unknown, payload: Uint8Array) => void>()
  const disconnectHandlers: ((c: WsClient) => void)[] = []
  let inflight: (uid: string) => InflightReply[] = () => []

  const timer = setInterval(tick, pingMs)
  timer.unref()

  function tick(): void {
    const now = deps.now()
    for (const c of clients.values()) {
      if (!c.ready) continue
      if (!deps.stillValid(c)) {
        c.close(WS_CLOSE.auth, 'session ended')
        continue
      }
      if (c.awaitingPong) {
        c.missedPongs++
        if (c.missedPongs >= 2) {
          c.ws.terminate()
          continue
        }
      }
      c.awaitingPong = true
      c.send({ t: 'ping', ts: now })
    }
    const live = watchedSet()
    for (const [uid, r] of rings) {
      if (now - r.lastUsed > ringIdleMs && !live.has(uid)) drop(uid)
    }
  }

  function watchedSet(): Set<string> {
    const out = new Set<string>()
    for (const c of clients.values()) for (const uid of c.subs) out.add(uid)
    return out
  }

  function drop(uid: string): void {
    const r = rings.get(uid)
    if (!r) return
    floor = Math.max(floor, r.evSeq)
    rings.delete(uid)
  }

  function ringOf(uid: string): Ring {
    let r = rings.get(uid)
    if (r) {
      // LRU order: most recently used last.
      rings.delete(uid)
      rings.set(uid, r)
      return r
    }
    if (rings.size >= maxRings) {
      const live = watchedSet()
      for (const old of rings.keys()) {
        if (rings.size < maxRings) break
        if (!live.has(old)) drop(old)
      }
    }
    r = { evSeq: floor, events: [], lastUsed: deps.now() }
    rings.set(uid, r)
    return r
  }

  function excluded(except: string | ReadonlySet<string> | undefined, id: string): boolean {
    if (except === undefined) return false
    return typeof except === 'string' ? except === id : except.has(id)
  }

  function rateOk(c: Client): boolean {
    const now = Date.now()
    c.tokens = Math.min(burst, c.tokens + ((now - c.lastRefill) / 1000) * perSec)
    c.lastRefill = now
    c.tokens -= 1
    return c.tokens >= 0
  }

  function protocolError(c: Client, reason: string): void {
    c.close(WS_CLOSE.protocol, reason)
  }

  function subscribe(c: Client, m: Extract<ClientMsg, { t: 'subscribe' }>): void {
    if (typeof m.sessionUid !== 'string' || !deps.sessionExists(m.sessionUid)) return hub.fail(c, m, new VesperError('not_found'))
    if (!c.subs.has(m.sessionUid) && c.subs.size >= MAX_SUBSCRIPTIONS) return hub.fail(c, m, new VesperError('rate_limited'))
    c.subs.add(m.sessionUid)
    // A watched session keeps its ring (never dropped while subscribed), so the head reported here stays the base
    // of the events that follow.
    const ring = ringOf(m.sessionUid)
    const evSeq = ring.evSeq
    let replayed = 0
    const since = m.sinceEvSeq
    if (typeof since === 'number' && since < evSeq && ring.events.length && since >= ring.events[0].evSeq - 1) {
      ring.lastUsed = deps.now()
      for (const e of ring.events) {
        if (e.evSeq <= since) continue
        c.send(e)
        replayed++
      }
    }
    c.send({ t: 'subscribed', sessionUid: m.sessionUid, evSeq, inflight: safeInflight(m.sessionUid), replayed })
    hub.ack(c, m)
  }

  function safeInflight(uid: string): InflightReply[] {
    try {
      return inflight(uid)
    } catch (e) {
      log.error('inflight provider failed', { error: e })
      return []
    }
  }

  function dispatch(c: Client, m: ClientMsg): void {
    let best: (typeof handlers)[number] | null = null
    for (const h of handlers) if (m.t.startsWith(h.prefix) && (!best || h.prefix.length > best.prefix.length)) best = h
    if (!best) return hub.fail(c, m as { id?: string }, new VesperError('not_implemented'))
    const fn = best.fn
    Promise.resolve()
      .then(() => fn(c, m))
      .catch((e: unknown) => {
        log.warn('handler failed', { t: m.t, error: e })
        hub.fail(c, m as { id?: string }, e)
      })
  }

  function onText(c: Client, text: string): void {
    let m: unknown
    try {
      m = JSON.parse(text)
    } catch {
      m = null
    }
    if (!isObj(m) || typeof m.t !== 'string') {
      if (!c.ready) return protocolError(c, 'expected hello')
      return c.send({ t: 'error', error: apiError('validation', { message: 'Malformed message' }) })
    }
    const msg = m as ClientMsg
    if (!c.ready) {
      if (msg.t !== 'hello' || msg.protocol !== WS_PROTOCOL) return protocolError(c, 'protocol mismatch')
      if (c.helloTimer) clearTimeout(c.helloTimer)
      c.helloTimer = null
      c.ready = true
      c.tz = typeof msg.tz === 'string' && msg.tz.length <= 64 ? msg.tz : null
      c.tzOffset = Number.isFinite(msg.tzOffset) ? Math.max(-900, Math.min(900, Math.trunc(msg.tzOffset))) : 0
      if (isObj(msg.client)) c.state = { visible: !!msg.client.visible, focused: !!msg.client.focused, audioUnlocked: !!msg.client.audioUnlocked }
      c.send({ t: 'ready', protocol: WS_PROTOCOL, serverTime: deps.now(), deviceId: c.device.id, bootId, clientId: c.id })
      return
    }
    if (msg.t === 'hello') return
    if (msg.t === 'pong') {
      c.awaitingPong = false
      c.missedPongs = 0
      return
    }
    // Anything but the automatic pong is the owner using this device (the idle limit must not sign out a socket-only
    // session that is in use). A frame that arrives after the session ended is dropped and the socket closed, so it
    // can neither act nor revive the session before the next tick.
    if (!seen(c)) return
    switch (msg.t) {
      case 'client.state':
        if (isObj(msg.client)) c.state = { visible: !!msg.client.visible, focused: !!msg.client.focused, audioUnlocked: !!msg.client.audioUnlocked }
        return
      case 'subscribe':
        return subscribe(c, msg)
      case 'unsubscribe':
        if (typeof msg.sessionUid === 'string') c.subs.delete(msg.sessionUid)
        return
      default:
        return dispatch(c, msg)
    }
  }

  /** Records activity; false (after closing with 4401) when the session behind the socket has ended. */
  function seen(c: Client): boolean {
    let ok: boolean
    try {
      ok = deps.seen ? deps.seen(c, c.ip) : deps.stillValid(c)
    } catch (e) {
      log.warn('activity update failed', { error: e })
      return true // a failed write is not a sign-out; the tick still re-validates
    }
    if (ok) return true
    c.close(WS_CLOSE.auth, 'session ended')
    return false
  }

  function onBinary(c: Client, bytes: Uint8Array): void {
    if (!c.ready) return protocolError(c, 'expected hello')
    if (!seen(c)) return
    let frame: ReturnType<typeof decodeBinary>
    try {
      frame = decodeBinary(bytes)
    } catch {
      return protocolError(c, 'bad binary frame')
    }
    const h = binHandlers.get(frame.kind)
    if (!h) return
    try {
      h(c, frame.header, frame.payload)
    } catch (e) {
      log.warn('binary handler failed', { kind: frame.kind, error: e })
    }
  }

  /** Changes on every server start, so reconnecting clients know evSeq counters restarted. */
  const bootId = randomBytes(8).toString('hex')

  const hub: HubImpl = {
    clients: () => clients.values(),
    client: (id) => clients.get(id),
    emit(sessionUid, msg, opts) {
      const ring = ringOf(sessionUid)
      ring.lastUsed = deps.now()
      // Events for only some sockets are UNSEQUENCED (evSeq 0, not replayable): consuming the shared counter would make
      // every other subscriber see a gap and refetch (07 C16 note).
      const except = opts?.except
      const targeted = !!(opts?.only || (typeof except === 'string' ? except : except?.size))
      let full: ServerMsg & { evSeq: number }
      if (targeted) full = { ...msg, sessionUid, evSeq: 0 } as ServerMsg & { evSeq: number }
      else {
        ring.evSeq++
        full = { ...msg, sessionUid, evSeq: ring.evSeq } as ServerMsg & { evSeq: number }
        ring.events.push(full)
        if (ring.events.length > ringSize) ring.events.splice(0, ring.events.length - ringSize)
      }
      const text = JSON.stringify(full)
      for (const c of clients.values()) {
        if (!c.ready || !c.subs.has(sessionUid)) continue
        if (excluded(except, c.id) || (opts?.only && opts.only !== c.id)) continue
        if (c.ws.readyState === OPEN) c.ws.send(text)
      }
    },
    broadcast(msg, opts) {
      const text = JSON.stringify(msg)
      for (const c of clients.values()) {
        if (!c.ready) continue
        if (opts?.clientId && c.id !== opts.clientId) continue
        if (opts?.deviceId && c.device.id !== opts.deviceId) continue
        if (opts?.desktopOnly && !c.isDesktop) continue
        if (c.ws.readyState === OPEN) c.ws.send(text)
      }
    },
    on(prefix, handler) {
      handlers.push({ prefix, fn: handler })
    },
    onBinary(kind, handler) {
      binHandlers.set(kind, handler)
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler)
    },
    closeDevice(deviceId, code, reason) {
      for (const c of clients.values()) if (c.device.id === deviceId) c.close(code, reason)
    },
    setInflightProvider(fn) {
      inflight = fn
    },
    ack(client, msg, extra) {
      if (typeof msg.id === 'string') client.send({ t: 'ack', id: msg.id, ...extra })
    },
    fail(client, msg, e) {
      const error = deps.toApiError(e)
      client.send(typeof msg.id === 'string' ? { t: 'error', id: msg.id, error } : { t: 'error', error })
    },
    attach(ws, info) {
      const c = new Client(ws, info.device, info.listener, info.isDesktop, info.ip ?? null, burst, Date.now())
      clients.set(c.id, c)
      c.helloTimer = setTimeout(() => protocolError(c, 'hello timeout'), helloMs)
      c.helloTimer.unref()
      ws.on('message', (data, isBinary) => {
        if (!rateOk(c)) {
          c.close(WS_CLOSE.rate, 'too many messages')
          return
        }
        if (isBinary) onBinary(c, toBytes(data))
        else onText(c, Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(toBytes(data)).toString('utf8'))
      })
      ws.on('error', (err) => log.debug('socket error', { error: err }))
      ws.on('close', () => {
        if (c.helloTimer) clearTimeout(c.helloTimer)
        if (!clients.delete(c.id)) return
        for (const h of disconnectHandlers) {
          try {
            h(c)
          } catch (e) {
            log.error('disconnect handler failed', { error: e })
          }
        }
      })
      return c
    },
    stats() {
      let subscriptions = 0
      for (const c of clients.values()) subscriptions += c.subs.size
      return { clients: clients.size, subscriptions, rings: rings.size }
    },
    dropSession(uid) {
      drop(uid)
      for (const c of clients.values()) c.subs.delete(uid)
    },
    close() {
      clearInterval(timer)
      for (const c of clients.values()) {
        c.close(1001, 'server shutting down')
        // A peer that never answers the close frame must not hold the shutdown open.
        setTimeout(() => c.ws.terminate(), 1000).unref()
      }
    }
  }
  return hub
}
