/**
 * Memory functions, state notes, epochs and utility tasks through the engine (07 B7, C1, C4, C5, C13, C18, A4):
 * native tool loop ≤ maxToolCalls, text-mode bracket tags, "memory is disabled", auto-recall, notes for state
 * changes, the thinking-strip retry, forced and budgeted rollovers, /continue, auto-title and recaps.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '@shared/ws'
import { coreOf } from '@server/core'
import { FakeMemoryService } from '../../fakes/services'
import { thinkingSignature } from '../../mocks/llm'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import type { WsProbe } from '../server/helpers'

let h: ChatHarness
let memory: FakeMemoryService

beforeAll(async () => {
  process.env.VESPER_CHAT_SUMMARY_IDLE_MS = '50'
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  memory = new FakeMemoryService()
  h.ctx.services.memory = memory
  await h.ctx.settings.patch({ chat: { autoTitle: false, maxToolCalls: 3 }, memory: { enabled: true, autoRecall: false } })
  await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
  try {
    fs.rmSync(path.join(h.ctx.paths.roaming, 'protocols.md'))
  } catch {
    /* absent */
  }
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos

async function fresh(body: Record<string, unknown> = {}): Promise<{ uid: string; shortId: string; p: WsProbe }> {
  const s = await h.session(body)
  return { ...s, p: await h.client(s.uid) }
}

function rowsOf(uid: string): ReturnType<ReturnType<typeof repos>['transcript']['forEpoch']> {
  const s = repos().sessions.byUid(uid)!
  return repos().transcript.forEpoch(repos().epochs.current(s.id)!)
}

/** Chat requests of the engine (not titles/recaps), Anthropic or OpenAI. */
function turnRequests(): Record<string, unknown>[] {
  return chatRequests(h.mock)
    .map((r) => r.json)
    .filter((j) => JSON.stringify(j.system ?? j.messages).includes('# Protocols'))
}

describe('native memory tools @R9', () => {
  it('runs a tool loop through MemoryService and answers with the results', async () => {
    memory.addHit({ body: 'We planned a trip to Lisbon in May.', shortId: 'K7Q2MX' })
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'Let me look.', toolCalls: [{ name: 'memory_search', input: { query: 'lisbon trip', scope: 'galaxy', limit: 99 } }] }, { text: 'You planned Lisbon in May.' })
    const t = await h.send(p, uid, 'where did we plan to go?')
    expect(t.done.message.body).toBe('Let me look.\n\nYou planned Lisbon in May.')
    const search = memory.callsOf('search')[0].args as [{ query: string; limit: number }, { sessionUid: string; requested?: string }, number]
    expect(search[0]).toMatchObject({ query: 'lisbon trip', limit: 10 })
    expect(search[1]).toEqual({ sessionUid: uid, requested: undefined })
    const tool = t.events.find((e) => e.t === 'reply.tool') as Extract<ServerMsg, { t: 'reply.tool' }>
    expect(tool).toMatchObject({ kind: 'search', query: 'lisbon trip', count: 1, sessions: ['K7Q2MX'] })
    expect(t.done.message.recalled).toBe(1)
    const roles = rowsOf(uid).map((r) => r.role)
    expect(roles).toEqual(['user', 'system', 'assistant', 'tool', 'assistant'])
    const result = rowsOf(uid)[3].blocks[0] as { t: string; text: string }
    expect(result.t).toBe('tool_result')
    expect(result.text).toContain('<memory_result id="r_fake">')
    h.mock.recorder.assertPrefixInvariant()
  })

  it('caps calls at chat.maxToolCalls and still pairs every tool_use with a result', async () => {
    await h.ctx.settings.patch({ chat: { maxToolCalls: 2 } })
    const { uid, p } = await fresh()
    const call = { toolCalls: [{ name: 'memory_search', input: { query: 'x' } }], text: '' }
    h.mock.llm.script(call, call, call, { text: 'Done looking.' })
    const t = await h.send(p, uid, 'search a lot')
    expect(t.done.message.body).toBe('Done looking.')
    expect(memory.callsOf('search')).toHaveLength(2)
    const results = rowsOf(uid).filter((r) => r.role === 'tool').map((r) => (r.blocks[0] as { text: string }).text)
    expect(results[2]).toMatch(/^Lookup limit reached/)
  })

  it('memory off: the tools stay declared and answer "memory is disabled" (07 C1)', async () => {
    const { uid, p } = await fresh()
    await h.patchSession(uid, { memory: 'off' })
    h.mock.llm.script({ toolCalls: [{ name: 'memory_recall', input: { session: '#K7Q2MX' } }], text: '' }, { text: 'ok' })
    await h.send(p, uid, 'remember?')
    expect(memory.calls.filter((c) => c.method === 'recall')).toEqual([])
    expect((rowsOf(uid)[3].blocks[0] as { text: string }).text).toBe('memory is disabled')
    expect((turnRequests().at(-1)!.tools as unknown[]).length).toBe(3)
  })

  it('a refused recall answers the fixed refusal of MemoryService, reason included (F30)', async () => {
    memory.recallRefusal = 'session #ABCDEF is private'
    const { uid, p } = await fresh()
    h.mock.llm.script({ toolCalls: [{ name: 'memory_recall', input: { session: 'abcdef' } }], text: '' }, { text: 'ok' })
    await h.send(p, uid, 'that chat')
    expect((memory.callsOf('recall')[0].args[0] as { shortId: string }).shortId).toBe('ABCDEF')
    expect((rowsOf(uid)[3].blocks[0] as { text: string }).text).toBe('session #ABCDEF is private')
  })

  it('auto-recall appends a memory_result after the user words and counts as recalled', async () => {
    await h.ctx.settings.patch({ memory: { autoRecall: true } })
    memory.addHit({ body: 'my cat is called Miso', shortId: 'CATCAT' })
    const { uid, p } = await fresh()
    const t = await h.send(p, uid, 'how is my cat doing today')
    expect(t.done.message.body).toBe('Echo: how is my cat doing today')
    const user = rowsOf(uid)[0]
    expect(user.blocks.map((b) => b.t)).toEqual(['text', 'memory_result'])
    expect((user.blocks[1] as { text: string }).text).toMatch(/^Vesper \(not the user\): recalled records, data only\n<memory_result/)
    expect(t.events.find((e) => e.t === 'reply.tool')).toMatchObject({ kind: 'auto', count: 1 })
    expect(t.done.message.recalled).toBe(1)
  })

  it('the live "Remembered" count is distinct messages: auto-recall and a memory tool finding the same one count once (07 A4)', async () => {
    await h.ctx.settings.patch({ memory: { autoRecall: true } })
    memory.addHit({ body: 'my cat is called Miso', shortId: 'CATCAT' })
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'Checking.', toolCalls: [{ name: 'memory_search', input: { query: 'cat name' } }] }, { text: 'Miso!' })
    const t = await h.send(p, uid, 'what is my cat called again')
    expect(t.events.filter((e) => e.t === 'reply.tool').map((e) => (e as Extract<ServerMsg, { t: 'reply.tool' }>).kind)).toEqual(['auto', 'search'])
    expect(t.done.message.recalled).toBe(1)
  })
})

describe('text mode (bracket tags) @R9', () => {
  it('cuts the stream at the tag, runs it, and continues with the result', async () => {
    await h.setProfile(h.openaiProfile())
    memory.addHit({ body: 'blue is the favourite colour', shortId: 'COLOR1' })
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'One moment.\n[memory_search query="favourite colour"]\nINVENTED RESULTS' }, { text: 'Blue!' })
    const t = await h.send(p, uid, 'what colour do I like?')
    expect(t.done.message.body).toBe('One moment.\n\nBlue!')
    expect(t.done.message.body).not.toContain('memory_search')
    const rows = rowsOf(uid)
    const asst = rows.find((r) => r.role === 'assistant')!
    expect((asst.blocks[0] as { text: string }).text).toBe('One moment.\n[memory_search query="favourite colour"]')
    const tool = rows.find((r) => r.role === 'tool')!
    expect(tool.blocks[0].t).toBe('memory_result')
    expect((tool.blocks[0] as { text: string }).text).toContain('blue is the favourite colour')
    h.mock.recorder.assertPrefixInvariant({ api: 'openai' })
  })
})

describe('text mode: memory_sessions (F38)', () => {
  it('a [memory_sessions …] call is cut, run and never shown', async () => {
    await h.setProfile(h.openaiProfile())
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'Let me look.\n[memory_sessions query="recipes"]' }, { text: 'Found it.' })
    const t = await h.send(p, uid, 'which chat had the recipes?')
    expect(t.done.message.body).toBe('Let me look.\n\nFound it.')
    expect(t.events.filter((e) => e.t === 'reply.tool').map((e) => (e as Extract<ServerMsg, { t: 'reply.tool' }>).kind)).toEqual(['sessions'])
    const tool = rowsOf(uid).find((r) => r.role === 'tool')!
    expect((tool.blocks[0] as { text: string }).text).toContain('results of [memory_sessions query="recipes"]')
  })
})

describe('state notes (07 C1, A4, C13)', () => {
  it('memory / prompt / facts / links changes arrive as appended notes; system stays frozen', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'one')
    await h.patchSession(uid, { memory: 'off', systemPrompt: 'Answer like a pirate.' })
    repos().facts.create('My birthday is 3 March.', Date.now())
    const other = await h.session()
    await h.inject('PUT', `/api/sessions/${uid}/links/${other.shortId}`, {})
    await h.send(p, uid, 'two')
    const notes = rowsOf(uid).filter((r) => r.role === 'system').map((r) => r.blocks.map((b) => (b as { text: string }).text).join('\n'))
    expect(notes).toHaveLength(2)
    expect(notes[1]).toContain('turned memory off')
    expect(notes[1]).toContain('From now on:\nAnswer like a pirate.')
    expect(notes[1]).toContain('- My birthday is 3 March.')
    const reqs = turnRequests()
    expect(JSON.stringify(reqs.at(-1)!.system)).toBe(JSON.stringify(reqs.at(-2)!.system))
    expect(JSON.stringify(reqs.at(-1)!.system)).not.toContain('pirate')
    h.mock.recorder.assertPrefixInvariant()
    for (const f of repos().facts.list()) repos().facts.delete(f.id)
  })

  it('the epoch opens with the manifest (memory on) and the voice state', async () => {
    memory.addHit({ body: 'x', shortId: 'LINKED', sessionTitle: 'Plans' })
    const { uid, p } = await fresh()
    await h.send(p, uid, 'hello', { speak: true })
    const opening = rowsOf(uid)[1]
    expect(opening.role).toBe('system')
    const text = opening.blocks.map((b) => (b as { text: string }).text).join('\n')
    expect(text).toContain('Conversations you can access with the memory functions:\n#LINKED · Plans')
    expect(text).toContain('Voice is on')
    // Opus 5.5 takes it as a mid-conversation system message after the user turn.
    const msgs = turnRequests().at(-1)!.messages as { role: string }[]
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system'])
  })
})

describe('thinking strip (07 C5)', () => {
  it('a history 400 strips earlier thinking (persisted watermark) and retries once', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ reasoning: 'deep thought', text: 'First answer.' })
    await h.send(p, uid, 'first')
    expect(JSON.stringify(rowsOf(uid).map((r) => r.blocks))).toContain(thinkingSignature('deep thought'))
    h.mock.llm.script({ error: { status: 400, message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } })
    const t = await h.send(p, uid, 'second')
    expect(t.done.message).toMatchObject({ status: 'complete', body: 'Echo: second' })
    const s = repos().sessions.byUid(uid)!
    expect(repos().epochs.current(s.id)!.thinkingStripBefore).not.toBeNull()
    const last = turnRequests().at(-1)!
    expect(JSON.stringify(last.messages)).not.toContain('"thinking"')
    // Later turns keep the strip (the next request is valid and still has no old thinking).
    const t3 = await h.send(p, uid, 'third')
    expect(t3.done.message.status).toBe('complete')
    expect(JSON.stringify(turnRequests().at(-1)!.messages)).not.toContain('deep thought')
  })

  it('a history 400 in the middle of a tool loop strips only earlier turns', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ reasoning: 'old', text: 'Earlier.' })
    await h.send(p, uid, 'one')
    h.mock.llm.script(
      { reasoning: 'now', toolCalls: [{ name: 'memory_search', input: { query: 'q' } }], text: '' },
      { error: { status: 400, message: 'Invalid `signature` in `thinking` block' } },
      { text: 'Recovered.' }
    )
    const t = await h.send(p, uid, 'two')
    expect(t.done.message.body).toBe('Recovered.')
    const last = JSON.stringify(turnRequests().at(-1)!.messages)
    expect(last).not.toContain(thinkingSignature('old'))
    expect(last).toContain(thinkingSignature('now'))
  })
})

describe('epochs (07 C4)', () => {
  it('a context error forces a rollover with a recap and one retry', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'we talked about gardening')
    h.mock.llm.script({ error: { status: 400, message: 'prompt is too long: 300000 tokens > 200000 maximum' } }, { text: 'A recap about gardening.', match: { lastUserIncludes: 'Updated recap:' } })
    const t = await h.send(p, uid, 'next')
    expect(t.done.message).toMatchObject({ status: 'complete', body: 'Echo: next' })
    const created = t.events.find((e) => e.t === 'epoch.created') as Extract<ServerMsg, { t: 'epoch.created' }>
    expect(created.startSeq).toBe(3)
    const rows = rowsOf(uid)
    expect(rows[0].blocks.map((b) => b.t)).toEqual(['text', 'memory_result'])
    expect((rows[0].blocks[1] as { text: string }).text).toContain('A recap about gardening.')
    const msgs = turnRequests().at(-1)!.messages as unknown[]
    expect(JSON.stringify(msgs)).not.toContain('we talked about gardening"')
  })

  it('rolls over at the budget: background draft, then a new epoch at the next turn', async () => {
    await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { contextWindow: 6000 }, options: { maxTokens: 512, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false } }))
    const { uid, p } = await fresh()
    const long = 'lorem ipsum dolor sit amet '.repeat(60)
    let created: ServerMsg | undefined
    for (let i = 0; i < 8 && !created; i++) {
      const t = await h.send(p, uid, `${i} ${long}`)
      created = t.events.find((e) => e.t === 'epoch.created')
      await new Promise((r) => setTimeout(r, 30)) // let the background draft finish
    }
    expect(created).toBeDefined()
    const s = repos().sessions.byUid(uid)!
    const e = repos().epochs.current(s.id)!
    expect(e.recap).toBeTruthy()
    expect(e.startMessageId).not.toBe(0n)
    // Nothing older than the epoch is sent: one system + one user message (+ its folded notes).
    const msgs = turnRequests().at(-1)!.messages as { role: string }[]
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('newEpoch (apply protocols) takes effect at the next turn with the edited protocols', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'before')
    fs.writeFileSync(path.join(h.ctx.paths.roaming, 'protocols.md'), '# Protocols\nYou are {{assistant_name}} (edited).')
    await h.send(p, uid, 'edited but not applied')
    expect(JSON.stringify(turnRequests().at(-1)!.system)).not.toContain('(edited)')
    const r = await h.inject('POST', `/api/sessions/${uid}/epoch`, { reason: 'apply-protocols' })
    expect(r.statusCode).toBe(200)
    const t = await h.send(p, uid, 'after apply')
    expect(t.events.some((e) => e.t === 'epoch.created')).toBe(true)
    expect(JSON.stringify(turnRequests().at(-1)!.system)).toContain('You are Vesper (edited).')
  })
})

describe('utility tasks (07 C18)', () => {
  it('auto-titles after the first exchange', async () => {
    await h.ctx.settings.patch({ chat: { autoTitle: true } })
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '"Lisbon Trip Plans."', match: { lastUserIncludes: 'Title:' } })
    const t = await h.send(p, uid, 'help me plan lisbon')
    void t
    const upd = (await waitMsg(p, (m) => m.t === 'session.updated' && m.session.title !== '')) as Extract<ServerMsg, { t: 'session.updated' }>
    expect(upd.session.title).toBe('Lisbon Trip Plans')
  })

  it('/continue: a hidden opener carries the recap and the AI greets', async () => {
    const src = await fresh()
    await h.send(src.p, src.uid, 'we planned the garden')
    h.mock.llm.script({ text: 'They planned a garden.', match: { lastUserIncludes: 'Updated recap:' } }, { text: 'Welcome back! The garden?' })
    const r = await h.inject('POST', '/api/sessions', { continueFrom: src.uid })
    const nu = (r.json() as { uid: string }).uid
    // Subscribe from evSeq 0: the opener may already be done (the ring replays it).
    const p = await h.client()
    p.send({ t: 'subscribe', sessionUid: nu, sinceEvSeq: 0 })
    const done = (await waitMsg(p, (m) => m.t === 'reply.done', 10_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.body).toBe('Welcome back! The garden?')
    const s = repos().sessions.byUid(nu)!
    const [opener] = repos().messages.tail(s.id, 2)
    expect(opener.hidden).toBe(true)
    const row = repos().transcript.forMessage(opener.id)[0]
    expect((row.blocks[0] as { text: string }).text).toMatch(new RegExp(`^\\[Now: [^\\]]+\\]\\nGreet the user and pick up where you left off in conversation #${src.shortId}\\.$`))
    expect((row.blocks[1] as { text: string }).text).toContain('They planned a garden.')
    const page = (await h.inject('GET', `/api/sessions/${nu}/messages?mode=latest`)).json() as { items: { hidden?: boolean }[] }
    expect(page.items[0].hidden).toBe(true)
  })

  it('refreshes the session summary at idle after 20 new messages (07 C13)', async () => {
    await h.setProfile(h.openaiProfile())
    const { uid, p } = await fresh()
    for (let i = 0; i < 10; i++) await h.send(p, uid, `message ${i}`)
    h.mock.llm.script({ text: 'Ten test messages about numbers.', match: { lastUserIncludes: 'One-sentence summary:' } })
    const upd = (await waitMsg(p, (m) => m.t === 'session.updated' && !!m.session.summary, 5000)) as Extract<ServerMsg, { t: 'session.updated' }>
    expect(upd.session.summary).toBe('Ten test messages about numbers.')
    expect(repos().sessions.byUid(uid)!.meta.summaryAt).toBe(20)
    expect(h.engine.stats().timers).toBe(0)
  })

  it('streams reasoning to clients only when showReasoning is on', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ reasoning: 'hidden thoughts', text: 'A.' })
    const t1 = await h.send(p, uid, 'one')
    expect(t1.events.some((e) => e.t === 'reply.reasoning')).toBe(false)
    await h.ctx.settings.patch({ chat: { showReasoning: true } })
    h.mock.llm.script({ reasoning: 'shown thoughts', text: 'B.' })
    const t2 = await h.send(p, uid, 'two')
    expect(t2.events.filter((e) => e.t === 'reply.reasoning').map((e) => (e as { text: string }).text).join('')).toBe('shown thoughts')
    await h.ctx.settings.patch({ chat: { showReasoning: false } })
  })

  it('recap is cached per (session, last message)', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'cache me')
    h.mock.llm.script({ text: 'Recap one.', match: { lastUserIncludes: 'Updated recap:' } })
    expect(await h.engine.recap(uid)).toBe('Recap one.')
    const before = chatRequests(h.mock).length
    expect(await h.engine.recap(uid)).toBe('Recap one.')
    expect(chatRequests(h.mock).length).toBe(before)
  })

  it('falls back to an extractive recap when the utility model fails', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'remember the tulips')
    h.mock.llm.script({ error: { status: 500 }, match: { lastUserIncludes: 'Updated recap:' } })
    const text = await h.engine.recap(uid)
    expect(text).toContain('Most recent messages:')
    expect(text).toContain('remember the tulips')
  })
})
