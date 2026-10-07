/**
 * 07 C9 "busy_timeout 250 ms with async retry" (Phase 4): the main connection waits at most 250 ms (synchronously)
 * for another connection's write lock; the hot write paths — a turn's first rows, its transcript rows and the
 * finished reply, the embed-queue insert — retry asynchronously, so a long-held lock neither loses a reply nor
 * stalls the event loop for its whole duration; other requests answer a retryable 503 `db_error`.
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isBusy, MAIN_BUSY_TIMEOUT_MS, openDb, retryBusy } from '@server/db/sqlite'
import { memoryOf } from '@server/memory/service'
import { tempDir } from '../../fakes'
import { startMockServer, type MockServer } from '../../mocks/server'
import { ChatHarness } from '../chat/harness'

/** Hold the write lock from a second connection (what db.worker does) for `ms`. */
function holdLock(file: string, ms: number): Promise<void> {
  const other = new DatabaseSync(file)
  other.exec('PRAGMA busy_timeout = 5000')
  other.exec('BEGIN IMMEDIATE')
  return new Promise((resolve) =>
    setTimeout(() => {
      other.exec('COMMIT')
      other.close()
      resolve()
    }, ms)
  )
}

/** The longest gap between 5 ms ticks while `p` runs (an event-loop stall probe). */
async function worstGap<T>(p: () => Promise<T>): Promise<{ result: T; worst: number }> {
  let last = performance.now()
  let worst = 0
  const iv = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 5)
  try {
    const result = await p()
    return { result, worst }
  } finally {
    clearInterval(iv)
  }
}

/** The main-thread stall gate (07 H1): one busy_timeout (250 ms) plus a scheduler-overshoot margin. */
const STALL_GATE_MS = MAIN_BUSY_TIMEOUT_MS + 400

describe('sqlite helpers', () => {
  it('the main connection gives up after 250 ms with SQLITE_BUSY; retryBusy waits asynchronously', async () => {
    const file = path.join(tempDir(), 'busy.db')
    const db = openDb(file, { busyTimeoutMs: MAIN_BUSY_TIMEOUT_MS })
    try {
      db.exec('CREATE TABLE t (x)')
      // Held far longer than one 250 ms attempt can block (07 H1), so "one long stall" and "several short ones" stay
      // distinguishable even when a loaded machine stretches every sleep (the margin used to be 200 ms: flaky).
      const held = holdLock(file, 1600)
      const t0 = performance.now()
      let err: unknown = null
      try {
        db.prepare('INSERT INTO t VALUES (1)').run()
      } catch (e) {
        err = e
      }
      const waited = performance.now() - t0
      expect(isBusy(err)).toBe(true)
      expect(waited).toBeGreaterThanOrEqual(200)
      // Gave up long before the hold ends (the default busy_timeout would wait it out). The lock is released by a timer
      // on this thread, so no synchronous call can see it go: the bounds below hold under any CPU load.
      expect(waited).toBeLessThan(900)
      const attempts: number[] = []
      const r = await retryBusy(() => {
        const t = performance.now()
        try {
          return db.prepare('INSERT INTO t VALUES (2)').run().changes
        } finally {
          attempts.push(performance.now() - t)
        }
      })
      expect(r).toBe(1)
      // Each attempt blocks ≤ 250 ms and the write lands on a later one, after yielding to the event loop: the 1.6 s
      // hold is never one long stall. (Counted, not timed: a wall-clock gap probe flaked on a busy PC.)
      expect(attempts.length).toBeGreaterThanOrEqual(2)
      expect(Math.max(...attempts)).toBeLessThan(900)
      await held
      expect(isBusy(new Error('something else'))).toBe(false)
      await expect(retryBusy(() => db.prepare('INSERT INTO nope VALUES (1)').run())).rejects.toThrow(/no such table/)
    } finally {
      db.close()
    }
  })
})

describe('a chat turn while db.worker holds the lock', () => {
  let mock: MockServer
  let h: ChatHarness
  beforeAll(async () => {
    mock = await startMockServer()
    h = await ChatHarness.start({ mock })
    await h.setProfile(h.openaiProfile())
    // Keyword memory is on by default (F37): the turn's auto-recall starts the memory engine, which runs IN-PROCESS in
    // unit tests (no built worker) and writes its first generation row — on the main thread, waiting on a held lock.
    // A real db.worker thread waits on its own; start it before any lock is taken so the loop measurement is fair.
    await memoryOf(h.ctx).link.start()
  })
  afterAll(async () => {
    await h.close()
    await mock.close()
  })
  const dbFile = () => path.join(h.ctx.paths.roaming, 'vesper.db')

  it('the user message, the reply rows and the finished reply are all saved; the loop never stalls for the hold', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    h.mock.llm.script({ text: 'A reply that is written while the database is locked for a while.', chunkChars: 8, delayMs: 30 })
    // Locked before the send (first rows) …
    // Holds far longer than one 250 ms attempt (see above): a stall for the hold would be ≥ 1.4 s.
    const first = holdLock(dbFile(), 1500)
    const r = await worstGap(async () => {
      const turn = h.send(p, s.uid, 'hello while locked', {}, 20_000)
      // … and again while the reply streams (transcript row + final update).
      await new Promise((res) => setTimeout(res, 50))
      await first
      const second = new Promise<void>((res) => {
        const off = setInterval(() => {
          if (p.msgs.some((m) => m.t === 'reply.delta')) {
            clearInterval(off)
            void holdLock(dbFile(), 1400).then(res)
          }
        }, 5)
      })
      const t = await turn
      await second
      return t
    })
    expect(r.result.done.message).toMatchObject({ status: 'complete', body: 'A reply that is written while the database is locked for a while.' })
    expect(r.worst).toBeLessThan(STALL_GATE_MS)
    const page = (await h.inject('GET', `/api/sessions/${s.uid}/messages?mode=latest&limit=10`)).json() as { items: { role: string; body: string; status: string }[] }
    expect(page.items.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete']
    ])
    const rows = Number((h.ctx.db.prepare('SELECT count(*) AS c FROM transcript WHERE session_id = (SELECT id FROM sessions WHERE uid = ?)').get(s.uid) as { c: number }).c)
    expect(rows).toBeGreaterThanOrEqual(2)
  })

  it('another request answers a retryable 503 db_error while the lock outlasts 250 ms', async () => {
    const s = await h.session()
    const held = holdLock(dbFile(), 600)
    const r = await h.inject('PATCH', `/api/sessions/${s.uid}`, { title: 'renamed' })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ error: { code: 'db_error', retryable: true } })
    await held
    expect((await h.inject('PATCH', `/api/sessions/${s.uid}`, { title: 'renamed' })).statusCode).toBe(200)
  })
})
