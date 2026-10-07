import { describe, expect, it } from 'vitest'
import { Recorder, type RecordedRequest } from '../../mocks/recorder'

let seq = 0
function req(body: Record<string, unknown>, path = '/v1/messages', headers: Record<string, string> = {}): RecordedRequest {
  const text = JSON.stringify(body)
  return { seq: ++seq, ts: Date.now(), module: 'llm', method: 'POST', path, rawPath: path, query: {}, headers, body: text, bytes: Buffer.from(text), json: body }
}

const system = [{ type: 'text', text: 'You are Vesper.' }]
const tools = [{ name: 'memory_search', input_schema: { type: 'object' } }]
const u1 = { role: 'user', content: [{ type: 'text', text: '[Now: Mon 5 Oct 2026 14:03 (UTC+00:00)]\nhello' }] }
const a1 = { role: 'assistant', content: [{ type: 'text', text: 'Echo: hello' }] }
const u2 = { role: 'user', content: [{ type: 'text', text: '[Now: Mon 5 Oct 2026 14:04 (UTC+00:00)]\nagain' }] }

describe('prefix invariance validator (07 C1)', () => {
  it('accepts a conversation that only appends', () => {
    const r = new Recorder()
    r.push(req({ model: 'm', system, tools, messages: [u1] }))
    r.push(req({ model: 'm', system, tools, messages: [u1, a1, u2] }))
    expect(r.checkPrefixInvariant()).toEqual([])
    expect(() => r.assertPrefixInvariant()).not.toThrow()
  })

  it('catches an edited earlier turn', () => {
    const r = new Recorder()
    r.push(req({ model: 'm', system, tools, messages: [u1, a1, u2] }))
    const edited = { role: 'assistant', content: [{ type: 'text', text: 'Echo: hello!' }] }
    r.push(req({ model: 'm', system, tools, messages: [u1, edited, u2, a1, u2] }))
    const v = r.checkPrefixInvariant()
    expect(v).toHaveLength(1)
    expect(v[0].field).toBe('messages[1]')
    expect(() => r.assertPrefixInvariant()).toThrow(/messages\[1\]/)
  })

  it('catches a re-rendered system prompt, changed tools and dropped turns', () => {
    const r = new Recorder()
    r.push(req({ model: 'm', system, tools, messages: [u1, a1, u2] }))
    r.push(req({ model: 'm', system: [{ type: 'text', text: 'You are Vesper. It is 14:05.' }], tools: [], messages: [u1] }))
    expect(r.checkPrefixInvariant().map((x) => x.field).sort()).toEqual(['messages.length', 'system', 'tools'])
  })

  it('ignores moved cache_control breakpoints and keeps conversations apart', () => {
    const r = new Recorder()
    const u1c = { role: 'user', content: [{ type: 'text', text: u1.content[0].text, cache_control: { type: 'ephemeral' } }] }
    const other = { role: 'user', content: [{ type: 'text', text: 'a different session' }] }
    r.push(req({ model: 'm', system, messages: [u1c] }))
    r.push(req({ model: 'm', system: 'another system', messages: [other] }))
    r.push(req({ model: 'm', system, messages: [u1, a1, u2] }))
    expect(r.checkPrefixInvariant()).toEqual([])
  })

  it('supports the explicit conversation header, OpenAI format and an allow-list', () => {
    const r = new Recorder()
    const h = { 'x-mock-conversation': 'c1' }
    r.push(req({ model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'x' }] }, '/v1/chat/completions', h))
    r.push(req({ model: 'm', messages: [{ role: 'system', content: 'S2' }, { role: 'user', content: 'x' }] }, '/v1/chat/completions', h))
    expect(r.checkPrefixInvariant()).toEqual([])
    expect(r.checkPrefixInvariant({ api: 'openai' })).toHaveLength(1)
    expect(r.checkPrefixInvariant({ api: 'openai', allow: (v) => v.field === 'messages[0]' })).toEqual([])
  })
})
