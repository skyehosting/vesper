/** Shared harness for the memory engine tests: a migrated temp DB, sessions with messages, an in-process worker link. */
import path from 'node:path'
import { MIGRATIONS } from '@server/db/migrations'
import { createRepos, type ReposImpl } from '@server/db/repos/index'
import { migrate, openDb, type Db } from '@server/db/sqlite'
import type { MessageRow, SessionRow } from '@server/db/repos'
import type { WorkerConfig, WorkerStatus } from '@server/memory/engine/protocol'
import { WorkerLink } from '@server/memory/link'
import type { EngineOptions } from '@server/memory/engine/engine'
import { fakeLog, type FakeLog } from '../../fakes/log'
import { tempDir } from '../../fakes/temp'

export interface MemDb {
  dir: string
  file: string
  db: Db
  repos: ReposImpl
}

export function memDb(): MemDb {
  const dir = tempDir('vesper-mem-')
  const file = path.join(dir, 'vesper.db')
  const db = openDb(file)
  migrate(db, MIGRATIONS)
  return { dir, file, db, repos: createRepos(db) }
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** A session with alternating messages; `start` is the first message's ts, one minute apart. */
export function addSession(
  m: MemDb,
  title: string,
  msgs: Array<[role: 'user' | 'assistant', body: string]>,
  o: { private?: boolean; start?: number; step?: number; tzName?: string; tzOffsetMin?: number } = {}
): { session: SessionRow; messages: MessageRow[] } {
  const start = o.start ?? Date.UTC(2026, 8, 1, 12)
  const s = m.repos.sessions.create({ title, private: o.private, now: start })
  const messages = msgs.map(([role, body], i) =>
    m.repos.messages.append({ sessionId: s.id, role, body, tsUtc: start + i * (o.step ?? 60_000), tzOffsetMin: o.tzOffsetMin ?? 0, tzName: o.tzName ?? 'UTC', device: 'test' })
  )
  return { session: m.repos.sessions.byId(s.id)!, messages }
}

export function enqueueAll(m: MemDb, rows: MessageRow[]): void {
  for (const r of rows) m.repos.embedQueue.enqueue(r.id)
}

export interface Harness {
  link: WorkerLink
  log: FakeLog
  config: WorkerConfig
  statuses: WorkerStatus[]
  /** Push a config change to the worker. */
  reconfigure(patch: Partial<WorkerConfig>): void
}

export async function harness(m: MemDb, cfg: Partial<WorkerConfig> & { baseUrl: string }, engine?: EngineOptions): Promise<Harness> {
  const config: WorkerConfig = { enabled: true, key: 'pa-test-key', embedModel: 'voyage-4-lite', rerankModel: 'rerank-3-lite', dim: 1024, tier: 'tier1', ...cfg }
  const log = fakeLog('mem')
  const statuses: WorkerStatus[] = []
  const link = new WorkerLink({ script: null, dbFile: m.file, log, config: async () => ({ ...config }), onStatus: (s) => statuses.push(s), engine })
  await link.start()
  return {
    link,
    log,
    config,
    statuses,
    reconfigure(patch) {
      Object.assign(config, patch)
      link.sendIfStarted({ t: 'config', config: { ...config } })
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Poll `fn` until it returns truthy (or fail after `ms`). */
export async function until<T>(fn: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

export function count(db: Db, sql: string, ...p: (string | number | bigint)[]): number {
  return Number((db.prepare(sql).get(...p) as { c: number | bigint }).c)
}
