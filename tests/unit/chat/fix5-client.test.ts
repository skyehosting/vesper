/**
 * Phase 5b fix5-client regressions through the chat engine (docs/review/phase5a-findings.md):
 *   P19 — an empty memory_search in a chat whose reach stops short of every chat names the OTHER chats that mention the
 *         query (never private ones, never any text of them), so the model can point at /link;
 *   P22 — the /continue opener is spoken on the requesting device when it speaks replies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '@shared/ws'
import { coreOf } from '@server/core'
import { FakeMemoryService, FakeSpeechService } from '../../fakes/services'
import { WsProbe } from '../server/helpers'
import { ChatHarness, waitMsg } from './harness'

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
  await h.ctx.settings.patch({ chat: { autoTitle: false, maxToolCalls: 3 }, memory: { enabled: false, autoRecall: false, scopeDefault: 'linked' } })
  await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
  try {
    fs.rmSync(path.join(h.ctx.paths.roaming, 'protocols.md'))
  } catch {
    /* absent */
  }
})
afterEach(() => {
  h.ctx.services.speech = undefined
})

const repos = (): ReturnType<typeof coreOf>['repos'] => coreOf(h.ctx).repos

/** The tool result the model read in `uid`'s latest turn. */
function toolResult(uid: string): string {
  const s = repos().sessions.byUid(uid)!
  const rows = repos().transcript.forEpoch(repos().epochs.current(s.id)!)
  const tool = rows.filter((r) => r.role === 'tool').at(-1)
  return (tool?.blocks[0] as { text: string } | undefined)?.text ?? ''
}

describe('P19: "that was in another chat" @R8 @R9', () => {
  it('an empty search names the unlinked chats that mention it (IDs only, never private ones)', async () => {
    const gift = await h.session({ title: 'Birthday ideas' })
    const pg = await h.client(gift.uid)
    h.mock.llm.script({ text: 'A telescope is a lovely gift.' })
    await h.send(pg, gift.uid, 'I want to buy my sister a telescope for her birthday.')
    const secret = await h.session({ title: 'Secret plans', private: true })
    const ps = await h.client(secret.uid)
    h.mock.llm.script({ text: 'Noted.' })
    await h.send(ps, secret.uid, 'The telescope is hidden in the garage.')

    const fresh = await h.session({ title: 'A week later' })
    const p = await h.client(fresh.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'telescope' } }] }, { text: 'It was in another chat.' })
    const t = await h.send(p, fresh.uid, 'What did I say about the telescope last week?')
    expect(t.done.message.body).toContain('It was in another chat.')
    const result = toolResult(fresh.uid)
    expect(result).toContain(`#${gift.shortId}`)
    expect(result).toContain(`/link #${gift.shortId}`)
    // A private chat is never named, and nothing of either chat's text or title reaches the model.
    expect(result).not.toContain(secret.shortId)
    expect(result).not.toMatch(/garage|sister|Birthday ideas|Secret plans/)

    // Linked: it is in reach now — no hint (the search itself would find it).
    expect((await h.inject('PUT', `/api/sessions/${fresh.uid}/links/${gift.shortId}`, { bothWays: false })).statusCode).toBe(200)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'telescope' } }] }, { text: 'Nothing.' })
    await h.send(p, fresh.uid, 'And the telescope?')
    expect(toolResult(fresh.uid)).not.toContain('appear in other conversations')
  })

  it('no hint when the chat may search every chat, or when nothing else matches', async () => {
    const other = await h.session({ title: 'Other' })
    const po = await h.client(other.uid)
    h.mock.llm.script({ text: 'Ok.' })
    await h.send(po, other.uid, 'The harbour lights came on.')
    const s = await h.session({ title: 'Asking' })
    const p = await h.client(s.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'volcano' } }] }, { text: 'No.' })
    await h.send(p, s.uid, 'Did I mention a volcano?')
    expect(toolResult(s.uid)).not.toContain('other conversations')
    await h.ctx.settings.patch({ memory: { scopeDefault: 'all' } })
    const s2 = await h.session({ title: 'Asking all' })
    const p2 = await h.client(s2.uid)
    h.mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'harbour' } }] }, { text: 'No.' })
    await h.send(p2, s2.uid, 'The harbour?')
    expect(toolResult(s2.uid)).not.toContain('other conversations')
  })
})

describe('P22: the /continue opener is spoken when the device speaks replies @R14 @R11', () => {
  async function continueFrom(speak: boolean): Promise<{ speech: FakeSpeechService; clientId: string | undefined; nu: string }> {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const src = await h.session({ title: 'Garden' })
    const p = await h.client(src.uid)
    h.mock.llm.script({ text: 'Lovely.' })
    await h.send(p, src.uid, 'We planned the garden.')
    const clientId = [...h.ctx.hub.clients()].find((c) => c.subscriptions.has(src.uid))?.id
    h.mock.llm.script({ text: 'They planned a garden.', match: { lastUserIncludes: 'Updated recap:' } }, { text: 'Welcome back! The garden?' })
    const r = await h.inject('POST', '/api/sessions', { continueFrom: src.uid, ...(speak ? { speak: true } : {}) })
    expect(r.statusCode).toBe(200)
    const nu = (r.json() as { uid: string }).uid
    const q = await h.client()
    q.send({ t: 'subscribe', sessionUid: nu, sinceEvSeq: 0 })
    const done = (await waitMsg(q, (m) => m.t === 'reply.done', 10_000)) as Extract<ServerMsg, { t: 'reply.done' }>
    expect(done.message.body).toBe('Welcome back! The garden?')
    return { speech, clientId, nu }
  }

  it('speak: true → speech for the opener goes to the tab that showed the source chat', async () => {
    const { speech, clientId, nu } = await continueFrom(true)
    expect(clientId).toBeTruthy()
    expect(speech.opened).toHaveLength(1)
    expect(speech.opened[0].target).toMatchObject({ sessionUid: nu, clientIds: [clientId] })
    expect(speech.opened[0].sink.text).toContain('Welcome back!')
  })

  it('without speak (voice replies off here) the opener stays text', async () => {
    const { speech } = await continueFrom(false)
    expect(speech.opened).toHaveLength(0)
  })

  it("perDevice 'all': the requesting tab speaks the opener although it is not subscribed to the new chat yet (P22-a)", async () => {
    await h.ctx.settings.patch({ voice: { tts: { perDevice: 'all' } } })
    try {
      const { speech, clientId, nu } = await continueFrom(true)
      expect(speech.opened).toHaveLength(1)
      expect(speech.opened[0].target).toMatchObject({ sessionUid: nu })
      expect(speech.opened[0].target.clientIds).toContain(clientId)
    } finally {
      await h.ctx.settings.patch({ voice: { tts: { perDevice: 'sender' } } })
    }
  })

  it('/continue #ID typed in ANOTHER chat (or the sidebar): the tab named by speakClientId speaks it (P22-b)', async () => {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const src = await h.session({ title: 'Orchard' })
    const p = await h.client(src.uid)
    h.mock.llm.script({ text: 'Noted.' })
    await h.send(p, src.uid, 'We planted apples.')
    p.close()
    const other = await h.session({ title: 'Elsewhere' })
    const q = new WsProbe(`ws://${h.host}/ws`, { origin: h.origin, cookie: h.cookie })
    // The tab learns its own id from `ready` (additive) and sends it with the request.
    const qId = (await q.hello()).clientId
    expect(qId).toBeTruthy()
    q.send({ t: 'subscribe', sessionUid: other.uid })
    await q.next('subscribed', (m) => m.sessionUid === other.uid)
    expect([...h.ctx.hub.clients()].find((c) => c.subscriptions.has(other.uid))?.id).toBe(qId)
    h.mock.llm.script({ text: 'They planted apples.', match: { lastUserIncludes: 'Updated recap:' } }, { text: 'Welcome back! Apples?' })
    const r = await h.inject('POST', '/api/sessions', { continueFrom: src.uid, speak: true, speakClientId: qId })
    expect(r.statusCode).toBe(200)
    const nu = (r.json() as { uid: string }).uid
    q.send({ t: 'subscribe', sessionUid: nu, sinceEvSeq: 0 })
    await waitMsg(q, (m) => m.t === 'reply.done', 10_000)
    q.close()
    expect(speech.opened).toHaveLength(1)
    expect(speech.opened[0].target).toMatchObject({ sessionUid: nu, clientIds: [qId] })
  })

  it('a speakClientId that is not a live tab of this device is ignored (no speech without a tab on the source)', async () => {
    const speech = new FakeSpeechService()
    h.ctx.services.speech = speech
    const src = await h.session({ title: 'Pond' })
    const p = await h.client(src.uid)
    h.mock.llm.script({ text: 'Okay.' })
    await h.send(p, src.uid, 'We dug a pond.')
    p.close()
    await waitFor(() => ![...h.ctx.hub.clients()].some((c) => c.subscriptions.has(src.uid)))
    for (const c of [...h.ctx.hub.clients()]) c.state.audioUnlocked = false
    h.mock.llm.script({ text: 'They dug a pond.', match: { lastUserIncludes: 'Updated recap:' } }, { text: 'Welcome back! The pond?' })
    const r = await h.inject('POST', '/api/sessions', { continueFrom: src.uid, speak: true, speakClientId: 'not-a-client' })
    expect(r.statusCode).toBe(200)
    const nu = (r.json() as { uid: string }).uid
    const q = await h.client()
    q.send({ t: 'subscribe', sessionUid: nu, sinceEvSeq: 0 })
    await waitMsg(q, (m) => m.t === 'reply.done', 10_000)
    expect(speech.opened).toHaveLength(0)
  })
})

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
