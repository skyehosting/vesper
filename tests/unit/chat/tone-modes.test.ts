/**
 * Voice tone modes end to end on a real server (H-v11-tone; 07 A2/A3/C1, R13): the chat engine + the real speech
 * service against the mock LLM and mock ElevenLabs (v4: the tone is an audio-tag prefix of the synthesized text).
 *
 *   - 'conversation': the AI is told to tag only when the conversation's tone shifts; a reply without a tag keeps the
 *     chat's tone — across replies AND across a server restart (read back from the transcript, stored nowhere else);
 *   - a mode change mid-chat reaches the AI as a system_note, never as a re-rendered system (prefix invariance);
 *   - 'off': no instruction, a stray tag is stripped from the shown/stored text and no tone reaches the voice;
 *   - a voice that can't use a tone (OpenAI tts-1) means "Do not write tone tags." and no tone parameter.
 * @R13 @R14
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerMsg } from '@shared/ws'
import { startMockServer, type MockServer } from '../../mocks/server'
import { ChatHarness, chatRequests, waitMsg, type Turn } from './harness'
import type { WsProbe } from '../server/helpers'

let mock: MockServer
let h: ChatHarness

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  h = await ChatHarness.start({ mock })
})
afterAll(async () => {
  await h.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})

async function setup(tts: Record<string, unknown> = {}): Promise<void> {
  await h.setProfile(h.openaiProfile('mock-echo'))
  await h.ctx.settings.patch({
    chat: { autoTitle: false },
    voice: { tts: { enabled: true, provider: 'elevenlabs', voiceId: 'mock-aria', model: 'eleven_v4', reveal: 'text-first', toneMode: 'conversation', tonePlacement: 'start', ...tts } }
  })
  await h.ctx.secrets.set('tts:elevenlabs', 'xi-good-key', null)
}

/** One spoken turn: the reply's text, its stored body, and what ElevenLabs was asked to say for it. */
async function spoken(p: WsProbe, uid: string, reply: string): Promise<{ turn: Turn; synth: string[] }> {
  const before = mock.tts.synthTexts().length
  mock.llm.script({ text: reply })
  const turn = await h.send(p, uid, 'Tell me more.', { speak: true })
  expect(turn.done.message.status).toBe('complete')
  if (!turn.events.some((m) => m.t === 'speech.end' && m.replyId === turn.replyId)) await waitMsg(p, (m: ServerMsg) => m.t === 'speech.end' && m.replyId === turn.replyId)
  const synth = mock.tts.synthTexts().slice(before).map((x) => x.text)
  expect(synth.length).toBeGreaterThan(0)
  return { turn, synth }
}

const prefixOf = (texts: string[]): Array<string | null> => texts.map((t) => /^\[([^\]]+)\] /.exec(t)?.[1] ?? null)
const lastRequest = (): Record<string, unknown> => chatRequests(mock).at(-1)!.json
const systemOf = (json: Record<string, unknown>): string => JSON.stringify((json.messages as Array<{ role: string }>).filter((m) => m.role === 'system'))
const notesOf = (json: Record<string, unknown>): string => JSON.stringify((json.messages as Array<{ role: string }>).slice(1))

describe('voice tone modes (H-v11-tone) @R13', () => {
  it("'conversation': a tag only when the tone shifts; the tone carries on across replies and a restart", async () => {
    mock.reset()
    await setup()
    const s = await h.session()
    let p = await h.client(s.uid)

    const a = await spoken(p, s.uid, '[tone=warm, gentle] It is lovely to hear from you again. How was the trip?')
    expect(systemOf(lastRequest())).toContain('only when the emotional tone of the conversation really shifts')
    expect(systemOf(lastRequest())).not.toMatch(/every spoken reply/)
    expect(prefixOf(a.synth).every((x) => x === 'warm, gentle')).toBe(true)
    expect(a.turn.done.message.body).not.toContain('[tone')

    // No tag: the current tone continues (in memory).
    const b = await spoken(p, s.uid, 'That sounds like a wonderful week by the sea.')
    expect(prefixOf(b.synth).every((x) => x === 'warm, gentle')).toBe(true)

    // Restart: the tone is read back from the chat's transcript (07 A3: it is stored nowhere else).
    await h.restart()
    await h.ctx.secrets.set('tts:elevenlabs', 'xi-good-key', null)
    p = await h.client(s.uid)
    const c = await spoken(p, s.uid, 'Tell me about the lighthouse you mentioned.')
    expect(prefixOf(c.synth).every((x) => x === 'warm, gentle')).toBe(true)

    // A shift: the new tag applies from where it lands, and then carries on.
    const d = await spoken(p, s.uid, '[tone=serious, concerned] Wait, the boat hit the rocks? Is everyone all right?')
    expect(prefixOf(d.synth).every((x) => x === 'serious, concerned')).toBe(true)
    const e = await spoken(p, s.uid, 'I am glad nobody was hurt.')
    expect(prefixOf(e.synth).every((x) => x === 'serious, concerned')).toBe(true)

    // Never in messages, never shown.
    for (const m of h.ctx.repos.messages.tail(h.ctx.repos.sessions.byUid(s.uid)!.id, 50)) expect(m.body).not.toMatch(/\[tone/i)
    // One epoch the whole time: every request repeats the previous one byte for byte (07 C1).
    mock.recorder.assertPrefixInvariant({ api: 'openai' })
  })

  it("a mode change mid-chat is a note; 'off' strips stray tags and sends no tone; back on asks for a tag again", async () => {
    mock.reset()
    await setup()
    const s = await h.session()
    const p = await h.client(s.uid)
    await spoken(p, s.uid, '[tone=playful] Ready when you are!')

    await h.ctx.settings.patch({ voice: { tts: { toneMode: 'off' } } })
    const off = await spoken(p, s.uid, '[tone=excited] Oh, that is brilliant news!')
    const req = lastRequest()
    expect(notesOf(req)).toContain('turned voice tones off: from now on, do not write tone tags.')
    // The frozen system still says what it said (the change is a note, not a re-render).
    expect(systemOf(req)).toContain('only when the emotional tone of the conversation really shifts')
    expect(prefixOf(off.synth)).toEqual(off.synth.map(() => null))
    expect(off.synth.join(' ')).not.toMatch(/excited|\[tone/)
    expect(off.turn.done.message.body).toBe('Oh, that is brilliant news!')
    expect(off.turn.events.filter((m) => m.t === 'reply.delta').map((m) => (m as { text: string }).text).join('')).not.toContain('[tone')

    // No change since: no second note.
    await spoken(p, s.uid, 'Shall we plan the next one?')
    expect((notesOf(lastRequest()).match(/turned voice tones off/g) ?? []).length).toBe(1)

    await h.ctx.settings.patch({ voice: { tts: { toneMode: 'reply' } } })
    await spoken(p, s.uid, '[tone=calm] Let us take it slowly.')
    expect(notesOf(lastRequest())).toContain('Voice tones are set per reply now: start every spoken reply with one tone tag')

    await h.ctx.settings.patch({ voice: { tts: { toneMode: 'conversation' } } })
    await spoken(p, s.uid, 'Sure.')
    expect(notesOf(lastRequest())).toContain('Voice tones now follow the conversation: start your next spoken reply with one tone tag')
    mock.recorder.assertPrefixInvariant({ api: 'openai' })
  })

  it("a voice that can't use a tone: the AI is not asked for tags, and the voice gets no tone", async () => {
    mock.reset()
    await setup({ provider: 'openai', voiceId: 'alloy', model: 'tts-1' })
    await h.ctx.secrets.set('tts:openai', 'sk-test-0123456789', null)
    const s = await h.session()
    const p = await h.client(s.uid)
    const before = mock.tts.synthTexts().length
    mock.llm.script({ text: '[tone=warm] Hello there.' })
    const turn = await h.send(p, s.uid, 'Hi!', { speak: true })
    expect(turn.done.message.body).toBe('Hello there.')
    const sys = systemOf(lastRequest())
    expect(sys).toContain('Do not write tone tags.')
    expect(sys).not.toContain('[tone=')
    await expect.poll(() => mock.tts.synthTexts().length > before, { timeout: 10_000 }).toBe(true)
    expect(mock.tts.synthTexts().slice(before).every((x) => x.tone === null)).toBe(true)

    // Switching to gpt-4o-mini-tts makes tones possible: the AI hears about it in a note.
    await h.ctx.settings.patch({ voice: { tts: { model: 'gpt-4o-mini-tts' } } })
    mock.llm.script({ text: '[tone=warm] Nice to meet you.' })
    await h.send(p, s.uid, 'Hello again.', { speak: true })
    expect(notesOf(lastRequest())).toContain('Voice tones now follow the conversation')
    await expect.poll(() => mock.tts.synthTexts().at(-1)?.tone, { timeout: 10_000 }).toBe('Speak in a warm tone.')
  })
})
