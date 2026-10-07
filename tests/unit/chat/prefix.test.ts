/**
 * PREFIX INVARIANCE (07 C1, the guard for Anthropic preserved thinking and prompt caching): within one epoch, every
 * request repeats `system`, `tools` and every earlier message byte-for-byte, across normal turns, /memory off,
 * /voice on, a voice tones mode change (H-v11-tone), a prompt edit, a protocols edit (applied only at a new epoch), a rename, a model switch, a tool loop,
 * a stop mid-reply and a server restart — for the Anthropic adapter, the OpenAI adapter and text mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMemoryService, FakeSpeechService } from '../../fakes/services'
import { ChatHarness, chatRequests, waitMsg, type ProfileInput } from './harness'
import type { WsProbe } from '../server/helpers'

let h: ChatHarness

beforeAll(async () => {
  h = await ChatHarness.start({ now: Date.UTC(2026, 9, 5, 12, 0) })
})
afterAll(() => h.close())

interface Config {
  name: string
  api: 'anthropic' | 'openai'
  profile: () => ProfileInput
  key?: string
  /** Model for the /model step (same tool capability). */
  otherModel: string
  native: boolean
}

const CONFIGS: Config[] = [
  { name: 'anthropic native', api: 'anthropic', profile: () => h.anthropicProfile('claude-opus-5-5'), key: 'sk-ant-test-0123456789', otherModel: 'claude-opus-5', native: true },
  {
    name: 'openai native',
    api: 'openai',
    profile: () => ({ id: 'oai', label: 'OpenAI', preset: 'openai', adapter: 'openai', baseUrl: `${h.mock.url}/v1`, model: 'mock-a' }),
    key: 'sk-test-0123456789',
    otherModel: 'mock-b',
    native: true
  },
  { name: 'custom text mode', api: 'openai', profile: () => h.openaiProfile('mock-echo'), otherModel: 'mock-other', native: false }
]

function services(): { memory: FakeMemoryService; speech: FakeSpeechService } {
  const memory = new FakeMemoryService()
  memory.addHit({ body: 'We talked about the moon landing.', shortId: 'MOON01' })
  const speech = new FakeSpeechService()
  h.ctx.services.memory = memory
  h.ctx.services.speech = speech
  return { memory, speech }
}

describe('prefix invariance across every operation (07 C1) @R11', () => {
  it.each(CONFIGS)('$name', async (c) => {
    h.mock.reset()
    h.mock.recorder.clear()
    try {
      fs.rmSync(path.join(h.ctx.paths.roaming, 'protocols.md'))
    } catch {
      /* absent */
    }
    await h.ctx.settings.patch({ profile: { assistantName: 'Vesper' }, chat: { autoTitle: false }, memory: { enabled: true, autoRecall: false }, voice: { tts: { enabled: false, toneMode: 'conversation' } } })
    await h.setProfile(c.profile(), c.key)
    services()
    const s = await h.session()
    let p: WsProbe = await h.client(s.uid)
    const say = async (text: string, extra: Record<string, unknown> = {}): Promise<string> => (await h.send(p, s.uid, `${c.name}: ${text}`, extra)).done.message.status

    expect(await say('hello')).toBe('complete')
    expect(await say('second turn')).toBe('complete')

    await h.patchSession(s.uid, { memory: 'off' }) // /memory off
    expect(await say('memory is off now')).toBe('complete')

    // Voice replies on + "Voice tones: Every reply" (H-v11-tone): the tone instruction changes inside the epoch.
    await h.ctx.settings.patch({ voice: { tts: { enabled: true, toneMode: 'reply' } } })
    expect(await say('voice please', { speak: true })).toBe('complete') // /voice on

    await h.patchSession(s.uid, { systemPrompt: 'Be brief.' }) // /prompt
    expect(await say('after the prompt edit')).toBe('complete')

    fs.writeFileSync(path.join(h.ctx.paths.roaming, 'protocols.md'), '# Protocols\nYou are {{assistant_name}}. EDITED PROTOCOLS.') // protocols edit
    expect(await say('after the protocols edit')).toBe('complete')

    await h.ctx.settings.patch({ profile: { assistantName: 'Nova' } }) // rename
    expect(await say('after the rename')).toBe('complete')

    await h.patchSession(s.uid, { memory: 'on', model: c.otherModel }) // /model (+ memory back on for the tool loop)
    expect(await say('after the model switch')).toBe('complete')

    // Tool loop (with thinking on Anthropic).
    if (c.native) h.mock.llm.script({ reasoning: c.api === 'anthropic' ? 'I should search.' : undefined, text: 'Checking.', toolCalls: [{ name: 'memory_search', input: { query: 'moon' } }] }, { text: 'Found the moon talk.' })
    else h.mock.llm.script({ text: 'Checking.\n[memory_search query="moon"]' }, { text: 'Found the moon talk.' })
    expect(await say('what did we discuss about the moon?')).toBe('complete')

    // Stop mid-reply.
    h.mock.llm.script({ text: 'streaming slowly '.repeat(60), chunkChars: 4, delayMs: 5 })
    p.send({ t: 'chat.send', id: 'stopme', sessionUid: s.uid, text: `${c.name}: a long answer please`, attachments: [], client: { ts: 0, tzOffset: 120, tzName: 'Europe/Berlin' }, speak: false })
    await waitMsg(p, (m) => m.t === 'reply.delta')
    p.send({ t: 'chat.stop', sessionUid: s.uid })
    const stopped = await waitMsg(p, (m) => m.t === 'reply.done')
    expect(stopped.t === 'reply.done' && stopped.message.status).toBe('stopped')
    expect(await say('after the stop')).toBe('complete')

    // Server restart: the transcript is replayed from SQLite.
    await h.restart()
    await h.ctx.settings.patch({ chat: { autoTitle: false } })
    services()
    p = await h.client(s.uid)
    expect(await say('after the restart')).toBe('complete')

    const reqs = chatRequests(h.mock).filter((r) => (c.api === 'anthropic' ? /\/v1\/messages$/.test(r.path) : /\/chat\/completions$/.test(r.path)))
    expect(reqs.length).toBe(13) // 12 user turns (one stopped) + the second round of the tool loop
    h.mock.recorder.assertPrefixInvariant({ api: c.api })
    // Nothing of the edits reached the frozen system; the rename did not either.
    const sys = JSON.stringify(c.api === 'anthropic' ? reqs.at(-1)!.json.system : (reqs.at(-1)!.json.messages as unknown[])[0])
    expect(sys).not.toContain('EDITED PROTOCOLS')
    expect(sys).not.toContain('Nova')
    expect(sys).not.toContain('Be brief.')
    expect(JSON.stringify(reqs.at(-1)!.json)).toContain('Be brief.') // …but the prompt note is in the messages
    // The tone mode change is a note too; the frozen system still has the instruction the epoch started with.
    expect(sys).toContain('Do not write tone tags.')
    expect(sys).not.toContain('every spoken reply')
    expect(JSON.stringify(reqs.at(-1)!.json)).toContain('Voice tones are set per reply now: start every spoken reply with one tone tag')
    if (c.native) expect(JSON.stringify(reqs.at(-1)!.json.tools ?? null)).toContain('memory_search')
    else expect(reqs.at(-1)!.json.tools).toBeUndefined()

    // Apply the protocols now: the next turn starts a new epoch (a new conversation for the recorder) with them.
    expect((await h.inject('POST', `/api/sessions/${s.uid}/epoch`, { reason: 'apply-protocols' })).statusCode).toBe(200)
    expect(await say('after applying')).toBe('complete')
    const after = chatRequests(h.mock).filter((r) => !JSON.stringify(r.json.system ?? (r.json.messages as unknown[])[0]).includes('You write recaps')).at(-1)!
    const sys2 = JSON.stringify(c.api === 'anthropic' ? after.json.system : (after.json.messages as unknown[])[0])
    expect(sys2).toContain('You are Nova. EDITED PROTOCOLS.')
    h.mock.recorder.assertPrefixInvariant({ api: c.api })
  })
})
