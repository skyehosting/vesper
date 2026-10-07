/**
 * Regenerate chooses its epoch like a send does (07 C1/C4/C7/C19):
 *  - F25: in an imported conversation (messages without a wire transcript) the earlier messages reach the model as a
 *    recap and the user turn itself is sent — on the regenerate and on every later turn of that branch;
 *  - F26: a switch to a profile with another tool capability starts a new epoch (no native `tools` to a tools:false
 *    profile), the hard budget rolls over, and a context-overflow error gets the forced rollover + one retry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import type { ServerMsg } from '@shared/ws'
import { ChatHarness, chatRequests } from './harness'
import type { WsProbe } from '../server/helpers'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start({ now: T0 })
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  h.ctx.services.memory = undefined
  h.platform.setNow(T0)
  await h.ctx.settings.patch({ chat: { autoTitle: false } })
  await h.setProfile(h.openaiProfile())
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos
const client = { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' }

/** Chat requests of the engine only (not recap / title utility calls). */
function turnRequests(): Record<string, unknown>[] {
  return chatRequests(h.mock)
    .map((r) => r.json)
    .filter((j) => JSON.stringify(j.system ?? j.messages).includes('# Protocols'))
}

async function regenerate(p: WsProbe, uid: string, messageUid: string, id: string): Promise<Awaited<ReturnType<ChatHarness['awaitTurn']>>> {
  p.send({ t: 'chat.regenerate', id, sessionUid: uid, messageUid, speak: false, client })
  return h.awaitTurn(p, id)
}

/** Messages written the way an import writes them: rows in `messages`, no transcript, no epoch. */
function imported(uid: string, items: [role: 'user' | 'assistant', body: string][]): string[] {
  const s = repos().sessions.byUid(uid)!
  return items.map(([role, body], i) => repos().messages.append({ sessionId: s.id, role, body, tsUtc: T0 - 86_400_000 + i * 60_000, tzOffsetMin: 0, tzName: 'UTC', device: 'import', status: 'complete' }).uid)
}

describe('regenerate in an imported conversation (F25)', () => {
  it('sends the earlier messages as a recap and the user turn itself, then keeps them for later turns', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const uids = imported(s.uid, [
      ['user', 'my favourite tea is oolong'],
      ['assistant', 'Noted, oolong.'],
      ['user', 'my cat is Miso'],
      ['assistant', 'Miso, lovely.']
    ])
    h.mock.llm.script({ text: 'Miso is a lovely name.', match: { lastUserIncludes: 'my cat is Miso' } })
    const r = await regenerate(p, s.uid, uids[3], 'rg1')
    expect(r.done.message).toMatchObject({ status: 'complete', body: 'Miso is a lovely name.' })
    const req = JSON.stringify(turnRequests().at(-1))
    expect(req).toContain('oolong')
    expect(req).toContain('my cat is Miso')
    expect(r.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    // The epoch starts at the user turn and carries the recap (never a start-0 epoch over transcript-less history).
    const e = repos().epochs.current(repos().sessions.byUid(s.uid)!.id)!
    expect(e.startMessageId).toBe(repos().messages.byUid(uids[2])!.id)
    expect(e.recap).toContain('oolong')

    await h.send(p, s.uid, 'what tea do I like and what is my cat?')
    const next = JSON.stringify(turnRequests().at(-1))
    expect(next).toContain('oolong')
    expect(next).toContain('my cat is Miso')
  })

  it('regenerating the first imported reply sends its user message', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const uids = imported(s.uid, [
      ['user', 'hello from the archive'],
      ['assistant', 'Hi.']
    ])
    await regenerate(p, s.uid, uids[1], 'rg2')
    expect(JSON.stringify(turnRequests().at(-1))).toContain('hello from the archive')
  })
})

describe('regenerate honours tool mode, budget and context overflow (F26)', () => {
  it('after a switch to a tools:false profile the regenerate sends no native tools (a new text-mode epoch)', async () => {
    await h.ctx.settings.patch({
      llm: {
        profiles: [
          { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: `${h.mock.url}/anthropic`, model: 'claude-opus-5-5' },
          { id: 'local', label: 'Local', preset: 'custom', adapter: 'openai', baseUrl: `${h.mock.url}/v1`, model: 'mock-local', capabilities: { tools: false } }
        ] as never,
        defaultProfile: 'claude'
      }
    })
    await h.ctx.secrets.set('llm:claude', 'sk-ant-test-0123456789', `${h.mock.url}/anthropic`)
    const s = await h.session()
    const p = await h.client(s.uid)
    const t = await h.send(p, s.uid, 'hello there friend')
    await h.patchSession(s.uid, { llmProfile: 'local', model: 'mock-local' })
    const r = await regenerate(p, s.uid, t.done.message.uid, 'rg3')
    expect(r.done.message.status).toBe('complete')
    const req = turnRequests().at(-1)!
    expect(req.model).toBe('mock-local')
    expect(req.tools).toBeUndefined()
    expect(JSON.stringify(req)).toContain('hello there friend')
    const e = repos().epochs.current(repos().sessions.byUid(s.uid)!.id)!
    expect(e.toolMode).toBe('text')
  })

  it('a context overflow on regenerate gets the forced rollover and one retry', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'we talked about gardening')
    const t = await h.send(p, s.uid, 'and about roses')
    h.mock.llm.script({ error: { status: 400, message: "This model's maximum context length is 8192 tokens." }, match: { lastUserIncludes: 'and about roses' } })
    const r = await regenerate(p, s.uid, t.done.message.uid, 'rg4')
    expect(r.done.message).toMatchObject({ status: 'complete', body: 'Echo: and about roses' })
    expect(r.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(JSON.stringify(turnRequests().at(-1))).not.toContain('we talked about gardening"')
  })

  it('over the hard window a regenerate rolls over first', async () => {
    await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { contextWindow: 4000 }, options: { maxTokens: 512, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false } }))
    const s = await h.session()
    const p = await h.client(s.uid)
    const long = 'lorem ipsum dolor sit amet '.repeat(40)
    await h.send(p, s.uid, `one ${long}`)
    const t = await h.send(p, s.uid, `two ${long}`)
    // A smaller model now: the same history no longer fits its hard window.
    await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { contextWindow: 1500 }, options: { maxTokens: 256, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false } }))
    const r = await regenerate(p, s.uid, t.done.message.uid, 'rg5')
    expect(r.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(r.done.message.status).toBe('complete')
  })
})
