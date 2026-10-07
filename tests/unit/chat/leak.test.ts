/**
 * Resource hygiene (07 D14, owner request): 200 turns — including stops, errors and tool loops — leave no active
 * turns, owned tasks, AbortControllers, linked abort listeners or timers behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMemoryService, FakeSpeechService } from '../../fakes/services'
import { ChatHarness, waitMsg } from './harness'

let h: ChatHarness
beforeAll(async () => {
  h = await ChatHarness.start()
})
afterAll(() => h.close())

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

describe('no leaks after 200 turns', () => {
  it('stats return to baseline', async () => {
    await h.ctx.settings.patch({ chat: { autoTitle: false }, memory: { enabled: true, autoRecall: true } })
    const memory = new FakeMemoryService()
    memory.addHit({ body: 'turn words here', shortId: 'LEAK01' })
    h.ctx.services.memory = memory
    h.ctx.services.speech = new FakeSpeechService()
    await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
    // A private session: no idle summary timer is expected.
    const s = await h.session({ private: true })
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'warm up the turn words')
    await new Promise((r) => setTimeout(r, 50))
    const baseTimers = timers()

    for (let i = 0; i < 200; i++) {
      if (i % 50 === 7) {
        h.mock.llm.script({ text: 'slow '.repeat(50), chunkChars: 5, delayMs: 2 })
        p.send({ t: 'chat.send', id: `s${i}`, sessionUid: s.uid, text: `stop ${i}`, attachments: [], client: { ts: 0, tzOffset: 0, tzName: null }, speak: false })
        await waitMsg(p, (m) => m.t === 'reply.delta')
        p.send({ t: 'chat.stop', sessionUid: s.uid })
        await waitMsg(p, (m) => m.t === 'reply.done')
        p.msgs.length = 0
        continue
      }
      if (i % 50 === 13) h.mock.llm.script({ error: { status: 401 } })
      if (i % 50 === 21) h.mock.llm.script({ toolCalls: [{ name: 'memory_search', input: { query: 'turn' } }], text: '' })
      await h.send(p, s.uid, `turn words ${i}`, { speak: i % 3 === 0 })
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(h.engine.stats()).toMatchObject({ active: 0, starting: 0, background: 0, controllers: 0, timers: 0, linkedListeners: 0, sinkWatchers: 0 })
    expect(timers()).toBeLessThanOrEqual(baseTimers)
    expect(h.engine.busy(s.uid)).toBe(false)
  }, 120_000)
})
