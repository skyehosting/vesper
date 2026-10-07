/**
 * The real db.worker thread (bundled from src/workers/db.worker.ts with esbuild, as electron-vite does): crash →
 * restart → resume, the restart budget (07 C19), heap stability over 10k queued items, and a clean close.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WorkerConfig, WorkerStatus } from '@server/memory/engine/protocol'
import { WorkerLink } from '@server/memory/link'
import { fakeLog, type FakeLog } from '../../fakes/log'
import { removeTempDir } from '../../fakes/temp'
import { startMockServer, type MockServer } from '../../mocks/server'
import { addSession, count, enqueueAll, memDb, until, type MemDb } from './helpers'

let mock: MockServer
let workerDir: string
let m: MemDb
let link: WorkerLink | null = null
let log: FakeLog

beforeAll(async () => {
  mock = await startMockServer()
  workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-dbworker-'))
  const root = path.resolve(__dirname, '../../..')
  await build({
    entryPoints: [path.join(root, 'src/workers/db.worker.ts')],
    outfile: path.join(workerDir, 'db.worker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { __VESPER_TEST__: 'true' },
    alias: { '@shared': path.join(root, 'src/shared'), '@server': path.join(root, 'src/server') },
    logLevel: 'silent'
  })
}, 60_000)
afterAll(async () => {
  await mock.close()
  fs.rmSync(workerDir, { recursive: true, force: true })
})
beforeEach(() => {
  mock.reset()
  m = memDb()
  log = fakeLog('mem')
})
afterEach(async () => {
  await link?.close()
  link = null
  m.db.close()
  removeTempDir(m.dir)
})

function start(cfg: Partial<WorkerConfig> = {}): WorkerLink {
  const config: WorkerConfig = { enabled: true, baseUrl: `${mock.url}/voyage/v1`, key: 'pa-k', embedModel: 'voyage-4-lite', rerankModel: 'rerank-3-lite', dim: 256, tier: 'tier1', ...cfg }
  link = new WorkerLink({ script: path.join(workerDir, 'db.worker.js'), dbFile: m.file, log, config: async () => config, onStatus: (_s: WorkerStatus) => undefined })
  return link
}

const workerHandles = () => process.getActiveResourcesInfo().filter((r) => r === 'Worker' || r === 'MessagePort').length

describe('db.worker thread', () => {
  it('runs on its own thread, embeds and closes without leaving handles @R17', async () => {
    const baseline = workerHandles()
    const s = addSession(m, 'T', [['user', 'hello from the real worker thread today']])
    enqueueAll(m, s.messages)
    const l = start()
    await l.start()
    expect(l.inProcess).toBe(false)
    await l.request('drain', {}, 10_000)
    expect(count(m.db, 'SELECT count(*) AS c FROM vectors')).toBe(1)
    await l.close()
    link = null
    await until(() => workerHandles() <= baseline, 3000, 'worker handles released')
  })

  it('crash → restart → resume: in-flight requests fail cleanly and the durable queue drains', async () => {
    const s = addSession(
      m,
      'Crash',
      Array.from({ length: 30 }, (_, i) => ['user', `crash test message number ${i} with enough words`] as ['user', string])
    )
    enqueueAll(m, s.messages)
    mock.voyage.setDelay(400)
    const l = start()
    await l.start()
    const pending = l.request('drain', {}, 10_000)
    await new Promise((r) => setTimeout(r, 100))
    l.crashForTest()
    await expect(pending).rejects.toMatchObject({ info: { code: 'memory_unavailable' } })
    expect(l.sizes).toEqual({ pending: 0, jobs: 0 })
    await until(() => l.started, 5000, 'restart')
    mock.voyage.setDelay(0)
    await l.request('drain', {}, 10_000)
    await until(() => count(m.db, 'SELECT count(*) AS c FROM vectors') === 30, 10_000, 'resume')
    expect(log.text()).toContain('restarting db.worker')
  })

  it('gives up after 3 restarts within 5 minutes', async () => {
    const l = start()
    await l.start()
    for (let i = 0; i < 3; i++) {
      l.crashForTest()
      await until(() => !l.started, 3000, 'crash')
      await until(() => l.started, 5000, 'restart')
    }
    l.crashForTest()
    await until(() => l.dead, 5000, 'dead')
    await expect(l.request('status', {}, 1000)).rejects.toMatchObject({ info: { code: 'memory_unavailable' } })
  })

  it('heap and maps stay flat over 10k queued items (leak check) @R17', async () => {
    const l = start()
    await l.start()
    await l.request('loadIndex', {}, 5000)
    const round = async (base: number) => {
      const s = addSession(
        m,
        `L${base}`,
        Array.from({ length: 5000 }, (_, i) => ['user', `leak check item ${base + i} about subject ${(base + i) % 89}`] as ['user', string])
      )
      enqueueAll(m, s.messages)
      l.send({ t: 'enqueued', count: 5000 })
      await l.request('drain', {}, 30_000)
      await until(async () => (await l.request('status', {}, 5000)).queued === 0, 30_000, 'drained')
      return l.request('stats', { gc: true }, 5000)
    }
    await round(0)
    const a = await round(5000)
    const b = await round(10_000)
    expect(b.sizes.inflight).toBe(0)
    expect(b.sizes.jobs).toBe(0)
    expect(b.sizes.statements).toBeLessThanOrEqual(a.sizes.statements)
    expect(b.sizes.countCache).toBeLessThanOrEqual(8)
    // Only the index itself grows (5,000 × 32 B of bits + parallel arrays); everything else returns to baseline.
    const growth = b.heapUsed - a.heapUsed
    expect(growth, `heap grew ${Math.round(growth / 1024)} KiB`).toBeLessThan(4 * 1024 * 1024)
    expect(b.sizes.index).toBe(15_000)
  }, 90_000)
})
