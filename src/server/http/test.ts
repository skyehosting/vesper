/**
 * Test endpoints (05 §3, 07 B10): registered only in test builds with VESPER_TEST=1, reachable only from this machine
 * on Listener A (guard 'test'). The packaged smoke test asserts GET /api/test/ping → 404.
 */
import { randomUUID } from 'node:crypto'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE, sessionCookie } from '../auth/core'
import { coreOf } from '../core'
import { tx } from '../db/sqlite'
import type { UpdateStatus } from '@shared/api'
import type { PlatformUpdater } from '../platform'
import { sttImpl } from '../providers/stt'
import { systemOf } from '../system'
import type { ServerContext } from '../services'
import { isTestMode } from '../testMode'
import { parse } from './route'

const WORDS = ['coffee', 'garden', 'river', 'violin', 'orbit', 'lantern', 'maple', 'harbor', 'comet', 'pepper', 'atlas', 'velvet', 'ember', 'meadow', 'quartz', 'tide']

/** Deterministic filler text so keyword search has something to find. */
function filler(n: number): string {
  const words: string[] = []
  let x = (n * 2654435761) >>> 0
  const count = 6 + (n % 20)
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    words.push(WORDS[x % WORDS.length])
  }
  return words.join(' ')
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  // Written as a constant-folded branch so the release build (__VESPER_TEST__ = false) drops registerTestRoutes entirely.
  if (__VESPER_TEST__ && isTestMode()) registerTestRoutes(app, ctx)
}

function registerTestRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const core = coreOf(ctx)
  const config = { auth: 'public' as const, guard: 'test' as const }

  app.get('/api/test/ping', { config }, () => ({ ok: true }))

  app.post('/api/test/login-as', { config }, (req, reply) => {
    const { kind } = parse(z.object({ kind: z.enum(['browser', 'desktop']) }), req.body)
    const r = kind === 'desktop' ? core.auth.createDesktopSession() : core.auth.createDevice({ kind: 'browser', listener: 'loopback', name: 'Test browser' })
    reply.header('set-cookie', sessionCookie(r.token, kind !== 'desktop'))
    // The raw cookie is returned too so harnesses whose cookie jars drop Secure cookies on http:// can set it.
    return { deviceId: r.deviceId, cookie: { name: SESSION_COOKIE, value: r.token } }
  })

  app.post('/api/test/seed', { config }, (req) => {
    const b = parse(
      z.object({
        sessions: z.number().int().min(0).max(1000).default(1),
        messagesPerSession: z.number().int().min(0).max(100_000).default(10),
        bigSession: z.number().int().min(0).max(2_000_000).optional()
      }),
      req.body
    )
    const sessionUids: string[] = []
    const now = ctx.clock.now()
    const insert = ctx.db.prepare(
      `INSERT INTO messages (uid, session_id, branch_id, seq, role, tag, body, ts_utc, tz_offset_min, tz_name, device, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'UTC', 'seed', 'complete')`
    )
    const fill = (title: string, count: number) => {
      const s = core.repos.sessions.create({ title, now })
      const start = now - count * 60_000
      for (let done = 0; done < count; ) {
        const end = Math.min(count, done + 10_000)
        tx(ctx.db, () => {
          for (let k = done + 1; k <= end; k++) {
            const user = k % 2 === 1
            insert.run(randomUUID(), s.id, s.activeBranch, BigInt(k), user ? 'user' : 'assistant', user ? 'user response' : 'ai response', `#${k} ${filler(k)}`, start + k * 60_000)
          }
        })
        done = end
      }
      ctx.db
        .prepare('UPDATE sessions SET last_seq = ?, message_count = ?, last_message_utc = ?, updated_utc = ? WHERE id = ?')
        .run(BigInt(count), count, count ? start + count * 60_000 : null, now, s.id)
      sessionUids.push(s.uid)
    }
    for (let i = 0; i < b.sessions; i++) fill(`Seed ${i + 1}`, b.messagesPerSession)
    if (b.bigSession) fill(`Big ${b.bigSession}`, b.bigSession)
    ctx.hub.broadcast({ t: 'sessions.changed' })
    return { sessionUids }
  })

  app.post('/api/test/clock', { config }, (req) => {
    const { offsetMs } = parse(z.object({ offsetMs: z.number().finite() }), req.body)
    core.clockOffsetMs = offsetMs
    return { now: ctx.clock.now() }
  })

  app.get('/api/test/stats', { config }, () => {
    const s = ctx.hub.clients()
    let clients = 0
    let subscriptions = 0
    for (const c of s) {
      clients++
      subscriptions += c.subscriptions.size
    }
    const h = core.eventLoopDelay
    return {
      clients,
      subscriptions,
      eventLoopDelayP99Ms: h ? Math.round((h.percentile(99) / 1e6) * 100) / 100 : 0,
      rssMB: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10
    }
  })

  /**
   * Leak gates (07 D14, `npm run soak`, review F45): the server heap after a full GC, active handles by type and the
   * size of every per-client/per-reply map, so a soak can assert "back to baseline" after N cycles.
   */
  app.get('/api/test/leaks', { config }, async () => {
    const gc = testGc()
    if (gc) {
      gc()
      gc()
    }
    const m = process.memoryUsage()
    const mb = (n: number): number => Math.round((n / 1048576) * 100) / 100
    const resources: Record<string, number> = {}
    for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] ?? 0) + 1
    const statsOf = (o: unknown): unknown => {
      const f = (o as { stats?: () => unknown } | undefined)?.stats
      return typeof f === 'function' ? f.call(o) : null
    }
    return {
      gc: gc !== null,
      heapUsedMB: mb(m.heapUsed),
      heapTotalMB: mb(m.heapTotal),
      externalMB: mb(m.external),
      arrayBuffersMB: mb(m.arrayBuffers),
      rssMB: mb(m.rss),
      resources,
      hub: statsOf(ctx.hub),
      engine: statsOf(ctx.services.chat),
      speech: statsOf(ctx.services.speech),
      auth: statsOf(core.auth),
      stt: (await sttImpl(ctx)?.stats()) ?? null,
      wintts: statsOf((ctx.services.speech as { providers?: { host?: () => unknown } } | undefined)?.providers?.host?.() ?? undefined)
    }
  })

  /**
   * H-v12-updates: a fake updater on the platform (the standalone server has none). POST installs it (once) and moves
   * it to `status`; `onCheck` is what its next checks find. It never touches the network; GET reports what the UI asked
   * of it (checks, downloads, restart requests).
   */
  const UPDATE_STATES = ['idle', 'checking', 'available', 'downloading', 'ready', 'up-to-date', 'error'] as const
  const fakeStatus = z.object({ state: z.enum(UPDATE_STATES), version: z.string().max(40).optional(), percent: z.number().min(0).max(100).optional() })
  let fake: { updater: PlatformUpdater; set(s: z.infer<typeof fakeStatus>): void; onCheck: z.infer<typeof fakeStatus>; counts: { checks: number; downloads: number; restarts: number } } | null = null
  const makeFake = (): NonNullable<typeof fake> => {
    let s: UpdateStatus = { state: 'idle', currentVersion: ctx.platform.version }
    const listeners = new Set<(s: UpdateStatus) => void>()
    const counts = { checks: 0, downloads: 0, restarts: 0 }
    const f: NonNullable<typeof fake> = {
      counts,
      onCheck: { state: 'up-to-date' },
      set(next) {
        const version = next.version ?? s.version
        s = {
          state: next.state,
          currentVersion: ctx.platform.version,
          ...(version && next.state !== 'up-to-date' && next.state !== 'idle' ? { version, releaseUrl: `https://github.com/example/vesper/releases/tag/v${version}` } : {}),
          ...(next.percent !== undefined ? { percent: next.percent } : next.state === 'ready' ? { percent: 100 } : {}),
          ...(next.state === 'up-to-date' || next.state === 'available' ? { checkedUtc: ctx.clock.now() } : {}),
          ...(next.state === 'error' ? { error: "Couldn't check for updates. Vesper will try again later." } : {})
        }
        for (const fn of [...listeners]) fn(s)
      },
      updater: {
        status: () => s,
        async check() {
          counts.checks++
          f.set(f.onCheck)
          return s
        },
        async download() {
          counts.downloads++
          if (s.state === 'available') f.set({ state: 'downloading', percent: 0 })
          return s
        },
        restart() {
          if (s.state !== 'ready') return false
          counts.restarts++
          return true
        },
        onChange(fn) {
          listeners.add(fn)
          return () => void listeners.delete(fn)
        }
      }
    }
    return f
  }

  app.post('/api/test/updater', { config }, (req) => {
    const b = parse(z.object({ status: fakeStatus.optional(), onCheck: fakeStatus.optional() }).strict(), req.body ?? {})
    const fresh = !fake
    if (!fake) {
      fake = makeFake()
      ctx.platform.updater = fake.updater
      systemOf(ctx)?.updates.attach()
    }
    if (b.onCheck) fake.onCheck = b.onCheck
    // A newly attached updater announces itself (open pages switch from 'unsupported').
    if (b.status || fresh) fake.set(b.status ?? { state: 'idle' })
    return { counts: fake.counts, status: fake.updater.status() }
  })

  app.get('/api/test/updater', { config }, () => (fake ? { counts: fake.counts, status: fake.updater.status() } : { counts: null, status: null }))
}

let gcFn: (() => void) | null | undefined
/** `global.gc` without restarting the server with --expose-gc (test routes only). */
function testGc(): (() => void) | null {
  if (gcFn !== undefined) return gcFn
  const g = (globalThis as { gc?: () => void }).gc
  if (typeof g === 'function') return (gcFn = g)
  try {
    setFlagsFromString('--expose-gc')
    gcFn = runInNewContext('gc') as () => void
  } catch {
    gcFn = null
  }
  return gcFn
}
