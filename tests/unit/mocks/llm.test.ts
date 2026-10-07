import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../mocks/server'
import { thinkingSignature, userWords } from '../../mocks/llm'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => mock.reset())

interface SseEvent {
  event: string | null
  data: string
}

async function sse(res: Response): Promise<SseEvent[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? null
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n')
      return { event: ev, data }
    })
}

const NOW = '[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York) · 23 days since the previous message]\n'

function openai(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${mock.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test', ...headers }, body: JSON.stringify(body) })
}

function anthropic(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) })
}

describe('mock LLM — OpenAI-compatible', () => {
  it('echoes the user words (header stripped) as an SSE stream with usage and [DONE]', async () => {
    const res = await openai({ model: 'mock-echo', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: `${NOW}hello` }] })
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const events = await sse(res)
    expect(events[events.length - 1].data).toBe('[DONE]')
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }>; usage?: { total_tokens: number } })
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Echo: hello')
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop')
    expect(chunks[chunks.length - 1].usage?.total_tokens).toBeGreaterThan(0)
  })

  it('streams reasoning_content and parallel tool calls that reassemble into valid JSON', async () => {
    mock.llm.script({ text: '', reasoning: 'Let me look that up.', toolCalls: [{ name: 'memory_search', input: { query: 'paris trip' } }, { name: 'memory_recall', input: { session: 'K7Q2MX', last: 4 } }] })
    const events = await sse(await openai({ model: 'mock-tools', stream: true, messages: [{ role: 'user', content: 'where did we go?' }] }))
    const deltas = events.filter((e) => e.data !== '[DONE]').map((e) => (JSON.parse(e.data) as { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }).choices[0])
    expect(deltas.map((d) => (d.delta.reasoning_content as string | undefined) ?? '').join('')).toBe('Let me look that up.')
    const calls: Array<{ id?: string; name?: string; args: string }> = []
    for (const d of deltas)
      for (const tc of (d.delta.tool_calls as Array<{ index: number; id?: string; function: { name?: string; arguments?: string } }> | undefined) ?? []) {
        calls[tc.index] ??= { args: '' }
        if (tc.id) calls[tc.index].id = tc.id
        if (tc.function.name) calls[tc.index].name = tc.function.name
        calls[tc.index].args += tc.function.arguments ?? ''
      }
    expect(calls.map((c) => c.name)).toEqual(['memory_search', 'memory_recall'])
    expect(JSON.parse(calls[1].args)).toEqual({ session: 'K7Q2MX', last: 4 })
    expect(deltas.find((d) => d.finish_reason)?.finish_reason).toBe('tool_calls')
  })

  it('answers non-streaming requests, lists models and returns scripted errors', async () => {
    const json = (await (await openai({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }] })).json()) as { choices: Array<{ message: { content: string } }> }
    expect(json.choices[0].message.content).toBe('Echo: hi')
    const models = (await (await fetch(`${mock.url}/v1/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data.map((m) => m.id)).toContain('mock-echo')
    mock.llm.script({ error: { status: 429, retryAfterSec: 3 } })
    const limited = await openai({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }] })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3')
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limit_exceeded')
    mock.llm.requireKey('sk-right')
    expect((await openai({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).status).toBe(401)
  })

  it('rejects a tool message without its assistant tool call', async () => {
    const res = await openai({ model: 'm', messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'call_1', content: 'r' }] })
    expect(res.status).toBe(400)
  })

  it('drops the connection after N events (abort scenario)', async () => {
    mock.llm.script({ text: 'a long reply that will be cut off', chunkChars: 2, abortAfterEvents: 3 })
    const res = await openai({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] })
    await expect(res.text()).rejects.toThrow()
  })
})

describe('mock LLM — Anthropic', () => {
  it('streams thinking (signed), text and tool_use with the real event sequence', async () => {
    mock.llm.script({ reasoning: 'Hmm.', text: 'Searching.', toolCalls: [{ name: 'memory_search', input: { query: 'cats' } }] })
    const events = await sse(await anthropic({ model: 'claude-mock-5', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'cats?' }] }] }))
    const types = events.map((e) => e.event)
    expect(types[0]).toBe('message_start')
    expect(types.slice(-2)).toEqual(['message_delta', 'message_stop'])
    const parsed = events.map((e) => JSON.parse(e.data) as Record<string, unknown>)
    const starts = parsed.filter((p) => p.type === 'content_block_start').map((p) => (p.content_block as { type: string }).type)
    expect(starts).toEqual(['thinking', 'text', 'tool_use'])
    const sig = parsed.find((p) => p.type === 'content_block_delta' && (p.delta as { type: string }).type === 'signature_delta')
    expect((sig?.delta as { signature: string }).signature).toBe(thinkingSignature('Hmm.'))
    const json = parsed
      .filter((p) => p.type === 'content_block_delta' && (p.delta as { type: string }).type === 'input_json_delta')
      .map((p) => (p.delta as { partial_json: string }).partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ query: 'cats' })
    expect((parsed[parsed.length - 2].delta as { stop_reason: string }).stop_reason).toBe('tool_use')
  })

  it('validates replayed thinking signatures and tool pairing like the real API', async () => {
    const good = { type: 'thinking', thinking: 'Hmm.', signature: thinkingSignature('Hmm.') }
    const tool = { type: 'tool_use', id: 'toolu_1', name: 'memory_search', input: { query: 'cats' } }
    const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'none' }
    const ok = await anthropic({ model: 'claude-mock-5', max_tokens: 100, messages: [{ role: 'user', content: 'cats?' }, { role: 'assistant', content: [good, tool] }, { role: 'user', content: [result] }] })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { content: Array<{ text?: string }> }).content[0].text).toBe('Echo: tool result received')
    const tampered = await anthropic({ model: 'claude-mock-5', max_tokens: 100, messages: [{ role: 'user', content: 'cats?' }, { role: 'assistant', content: [{ ...good, thinking: 'Hmm!' }, tool] }, { role: 'user', content: [result] }] })
    expect(tampered.status).toBe(400)
    expect(JSON.stringify(await tampered.json())).toMatch(/Invalid `signature`/)
    const unpaired = await anthropic({ model: 'claude-mock-5', max_tokens: 100, messages: [{ role: 'user', content: 'cats?' }, { role: 'assistant', content: [tool] }, { role: 'user', content: 'never mind' }] })
    expect(unpaired.status).toBe(400)
  })

  it('reports refusals and in-stream errors', async () => {
    mock.llm.script({ text: 'I can', refusal: true }, { text: 'partial', midStreamError: { afterEvents: 3 } })
    const refusal = (await sse(await anthropic({ model: 'claude-mock-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }))).map((e) => JSON.parse(e.data) as Record<string, unknown>)
    expect((refusal.find((p) => p.type === 'message_delta')?.delta as { stop_reason: string }).stop_reason).toBe('refusal')
    const broken = await sse(await anthropic({ model: 'claude-mock-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }))
    expect(broken[broken.length - 1].event).toBe('error')
  })

  it('serves /v1/models with capabilities when the request carries Anthropic headers', async () => {
    const res = await fetch(`${mock.url}/v1/models`, { headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } })
    const body = (await res.json()) as { data: Array<{ id: string; capabilities: { thinking?: { supported: boolean } } | null }> }
    expect(body.data[0].capabilities?.thinking?.supported).toBe(true)
    expect(body.data[1].capabilities).toBeNull()
    const prefixed = (await (await fetch(`${mock.url}/anthropic/v1/models`)).json()) as { data: unknown[] }
    expect(prefixed.data).toHaveLength(2)
  })
})

describe('mock LLM — scripting', () => {
  it('matches turns by api and text, records requests and reports unused turns', async () => {
    mock.llm.script({ text: 'for anthropic', match: { api: 'anthropic' } }, { text: 'about cats', match: { lastUserIncludes: 'cats' } })
    const a = (await (await openai({ model: 'm', messages: [{ role: 'user', content: 'dogs' }] })).json()) as { choices: Array<{ message: { content: string } }> }
    expect(a.choices[0].message.content).toBe('Echo: dogs')
    const b = (await (await openai({ model: 'm', messages: [{ role: 'user', content: 'cats' }] })).json()) as { choices: Array<{ message: { content: string } }> }
    expect(b.choices[0].message.content).toBe('about cats')
    expect(() => mock.llm.assertConsumed()).toThrow(/1 scripted/)
    expect(mock.recorder.count('/v1/chat/completions')).toBe(2)
    expect(mock.recorder.last()?.headers.authorization).toBe('Bearer sk-test')
  })

  it('strips the time header and appended recall blocks from echoed words', () => {
    expect(userWords(`${NOW}hello`)).toBe('hello')
    expect(userWords('[Mon 5 Oct 2026 14:03] hi\n\nVesper (not the user): recalled records')).toBe('hi')
  })

  it('records unhandled requests', async () => {
    expect((await fetch(`${mock.url}/nope`)).status).toBe(404)
    expect(() => mock.recorder.assertNoUnhandled()).toThrow(/GET \/nope/)
  })
})
