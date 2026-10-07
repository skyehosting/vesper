import { beforeEach, describe, expect, it } from 'vitest'
import { BIN_KIND, encodeBinary, WS_PROTOCOL, type ClientMsg, type ServerMsg } from '@shared/ws'
import type { ApiErrorException } from '../../../src/web/lib/errors.logic'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffDelay,
  LIVENESS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SeqTracker,
  WsClient,
  type SocketHandlers,
  type WsDeps
} from '../../../src/web/lib/ws.logic'

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────
class FakeClock {
  t = 1_000_000
  private seq = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number)
  }
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      this.timers.delete(next[0])
      this.t = next[1].at
      next[1].fn()
    }
    this.t = end
  }
}

class FakeSocket {
  sent: (string | Uint8Array)[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(
    readonly url: string,
    readonly h: SocketHandlers
  ) {}
  send(d: string | Uint8Array): void {
    this.sent.push(d)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
  /** Client → server JSON messages. */
  msgs(): ClientMsg[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as ClientMsg)
  }
  last(): ClientMsg | undefined {
    const m = this.msgs()
    return m[m.length - 1]
  }
  recv(msg: ServerMsg): void {
    this.h.message(JSON.stringify(msg))
  }
}

function setup(): { client: WsClient; clock: FakeClock; sockets: FakeSocket[]; errors: unknown[]; open(): FakeSocket } {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const errors: unknown[] = []
  const deps: WsDeps = {
    url: () => 'ws://127.0.0.1:41730/ws',
    createSocket: (url, h) => {
      const s = new FakeSocket(url, h)
      sockets.push(s)
      return s
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.t,
    random: () => 0.5,
    clientState: () => ({ visible: true, focused: true, audioUnlocked: false }),
    zone: () => ({ tz: 'America/New_York', tzOffset: -240 }),
    reportError: (e) => errors.push(e)
  }
  const client = new WsClient(deps)
  const open = (): FakeSocket => {
    const s = sockets[sockets.length - 1]
    s.h.open()
    s.recv({ t: 'ready', protocol: WS_PROTOCOL, serverTime: clock.t, deviceId: 'd1', bootId: 'boot-1' })
    return s
  }
  return { client, clock, sockets, errors, open }
}

const subscribed = (sessionUid: string, evSeq: number, replayed = 0): ServerMsg => ({ t: 'subscribed', sessionUid, evSeq, inflight: [], replayed })
const delta = (sessionUid: string, evSeq: number, text = 'x'): ServerMsg => ({ t: 'reply.delta', sessionUid, evSeq, replyId: 'r1', text })

// ── backoff ────────────────────────────────────────────────────────────────────────────────────
describe('backoffDelay', () => {
  it('starts at 0.5 s, doubles, caps at 10 s, never leaves [min, max]', () => {
    expect(backoffDelay(0, () => 0)).toBe(BACKOFF_MIN_MS)
    expect(backoffDelay(0, () => 1)).toBe(BACKOFF_MIN_MS)
    expect(backoffDelay(1, () => 1)).toBe(1000)
    expect(backoffDelay(3, () => 1)).toBe(4000)
    expect(backoffDelay(10, () => 1)).toBe(BACKOFF_MAX_MS)
    expect(backoffDelay(50, () => 1)).toBe(BACKOFF_MAX_MS)
    for (let a = 0; a < 30; a++) {
      for (const r of [0, 0.3, 0.999]) {
        const d = backoffDelay(a, () => r)
        expect(d).toBeGreaterThanOrEqual(BACKOFF_MIN_MS)
        expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS)
      }
    }
  })

  it('jitters within the upper half of the step', () => {
    expect(backoffDelay(4, () => 0)).toBe(4000)
    expect(backoffDelay(4, () => 1)).toBe(8000)
  })
})

// ── evSeq tracking ─────────────────────────────────────────────────────────────────────────────
describe('SeqTracker', () => {
  let t: SeqTracker
  beforeEach(() => {
    t = new SeqTracker()
    t.track('s')
  })

  it('accepts contiguous events and drops duplicates', () => {
    t.subscribing('s', undefined)
    expect(t.onSubscribed('s', 10, 0)).toEqual({ stale: false })
    expect(t.onEvent('s', 11)).toBe('accept')
    expect(t.onEvent('s', 12)).toBe('accept')
    expect(t.onEvent('s', 12)).toBe('duplicate')
    expect(t.onEvent('s', 5)).toBe('duplicate')
    expect(t.resumeFrom('s')).toBe(12)
  })

  it('reports a jump as a gap and drops events until the fresh subscribe is answered', () => {
    t.onSubscribed('s', 10, 0)
    expect(t.onEvent('s', 13)).toBe('gap')
    t.startResync('s')
    expect(t.resumeFrom('s')).toBeUndefined()
    expect(t.onEvent('s', 14)).toBe('resyncing')
    expect(t.onSubscribed('s', 20, 0)).toEqual({ stale: true })
    expect(t.onEvent('s', 21)).toBe('accept')
  })

  it('resumes from sinceEvSeq when the server replays everything', () => {
    t.onSubscribed('s', 10, 0)
    t.subscribing('s', 10)
    expect(t.onSubscribed('s', 14, 4)).toEqual({ stale: false })
    // replayed events arrive after `subscribed`
    for (const n of [11, 12, 13, 14]) expect(t.onEvent('s', n)).toBe('accept')
  })

  it('also accepts replayed events that arrive before `subscribed`', () => {
    t.onSubscribed('s', 10, 0)
    t.subscribing('s', 10)
    expect(t.onEvent('s', 11)).toBe('accept')
    expect(t.onEvent('s', 12)).toBe('accept')
    expect(t.onSubscribed('s', 12, 2)).toEqual({ stale: false })
    expect(t.onEvent('s', 13)).toBe('accept')
  })

  it('is stale when the ring could not replay everything', () => {
    t.onSubscribed('s', 10, 0)
    t.subscribing('s', 10)
    expect(t.onSubscribed('s', 900, 512)).toEqual({ stale: true })
    expect(t.onEvent('s', 901)).toBe('accept')
  })

  it('is stale when the server restarted (head behind what we had)', () => {
    t.onSubscribed('s', 300, 0)
    t.subscribing('s', 300)
    expect(t.onSubscribed('s', 2, 0)).toEqual({ stale: true })
    expect(t.onEvent('s', 3)).toBe('accept')
  })

  it('ignores sessions it does not track', () => {
    expect(t.onEvent('other', 1)).toBe('untracked')
  })
})

// ── client ─────────────────────────────────────────────────────────────────────────────────────
describe('WsClient', () => {
  it('sends hello with protocol, zone and client state, then becomes ready', () => {
    const { client, sockets, open } = setup()
    const seen: string[] = []
    client.onStatus((i) => seen.push(i.status))
    client.start()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('ws://127.0.0.1:41730/ws')
    const s = open()
    expect(s.msgs()[0]).toEqual({
      t: 'hello',
      protocol: WS_PROTOCOL,
      tz: 'America/New_York',
      tzOffset: -240,
      client: { visible: true, focused: true, audioUnlocked: false }
    })
    expect(client.connected()).toBe(true)
    expect(seen).toEqual(['connecting', 'ready'])
  })

  it('knows its own server client id while ready (ready.clientId, fix5-client P22)', () => {
    const { client, clock, sockets } = setup()
    client.start()
    expect(client.clientId).toBeNull()
    sockets[0].h.open()
    sockets[0].recv({ t: 'ready', protocol: WS_PROTOCOL, serverTime: clock.t, deviceId: 'd1', bootId: 'boot-1', clientId: 'c_one' })
    expect(client.clientId).toBe('c_one')
    sockets[0].h.close(1006, '')
    expect(client.clientId).toBeNull()
    clock.advance(BACKOFF_MIN_MS)
    sockets[1].h.open()
    sockets[1].recv({ t: 'ready', protocol: WS_PROTOCOL, serverTime: clock.t, deviceId: 'd1', bootId: 'boot-1', clientId: 'c_two' })
    expect(client.clientId).toBe('c_two')
  })

  it('answers ping with pong', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    s.recv({ t: 'ping', ts: 42 })
    expect(s.last()).toEqual({ t: 'pong', ts: 42 })
  })

  it('reconnects with backoff and resubscribes with the last evSeq', () => {
    const { client, clock, sockets, open } = setup()
    client.start()
    let s = open()
    client.subscribe('sess')
    const sub = s.last() as Extract<ClientMsg, { t: 'subscribe' }>
    expect(sub).toMatchObject({ t: 'subscribe', sessionUid: 'sess' })
    expect(sub.sinceEvSeq).toBeUndefined()
    s.recv(subscribed('sess', 5))
    s.recv(delta('sess', 6))
    s.recv(delta('sess', 7))

    s.h.close(1006, '')
    expect(client.status).toBe('reconnecting')
    expect(client.conn.attempt).toBe(1)
    expect(sockets).toHaveLength(1)
    clock.advance(BACKOFF_MIN_MS - 1)
    expect(sockets).toHaveLength(1)
    clock.advance(1)
    expect(sockets).toHaveLength(2)
    s = open()
    expect(s.msgs().find((m) => m.t === 'subscribe')).toMatchObject({ t: 'subscribe', sessionUid: 'sess', sinceEvSeq: 7 })
    expect(client.conn.attempt).toBe(0)
  })

  it('grows the delay over consecutive failures', () => {
    const { client, clock, sockets } = setup()
    client.start()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = clock.t
      sockets[sockets.length - 1].h.close(1006, '')
      const at = client.conn.nextRetryAt ?? 0
      delays.push(at - before)
      clock.advance(at - before)
    }
    expect(delays).toEqual([500, 750, 1500, 3000, 6000, 7500])
  })

  it('stops reconnecting on 4401 (auth), 4409 (protocol) and 4410 (replaced)', () => {
    for (const [code, status] of [
      [4401, 'unauthorized'],
      [4409, 'incompatible'],
      [4410, 'replaced']
    ] as const) {
      const { client, clock, sockets, open } = setup()
      client.start()
      open().h.close(code, '')
      expect(client.status).toBe(status)
      clock.advance(60_000)
      expect(sockets).toHaveLength(1)
      client.retryNow()
      expect(sockets).toHaveLength(1)
    }
  })

  it('waits the maximum after 4429 (rate limited)', () => {
    const { client, clock, open } = setup()
    client.start()
    open().h.close(4429, '')
    expect(client.status).toBe('reconnecting')
    expect((client.conn.nextRetryAt ?? 0) - clock.t).toBe(BACKOFF_MAX_MS)
  })

  it('detects a gap: resubscribes fresh, signals resync, drops events until subscribed', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    client.subscribe('sess')
    s.recv(subscribed('sess', 10))
    const got: number[] = []
    const resyncs: string[] = []
    client.on('reply.delta', (m) => got.push(m.evSeq))
    client.onResync((uid, reason) => resyncs.push(`${uid}:${reason}`))
    s.recv(delta('sess', 11))
    s.recv(delta('sess', 11)) // duplicate
    s.recv(delta('sess', 14)) // gap
    expect(resyncs).toEqual(['sess:gap'])
    const resub = s.last() as Extract<ClientMsg, { t: 'subscribe' }>
    expect(resub).toMatchObject({ t: 'subscribe', sessionUid: 'sess' })
    expect(resub.sinceEvSeq).toBeUndefined()
    s.recv(delta('sess', 15)) // dropped while resyncing
    s.recv(subscribed('sess', 15))
    expect(resyncs).toEqual(['sess:gap', 'sess:stale'])
    s.recv(delta('sess', 16))
    expect(got).toEqual([11, 16])
  })

  it('signals stale when a resume could not be replayed', () => {
    const { client, clock, open } = setup()
    client.start()
    let s = open()
    client.subscribe('sess')
    s.recv(subscribed('sess', 3))
    s.h.close(1006, '')
    clock.advance(BACKOFF_MIN_MS)
    s = open()
    const resyncs: string[] = []
    client.onResync((uid, reason) => resyncs.push(`${uid}:${reason}`))
    s.recv(subscribed('sess', 2000, 512))
    expect(resyncs).toEqual(['sess:stale'])
  })

  it('correlates requests with acks and errors by id', async () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    const p = client.request({
      t: 'chat.send',
      sessionUid: 'sess',
      text: 'hi',
      attachments: [],
      client: { ts: 1, tzOffset: 0, tzName: null },
      speak: false
    })
    const sent = s.last() as Extract<ClientMsg, { t: 'chat.send' }>
    expect(sent.t).toBe('chat.send')
    expect(typeof sent.id).toBe('string')
    s.recv({ t: 'ack', id: sent.id, replyId: 'r9', messageUid: 'm9' })
    await expect(p).resolves.toEqual({ t: 'ack', id: sent.id, replyId: 'r9', messageUid: 'm9' })

    const q = client.request({ t: 'speech.replay', messageUid: 'm1' })
    const sent2 = s.last() as Extract<ClientMsg, { t: 'speech.replay' }>
    s.recv({ t: 'error', id: sent2.id, error: { code: 'session_busy', message: 'busy', retryable: true } })
    await expect(q).rejects.toMatchObject({ error: { code: 'session_busy' } })
    expect(client.stats().pending).toBe(0)
  })

  it('times out unanswered requests', async () => {
    const { client, clock, open } = setup()
    client.start()
    open()
    const p = client.request({ t: 'speech.replay', messageUid: 'm1' })
    clock.advance(REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toMatchObject({ error: { code: 'network' } })
    expect(client.stats().pending).toBe(0)
  })

  it('queues requests while disconnected and sends them on ready', async () => {
    const { client, sockets, open } = setup()
    client.start()
    const p = client.request({ t: 'speech.replay', messageUid: 'm1' })
    expect(sockets[0].sent).toHaveLength(0)
    const s = open()
    const sent = s.msgs().find((m) => m.t === 'speech.replay') as Extract<ClientMsg, { t: 'speech.replay' }>
    expect(sent).toBeDefined()
    s.recv({ t: 'ack', id: sent.id ?? '' })
    await expect(p).resolves.toMatchObject({ t: 'ack' })
  })

  it('fails requests that were on the wire when the socket dropped', async () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    const p = client.request({ t: 'speech.replay', messageUid: 'm1' })
    s.h.close(1006, '')
    const err = (await p.catch((e: unknown) => e)) as ApiErrorException
    expect(err.error.code).toBe('network')
  })

  it('F62: a resendable request on the wire when the socket dropped is resent unchanged after reconnect, not failed', async () => {
    const { client, clock, sockets, open } = setup()
    client.start()
    const s1 = open()
    let settled: unknown = 'pending'
    const p = client.request({ t: 'chat.send', sessionUid: 's1', text: 'hi', attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false, clientMsgId: 'cm-1' }, { resend: true })
    void p.then(
      (v) => (settled = v),
      (e: unknown) => (settled = e)
    )
    const first = s1.msgs().find((m) => m.t === 'chat.send') as Extract<ClientMsg, { t: 'chat.send' }>
    s1.h.close(1006, '')
    await Promise.resolve()
    expect(settled).toBe('pending')
    clock.advance(BACKOFF_MAX_MS)
    const s2 = sockets[sockets.length - 1]
    expect(s2).not.toBe(s1)
    open()
    const again = s2.msgs().find((m) => m.t === 'chat.send') as Extract<ClientMsg, { t: 'chat.send' }>
    // The very same frame: same request id and the same clientMsgId (the server dedupes on it).
    expect(again).toEqual(first)
    s2.recv({ t: 'ack', id: again.id, replyId: 'r1', messageUid: 'u1' })
    await expect(p).resolves.toMatchObject({ t: 'ack', replyId: 'r1', messageUid: 'u1' })
  })

  it('F62: a resendable request still fails when no connection comes back in time', async () => {
    const { client, clock, open } = setup()
    client.start()
    const s1 = open()
    const p = client.request({ t: 'speech.replay', messageUid: 'm1' }, { resend: true })
    s1.h.close(1006, '')
    clock.advance(REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toMatchObject({ error: { code: 'network' } })
    expect(client.stats().pending).toBe(0)
  })

  it('treats a silent socket as dead (liveness timeout) and reconnects', () => {
    const { client, clock, sockets, open } = setup()
    client.start()
    const s = open()
    clock.advance(LIVENESS_TIMEOUT_MS)
    expect(s.closed).not.toBeNull()
    expect(client.status).toBe('reconnecting')
    clock.advance(BACKOFF_MIN_MS)
    expect(sockets).toHaveLength(2)
  })

  it('does not reconnect after stop()', () => {
    const { client, clock, sockets, open } = setup()
    client.start()
    open()
    client.stop()
    expect(client.status).toBe('closed')
    clock.advance(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('ref-counts subscriptions and unsubscribes once', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    const a = client.subscribe('sess')
    const b = client.subscribe('sess')
    expect(s.msgs().filter((m) => m.t === 'subscribe')).toHaveLength(1)
    a()
    a()
    expect(s.msgs().filter((m) => m.t === 'unsubscribe')).toHaveLength(0)
    b()
    expect(s.msgs().filter((m) => m.t === 'unsubscribe')).toEqual([{ t: 'unsubscribe', sessionUid: 'sess' }])
    expect(client.isSubscribed('sess')).toBe(false)
  })

  it('routes subscribe errors to the session', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    const errs: string[] = []
    client.onSubscribeError((uid, e) => errs.push(`${uid}:${e.code}`))
    client.subscribe('gone')
    const sub = s.last() as Extract<ClientMsg, { t: 'subscribe' }>
    s.recv({ t: 'error', id: sub.id, error: { code: 'not_found', message: 'x', retryable: false } })
    expect(errs).toEqual(['gone:not_found'])
  })

  it('removes listeners on unsubscribe (no leaks) and isolates throwing listeners', () => {
    const { client, errors, open } = setup()
    client.start()
    const s = open()
    const base = client.stats()
    let n = 0
    const offs = [
      client.on('toast', () => {
        throw new Error('boom')
      }),
      client.on('toast', () => n++),
      client.onAny(() => undefined),
      client.onBinary(BIN_KIND.speechChunk, () => undefined),
      client.onStatus(() => undefined),
      client.onResync(() => undefined)
    ]
    s.recv({ t: 'toast', tone: 'info', text: 'hi' })
    expect(n).toBe(1)
    expect(errors).toHaveLength(1)
    for (const off of offs) off()
    expect(client.stats()).toEqual(base)
  })

  it('decodes binary frames and dispatches them by kind, with evSeq tracking', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    client.subscribe('sess')
    s.recv(subscribed('sess', 1))
    const got: { header: unknown; bytes: number[] }[] = []
    client.onBinary(BIN_KIND.speechChunk, (header, payload) => got.push({ header, bytes: [...payload] }))
    const frame = (evSeq: number): Uint8Array => encodeBinary(BIN_KIND.speechChunk, { sessionUid: 'sess', evSeq, replyId: 'r1', index: 0 }, new Uint8Array([1, 2, 3]))
    s.h.message(frame(2).buffer)
    s.h.message(frame(2)) // duplicate
    expect(got).toEqual([{ header: { sessionUid: 'sess', evSeq: 2, replyId: 'r1', index: 0 }, bytes: [1, 2, 3] }])
    s.h.message(new Uint8Array([1, 0])) // malformed → reported, not thrown
  })

  it('sends client.state only when it changes', () => {
    const { client, open } = setup()
    client.start()
    const s = open()
    client.updateClientState()
    expect(s.msgs().filter((m) => m.t === 'client.state')).toHaveLength(0)
  })
})
