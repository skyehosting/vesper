/**
 * Keyword memory for the AI without Voyage (Phase 4b F37/F27, research 02 §5.7 "Voyage not configured → memory
 * functions work in keyword mode", Settings → Memory "Keyword memory is always on"): with the Voyage switch off
 * (the default) the memory functions, links, the manifest and auto-recall work on this PC by keywords; only a chat's
 * own memory switch turns them off. One definition of "memory on" everywhere (engine, notes, tools, MemoryService).
 * Real server, real MemoryService (in-process db.worker), mock LLM; no Voyage key — nothing goes to Voyage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import { findMessage } from '@server/chat/temporary'
import { runMemoryFunction } from '@server/chat/tools'
import { runDailyPurge } from '@server/memory/purge'
import type { MemoryService } from '@server/services'
import { ChatHarness } from './harness'

let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  await h.ctx.settings.patch({ chat: { autoTitle: false, maxToolCalls: 3 }, memory: { enabled: false, autoRecall: false, scopeDefault: 'linked' } })
  await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos

function wire(uid: string): { role: string; text: string }[] {
  const s = repos().sessions.byUid(uid)!
  return repos()
    .transcript.forEpoch(repos().epochs.current(s.id)!)
    .map((r) => ({ role: r.role, text: r.blocks.map((b) => ('text' in b ? b.text : '')).join('\n') }))
}

/** A chat that once talked about Lisbon, linked from a new chat. */
async function linkedPair(): Promise<{ a: { uid: string; shortId: string }; b: { uid: string; shortId: string } }> {
  const a = await h.session({ title: 'Trip planning' })
  const pa = await h.client(a.uid)
  await h.send(pa, a.uid, 'We planned a trip to lisbon in May with the kids')
  pa.close()
  const b = await h.session({ title: 'Today' })
  const r = await h.inject('PUT', `/api/sessions/${b.uid}/links/${a.shortId}`, {})
  expect(r.statusCode).toBeLessThan(300)
  return { a, b }
}

describe('F37: AI memory works by keywords while the Voyage switch is off', () => {
  it('memory_search and memory_recall find the linked chat; the manifest lists it', async () => {
    expect(h.ctx.settings.get().memory.enabled).toBe(false)
    const { a, b } = await linkedPair()
    const pb = await h.client(b.uid)
    h.mock.llm.script(
      { text: '', toolCalls: [{ name: 'memory_search', input: { query: 'lisbon trip' } }] },
      { text: '', toolCalls: [{ name: 'memory_recall', input: { session: `#${a.shortId}` } }] },
      { text: 'Lisbon in May.' }
    )
    const t = await h.send(pb, b.uid, 'what did we decide about the trip?')
    expect(t.done.message.body).toContain('Lisbon in May.')
    const rows = wire(b.uid)
    const notes = rows.filter((r) => r.role === 'system').map((r) => r.text).join('\n')
    expect(notes).toContain('Conversations you can access with the memory functions')
    expect(notes).toContain(`#${a.shortId}`)
    expect(notes).not.toContain('memory is disabled')
    const results = rows.filter((r) => r.role === 'tool').map((r) => r.text)
    expect(results).toHaveLength(2)
    for (const x of results) {
      expect(x).not.toBe('memory is disabled')
      expect(x).toContain('lisbon in May')
    }
    pb.close()
  })

  it('a chat whose own memory is off still answers "memory is disabled"', async () => {
    const { b } = await linkedPair()
    await h.patchSession(b.uid, { memory: 'off' })
    const pb = await h.client(b.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'lisbon' } }] }, { text: 'ok' })
    await h.send(pb, b.uid, 'do you remember lisbon?')
    expect(wire(b.uid).filter((r) => r.role === 'tool').map((r) => r.text)).toEqual(['memory is disabled'])
    pb.close()
  })
})

describe('F29: scope and access changes reach the AI as a fresh manifest (07 C13)', () => {
  it('narrowing to this chat, widening again, and a linked chat turning private each re-send the list', async () => {
    const { a, b } = await linkedPair()
    const pb = await h.client(b.uid)
    const manifests = () => wire(b.uid).filter((r) => r.role === 'system' && r.text.includes('Conversations you can access'))
    await h.send(pb, b.uid, 'first turn here')
    expect(manifests()).toHaveLength(1)
    expect(manifests()[0].text).toContain(`#${a.shortId}`)

    await h.patchSession(b.uid, { memoryScope: 'this' })
    await h.send(pb, b.uid, 'second turn here')
    expect(manifests()).toHaveLength(2)
    expect(manifests()[1].text).not.toContain(`#${a.shortId}`)

    await h.patchSession(b.uid, { memoryScope: 'linked' })
    await h.send(pb, b.uid, 'third turn here')
    expect(manifests()).toHaveLength(3)
    expect(manifests()[2].text).toContain(`#${a.shortId}`)

    await h.patchSession(a.uid, { private: true })
    await h.send(pb, b.uid, 'fourth turn here')
    expect(manifests()).toHaveLength(4)
    expect(manifests()[3].text).not.toContain(`#${a.shortId}`)

    // Nothing changed: no new note.
    await h.send(pb, b.uid, 'fifth turn here')
    expect(manifests()).toHaveLength(4)
    pb.close()
  })
})

describe('F71: the Remembered chip of a temporary chat lists what THAT reply recalled', () => {
  it('ids never cross stores: a vesper.db turn with the same internal id is not shown', async () => {
    await h.ctx.settings.patch({ memory: { scopeDefault: 'all' } })
    const a = await h.session({ title: 'Festival' })
    const pa = await h.client(a.uid)
    await h.send(pa, a.uid, 'lantern festival plans for the weekend')
    pa.close()
    const temp = await h.session({ temporary: true })
    const pt = await h.client(temp.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'lantern festival' } }] }, { text: 'Found it.' })
    const t = await h.send(pt, temp.uid, 'what were the lantern plans?')
    expect(t.done.message.recalled).toBeGreaterThan(0)
    // A vesper.db reply whose internal id equals the temporary reply's (both stores count from 1) recalled something else.
    const tempAsst = findMessage(h.ctx, t.done.message.uid)!
    expect(tempAsst.store.temporary).toBe(true)
    const other = repos().sessions.create({ title: 'Other', now: Date.now() })
    const wrong = repos().messages.append({ sessionId: other.id, role: 'user', body: 'WRONGROW from another chat', tsUtc: Date.now(), tzOffsetMin: 0, tzName: 'UTC', device: null })
    repos().memoryInjections.add(other.id, wrong.id, tempAsst.message.id)
    const r = await h.inject('GET', `/api/messages/${t.done.message.uid}/recalled`)
    expect(r.statusCode).toBe(200)
    const bodies = (r.json() as { body: string; sessionUid: string }[]).map((x) => x.body)
    expect(bodies).not.toContain('WRONGROW from another chat')
    expect(bodies).toContain('lantern festival plans for the weekend')
    expect(bodies.length).toBe(t.done.message.recalled)
    pt.close()
    await h.inject('DELETE', `/api/sessions/${temp.uid}`)
  })
})

describe('F30: recall refusals keep their reason', () => {
  it('an unlinked chat: the model learns it can ask the user to /link it; a typo: that the ID does not exist', async () => {
    const { a } = await linkedPair()
    const c = await h.session({ title: 'Unlinked' })
    const pc = await h.client(c.uid)
    h.mock.llm.script(
      { text: '', toolCalls: [{ name: 'memory_recall', input: { session: `#${a.shortId}` } }] },
      { text: '', toolCalls: [{ name: 'memory_recall', input: { session: '#ZZZZZZ' } }] },
      { text: 'ok' }
    )
    await h.send(pc, c.uid, 'remember that trip chat?')
    const results = wire(c.uid).filter((r) => r.role === 'tool').map((r) => r.text)
    expect(results[0]).toBe(`Conversation #${a.shortId} is not linked to this one. Ask the user to link it with /link #${a.shortId}.`)
    expect(results[1]).toBe('There is no conversation #ZZZZZZ.')
    pc.close()
  })

  it('a linked chat that cannot be reached says why: its memory is off, or this chat is narrowed to itself (no /link hint)', async () => {
    const recall = (target: string, from: string) => (h.ctx.services.memory as MemoryService).recall({ shortId: target }, { sessionUid: from })
    // The target's own memory is off: linking again would change nothing.
    const { a, b } = await linkedPair()
    await h.patchSession(a.uid, { memory: 'off' })
    const off = await recall(a.shortId, b.uid)
    expect(off.hits).toEqual([])
    expect(off.refused).toBe(`Memory is turned off for conversation #${a.shortId}, so it can't be recalled.`)
    expect(off.refused).not.toContain('/link')

    // This chat's memory is narrowed to itself (F29's scenario): the link is there, the scope keeps it out.
    const pair = await linkedPair()
    await h.patchSession(pair.b.uid, { memoryScope: 'this' })
    const narrow = await recall(pair.a.shortId, pair.b.uid)
    expect(narrow.hits).toEqual([])
    expect(narrow.refused).toBe(
      `This conversation's memory is limited to itself, so it can't recall #${pair.a.shortId}. The user can widen it in this chat's memory settings.`
    )
    // Widened again: recalled.
    await h.patchSession(pair.b.uid, { memoryScope: 'linked' })
    const wide = await recall(pair.a.shortId, pair.b.uid)
    expect(wide.refused).toBeUndefined()
    expect(wide.hits.map((x) => x.body).join('\n')).toContain('lisbon')
  })
})

describe('F16: the 30-day purge reaches copies recalled into other chats', () => {
  it('auto-recall and memory_search copies in a linked chat say "(deleted)" after the purge; the DB keeps no trace', async () => {
    await h.ctx.settings.patch({ memory: { autoRecall: true } })
    const a = await h.session({ title: 'Holiday' })
    const pa = await h.client(a.uid)
    // The reply doesn't quote it (a reply is its own message: deleting the user's message leaves it).
    h.mock.llm.script({ text: 'Noted.' })
    await h.send(pa, a.uid, 'my PURGECANARY zanzibar holiday passport number is 12345')
    pa.close()
    const b = await h.session({ title: 'Today' })
    expect((await h.inject('PUT', `/api/sessions/${b.uid}/links/${a.shortId}`, {})).statusCode).toBeLessThan(300)
    const pb = await h.client(b.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'zanzibar passport' } }] }, { text: 'Found it.' })
    await h.send(pb, b.uid, 'what about the zanzibar holiday passport?')
    pb.close()
    const sb = repos().sessions.byUid(b.uid)!
    const copies = () => JSON.stringify(repos().transcript.forEpoch(repos().epochs.current(sb.id)!).map((r) => r.blocks))
    // Recalled twice: the auto-recall block of the user row and the tool result.
    expect(copies().split('PURGECANARY').length - 1).toBeGreaterThanOrEqual(2)

    const sa = repos().sessions.byUid(a.uid)!
    const msg = repos().messages.tail(sa.id, 10).find((m) => m.body.includes('PURGECANARY'))!
    expect((await h.inject('DELETE', `/api/messages/${msg.uid}`)).statusCode).toBe(204)
    const core = coreOf(h.ctx)
    core.clockOffsetMs += 31 * 24 * 3_600_000
    try {
      expect(await runDailyPurge(h.ctx, { force: true })).toMatchObject({ ran: true, cleared: 1 })
    } finally {
      core.clockOffsetMs -= 31 * 24 * 3_600_000
    }
    expect(repos().messages.byId(msg.id)!.body).toBe('')
    const after = copies()
    expect(after).not.toContain('PURGECANARY')
    expect(after).toContain('user response] (deleted)')
    const left = h.ctx.db.prepare("SELECT count(*) AS n FROM transcript WHERE blocks LIKE '%PURGECANARY%'").get() as { n: number | bigint }
    expect(Number(left.n)).toBe(0)
  })
})

describe('F27: one definition of "memory on" (session switch vs the global one)', () => {
  it("'/memory on' with the global switch off: search finds the record instead of 'No matching records'", async () => {
    const { b } = await linkedPair()
    await h.patchSession(b.uid, { memory: 'on' })
    const pb = await h.client(b.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'lisbon' } }] }, { text: 'ok' })
    await h.send(pb, b.uid, 'what did I tell you about my trip?')
    const result = wire(b.uid).find((r) => r.role === 'tool')!.text
    expect(result).not.toContain('No matching records were found.')
    expect(result).toContain('lisbon in May')
    pb.close()
  })

  it('a refusal from MemoryService reaches the model as its text, never as an empty result', async () => {
    const refusing = {
      search: async () => ({ hits: [], mode: 'keyword' as const, refused: 'Memory is turned off for this conversation.' }),
      formatResult: () => 'No matching records were found.'
    } as unknown as MemoryService
    const env = { memory: refusing, enabled: true, sessionUid: 'x', nowUtc: 0, tzName: null, tzOffsetMin: 0 }
    const r = await runMemoryFunction('memory_search', { query: 'lisbon' }, env)
    expect(r.text).toBe('Memory is turned off for this conversation.')
  })
})
