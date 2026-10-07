import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { AUDIO_BACKPRESSURE_BYTES, BIN_KIND, WS_CLOSE, encodeBinary, type SpeechChunkHeader } from '@shared/ws'
import { createHub } from '@server/ws/hub'
import { createLog } from '@server/log'
import { toApiError } from '@server/http/errors'
import { coreOf, sleep, startTestServer, WsProbe, wsUrl, type TestServer } from './helpers'
import os from 'node:os'
import path from 'node:path'

let t: TestServer
let cookie: string

beforeAll(async () => {
  t = await startTestServer({ opts: { hub: { pingIntervalMs: 150, rateBurst: 20, ratePerSec: 20, ringSize: 8, helloTimeoutMs: 1000 } } })
  cookie = await t.login('browser')
})
afterAll(() => t.close())

const probe = (headers: Record<string, string> = {}) => new WsProbe(wsUrl(t), { origin: t.origin, cookie, ...headers })

async function newSession(): Promise<string> {
  const r = await t.inject({ method: 'POST', url: '/api/sessions', payload: { title: 'ws' }, cookie })
  return r.json().uid
}

describe('upgrade', () => {
  it('refuses a foreign or missing Origin before the handshake', async () => {
    const bad = probe({ origin: 'http://evil.example' })
    await expect(bad.opened).rejects.toThrow()
    expect(bad.rejected).toBe(403)
    const none = new WsProbe(wsUrl(t), { cookie })
    await expect(none.opened).rejects.toThrow()
    expect(none.rejected).toBe(403)
  })

  it('refuses a foreign Host with 421', async () => {
    const p = new WsProbe(`ws://${t.host}/ws`, { origin: t.origin, cookie, host: 'evil.example' })
    await expect(p.opened).rejects.toThrow()
    expect(p.rejected).toBe(421)
  })

  it('closes with 4401 without a valid session', async () => {
    const p = probe({ cookie: '__Host-vesper_sid=nope' })
    await p.opened
    expect((await p.closedP).code).toBe(WS_CLOSE.auth)
  })
})

describe('protocol', () => {
  it('hello → ready; a wrong protocol or a first non-hello closes with 4409', async () => {
    const ok = probe()
    const ready = await ok.hello()
    expect(ready.protocol).toBe(1)
    expect(typeof ready.deviceId).toBe('string')
    ok.close()

    const wrong = probe()
    await wrong.opened
    wrong.send({ t: 'hello', protocol: 99, tz: null, tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: false } })
    expect((await wrong.closedP).code).toBe(WS_CLOSE.protocol)

    const early = probe()
    await early.opened
    early.send({ t: 'subscribe', sessionUid: 'x' })
    expect((await early.closedP).code).toBe(WS_CLOSE.protocol)

    const silent = probe()
    await silent.opened
    expect((await silent.closedP).code).toBe(WS_CLOSE.protocol) // hello timeout
  })

  it('subscribe → subscribed + ack; unknown sessions are an error with the id', async () => {
    const uid = await newSession()
    const p = probe()
    await p.hello()
    p.send({ t: 'subscribe', id: 's1', sessionUid: uid })
    expect(await p.next('subscribed')).toMatchObject({ sessionUid: uid, evSeq: 0, inflight: [], replayed: 0 })
    expect(await p.next('ack')).toMatchObject({ id: 's1' })
    p.send({ t: 'subscribe', id: 's2', sessionUid: 'nope' })
    expect(await p.next('error')).toMatchObject({ id: 's2', error: { code: 'not_found' } })
    p.close()
  })

  it('session events carry evSeq; resume replays from the ring, too-old gaps replay nothing', async () => {
    const uid = await newSession()
    const hub = t.server.ctx.hub
    const a = probe()
    await a.hello()
    a.send({ t: 'subscribe', sessionUid: uid })
    await a.next('subscribed')
    for (let i = 0; i < 5; i++) hub.emit(uid, { t: 'reply.delta', sessionUid: uid, replyId: 'r', text: `d${i}` })
    const got = [] as number[]
    for (let i = 0; i < 5; i++) got.push((await a.next('reply.delta')).evSeq)
    expect(got).toEqual([1, 2, 3, 4, 5])

    const b = probe()
    await b.hello()
    b.send({ t: 'subscribe', sessionUid: uid, sinceEvSeq: 2 })
    const replay = [(await b.next('reply.delta')).evSeq, (await b.next('reply.delta')).evSeq, (await b.next('reply.delta')).evSeq]
    expect(replay).toEqual([3, 4, 5])
    expect(await b.next('subscribed')).toMatchObject({ evSeq: 5, replayed: 3 })

    // Ring size is 8 in this server: after 10 more events, evSeq 2 is no longer covered.
    for (let i = 0; i < 10; i++) hub.emit(uid, { t: 'reply.delta', sessionUid: uid, replyId: 'r', text: 'x' })
    const c = probe()
    await c.hello()
    c.send({ t: 'subscribe', sessionUid: uid, sinceEvSeq: 2 })
    expect(await c.next('subscribed')).toMatchObject({ evSeq: 15, replayed: 0 })
    expect(c.msgs.filter((m) => m.t === 'reply.delta')).toHaveLength(0)
    // Up to date: nothing to replay, and the client can tell (since + replayed === evSeq).
    c.send({ t: 'subscribe', sessionUid: uid, sinceEvSeq: 15 })
    expect(await c.next('subscribed')).toMatchObject({ evSeq: 15, replayed: 0 })
    for (const x of [a, b, c]) x.close()
  })

  it('handlers by prefix answer with ack; unknown types fail with not_implemented', async () => {
    const hub = coreOf(t.server.ctx).hub
    hub.on('test.', (client, m) => hub.ack(client, m as { id?: string }, { replyId: 'r1' }))
    hub.on('test.boom', () => {
      throw new Error('internal detail that must not leak')
    })
    const p = probe()
    await p.hello()
    p.send({ t: 'test.hi', id: 'a1' })
    expect(await p.next('ack')).toMatchObject({ id: 'a1', replyId: 'r1' })
    p.send({ t: 'test.boom', id: 'a2' })
    const err = await p.next('error')
    expect(err).toMatchObject({ id: 'a2', error: { code: 'internal' } })
    expect(JSON.stringify(err)).not.toContain('internal detail')
    p.send({ t: 'nope.nothing', id: 'a3' })
    expect(await p.next('error')).toMatchObject({ id: 'a3', error: { code: 'not_implemented' } })
    p.send('not json' as unknown as object)
    p.close()
  })

  it('binary frames are decoded and dispatched by kind', async () => {
    const hub = t.server.ctx.hub
    const got: { header: unknown; bytes: number[] }[] = []
    hub.onBinary(BIN_KIND.micPcm, (_c, header, payload) => got.push({ header, bytes: [...payload] }))
    const p = probe()
    await p.hello()
    p.ws.send(encodeBinary(BIN_KIND.micPcm, { seq: 7 }, new Uint8Array([1, 2, 3])))
    p.ws.send(new Uint8Array([9])) // malformed → 4409
    expect((await p.closedP).code).toBe(WS_CLOSE.protocol)
    expect(got).toEqual([{ header: { seq: 7 }, bytes: [1, 2, 3] }])
  })

  it('pings; missing two pongs terminates, answering keeps the socket', async () => {
    const lazy = probe()
    await lazy.hello()
    await lazy.next('ping', undefined, 1000)
    const closed = await Promise.race([lazy.closedP, sleep(2000).then(() => null)])
    expect(closed).not.toBeNull()

    const good = probe()
    await good.hello()
    good.ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.t === 'ping') good.send({ t: 'pong', ts: m.ts })
    })
    await sleep(800)
    expect(good.closed).toBeNull()
    good.close()
  })

  it('floods close with 4429', async () => {
    const p = probe()
    await p.hello()
    for (let i = 0; i < 60; i++) p.send({ t: 'client.state', client: { visible: true, focused: true, audioUnlocked: true } })
    expect((await p.closedP).code).toBe(WS_CLOSE.rate)
  })

  it('closeDevice and revocation close sockets; onDisconnect runs', async () => {
    const hub = t.server.ctx.hub
    const gone: string[] = []
    hub.onDisconnect((c) => gone.push(c.id))
    const extra = await t.login('browser')
    const p = probe({ cookie: extra })
    const ready = await p.hello()
    hub.closeDevice(ready.deviceId, 4410, 'replaced')
    expect((await p.closedP).code).toBe(4410)
    await sleep(20)
    expect(gone.length).toBeGreaterThan(0)

    const q = probe({ cookie: extra })
    await q.hello()
    coreOf(t.server.ctx).repos.devices.revoke(ready.deviceId, Date.now())
    expect((await q.closedP).code).toBe(WS_CLOSE.auth) // re-validated on the ping tick
  })

  describe('session lifetime on an open socket (F01, 07 B4)', () => {
    const DAY = 86_400_000
    const core = () => coreOf(t.server.ctx)
    /** A socket that answers pings, so only the session check can close it. */
    async function live(c: string): Promise<{ p: WsProbe; deviceId: string }> {
      const p = probe({ cookie: c })
      p.ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.t === 'ping') p.send({ t: 'pong', ts: m.ts })
      })
      const ready = await p.hello()
      return { p, deviceId: ready.deviceId }
    }
    const lastSeen = (id: string) => (t.server.ctx.db.prepare('SELECT last_seen_utc FROM devices WHERE id = ?').get(id) as { last_seen_utc: number }).last_seen_utc

    it('closes with 4401 once the idle limit passes', async () => {
      const { p } = await live(await t.login('browser'))
      try {
        core().clockOffsetMs = 8 * DAY // default idle limit is 7 days
        expect((await Promise.race([p.closedP, sleep(2000).then(() => null)]))?.code).toBe(WS_CLOSE.auth)
      } finally {
        core().clockOffsetMs = 0
        p.close()
      }
    })

    it('a frame that arrives after the idle limit (before the next tick) cannot revive the session', async () => {
      const c = await t.login('browser')
      const { p, deviceId } = await live(c)
      const before = lastSeen(deviceId)
      try {
        core().clockOffsetMs = 8 * DAY // past the 7-day idle limit; the next tick is up to 150 ms away
        p.send({ t: 'client.state', client: { visible: true, focused: true, audioUnlocked: false } })
        expect((await Promise.race([p.closedP, sleep(2000).then(() => null)]))?.code).toBe(WS_CLOSE.auth)
        expect(lastSeen(deviceId)).toBe(before)
        expect((await t.inject({ url: '/api/sessions', cookie: c })).statusCode).toBe(401)
      } finally {
        core().clockOffsetMs = 0
        p.close()
      }
    })

    it('a binary frame after the idle limit closes the socket and writes nothing', async () => {
      const c = await t.login('browser')
      const { p, deviceId } = await live(c)
      const before = lastSeen(deviceId)
      try {
        core().clockOffsetMs = 8 * DAY
        p.ws.send(Buffer.from([0xff]))
        expect((await Promise.race([p.closedP, sleep(2000).then(() => null)]))?.code).toBe(WS_CLOSE.auth)
        expect(lastSeen(deviceId)).toBe(before)
      } finally {
        core().clockOffsetMs = 0
        p.close()
      }
    })

    it('AuthCore.touch never refreshes an expired, revoked or pending session', async () => {
      const c = await t.login('browser')
      const { p, deviceId } = await live(c)
      p.close()
      const before = lastSeen(deviceId)
      try {
        core().clockOffsetMs = 8 * DAY
        core().auth.touch(deviceId, '127.0.0.1')
        expect(lastSeen(deviceId)).toBe(before)
        expect(core().auth.stillValid(deviceId)).toBe(false)
        core().clockOffsetMs = 0
        expect(core().auth.touch(deviceId, '127.0.0.1')).toBe(true) // still valid now: an ordinary touch
        core().repos.devices.revoke(deviceId, Date.now())
        core().clockOffsetMs = DAY // past the touch throttle
        const atRevoke = lastSeen(deviceId)
        expect(core().auth.touch(deviceId, '127.0.0.1')).toBe(false)
        expect(lastSeen(deviceId)).toBe(atRevoke)
      } finally {
        core().clockOffsetMs = 0
      }
    })

    it('closes with 4401 once the absolute limit passes, even while active', async () => {
      const { p, deviceId } = await live(await t.login('browser'))
      try {
        t.server.ctx.db.prepare('UPDATE devices SET created_utc = created_utc - ? WHERE id = ?').run(31 * DAY, deviceId)
        expect((await Promise.race([p.closedP, sleep(2000).then(() => null)]))?.code).toBe(WS_CLOSE.auth)
      } finally {
        p.close()
      }
    })

    it('messages on the socket count as activity (no idle sign-out while in use); pongs do not', async () => {
      const c = await t.login('browser')
      const { p, deviceId } = await live(c)
      try {
        core().clockOffsetMs = 6 * DAY
        await sleep(400) // several ticks: pongs alone must not refresh last_seen
        expect(lastSeen(deviceId)).toBeLessThan(Date.now() + DAY)
        p.send({ t: 'client.state', client: { visible: true, focused: true, audioUnlocked: false } })
        p.send({ t: 'unsubscribe', sessionUid: 'nope' })
        await sleep(100)
        expect(lastSeen(deviceId)).toBeGreaterThan(Date.now() + 5 * DAY)
        core().clockOffsetMs = 12 * DAY // six days after the activity: still within 7 d idle
        await sleep(500)
        expect(p.closed).toBeNull()
        expect((await t.inject({ url: '/api/sessions', cookie: c })).statusCode).toBe(200)
      } finally {
        core().clockOffsetMs = 0
        p.close()
      }
    })
  })

  it('broadcast reaches ready clients; settings changes are broadcast', async () => {
    const desktop = await t.login('desktop')
    const p = probe({ cookie: desktop })
    await p.hello()
    const r = await t.inject({ method: 'PATCH', url: '/api/settings', payload: { appearance: { accent: 'rose' } }, cookie: desktop })
    expect(r.statusCode).toBe(200)
    const m = await p.next('settings.changed')
    expect(m.settings.appearance.accent).toBe('rose')
    p.close()
  })
})

describe('backpressure', () => {
  it('sendSpeech refuses over AUDIO_BACKPRESSURE_BYTES', () => {
    const hub = createHub({
      now: () => Date.now(),
      log: createLog({ dir: path.join(os.tmpdir(), 'vesper-hub-log') }),
      toApiError,
      sessionExists: () => true,
      stillValid: () => true
    })
    const sent: unknown[] = []
    const fake = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d: unknown) => sent.push(d),
      close: () => undefined,
      terminate: () => undefined,
      on: () => fake
    }
    const c = hub.attach(fake as unknown as WebSocket, { device: { id: 'd', kind: 'browser', name: 'x', listener: 'loopback' }, listener: 'loopback', isDesktop: false })
    const header: SpeechChunkHeader = { sessionUid: 's', evSeq: 1, replyId: 'r', index: 0, src: [0, 1], text: 'a', spoken: 'a', timeline: null, durationMs: 10, mime: 'audio/wav', instant: false, final: true }
    expect(c.sendSpeech(header, new Uint8Array(10))).toBe(true)
    fake.bufferedAmount = AUDIO_BACKPRESSURE_BYTES + 1
    expect(c.sendSpeech(header, new Uint8Array(10))).toBe(false)
    expect(sent).toHaveLength(1)
    hub.close()
  })
})
