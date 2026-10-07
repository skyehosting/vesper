/**
 * engine-int: the chat engine through the other Phase 2 services' single sources (Phase 3 brief items 4–6):
 * protocols from content-server (07 C1), pinned facts through memory's facts API (07 A4), the "Remembered" rows
 * through memoryOf(ctx).recordInjections, startup recovery through repos (07 C6), the free-tier limit of one
 * memory_search per reply (07 C11), and emptying the trash on db.worker's purge job (07 C9). @R9 @R11 @R7
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import { FREE_TIER_SEARCH_LIMIT } from '@server/chat/engine'
import { memoryOf } from '@server/memory/service'
import { FakeMemoryService } from '../../fakes/services'
import { ChatHarness, chatRequests } from './harness'

let h: ChatHarness
let memory: FakeMemoryService

beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  memory = new FakeMemoryService()
  h.ctx.services.memory = memory
  await h.ctx.settings.patch({ chat: { autoTitle: false, maxToolCalls: 3 }, memory: { enabled: true, autoRecall: false } })
  await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos

describe('single sources (07 C1 / A4) @R11', () => {
  it('a new epoch freezes the protocols content-server serves (text + its hash)', async () => {
    const file = path.join(h.ctx.paths.roaming, 'protocols.md')
    fs.writeFileSync(file, '# Protocols\nYou are {{assistant_name}}. FROM CONTENT SERVER.')
    try {
      const s = await h.session()
      const p = await h.client(s.uid)
      await h.send(p, s.uid, 'hi')
      const e = repos().epochs.current(repos().sessions.byUid(s.uid)!.id)!
      expect(e.systemJson).toContain('FROM CONTENT SERVER')
      expect(e.protocolsHash).toBe(h.ctx.services.content!.protocols().hash)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it("pinned facts reach the model as memory's note, and a change appends a new note (prefix intact)", async () => {
    const facts = memoryOf(h.ctx).facts
    for (const f of facts.list()) facts.delete(f.id)
    facts.create('I am allergic to peanuts')
    const s = await h.session()
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'hello')
    const first = JSON.stringify(chatRequests(h.mock).at(-1)!.json)
    expect(first).toContain(facts.note()!.split('\n')[0])
    expect(first).toContain('- I am allergic to peanuts')
    facts.create('My sister is called Ana')
    await h.send(p, s.uid, 'again')
    const second = JSON.stringify(chatRequests(h.mock).at(-1)!.json)
    expect(second).toContain('- My sister is called Ana')
    h.mock.recorder.assertPrefixInvariant()
    for (const f of facts.list()) facts.delete(f.id)
  })
})

describe('memory rules @R9', () => {
  it('"Remembered" rows are written through memory\'s recordInjections', async () => {
    const src = await h.session({ title: 'Source' })
    const sp = await h.client(src.uid)
    const t0 = await h.send(sp, src.uid, 'I adopted a cat named Miso')
    memory.addHit({ body: 'I adopted a cat named Miso', messageUid: t0.userUid!, sessionUid: src.uid, shortId: src.shortId })
    await h.ctx.settings.patch({ memory: { autoRecall: true } })
    const s = await h.session()
    const p = await h.client(s.uid)
    const real = memoryOf(h.ctx)
    const calls: string[] = []
    const orig = real.recordInjections.bind(real)
    real.recordInjections = (sessionUid, turnUid, hits) => {
      calls.push(turnUid)
      orig(sessionUid, turnUid, hits)
    }
    try {
      const t = await h.send(p, s.uid, 'what is my cat called again')
      expect(t.done.message.recalled).toBe(1)
      expect(calls).toEqual([t.done.message.uid])
      const page = (await h.inject('GET', `/api/sessions/${s.uid}/messages`)).json() as { items: { uid: string; recalled?: number }[] }
      expect(page.items.find((m) => m.uid === t.done.message.uid)!.recalled).toBe(1)
    } finally {
      real.recordInjections = orig
    }
  })

  it('free Voyage tier: at most one memory_search per reply (07 C11)', async () => {
    memory.statusValue = { ...memory.statusValue, tier: 'free' }
    memory.addHit({ body: 'Lisbon in May', shortId: 'K7Q2MX' })
    const s = await h.session()
    const p = await h.client(s.uid)
    const call = (q: string) => ({ toolCalls: [{ name: 'memory_search', input: { query: q } }], text: '' })
    h.mock.llm.script(call('lisbon'), call('may trip'), { text: 'Done.' })
    const t = await h.send(p, s.uid, 'search twice')
    expect(t.done.message.body).toBe('Done.')
    expect(memory.callsOf('search')).toHaveLength(1)
    const sid = repos().sessions.byUid(s.uid)!.id
    const results = repos()
      .transcript.forEpoch(repos().epochs.current(sid)!)
      .filter((r) => r.role === 'tool')
      .map((r) => (r.blocks[0] as { text: string }).text)
    expect(results[1]).toBe(FREE_TIER_SEARCH_LIMIT)
    // Paid tiers are not limited.
    memory.statusValue = { ...memory.statusValue, tier: 'tier1' }
    h.mock.llm.script(call('a'), call('b'), { text: 'ok' })
    await h.send(p, s.uid, 'search twice again')
    expect(memory.callsOf('search')).toHaveLength(3)
  })
})

describe('repos and jobs (07 C6 / C9)', () => {
  it('startup turns streaming replies into stopped / error through messages.recoverStreaming', async () => {
    const s = await h.session()
    const sid = repos().sessions.byUid(s.uid)!.id
    const a = repos().messages.append({ sessionId: sid, role: 'assistant', body: 'half a reply', status: 'streaming', tsUtc: Date.now(), tzOffsetMin: 0, tzName: null, device: null })
    const b = repos().messages.append({ sessionId: sid, role: 'assistant', body: '', status: 'streaming', tsUtc: Date.now(), tzOffsetMin: 0, tzName: null, device: null })
    expect(repos().messages.recoverStreaming()).toBe(2)
    expect(repos().messages.byId(a.id)!.status).toBe('stopped')
    expect(repos().messages.byId(b.id)).toMatchObject({ status: 'error', error: { code: 'internal' } })
    expect(repos().messages.recoverStreaming()).toBe(0)
  })

  it("emptying the trash runs on db.worker's purge job and removes every row", async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'to be purged')
    const sid = repos().sessions.byUid(s.uid)!.id
    await h.inject('DELETE', `/api/sessions/${s.uid}`)
    const real = memoryOf(h.ctx)
    const jobs: string[] = []
    const orig = real.runJob.bind(real)
    real.runJob = (spec, o) => {
      jobs.push(spec.kind)
      return orig(spec, o)
    }
    try {
      const r = await h.inject('POST', '/api/trash/empty')
      expect(r.json()).toMatchObject({ purged: expect.any(Number) })
      expect(jobs).toEqual(['purge'])
    } finally {
      real.runJob = orig
    }
    for (const t of ['messages', 'transcript', 'epochs', 'branches']) {
      expect(Number((h.ctx.db.prepare(`SELECT count(*) AS c FROM ${t} WHERE session_id = ?`).get(sid) as { c: number }).c)).toBe(0)
    }
    expect(repos().sessions.byId(sid)).toBeNull()
  })
})
