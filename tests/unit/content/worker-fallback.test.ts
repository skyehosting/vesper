/**
 * db.worker gone for good (07 C19: > 3 crashes in 5 minutes) — Phase 4 integration: export, import and backup keep
 * working because the SAME job functions then run in the main process (with their yields), and a job the worker
 * died under is re-run there (export, backup). The worker is killed for real (`crashForTest`). @R18 @R20
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportResult } from '@shared/api'
import { memoryOf } from '@server/memory/service'
import type { Log } from '@server/services'
import { startTestServer, type TestServer } from '../server/helpers'
import { buildWorkers, removeWorkers, upload } from './helpers'

let t: TestServer
let desk: string
const warnings: string[] = []

beforeAll(async () => {
  const workersDir = buildWorkers()
  t = await startTestServer({ opts: { workersDir } })
  desk = await t.login('desktop')
  // Record what content logs (the fallback says so in the log, 07 C19).
  const log = t.server.ctx.log
  const child = log.child.bind(log)
  log.child = (scope: string): Log => {
    const c = child(scope)
    if (scope !== 'content') return c
    return { ...c, warn: (msg: string, data?: Record<string, unknown>) => (warnings.push(msg), c.warn(msg, data)) }
  }
})
afterAll(async () => {
  await t.close()
  removeWorkers()
})

const link = () => memoryOf(t.server.ctx).link

/** Kill the worker thread and wait until it is back (or gone for good). */
async function crash(): Promise<void> {
  await link().start()
  const before = link().sizes
  link().crashForTest()
  const end = Date.now() + 10_000
  // The exit is noticed asynchronously; then it either restarts (250/500/1000 ms) or is marked dead.
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20))
    if (link().dead) return
    if (!link().started) continue
    // Restarted: a request answers again.
    try {
      await link().request('status', {}, 2000)
      return
    } catch {
      /* not yet */
    }
  }
  throw new Error(`worker neither restarted nor died (${JSON.stringify(before)})`)
}

async function seed(messages: number): Promise<string> {
  const r = await t.inject({ method: 'POST', url: '/api/test/seed', payload: { sessions: 1, messagesPerSession: messages } })
  return (r.json() as { sessionUids: string[] }).sessionUids[0]
}

describe('db.worker gone for good', () => {
  it('an export the worker dies under is re-run in the main process', async () => {
    const uid = await seed(30_000)
    // Three crashes are restarted (07 C19); the fourth — during the export — is final.
    for (let i = 0; i < 3; i++) await crash()
    expect(link().dead).toBe(false)
    const req = t.inject({ method: 'GET', url: `/api/export?format=json&session=${uid}`, cookie: desk })
    const end = Date.now() + 10_000
    while (link().sizes.jobs === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 2))
    expect(link().sizes.jobs).toBe(1)
    link().crashForTest()
    const r = await req
    expect(r.statusCode, r.statusCode === 200 ? '' : r.body).toBe(200)
    expect(JSON.parse(r.body).sessions[0].messages).toHaveLength(30_000)
    expect(link().dead).toBe(true)
    expect(warnings).toContain('db.worker stopped during the job; running it again in the main process')
  })

  it('export, import and backup keep working, in the main process, and say so in the log', async () => {
    expect(link().dead).toBe(true)
    warnings.length = 0
    const uid = await seed(200)
    const md = await t.inject({ method: 'GET', url: `/api/export?format=md&session=${uid}`, cookie: desk })
    expect(md.statusCode).toBe(200)
    const all = await t.inject({ method: 'GET', url: '/api/export?format=json', cookie: desk })
    expect(all.statusCode).toBe(200)
    const one = await t.inject({ method: 'GET', url: `/api/export?format=json&session=${uid}`, cookie: desk })
    expect(JSON.parse(one.body).sessions[0].messages).toHaveLength(200)
    const before = Number((t.server.ctx.db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c)
    const json = fs.readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'import', 'chatgpt-conversations.json'))
    const im = await t.inject({ method: 'POST', url: '/api/import', cookie: desk, ...upload(json, 'conversations.json') })
    expect(im.statusCode).toBe(200)
    expect(im.json() as ImportResult).toEqual({ sessions: 2, messages: 6, attachments: 0, skipped: 1, source: 'chatgpt' })
    expect(Number((t.server.ctx.db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c)).toBe(before + 2)
    const b = await t.inject({ method: 'POST', url: '/api/backup', cookie: desk })
    expect(b.statusCode).toBe(200)
    const named = (b.json() as { file: string }).file
    const file = path.isAbsolute(named) ? named : path.join(t.server.ctx.paths.backups, named)
    expect(fs.statSync(file).size).toBeGreaterThan(0)
    expect(fs.existsSync(`${file}.part`)).toBe(false)
    expect(warnings.filter((w) => w === 'db.worker is unavailable; running the job in the main process').length).toBeGreaterThanOrEqual(4)
  })
})
