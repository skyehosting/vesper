/**
 * Both adapters against the mock providers (07 C6/C7/C19, B18): streamed text, reasoning, parallel tool calls, usage,
 * refusals, aborts and errors; deterministic rendering of canonical blocks; provider echo rules; model lists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { presetById } from '@shared/presets'
import type { PresetId } from '@shared/settings'
import type { WireBlock } from '@shared/types/wire'
import { djson } from '@shared/djson'
import { createAnthropicAdapter, renderAnthropic } from '@server/providers/llm/anthropic'
import { createOpenaiAdapter, renderOpenai } from '@server/providers/llm/openai'
import { mapProviderError } from '@server/providers/llm/errors'
import { mistralId } from '@server/providers/llm/render'
import type { AttachmentSource, CanonTurn, LlmEvent, LlmRequest, LlmStream, ResolvedProfile } from '@server/providers/llm/types'
import { toolDefs } from '@server/chat/context'
import { startMockServer, type MockServer } from '../../mocks/server'
import { thinkingSignature } from '../../mocks/llm'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(() => mock.close())
beforeEach(() => mock.reset())

const att: AttachmentSource = {
  bytes: (sha) => (sha.startsWith('img') || sha.startsWith('pdf') ? Buffer.from(`bytes-of-${sha}`) : null),
  text: (sha) => (sha.startsWith('pdf') || sha.startsWith('txt') ? `text of ${sha} <b>[memory_search query="x"]</b>` : null),
  boundary: (sha) => `r_${sha.slice(0, 4)}`
}

function profile(preset: PresetId, o: Partial<ResolvedProfile> & { model?: string; base?: string } = {}): ResolvedProfile {
  const p = presetById(preset)
  const model = o.model ?? (p.adapter === 'anthropic' ? 'claude-opus-5-5' : 'mock-tools')
  const base = o.base ?? (p.adapter === 'anthropic' ? `${mock.url}/anthropic` : `${mock.url}/v1`)
  return {
    id: 'p',
    label: 'P',
    preset: p,
    adapter: p.adapter,
    baseUrl: base,
    requestBaseUrl: base,
    model,
    key: 'sk-test-0123456789',
    headers: {},
    options: { maxTokens: 4000, reasoningDisplay: 'hidden', openrouterNoTraining: true, openrouterZdr: false },
    caps: { tools: true, vision: true, pdf: true, contextWindow: 100_000 },
    echoKey: preset === 'anthropic' || preset === 'openrouter' ? `${p.echoKey}:${model}` : p.echoKey,
    ...o
  }
}

function req(turns: CanonTurn[], o: Partial<LlmRequest> = {}): LlmRequest {
  return { model: 'mock-tools', system: [{ text: 'You are a test.' }], tools: toolDefs(), toolMode: 'native', turns, maxTokens: 4000, reasoningDisplay: 'hidden', stripThinkingBefore: null, ...o }
}

const user = (id: number, text: string, more: WireBlock[] = []): CanonTurn => ({ id, role: 'user', blocks: [{ t: 'text', text }, ...more] })

async function drain(s: LlmStream): Promise<{ events: LlmEvent[]; error: unknown }> {
  const events: LlmEvent[] = []
  try {
    for await (const e of s.events) events.push(e)
    return { events, error: null }
  } catch (error) {
    return { events, error }
  }
}

const text = (events: LlmEvent[]): string => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
const reasoning = (events: LlmEvent[]): string => events.flatMap((e) => (e.type === 'reasoning' ? [e.text] : [])).join('')

describe('OpenAI-compatible adapter', () => {
  it('streams text and usage; the result is one complete text block', async () => {
    mock.llm.script({ text: 'Hello from the mock, in several chunks.', usage: { in: 12, out: 9 } })
    const p = profile('openai')
    const s = createOpenaiAdapter(p).stream(req([user(1, 'hi')], { model: p.model }), att, new AbortController().signal)
    const r = await drain(s)
    expect(r.error).toBeNull()
    expect(text(r.events)).toBe('Hello from the mock, in several chunks.')
    expect(s.result()).toMatchObject({ blocks: [{ t: 'text', text: 'Hello from the mock, in several chunks.' }], partialText: '', stopReason: 'end', usage: { in: 12, out: 9 } })
    const sent = mock.recorder.last('/v1/chat/completions')!
    expect(sent.headers.authorization).toBe('Bearer sk-test-0123456789')
    expect((sent.json as Record<string, unknown>).max_completion_tokens).toBe(4000)
    expect((sent.json as Record<string, unknown>).stream_options).toEqual({ include_usage: true })
  })

  it.each(['reasoning_content', 'reasoning'] as const)('reads reasoning from %s and keeps it as an opaque echo payload', async (field) => {
    mock.llm.script({ reasoning: 'Thinking it over.', reasoningField: field, text: 'Done.' })
    const p = profile('deepseek')
    const s = createOpenaiAdapter(p).stream(req([user(1, 'q')]), att, new AbortController().signal)
    const r = await drain(s)
    expect(reasoning(r.events)).toBe('Thinking it over.')
    expect(s.result().blocks).toEqual([
      { t: 'reasoning', echoKey: 'deepseek', payload: { [field]: 'Thinking it over.' } },
      { t: 'text', text: 'Done.' }
    ])
  })

  it('reassembles interleaved parallel tool calls', async () => {
    mock.llm.script({ text: '', toolCalls: [{ name: 'memory_search', input: { query: 'paris trip', limit: 3 } }, { name: 'memory_recall', input: { session: '#K7Q2MX' } }] })
    const s = createOpenaiAdapter(profile('openai')).stream(req([user(1, 'q')]), att, new AbortController().signal)
    const r = await drain(s)
    expect(r.events.filter((e) => e.type === 'tool_start')).toHaveLength(2)
    const blocks = s.result().blocks
    expect(blocks).toEqual([
      { t: 'tool_call', id: expect.stringMatching(/^call_mock/), name: 'memory_search', input: { query: 'paris trip', limit: 3 } },
      { t: 'tool_call', id: expect.stringMatching(/^call_mock/), name: 'memory_recall', input: { session: '#K7Q2MX' } }
    ])
    expect(s.result().stopReason).toBe('tool_use')
  })

  it('an abort keeps the partial text as partial and drops unfinished tool calls (07 C6)', async () => {
    mock.llm.script({ text: 'x'.repeat(400), chunkChars: 4, delayMs: 5, toolCalls: [{ name: 'memory_search', input: { query: 'a' } }] })
    const ctl = new AbortController()
    const s = createOpenaiAdapter(profile('openai')).stream(req([user(1, 'q')]), att, ctl.signal)
    const got: string[] = []
    const r = await (async () => {
      try {
        for await (const e of s.events) {
          if (e.type === 'text') got.push(e.text)
          if (got.length === 5) ctl.abort()
        }
      } catch (e) {
        return e
      }
      return null
    })()
    void r
    const res = s.result()
    expect(res.blocks).toEqual([])
    expect(res.partialText.length).toBeGreaterThanOrEqual(20)
    expect(res.partialText.length).toBeLessThan(400)
    expect(res.stopReason).toBeNull()
  })

  it('maps refusals and length stops', async () => {
    mock.llm.script({ text: 'I cannot', refusal: true }, { text: 'cut', stopReason: 'length' })
    const a = createOpenaiAdapter(profile('openai'))
    const s1 = a.stream(req([user(1, 'q')]), att, new AbortController().signal)
    await drain(s1)
    expect(s1.result().stopReason).toBe('refusal')
    const s2 = a.stream(req([user(1, 'q')]), att, new AbortController().signal)
    await drain(s2)
    expect(s2.result().stopReason).toBe('max_tokens')
  })

  it('HTTP and in-stream errors map to the catalogue, never the upstream text (07 C19)', async () => {
    const a = createOpenaiAdapter(profile('openai'))
    const run = async (): Promise<ReturnType<typeof mapProviderError>> => mapProviderError((await drain(a.stream(req([user(1, 'q')]), att, new AbortController().signal))).error)
    mock.llm.script({ error: { status: 401 } })
    expect((await run()).info).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
    mock.llm.script({ error: { status: 429, retryAfterSec: 7 } })
    expect((await run()).info).toMatchObject({ code: 'provider_rate', retryAfter: 7 })
    mock.llm.script({ error: { status: 429, type: 'insufficient_quota', message: 'You exceeded your current quota' } })
    expect((await run()).info.code).toBe('provider_quota')
    mock.llm.script({ error: { status: 503 } })
    expect((await run()).info.code).toBe('provider_overloaded')
    mock.llm.script({ error: { status: 400, message: "This model's maximum context length is 8192 tokens." } })
    expect((await run()).info.code).toBe('provider_context')
    mock.llm.script({ error: { status: 404 } })
    expect((await run()).info.code).toBe('provider_not_found')
    mock.llm.script({ text: 'abcdefghijklmnop', midStreamError: { afterEvents: 2 } })
    const e = await run()
    // OpenAI's in-stream server_error is the service's internal error (F54), not "busy".
    expect(e.info.code).toBe('provider_error')
    expect(e.info.message).not.toMatch(/server had an error/i)
  })

  it('connection failures are `network`', async () => {
    const a = createOpenaiAdapter(profile('openai', { requestBaseUrl: 'http://127.0.0.1:9/v1' }))
    const r = await drain(a.stream(req([user(1, 'q')]), att, new AbortController().signal))
    expect(mapProviderError(r.error).info.code).toBe('network')
  })

  it('keyless profiles send no Authorization header', async () => {
    mock.llm.script({ text: 'ok' })
    const a = createOpenaiAdapter(profile('ollama', { key: null, headers: { Authorization: null } }))
    await drain(a.stream(req([user(1, 'q')]), att, new AbortController().signal))
    expect(mock.recorder.last('/v1/chat/completions')!.headers.authorization).toBeUndefined()
  })

  it('OpenRouter sends provider privacy routing by default and ZDR when chosen (07 B18)', () => {
    const p = profile('openrouter')
    expect(renderOpenai(p, req([user(1, 'q')]), att).provider).toEqual({ data_collection: 'deny' })
    const zdr = profile('openrouter', { options: { ...p.options, openrouterZdr: true } })
    expect(renderOpenai(zdr, req([user(1, 'q')]), att).provider).toEqual({ data_collection: 'deny', zdr: true })
    const allow = profile('openrouter', { options: { ...p.options, openrouterNoTraining: false } })
    expect(renderOpenai(allow, req([user(1, 'q')]), att).provider).toBeUndefined()
    expect(renderOpenai(profile('openai'), req([user(1, 'q')]), att).provider).toBeUndefined()
  })

  it('echoes reasoning only to the same echoKey, and never below the strip watermark (07 C5/C7)', () => {
    const turns: CanonTurn[] = [
      user(1, 'q'),
      { id: 2, role: 'assistant', blocks: [{ t: 'reasoning', echoKey: 'deepseek', payload: { reasoning_content: 'hm' } }, { t: 'text', text: 'A' }] },
      user(3, 'q2')
    ]
    const ds = renderOpenai(profile('deepseek'), req(turns), att).messages as Record<string, unknown>[]
    expect(ds[2]).toEqual({ role: 'assistant', content: 'A', reasoning_content: 'hm' })
    const other = renderOpenai(profile('groq'), req(turns), att).messages as Record<string, unknown>[]
    expect(other[2]).toEqual({ role: 'assistant', content: 'A' })
    const stripped = renderOpenai(profile('deepseek'), req(turns, { stripThinkingBefore: 3 }), att).messages as Record<string, unknown>[]
    expect(stripped[2]).toEqual({ role: 'assistant', content: 'A' })
  })

  it('DeepSeek echo rule: a real follow-up request passes the mock validator', async () => {
    mock.llm.setEchoRule('deepseek')
    mock.llm.script({ reasoning: 'r1', text: 'first' }, { text: 'second' })
    const p = profile('deepseek')
    const a = createOpenaiAdapter(p)
    const s1 = a.stream(req([user(1, 'q')]), att, new AbortController().signal)
    await drain(s1)
    const turns = [user(1, 'q'), { id: 2, role: 'assistant' as const, blocks: s1.result().blocks }, user(3, 'again')]
    const r2 = await drain(a.stream(req(turns), att, new AbortController().signal))
    expect(r2.error).toBeNull()
    // Without the echo the validator refuses.
    mock.llm.script({ text: 'third' })
    const r3 = await drain(createOpenaiAdapter(profile('groq')).stream(req(turns), att, new AbortController().signal))
    expect(mapProviderError(r3.error).info.code).toBe('provider_bad_request')
  })

  it('Mistral tool ids are remapped to 9 alphanumerics, consistently (07 C7)', async () => {
    mock.llm.setEchoRule('mistral9')
    mock.llm.script({ text: 'ok' })
    const turns: CanonTurn[] = [
      user(1, 'q'),
      { id: 2, role: 'assistant', blocks: [{ t: 'tool_call', id: 'toolu_01ABCDEFGHIJKLMNOP', name: 'memory_search', input: { query: 'x' } }] },
      { id: 3, role: 'tool', blocks: [{ t: 'tool_result', id: 'toolu_01ABCDEFGHIJKLMNOP', text: 'none' }] }
    ]
    const p = profile('mistral')
    const body = renderOpenai(p, req(turns), att)
    const msgs = body.messages as Record<string, unknown>[]
    const id = mistralId('toolu_01ABCDEFGHIJKLMNOP')
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/)
    expect((msgs[2].tool_calls as Record<string, unknown>[])[0].id).toBe(id)
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: id, content: 'none' })
    expect((await drain(createOpenaiAdapter(p).stream(req(turns), att, new AbortController().signal))).error).toBeNull()
  })

  it('renders attachments by capability and notes as user text (07 C7/C8/B7)', () => {
    const turns: CanonTurn[] = [
      user(1, 'look', [
        { t: 'image', sha: 'img1', mime: 'image/png', name: 'a.png', width: 10, height: 20 },
        { t: 'document', sha: 'pdf1', mime: 'application/pdf', name: 'doc.pdf' },
        { t: 'file_text', sha: 'pdf1', name: 'doc.pdf' },
        { t: 'file_text', sha: 'txt1', name: 'notes.txt' }
      ]),
      { id: 2, role: 'system', blocks: [{ t: 'system_note', text: 'Memory is off.' }] }
    ]
    const vision = renderOpenai(profile('openai'), req(turns), att).messages as Record<string, unknown>[]
    const parts = vision[1].content as Record<string, unknown>[]
    expect(parts.map((x) => x.type)).toEqual(['file', 'text', 'image_url', 'text'])
    expect((parts[2].image_url as { url: string }).url).toBe(`data:image/png;base64,${Buffer.from('bytes-of-img1').toString('base64')}`)
    expect(parts[3].text).toContain('<file id="r_txt1" name="notes.txt">')
    expect(parts[3].text).toContain('&lt;b&gt;[⁠memory_search')
    // OpenAI itself: the note is a system message after the user turn.
    expect(vision[2]).toEqual({ role: 'system', content: 'Memory is off.' })
    const plain = renderOpenai(profile('groq', { caps: { tools: true, vision: false, pdf: false, contextWindow: 1000 } }), req(turns), att).messages as Record<string, unknown>[]
    const p2 = plain[1].content as Record<string, unknown>[]
    expect(p2.map((x) => x.text)).toEqual(['look', '[image: a.png, 10×20]', expect.stringContaining('doc.pdf'), expect.stringContaining('notes.txt'), '(Note from Vesper, not from the user: Memory is off.)'])
    expect(plain).toHaveLength(2)
  })

  it('text mode renders tool calls as bracket text and declares no tools', () => {
    const turns: CanonTurn[] = [
      user(1, 'q'),
      { id: 2, role: 'assistant', blocks: [{ t: 'tool_call', id: 'c1', name: 'memory_search', input: { scope: 'all', query: 'x' } }] },
      { id: 3, role: 'tool', blocks: [{ t: 'tool_result', id: 'c1', text: 'R' }] }
    ]
    const body = renderOpenai(profile('ollama'), req(turns, { toolMode: 'text' }), att)
    expect(body.tools).toBeUndefined()
    expect((body.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: '[memory_search query="x" scope="all"]' },
      { role: 'user', content: 'R' }
    ])
  })

  it('lists models (tolerating both shapes) with OpenRouter capabilities', async () => {
    mock.llm.setModels(['b-model', 'a-model'])
    expect((await createOpenaiAdapter(profile('openai')).listModels(new AbortController().signal)).map((m) => m.id)).toEqual(['a-model', 'b-model'])
    mock.script({
      method: 'GET',
      path: '/v1/models',
      json: { data: [{ id: 'x/y', name: 'X Y', context_length: 1000, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }] }
    })
    expect(await createOpenaiAdapter(profile('openrouter')).listModels(new AbortController().signal)).toEqual([
      { id: 'x/y', label: 'X Y', contextWindow: 1000, caps: { tools: true, reasoning: false, vision: true, pdf: false } }
    ])
  })
})

describe('Anthropic adapter', () => {
  it('streams thinking (signed) + text + tool_use; signatures are kept verbatim', async () => {
    mock.llm.script({ reasoning: 'Let me think.', text: 'Looking it up.', toolCalls: [{ name: 'memory_search', input: { query: 'lisbon' } }], usage: { in: 50, out: 20, cacheRead: 30 } })
    const p = profile('anthropic')
    const s = createAnthropicAdapter(p).stream(req([user(1, 'q')], { model: p.model }), att, new AbortController().signal)
    const r = await drain(s)
    expect(r.error).toBeNull()
    expect(reasoning(r.events)).toBe('Let me think.')
    expect(text(r.events)).toBe('Looking it up.')
    const res = s.result()
    expect(res.blocks).toEqual([
      { t: 'reasoning', echoKey: 'anthropic:claude-opus-5-5', payload: { type: 'thinking', thinking: 'Let me think.', signature: thinkingSignature('Let me think.') } },
      { t: 'text', text: 'Looking it up.' },
      { t: 'tool_call', id: expect.stringMatching(/^toolu_mock/), name: 'memory_search', input: { query: 'lisbon' } }
    ])
    expect(res.stopReason).toBe('tool_use')
    expect(res.usage).toMatchObject({ in: 50, out: 20, cacheRead: 30 })
    const sent = mock.recorder.last('/anthropic/v1/messages') ?? mock.recorder.last('/v1/messages')!
    expect(sent.headers['x-api-key']).toBe('sk-test-0123456789')
    expect(sent.json).toMatchObject({ thinking: { type: 'adaptive', display: 'omitted' }, max_tokens: 4000 })
  })

  it('drops thinking that never got its signature when aborted (07 C6)', async () => {
    mock.llm.script({ reasoning: 'a long chain of thought '.repeat(20), chunkChars: 4, delayMs: 3, text: 'x' })
    const ctl = new AbortController()
    const s = createAnthropicAdapter(profile('anthropic')).stream(req([user(1, 'q')]), att, ctl.signal)
    let n = 0
    try {
      for await (const e of s.events) if (e.type === 'reasoning' && ++n === 3) ctl.abort()
    } catch {
      /* aborted */
    }
    expect(s.result().blocks).toEqual([])
  })

  it('refusal and errors map to the catalogue', async () => {
    const a = createAnthropicAdapter(profile('anthropic'))
    mock.llm.script({ text: 'no', refusal: true })
    const s = a.stream(req([user(1, 'q')]), att, new AbortController().signal)
    await drain(s)
    expect(s.result().stopReason).toBe('refusal')
    const run = async (): Promise<string> => mapProviderError((await drain(a.stream(req([user(1, 'q')]), att, new AbortController().signal))).error).info.code
    mock.llm.script({ error: { status: 529 } })
    expect(await run()).toBe('provider_overloaded')
    mock.llm.script({ error: { status: 400, message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } })
    expect(await run()).toBe('provider_history')
    mock.llm.script({ error: { status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum' } })
    expect(await run()).toBe('provider_context')
    mock.llm.script({ error: { status: 400, message: 'You have reached your specified API usage limits.' } })
    expect(await run()).toBe('provider_quota')
    mock.llm.script({ error: { status: 429, type: 'rate_limit_error', retryAfterSec: 3 } })
    expect(await run()).toBe('provider_rate')
    mock.llm.script({ text: 'abcdefghijklmnop', midStreamError: { afterEvents: 3 } })
    expect(await run()).toBe('provider_overloaded')
  })

  it('renders system notes as system messages only where the model and position allow (07 C7)', () => {
    const turns: CanonTurn[] = [user(1, 'q'), { id: 2, role: 'system', blocks: [{ t: 'system_note', text: 'Voice is on.' }] }]
    const opus = renderAnthropic(profile('anthropic'), req(turns, { model: 'claude-opus-5-5' }), att).messages as Record<string, unknown>[]
    expect(opus[1]).toEqual({ role: 'system', content: 'Voice is on.' })
    const sonnet5 = renderAnthropic(profile('anthropic', { model: 'claude-sonnet-5' }), req(turns, { model: 'claude-sonnet-5' }), att).messages as Record<string, unknown>[]
    expect(sonnet5).toHaveLength(1)
    expect((sonnet5[0].content as Record<string, unknown>[])[1]).toMatchObject({ type: 'text', text: '(Note from Vesper, not from the user: Voice is on.)' })
    // Followed by another user turn (an errored reply in between): folded into the user turn.
    const folded = renderAnthropic(profile('anthropic'), req([...turns, user(3, 'again')], { model: 'claude-opus-5-5' }), att).messages as Record<string, unknown>[]
    expect(folded.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('replays thinking to the same model only, and strips below the watermark (07 C5/C7)', () => {
    const think = { type: 'thinking', thinking: 'hm', signature: thinkingSignature('hm') }
    const turns: CanonTurn[] = [
      user(1, 'q'),
      { id: 2, role: 'assistant', blocks: [{ t: 'reasoning', echoKey: 'anthropic:claude-opus-5-5', payload: think }, { t: 'text', text: 'A' }] },
      user(3, 'q2')
    ]
    const same = renderAnthropic(profile('anthropic'), req(turns, { model: 'claude-opus-5-5' }), att).messages as Record<string, unknown>[]
    expect(same[1].content).toEqual([think, { type: 'text', text: 'A' }])
    const other = renderAnthropic(profile('anthropic', { model: 'claude-sonnet-5-5', echoKey: 'anthropic:claude-sonnet-5-5' }), req(turns, { model: 'claude-sonnet-5-5' }), att).messages as Record<string, unknown>[]
    expect(other[1].content).toEqual([{ type: 'text', text: 'A' }])
    const stripped = renderAnthropic(profile('anthropic'), req(turns, { model: 'claude-opus-5-5', stripThinkingBefore: 3 }), att).messages as Record<string, unknown>[]
    expect(stripped[1].content).toEqual([{ type: 'text', text: 'A' }])
  })

  it('renders deterministically: same blocks → same bytes; PDFs/images native by capability', () => {
    const turns: CanonTurn[] = [
      user(1, 'see', [
        { t: 'image', sha: 'img1', mime: 'image/jpeg', name: 'p.jpg', width: 1, height: 1 },
        { t: 'document', sha: 'pdf1', mime: 'application/pdf', name: 'd.pdf' },
        { t: 'file_text', sha: 'pdf1', name: 'd.pdf' }
      ]),
      { id: 2, role: 'assistant', blocks: [{ t: 'tool_call', id: 't1', name: 'memory_search', input: { b: 1, a: 2 } }] },
      { id: 3, role: 'tool', blocks: [{ t: 'tool_result', id: 't1', text: 'x', isError: true }] }
    ]
    const a = djson(renderAnthropic(profile('anthropic'), req(turns, { model: 'claude-opus-5-5' }), att))
    const b = djson(renderAnthropic(profile('anthropic'), req(JSON.parse(JSON.stringify(turns)) as CanonTurn[], { model: 'claude-opus-5-5' }), att))
    expect(a).toBe(b)
    const msgs = (JSON.parse(a) as { messages: { content: { type: string }[] }[] }).messages
    expect(msgs[0].content.map((c) => c.type)).toEqual(['text', 'image', 'document'])
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true })
  })

  it('utility requests ask for low effort and no thinking param', () => {
    const body = renderAnthropic(profile('anthropic'), req([user(1, 'q')], { model: 'claude-opus-5-5', utility: true, tools: [], toolMode: 'text' }), att)
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.tools).toBeUndefined()
  })

  it('lists models with capabilities (nullable capabilities tolerated)', async () => {
    const models = await createAnthropicAdapter(profile('anthropic')).listModels(new AbortController().signal)
    expect(models).toEqual([
      { id: 'claude-mock-5', label: 'Claude Mock 5', contextWindow: 200_000, maxOutput: 64_000, caps: { tools: true, vision: true, pdf: true, reasoning: true } },
      { id: 'claude-mock-legacy', label: 'Claude Mock Legacy', contextWindow: null, maxOutput: null, caps: { tools: true } }
    ])
  })
})

describe('OpenRouter reasoning_details', () => {
  it('joins streamed fragments per index into complete blocks', async () => {
    const { mergeDetails } = await import('@server/providers/llm/openai')
    const into: unknown[] = []
    mergeDetails(into, [{ type: 'reasoning.text', index: 0, text: 'Hel' }])
    mergeDetails(into, [{ type: 'reasoning.text', index: 0, text: 'lo', signature: null }])
    mergeDetails(into, [{ type: 'reasoning.encrypted', index: 1, data: 'abc' }, { type: 'reasoning.encrypted', index: 1, data: 'def' }])
    expect(into).toEqual([
      { type: 'reasoning.text', index: 0, text: 'Hello', signature: null },
      { type: 'reasoning.encrypted', index: 1, data: 'abcdef' }
    ])
  })
})
