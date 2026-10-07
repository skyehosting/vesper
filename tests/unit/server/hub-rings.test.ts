/**
 * Hub event rings (07 C16, Phase 4 integration): synced reveal excludes a SET of speaking clients from deltas, rings
 * of sessions that are gone are dropped (with their subscriptions), unwatched rings age out and the ring map has an
 * LRU cap — and none of that can make a resuming client miss events: a ring created after a drop starts above every
 * dropped evSeq, so a stale `sinceEvSeq` always reads as "refetch". @R17
 */
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { WS_PROTOCOL, type ServerMsg } from '@shared/ws'
import { createHub, type HubImpl, type HubOptions } from '@server/ws/hub'
import { createLog } from '@server/log'
import { toApiError } from '@server/http/errors'
import type { WsClient } from '@server/services'

interface FakeSocket {
  sent: ServerMsg[]
  message(m: unknown): void
  client: WsClient
}

let hub: HubImpl | null = null
afterEach(() => {
  hub?.close()
  hub = null
})

function makeHub(o: HubOptions = {}): HubImpl {
  hub = createHub(
    {
      now: () => Date.now(),
      log: createLog({ dir: path.join(os.tmpdir(), 'vesper-hub-log') }),
      toApiError,
      sessionExists: () => true,
      stillValid: () => true
    },
    { pingIntervalMs: 60_000, ...o }
  )
  return hub
}

function connect(h: HubImpl, name: string): FakeSocket {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const sent: ServerMsg[] = []
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (d: unknown) => {
      if (typeof d !== 'string') return
      const m = JSON.parse(d) as ServerMsg
      sent.push(m)
      // A live peer answers pings (07 C16), so the liveness check never closes it.
      if (m.t === 'ping') queueMicrotask(() => message({ t: 'pong', ts: m.ts }))
    },
    close: () => handlers.get('close')?.(),
    terminate: () => handlers.get('close')?.(),
    on: (ev: string, fn: (...a: unknown[]) => void) => {
      handlers.set(ev, fn)
      return ws
    }
  }
  const client = h.attach(ws as unknown as WebSocket, { device: { id: `dev-${name}`, kind: 'browser', name, listener: 'loopback' }, listener: 'loopback', isDesktop: false })
  const message = (m: unknown) => handlers.get('message')?.(Buffer.from(JSON.stringify(m)), false)
  message({ t: 'hello', protocol: WS_PROTOCOL, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: true } })
  return { sent, message, client }
}

const delta = (uid: string, text: string) => ({ t: 'reply.delta' as const, sessionUid: uid, replyId: 'r', text })
const of = <T extends ServerMsg['t']>(s: FakeSocket, t: T) => s.sent.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t)

describe('emit except a set of clients (synced reveal with several speakers)', () => {
  it('skips every excluded client, sends unsequenced to the rest; a string still works', () => {
    const h = makeHub()
    const [a, b, c] = ['a', 'b', 'c'].map((n) => connect(h, n))
    for (const s of [a, b, c]) s.message({ t: 'subscribe', sessionUid: 'S' })
    h.emit('S', delta('S', 'x'), { except: new Set([a.client.id, b.client.id]) })
    expect(of(a, 'reply.delta')).toEqual([])
    expect(of(b, 'reply.delta')).toEqual([])
    expect(of(c, 'reply.delta')).toMatchObject([{ text: 'x', evSeq: 0 }])
    h.emit('S', delta('S', 'y'), { except: a.client.id })
    expect(of(b, 'reply.delta')).toMatchObject([{ text: 'y', evSeq: 0 }])
    // An empty set is not "targeted": the event is sequenced and reaches everyone.
    h.emit('S', delta('S', 'z'), { except: new Set() })
    for (const s of [a, b, c]) expect(of(s, 'reply.delta').at(-1)).toMatchObject({ text: 'z', evSeq: 1 })
  })
})

describe('ring lifecycle (Phase 4 leak fix)', () => {
  it('dropSession forgets the ring and the subscriptions; a stale resume point reads as a gap', () => {
    const h = makeHub()
    const a = connect(h, 'a')
    a.message({ t: 'subscribe', sessionUid: 'T' })
    for (let i = 0; i < 3; i++) h.emit('T', delta('T', `${i}`))
    expect(h.stats()).toMatchObject({ rings: 1, subscriptions: 1 })
    h.dropSession('T')
    expect(h.stats()).toMatchObject({ rings: 0, subscriptions: 0 })
    // Not subscribed any more: nothing arrives.
    h.emit('T', delta('T', 'late'))
    expect(of(a, 'reply.delta').map((m) => m.text)).toEqual(['0', '1', '2'])
    // Same uid again (a restored/recreated session): the head starts above the dropped evSeq 3 (+1 for 'late').
    const b = connect(h, 'b')
    b.message({ t: 'subscribe', sessionUid: 'T', sinceEvSeq: 1 })
    const sub = of(b, 'subscribed')[0]
    expect(sub.evSeq).toBeGreaterThanOrEqual(4)
    expect(sub.evSeq - 1).toBeGreaterThan(sub.replayed) // the client's SeqTracker calls this stale → refetch
  })

  it('unwatched rings age out; watched ones stay; a new ring starts at the dropped high-water mark', async () => {
    const h = makeHub({ pingIntervalMs: 20, ringIdleMs: 30 })
    const a = connect(h, 'a')
    a.message({ t: 'subscribe', sessionUid: 'kept' })
    for (let i = 0; i < 5; i++) h.emit('gone', delta('gone', `${i}`))
    h.emit('kept', delta('kept', 'k'))
    expect(h.stats().rings).toBe(2)
    await new Promise((r) => setTimeout(r, 150))
    expect(h.stats()).toMatchObject({ rings: 1, clients: 1 })
    const b = connect(h, 'b')
    b.message({ t: 'subscribe', sessionUid: 'gone', sinceEvSeq: 2 })
    expect(of(b, 'subscribed')[0]).toMatchObject({ evSeq: 5, replayed: 0 })
  })

  it('the ring map is LRU-capped, never evicting a watched session', () => {
    const h = makeHub({ maxRings: 5 })
    const a = connect(h, 'a')
    a.message({ t: 'subscribe', sessionUid: 'watched' })
    for (let i = 0; i < 50; i++) h.emit(`s${i}`, delta(`s${i}`, 'x'))
    expect(h.stats().rings).toBeLessThanOrEqual(5)
    h.emit('watched', delta('watched', 'w'))
    expect(of(a, 'reply.delta').at(-1)).toMatchObject({ text: 'w', evSeq: expect.any(Number) })
    const head = of(a, 'reply.delta').at(-1)!.evSeq
    for (let i = 50; i < 100; i++) h.emit(`s${i}`, delta(`s${i}`, 'x'))
    h.emit('watched', delta('watched', 'w2'))
    // Still the same ring: the next event follows on, no gap for the subscriber.
    expect(of(a, 'reply.delta').at(-1)!.evSeq).toBe(head + 1)
  })
})
