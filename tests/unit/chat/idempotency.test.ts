/**
 * F62 (07 C16): `chat.send` is idempotent per clientMsgId. A resend after a dropped socket (the ack may have been lost)
 * gets the original ack and never a second user message, reply or provider call — also while the first is still being
 * admitted, and after a restart (the user row remembers the id).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import type { ServerMsg } from '@shared/ws'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import type { WsProbe } from '../server/helpers'

let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  await h.ctx.settings.patch({ chat: { autoTitle: false } })
  await h.setProfile(h.openaiProfile())
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos
type Ack = Extract<ServerMsg, { t: 'ack' }>

function sendFrame(p: WsProbe, uid: string, id: string, text: string, clientMsgId: string): void {
  p.send({ t: 'chat.send', id, sessionUid: uid, text, attachments: [], client: { ts: Date.now(), tzOffset: 0, tzName: null }, speak: false, clientMsgId })
}

async function ackOf(p: WsProbe, id: string): Promise<Ack> {
  const m = await waitMsg(p, (x) => (x.t === 'ack' || x.t === 'error') && x.id === id)
  if (m.t === 'error') throw new Error(JSON.stringify(m.error))
  return m as Ack
}

function rows(uid: string): number {
  return repos().messages.tail(repos().sessions.byUid(uid)!.id, 100).length
}

describe('chat.send idempotency (F62)', () => {
  it('a resend with the same clientMsgId gets the original ack and makes no second turn', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    const t = await h.send(p, s.uid, 'hello once', { clientMsgId: 'cm-1' })
    sendFrame(p, s.uid, 'again', 'hello once', 'cm-1')
    const ack = await ackOf(p, 'again')
    expect(ack.messageUid).toBe(t.userUid)
    expect(rows(s.uid)).toBe(2)
    expect(chatRequests(h.mock)).toHaveLength(1)
  })

  it('a resend while the first is still running is answered with the same reply id', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    h.mock.llm.script({ text: 'slow '.repeat(30), delayMs: 15, chunkChars: 5 })
    sendFrame(p, s.uid, 'first', 'are you there?', 'cm-2')
    sendFrame(p, s.uid, 'second', 'are you there?', 'cm-2')
    const [a, b] = [await ackOf(p, 'first'), await ackOf(p, 'second')]
    expect(b).toMatchObject({ replyId: a.replyId, messageUid: a.messageUid })
    await waitMsg(p, (m) => m.t === 'reply.done' && m.replyId === a.replyId)
    expect(rows(s.uid)).toBe(2)
    expect(chatRequests(h.mock)).toHaveLength(1)
  })

  it('after a restart the user row still answers a resend', async () => {
    const s = await h.session()
    let p = await h.client(s.uid)
    const t = await h.send(p, s.uid, 'before the restart', { clientMsgId: 'cm-3' })
    await h.restart()
    p = await h.client(s.uid)
    sendFrame(p, s.uid, 'late', 'before the restart', 'cm-3')
    expect((await ackOf(p, 'late')).messageUid).toBe(t.userUid)
    expect(rows(s.uid)).toBe(2)
  })

  it('a send that failed (busy) can be resent with the same id and then goes through', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    h.mock.llm.script({ text: 'slow '.repeat(30), delayMs: 15, chunkChars: 5 })
    sendFrame(p, s.uid, 'busy1', 'first message', 'cm-4a')
    await ackOf(p, 'busy1')
    sendFrame(p, s.uid, 'busy2', 'second message', 'cm-4b')
    const err = await waitMsg(p, (x) => x.t === 'error' && x.id === 'busy2')
    expect(err).toMatchObject({ error: { code: 'session_busy' } })
    await waitMsg(p, (m) => m.t === 'reply.done')
    const t = await h.send(p, s.uid, 'second message', { clientMsgId: 'cm-4b' })
    expect(t.done.message.body).toBe('Echo: second message')
    expect(rows(s.uid)).toBe(4)
  })

  it('different clientMsgIds are different messages', async () => {
    const s = await h.session()
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'same words', { clientMsgId: 'cm-5a' })
    await h.send(p, s.uid, 'same words', { clientMsgId: 'cm-5b' })
    expect(rows(s.uid)).toBe(4)
  })
})
