/**
 * The WebSocket client core (07 C16), free of DOM types so it runs under vitest with a fake socket and fake timers.
 * web/lib/ws.ts wires it to the browser (WebSocket, visibility/focus, online events).
 *
 * Responsibilities:
 * - one socket to /ws; `hello` on open, `ready` → usable; reconnect with jittered backoff 0.5 s → 10 s;
 * - session subscriptions survive reconnects: resubscribe with `sinceEvSeq` = the last evSeq seen per session;
 * - gap detection: an evSeq jump means events were lost → resubscribe without `sinceEvSeq` and tell listeners to
 *   refetch (`onResync`); duplicates (evSeq ≤ last) are dropped;
 * - request/ack correlation by id with a timeout; `ping` → `pong`; liveness timeout for half-open sockets;
 * - typed `on(type, cb)` / `onBinary(kind, cb)` returning unsubscribe functions (no listener leaks).
 */
import { apiError, type ApiError } from '@shared/errors'
import {
  decodeBinary,
  PING_INTERVAL_MS,
  WS_CLOSE,
  WS_PROTOCOL,
  type BinKind,
  type ClientMsg,
  type ClientState,
  type ServerMsg,
  type ServerMsgType
} from '@shared/ws'
import { ApiErrorException } from './errors.logic'

// ── backoff ───────────────────────────────────────────────────────────────────────────────────
export const BACKOFF_MIN_MS = 500
export const BACKOFF_MAX_MS = 10_000

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential from 0.5 s, capped at 10 s, with "equal jitter"
 * (half fixed, half random) so several tabs/devices don't reconnect in lockstep after a server restart.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 16)))
  const jittered = base / 2 + random() * (base / 2)
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)))
}

// ── evSeq tracking ────────────────────────────────────────────────────────────────────────────
export type SeqVerdict = 'accept' | 'duplicate' | 'gap' | 'resyncing' | 'untracked'

interface SeqState {
  /** Last evSeq applied; null until the first event or `subscribed`. */
  last: number | null
  /** sinceEvSeq sent with the outstanding subscribe (null = fresh subscribe). */
  since: number | null
  /** After a gap: drop events until the fresh `subscribed` arrives. */
  resyncing: boolean
}

/** Per-session evSeq bookkeeping. Pure; WsClient drives it. */
export class SeqTracker {
  private readonly map = new Map<string, SeqState>()

  track(uid: string): void {
    if (!this.map.has(uid)) this.map.set(uid, { last: null, since: null, resyncing: false })
  }

  forget(uid: string): void {
    this.map.delete(uid)
  }

  /** The server restarted (new bootId): every resume point is meaningless; resubscribe fresh and refetch. */
  resetAll(): void {
    for (const s of this.map.values()) {
      s.last = null
      s.since = null
      s.resyncing = false
    }
  }

  has(uid: string): boolean {
    return this.map.has(uid)
  }

  /** The evSeq to resume from on (re)subscribe, if any. */
  resumeFrom(uid: string): number | undefined {
    const s = this.map.get(uid)
    return s && !s.resyncing && s.last !== null ? s.last : undefined
  }

  /** Record what the outgoing subscribe asked for. */
  subscribing(uid: string, since: number | undefined): void {
    const s = this.map.get(uid)
    if (s) s.since = since ?? null
  }

  /** A gap was seen: the next subscribe is fresh and events are dropped until it is answered. */
  startResync(uid: string): void {
    const s = this.map.get(uid)
    if (!s) return
    s.resyncing = true
    s.since = null
  }

  onEvent(uid: string, evSeq: number): SeqVerdict {
    const s = this.map.get(uid)
    if (!s) return 'untracked'
    if (s.resyncing) return 'resyncing'
    // Targeted events (sent to only some sockets) are unsequenced: deliver without touching the counter.
    if (evSeq === 0) return 'accept'
    if (s.last === null || evSeq === s.last + 1) {
      s.last = evSeq
      return 'accept'
    }
    if (evSeq <= s.last) return 'duplicate'
    return 'gap'
  }

  /**
   * `subscribed {evSeq: head, replayed}` arrived. Returns `stale: true` when the client must refetch: after a gap
   * resync, when the server couldn't replay everything since `sinceEvSeq` (ring overflow), or when the head is behind
   * what we asked for (the server restarted and its counters reset).
   */
  onSubscribed(uid: string, head: number, replayed: number): { stale: boolean } {
    const s = this.map.get(uid)
    if (!s) return { stale: false }
    const wasResyncing = s.resyncing
    s.resyncing = false
    const since = s.since
    s.since = null
    if (since === null) {
      s.last = s.last === null || wasResyncing ? head : Math.max(s.last, head)
      return { stale: wasResyncing }
    }
    if (head < since || head - since > replayed) {
      s.last = head
      return { stale: true }
    }
    // Resume is complete: replayed events arrive (before or after this message) contiguously from `since`.
    if (s.last === null) s.last = since
    return { stale: wasResyncing }
  }
}

// ── socket abstraction ────────────────────────────────────────────────────────────────────────
export interface SocketHandlers {
  open(): void
  message(data: unknown): void
  close(code: number, reason: string): void
  error(): void
}

export interface SocketHandle {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface WsDeps {
  url(): string
  createSocket(url: string, handlers: SocketHandlers): SocketHandle
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
  random(): number
  clientState(): ClientState
  zone(): { tz: string | null; tzOffset: number }
  deviceName?(): string | undefined
  /** A listener threw; the client keeps going. */
  reportError?(err: unknown): void
}

// ── public types ──────────────────────────────────────────────────────────────────────────────
export type WsStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  /** 4401: the session cookie is gone or revoked — sign in again. */
  | 'unauthorized'
  /** 4409: client/server protocol mismatch — reload the page. */
  | 'incompatible'
  /** 4410: another socket for this client replaced this one. */
  | 'replaced'
  | 'closed'

export interface WsConnInfo {
  status: WsStatus
  /** Consecutive failed attempts since the last `ready`. */
  attempt: number
  /** When the next reconnect attempt fires (ms epoch), while reconnecting. */
  nextRetryAt: number | null
  lastCloseCode: number | null
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** Client messages that carry a request id (answered with `ack` or `error`). */
export type RequestMsg = ClientMsg extends infer M ? (M extends unknown ? ('id' extends keyof M ? M : never) : never) : never
export type RequestBody = DistributiveOmit<RequestMsg, 'id'>
export type Ack = Extract<ServerMsg, { t: 'ack' }>
export type MsgOf<T extends ServerMsgType> = Extract<ServerMsg, { t: T }>
export type ResyncReason = 'gap' | 'stale'

export const REQUEST_TIMEOUT_MS = 15_000
export const HANDSHAKE_TIMEOUT_MS = 10_000
/** Two missed pings (07 C16) plus slack → treat the socket as dead even if TCP hasn't noticed. */
export const LIVENESS_TIMEOUT_MS = 2 * PING_INTERVAL_MS + 5_000

interface Pending {
  resolve(ack: Ack): void
  reject(err: unknown): void
  timer: unknown
  msg: ClientMsg
  sent: boolean
  /** Safe to send again (the server dedupes it, F62): a drop re-queues it instead of failing it. */
  resend: boolean
}

function hasSessionSeq(x: unknown): x is { sessionUid: string; evSeq: number } {
  if (!x || typeof x !== 'object') return false
  const o = x as { sessionUid?: unknown; evSeq?: unknown }
  return typeof o.sessionUid === 'string' && typeof o.evSeq === 'number'
}

export class WsClient {
  private readonly deps: WsDeps
  private socket: SocketHandle | null = null
  private socketGen = 0
  private info: WsConnInfo = { status: 'idle', attempt: 0, nextRetryAt: null, lastCloseCode: null }
  private manualClose = false
  private retryTimer: unknown = null
  private handshakeTimer: unknown = null
  private livenessTimer: unknown = null

  private readonly listeners = new Map<string, Set<(msg: ServerMsg) => void>>()
  private readonly anyListeners = new Set<(msg: ServerMsg) => void>()
  private readonly binaryListeners = new Map<number, Set<(header: unknown, payload: Uint8Array) => void>>()
  private readonly statusListeners = new Set<(info: WsConnInfo) => void>()
  private readonly resyncListeners = new Set<(sessionUid: string, reason: ResyncReason) => void>()
  /** Server boot id from the last `ready` (null before the first). */
  private bootId: string | null = null
  /** This socket's id on the server (`ready.clientId`, additive) — names this tab, e.g. as the /continue speaker. */
  private ownId: string | null = null
  private readonly subscribeErrorListeners = new Set<(sessionUid: string, error: ApiError) => void>()

  private readonly subs = new Map<string, number>()
  readonly seq = new SeqTracker()
  /** subscribe request id → session, to route a subscribe `error` to the right session. */
  private readonly subscribeIds = new Map<string, string>()

  private readonly pending = new Map<string, Pending>()
  private idCounter = 0
  private lastClientState: string | null = null

  constructor(deps: WsDeps) {
    this.deps = deps
  }

  // ── lifecycle ──
  get status(): WsStatus {
    return this.info.status
  }

  get conn(): WsConnInfo {
    return this.info
  }

  connected(): boolean {
    return this.info.status === 'ready'
  }

  /** The server's id for this tab's socket while ready (null otherwise, or from an older server). */
  get clientId(): string | null {
    return this.info.status === 'ready' ? this.ownId : null
  }

  /** Open the socket (no-op while one is open or pending). */
  start(): void {
    this.manualClose = false
    if (this.socket || this.retryTimer !== null) return
    this.open()
  }

  /** Close for good (sign-out, page teardown). Pending requests fail with `network`. */
  stop(): void {
    this.manualClose = true
    this.clearTimer('retryTimer')
    this.clearTimer('handshakeTimer')
    this.clearTimer('livenessTimer')
    const s = this.socket
    this.socket = null
    this.socketGen++
    s?.close(1000, 'client stop')
    this.failPending(true)
    this.setInfo({ status: 'closed', nextRetryAt: null })
  }

  /** Skip the remaining backoff (network came back, tab became visible, user clicked "Retry now"). */
  retryNow(): void {
    if (this.manualClose || this.socket) return
    if (this.info.status === 'unauthorized' || this.info.status === 'incompatible' || this.info.status === 'replaced') return
    this.clearTimer('retryTimer')
    this.open()
  }

  /** Test hook: drop the socket as if the network failed (reconnect logic runs). */
  simulateDrop(): void {
    if (this.socket) this.abandonSocket(4000, 'simulated drop')
  }

  private open(): void {
    const gen = ++this.socketGen
    this.setInfo({ status: this.info.attempt > 0 || this.info.status === 'reconnecting' ? 'reconnecting' : 'connecting', nextRetryAt: null })
    const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
      if (gen === this.socketGen) fn(...a)
    }
    try {
      this.socket = this.deps.createSocket(this.deps.url(), {
        open: guard(() => this.onOpen()),
        message: guard((data: unknown) => this.onMessage(data)),
        close: guard((code: number, reason: string) => this.onClose(code, reason)),
        error: guard(() => undefined)
      })
    } catch (e) {
      this.deps.reportError?.(e)
      this.socket = null
      this.scheduleReconnect(false)
      return
    }
    this.handshakeTimer = this.deps.setTimeout(() => {
      this.handshakeTimer = null
      if (gen === this.socketGen && this.info.status !== 'ready') this.abandonSocket(4000, 'handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
  }

  private onOpen(): void {
    const zone = this.deps.zone()
    const client = this.deps.clientState()
    this.lastClientState = JSON.stringify(client)
    const name = this.deps.deviceName?.()
    this.rawSend({ t: 'hello', protocol: WS_PROTOCOL, tz: zone.tz, tzOffset: zone.tzOffset, client, ...(name ? { deviceName: name } : {}) })
    this.bumpLiveness()
  }

  private onClose(code: number, _reason: string): void {
    this.clearTimer('handshakeTimer')
    this.clearTimer('livenessTimer')
    this.socket = null
    this.socketGen++
    this.failPending(false)
    this.info = { ...this.info, lastCloseCode: code }
    if (this.manualClose) {
      this.setInfo({ status: 'closed', nextRetryAt: null })
      return
    }
    if (code === WS_CLOSE.auth) return this.setInfo({ status: 'unauthorized', nextRetryAt: null })
    if (code === WS_CLOSE.protocol) return this.setInfo({ status: 'incompatible', nextRetryAt: null })
    if (code === WS_CLOSE.replaced) return this.setInfo({ status: 'replaced', nextRetryAt: null })
    this.scheduleReconnect(code === WS_CLOSE.rate)
  }

  /** Forget a socket that may be half-open: detach it, then run the normal close path. */
  private abandonSocket(code: number, reason: string): void {
    const s = this.socket
    this.socketGen++
    this.socket = null
    try {
      s?.close(code, reason)
    } catch {
      // already closed
    }
    // onClose's guard no longer matches; run the bookkeeping ourselves.
    this.clearTimer('handshakeTimer')
    this.clearTimer('livenessTimer')
    this.failPending(false)
    this.info = { ...this.info, lastCloseCode: code }
    if (!this.manualClose) this.scheduleReconnect(false)
  }

  private scheduleReconnect(slow: boolean): void {
    const attempt = this.info.attempt
    const delay = slow ? BACKOFF_MAX_MS : backoffDelay(attempt, () => this.deps.random())
    this.clearTimer('retryTimer')
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
    this.setInfo({ status: 'reconnecting', attempt: attempt + 1, nextRetryAt: this.deps.now() + delay })
  }

  private bumpLiveness(): void {
    this.clearTimer('livenessTimer')
    const gen = this.socketGen
    this.livenessTimer = this.deps.setTimeout(() => {
      this.livenessTimer = null
      if (gen === this.socketGen && this.socket) this.abandonSocket(4000, 'liveness timeout')
    }, LIVENESS_TIMEOUT_MS)
  }

  // ── incoming ──
  private onMessage(data: unknown): void {
    this.bumpLiveness()
    if (typeof data === 'string') {
      let msg: ServerMsg
      try {
        msg = JSON.parse(data) as ServerMsg
      } catch (e) {
        this.deps.reportError?.(e)
        return
      }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') this.handle(msg)
      return
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) this.handleBinary(data)
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'ready':
        this.clearTimer('handshakeTimer')
        if (this.bootId !== null && msg.bootId !== this.bootId) {
          this.seq.resetAll()
          for (const uid of this.subs.keys()) this.emitResync(uid, 'stale')
        }
        this.bootId = msg.bootId
        this.ownId = typeof msg.clientId === 'string' ? msg.clientId : null
        this.setInfo({ status: 'ready', attempt: 0, nextRetryAt: null })
        for (const uid of this.subs.keys()) this.sendSubscribe(uid)
        this.flushPending()
        break
      case 'ping':
        this.rawSend({ t: 'pong', ts: msg.ts })
        return
      case 'ack': {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          this.deps.clearTimeout(p.timer)
          p.resolve(msg)
        }
        break
      }
      case 'error': {
        if (msg.id) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            this.deps.clearTimeout(p.timer)
            p.reject(new ApiErrorException(msg.error, 0))
          }
          const uid = this.subscribeIds.get(msg.id)
          if (uid !== undefined) {
            this.subscribeIds.delete(msg.id)
            for (const cb of [...this.subscribeErrorListeners]) {
              try {
                cb(uid, msg.error)
              } catch (e) {
                this.deps.reportError?.(e)
              }
            }
          }
        }
        break
      }
      case 'subscribed': {
        for (const [id, uid] of this.subscribeIds) if (uid === msg.sessionUid) this.subscribeIds.delete(id)
        const { stale } = this.seq.onSubscribed(msg.sessionUid, msg.evSeq, msg.replayed)
        this.dispatch(msg)
        if (stale) this.emitResync(msg.sessionUid, 'stale')
        return
      }
      default:
        break
    }
    if (hasSessionSeq(msg)) {
      const verdict = this.seq.onEvent(msg.sessionUid, msg.evSeq)
      if (verdict === 'duplicate' || verdict === 'resyncing') return
      if (verdict === 'gap') {
        this.resync(msg.sessionUid)
        return
      }
    }
    this.dispatch(msg)
  }

  private handleBinary(data: ArrayBuffer | Uint8Array): void {
    let frame: { kind: BinKind; header: unknown; payload: Uint8Array }
    try {
      frame = decodeBinary(data)
    } catch (e) {
      this.deps.reportError?.(e)
      return
    }
    if (hasSessionSeq(frame.header)) {
      const verdict = this.seq.onEvent(frame.header.sessionUid, frame.header.evSeq)
      if (verdict === 'duplicate' || verdict === 'resyncing') return
      if (verdict === 'gap') {
        this.resync(frame.header.sessionUid)
        return
      }
    }
    const set = this.binaryListeners.get(frame.kind)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(frame.header, frame.payload)
      } catch (e) {
        this.deps.reportError?.(e)
      }
    }
  }

  private dispatch(msg: ServerMsg): void {
    const set = this.listeners.get(msg.t)
    if (set) {
      for (const cb of [...set]) {
        try {
          cb(msg)
        } catch (e) {
          this.deps.reportError?.(e)
        }
      }
    }
    for (const cb of [...this.anyListeners]) {
      try {
        cb(msg)
      } catch (e) {
        this.deps.reportError?.(e)
      }
    }
  }

  private resync(uid: string): void {
    this.seq.startResync(uid)
    this.sendSubscribe(uid)
    this.emitResync(uid, 'gap')
  }

  private emitResync(uid: string, reason: ResyncReason): void {
    for (const cb of [...this.resyncListeners]) {
      try {
        cb(uid, reason)
      } catch (e) {
        this.deps.reportError?.(e)
      }
    }
  }

  // ── listeners ──
  on<T extends ServerMsgType>(type: T, cb: (msg: MsgOf<T>) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const fn = cb as (msg: ServerMsg) => void
    set.add(fn)
    return () => {
      const s = this.listeners.get(type)
      if (!s) return
      s.delete(fn)
      if (s.size === 0) this.listeners.delete(type)
    }
  }

  onAny(cb: (msg: ServerMsg) => void): () => void {
    this.anyListeners.add(cb)
    return () => void this.anyListeners.delete(cb)
  }

  onBinary(kind: BinKind, cb: (header: unknown, payload: Uint8Array) => void): () => void {
    let set = this.binaryListeners.get(kind)
    if (!set) {
      set = new Set()
      this.binaryListeners.set(kind, set)
    }
    set.add(cb)
    return () => {
      const s = this.binaryListeners.get(kind)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.binaryListeners.delete(kind)
    }
  }

  onStatus(cb: (info: WsConnInfo) => void): () => void {
    this.statusListeners.add(cb)
    return () => void this.statusListeners.delete(cb)
  }

  /** Events were lost for this session: refetch its state over REST (the fresh `subscribed` carries in-flight replies). */
  onResync(cb: (sessionUid: string, reason: ResyncReason) => void): () => void {
    this.resyncListeners.add(cb)
    return () => void this.resyncListeners.delete(cb)
  }

  /** The server refused a subscribe (e.g. `not_found`, `forbidden`). */
  onSubscribeError(cb: (sessionUid: string, error: ApiError) => void): () => void {
    this.subscribeErrorListeners.add(cb)
    return () => void this.subscribeErrorListeners.delete(cb)
  }

  /** Listener counts, for leak tests. */
  stats(): { listeners: number; binary: number; status: number; resync: number; subscriptions: number; pending: number } {
    let listeners = this.anyListeners.size
    for (const s of this.listeners.values()) listeners += s.size
    let binary = 0
    for (const s of this.binaryListeners.values()) binary += s.size
    return {
      listeners,
      binary,
      status: this.statusListeners.size,
      resync: this.resyncListeners.size + this.subscribeErrorListeners.size,
      subscriptions: this.subs.size,
      pending: this.pending.size
    }
  }

  // ── subscriptions ──
  /** Ref-counted: several views may follow one session; the last unsubscribe tells the server. */
  subscribe(sessionUid: string): () => void {
    const n = this.subs.get(sessionUid) ?? 0
    this.subs.set(sessionUid, n + 1)
    if (n === 0) {
      this.seq.track(sessionUid)
      if (this.connected()) this.sendSubscribe(sessionUid)
    }
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.subs.get(sessionUid) ?? 1) - 1
      if (left > 0) {
        this.subs.set(sessionUid, left)
        return
      }
      this.subs.delete(sessionUid)
      this.seq.forget(sessionUid)
      for (const [id, uid] of this.subscribeIds) if (uid === sessionUid) this.subscribeIds.delete(id)
      if (this.connected()) this.rawSend({ t: 'unsubscribe', sessionUid })
    }
  }

  isSubscribed(sessionUid: string): boolean {
    return this.subs.has(sessionUid)
  }

  private sendSubscribe(uid: string): void {
    if (!this.connected()) return
    const since = this.seq.resumeFrom(uid)
    this.seq.subscribing(uid, since)
    const id = this.nextId('s')
    this.subscribeIds.set(id, uid)
    const msg: ClientMsg = since === undefined ? { t: 'subscribe', id, sessionUid: uid } : { t: 'subscribe', id, sessionUid: uid, sinceEvSeq: since }
    this.rawSend(msg)
  }

  // ── outgoing ──
  /** Fire-and-forget; dropped (returns false) unless the socket is ready. */
  send(msg: ClientMsg): boolean {
    if (!this.connected()) return false
    return this.rawSend(msg)
  }

  /** Binary frame (mic PCM); dropped unless ready. */
  sendBinary(bytes: Uint8Array): boolean {
    if (!this.connected() || !this.socket) return false
    try {
      this.socket.send(bytes)
      return true
    } catch (e) {
      this.deps.reportError?.(e)
      return false
    }
  }

  /**
   * Send a request and resolve with its `ack` (reject with ApiErrorException on `error` or timeout). While
   * disconnected the request waits for the next `ready` within the same timeout. A request that was already on the
   * wire when the socket dropped fails with `network` — the server may or may not have acted on it — unless it is
   * `resend`able (the server answers a repeat with the original ack, F62): then the very same frame is sent again on
   * the next `ready`, and only the timeout fails it.
   */
  request(body: RequestBody, opts: { timeoutMs?: number; resend?: boolean } = {}): Promise<Ack> {
    const id = this.nextId('r')
    const msg = { ...body, id } as ClientMsg
    return new Promise<Ack>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new ApiErrorException(apiError('network', { message: "Vesper didn't answer in time." }), 0))
      }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const p: Pending = { resolve, reject, timer, msg, sent: false, resend: opts.resend === true }
      this.pending.set(id, p)
      if (this.connected()) p.sent = this.rawSend(msg)
    })
  }

  /** Recompute the client state (visibility/focus/audio) and tell the server if it changed. */
  updateClientState(): void {
    const client = this.deps.clientState()
    const key = JSON.stringify(client)
    if (key === this.lastClientState) return
    if (this.send({ t: 'client.state', client })) this.lastClientState = key
  }

  private flushPending(): void {
    for (const p of this.pending.values()) if (!p.sent) p.sent = this.rawSend(p.msg)
  }

  /** On close: requests already on the wire fail (resendable ones wait again); queued ones keep waiting (unless `all`). */
  private failPending(all: boolean): void {
    for (const [id, p] of this.pending) {
      if (!all && p.sent && p.resend) p.sent = false
      if (!all && !p.sent) continue
      this.pending.delete(id)
      this.deps.clearTimeout(p.timer)
      p.reject(new ApiErrorException(apiError('network', { message: 'The connection to Vesper was lost.' }), 0))
    }
  }

  private rawSend(msg: ClientMsg): boolean {
    if (!this.socket) return false
    try {
      this.socket.send(JSON.stringify(msg))
      return true
    } catch (e) {
      this.deps.reportError?.(e)
      return false
    }
  }

  private nextId(prefix: string): string {
    this.idCounter = (this.idCounter + 1) % Number.MAX_SAFE_INTEGER
    return `${prefix}${this.idCounter.toString(36)}`
  }

  private setInfo(patch: Partial<WsConnInfo>): void {
    const next = { ...this.info, ...patch }
    const changed =
      next.status !== this.info.status || next.attempt !== this.info.attempt || next.nextRetryAt !== this.info.nextRetryAt
    this.info = next
    if (!changed) return
    for (const cb of [...this.statusListeners]) {
      try {
        cb(next)
      } catch (e) {
        this.deps.reportError?.(e)
      }
    }
  }

  private clearTimer(which: 'retryTimer' | 'handshakeTimer' | 'livenessTimer'): void {
    const h = this[which]
    if (h !== null) this.deps.clearTimeout(h)
    this[which] = null
  }
}
