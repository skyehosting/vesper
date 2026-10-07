/**
 * F24 (07 C3/C4, B9): the background recap draft is tied to the path it summarised. An edit, a regenerate, a variant
 * switch or a delete after the draft was written never lets the edited-away, rejected or deleted text reach the model,
 * and "Delete and refresh context" always recomputes (also while a reply is still streaming).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import type { ServerMsg } from '@shared/ws'
import { echoTurn } from '../../mocks/llm'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import type { WsProbe } from '../server/helpers'

let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  // A pasted secret is never repeated by the reply (only the user's own message holds it).
  h.mock.llm.setDefault((info) => (info.lastUserText.startsWith('MY ') ? { text: 'Noted.' } : echoTurn(info)))
  h.ctx.services.memory = undefined
  await h.ctx.settings.patch({ chat: { autoTitle: false } })
  await h.setProfile(h.openaiProfile('mock-echo', { capabilities: { contextWindow: 6000 }, options: { maxTokens: 512, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false } }))
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos
const LONG = 'lorem ipsum dolor sit amet '.repeat(60)
const client = { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' }

/** Chat requests of the engine only (not recap / title utility calls). */
function turnRequests(): string[] {
  return chatRequests(h.mock)
    .map((r) => JSON.stringify(r.json))
    .filter((j) => j.includes('# Protocols'))
}

function draftOf(uid: string): string | null {
  const s = repos().sessions.byUid(uid)!
  return repos().epochs.current(s.id)?.recapDraft ?? null
}

async function waitDraft(uid: string): Promise<void> {
  const until = Date.now() + 5000
  while (!draftOf(uid)) {
    if (Date.now() > until) throw new Error('no draft')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Send long turns until the background draft exists (fill ≥ 0.75 × budget); returns each turn's user/reply uids. */
async function untilDraft(p: WsProbe, uid: string, texts: string[]): Promise<{ userUid: string; replyUid: string }[]> {
  const out: { userUid: string; replyUid: string }[] = []
  for (const text of texts) {
    const t = await h.send(p, uid, `${text} ${LONG}`)
    out.push({ userUid: t.userUid!, replyUid: t.done.message.uid })
    await new Promise((r) => setTimeout(r, 30))
    if (draftOf(uid)) return out
  }
  await waitDraft(uid)
  return out
}

describe('the recap draft follows the path (F24)', () => {
  it('edit: the edited-away words never reach the model through the draft', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const turns = await untilDraft(p, s.uid, ['SECRETWORD1', 'second', 'third', 'fourth'])
    expect(draftOf(s.uid)).toContain('SECRETWORD1')
    p.send({ t: 'chat.edit', id: 'ed', sessionUid: s.uid, messageUid: turns[0].userUid, text: 'short fixed text', attachments: [], speak: false, client })
    await h.awaitTurn(p, 'ed')
    expect(turnRequests().at(-1)).not.toContain('SECRETWORD1')
    // …nor at the next turn.
    await h.send(p, s.uid, 'and then')
    expect(turnRequests().at(-1)).not.toContain('SECRETWORD1')
  })

  it('delete and refresh context: the deleted text is gone from the next request even with a draft waiting', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const turns = await untilDraft(p, s.uid, ['MY PASSWORD IS HUNTER2', 'second', 'third', 'fourth'])
    expect(draftOf(s.uid)).toContain('HUNTER2')
    const r = await h.inject('DELETE', `/api/messages/${turns[0].userUid}?refresh=1`)
    expect(r.statusCode).toBe(204)
    const t = await h.send(p, s.uid, 'next')
    expect(t.events.some((e) => e.t === 'epoch.created')).toBe(true)
    expect(turnRequests().at(-1)).not.toContain('HUNTER2')
  })

  it('regenerate (a variant): the rejected reply never reaches the model through the draft', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    // Every chat turn "turn<n>" answers with its own canary REPLY<n> (recap calls echo their prompt).
    h.mock.llm.setDefault((info) => {
      const m = /^turn(\d+) /.exec(info.lastUserText)
      return m ? { text: `REPLY${m[1]}X ${LONG}` } : echoTurn(info)
    })
    const turns = await untilDraft(p, s.uid, ['turn0', 'turn1', 'turn2', 'turn3', 'turn4', 'turn5'])
    h.mock.llm.setDefault(echoTurn)
    // The draft was written at the last turn's user message: it covers the reply before it.
    const k = turns.length - 2
    expect(draftOf(s.uid)).toContain(`REPLY${k}X`)
    const t1 = { done: { message: { uid: turns[k].replyUid } } }
    h.mock.llm.script({ text: 'Another take.' })
    p.send({ t: 'chat.regenerate', id: 'rg', sessionUid: s.uid, messageUid: t1.done.message.uid, speak: false, client })
    await h.awaitTurn(p, 'rg')
    await h.send(p, s.uid, 'after the switch')
    expect(turnRequests().at(-1)).not.toContain(`REPLY${k}X`)
  })

  it('delete and refresh while a reply is streaming is not dropped: the next turn starts a new epoch without it', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const first = await h.send(p, s.uid, 'MY PIN IS 4711')
    await h.send(p, s.uid, 'something else')
    h.mock.llm.script({ text: 'slow '.repeat(40), delayMs: 20, chunkChars: 5 })
    p.send({ t: 'chat.send', id: 'slow', sessionUid: s.uid, text: 'take your time', attachments: [], client, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.delta')
    expect(h.engine.busy(s.uid)).toBe(true)
    const r = await h.inject('DELETE', `/api/messages/${first.userUid}?refresh=1`)
    expect(r.statusCode).toBe(204)
    await h.awaitTurn(p, 'slow')
    const t = await h.send(p, s.uid, 'next')
    expect(t.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(turnRequests().at(-1)).not.toContain('4711')
  })

  it('delete and refresh while the turn is condensing (summarizing) is not lost: the next turn rolls over again without it', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const pin = await h.send(p, s.uid, 'MY PIN IS 4711')
    await h.send(p, s.uid, 'something else')
    const filler = await h.send(p, s.uid, 'filler')
    await h.engine.newEpoch(s.uid, 'apply-protocols')
    // The stored draft no longer holds: the next turn recomputes its recap (slowly), reading the PIN.
    expect((await h.inject('DELETE', `/api/messages/${filler.userUid}`)).statusCode).toBe(204)
    h.mock.llm.script({ text: 'RECAP: the PIN is 4711.', firstByteDelayMs: 1500, match: { lastUserIncludes: '4711' } })
    p.send({ t: 'chat.send', id: 'goon', sessionUid: s.uid, text: 'go on', attachments: [], client, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.status' && m.state === 'summarizing')
    expect((await h.inject('DELETE', `/api/messages/${pin.userUid}?refresh=1`)).statusCode).toBe(204)
    await h.awaitTurn(p, 'goon')
    const t = await h.send(p, s.uid, 'next')
    expect(t.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(turnRequests().at(-1)).not.toContain('4711')
  })

  it('delete and refresh removes a message an earlier rollover already summarised into the recap chain', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const first = await h.send(p, s.uid, 'MY PASSWORD IS HUNTER2')
    await h.send(p, s.uid, 'second')
    await h.engine.newEpoch(s.uid, 'apply-protocols')
    const third = await h.send(p, s.uid, 'third')
    expect(third.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(repos().epochs.current(repos().sessions.byUid(s.uid)!.id)!.recap).toContain('HUNTER2')
    await h.send(p, s.uid, 'fourth')
    await h.send(p, s.uid, 'fifth')
    expect((await h.inject('DELETE', `/api/messages/${first.userUid}?refresh=1`)).statusCode).toBe(204)
    const t = await h.send(p, s.uid, 'next')
    expect(t.events.some((e: ServerMsg) => e.t === 'epoch.created')).toBe(true)
    expect(turnRequests().at(-1)).not.toContain('HUNTER2')
    expect(turnRequests().at(-1)).toContain('second')
    // …nor at the turn after.
    await h.send(p, s.uid, 'and after')
    expect(turnRequests().at(-1)).not.toContain('HUNTER2')
  })
})
