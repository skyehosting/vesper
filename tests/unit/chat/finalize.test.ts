/**
 * 07 C6 acceptance: a thinking + text + parallel-tool stream cut at EVERY event index — by the user (stop) or by a
 * dropped connection (error) — finalizes into rows that make the next request valid (signatures intact, every
 * tool_use paired), for both adapters.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { presetById } from '@shared/presets'
import type { PresetId } from '@shared/settings'
import { createAnthropicAdapter } from '@server/providers/llm/anthropic'
import { createOpenaiAdapter } from '@server/providers/llm/openai'
import { mapProviderError } from '@server/providers/llm/errors'
import type { AttachmentSource, CanonTurn, LlmAdapter, LlmRequest, ResolvedProfile } from '@server/providers/llm/types'
import { finalizeRound } from '@server/chat/finalize'
import { toolDefs } from '@server/chat/context'
import { startMockServer, type MockServer } from '../../mocks/server'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(() => mock.close())
beforeEach(() => mock.reset())

const att: AttachmentSource = { bytes: () => null, text: () => null, boundary: () => 'r_x' }

function adapter(preset: PresetId): { a: LlmAdapter; model: string } {
  const p = presetById(preset)
  const model = p.adapter === 'anthropic' ? 'claude-opus-5-5' : 'mock-tools'
  const base = p.adapter === 'anthropic' ? `${mock.url}/anthropic` : `${mock.url}/v1`
  const prof: ResolvedProfile = {
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
    echoKey: p.adapter === 'anthropic' ? `anthropic:${model}` : p.echoKey
  }
  return { a: p.adapter === 'anthropic' ? createAnthropicAdapter(prof) : createOpenaiAdapter(prof), model }
}

const req = (model: string, turns: CanonTurn[]): LlmRequest => ({ model, system: [{ text: 'sys' }], tools: toolDefs(), toolMode: 'native', turns, maxTokens: 4000, reasoningDisplay: 'hidden', stripThinkingBefore: null })
const user = (id: number, text: string): CanonTurn => ({ id, role: 'user', blocks: [{ t: 'text', text }] })

const TURN = {
  reasoning: 'I will look in two places at once.',
  text: 'Checking both.',
  toolCalls: [
    { name: 'memory_search', input: { query: 'alpha' } },
    { name: 'memory_recall', input: { session: '#K7Q2MX' } }
  ],
  chunkChars: 6
}

async function cutAt(a: LlmAdapter, model: string, k: number, mode: 'stop' | 'drop'): Promise<CanonTurn[]> {
  const ctl = new AbortController()
  mock.llm.script(mode === 'drop' ? { ...TURN, abortAfterEvents: k, delayMs: 1 } : { ...TURN, delayMs: 1 })
  const s = a.stream(req(model, [user(1, 'start')]), att, ctl.signal)
  let n = 0
  let errored = false
  try {
    for await (const _e of s.events) if (mode === 'stop' && ++n >= k) ctl.abort()
  } catch (e) {
    if (!ctl.signal.aborted) {
      errored = true
      expect(['network', 'provider_overloaded', 'provider_bad_request']).toContain(mapProviderError(e).info.code)
    }
  }
  const f = finalizeRound(s.result(), { stopped: ctl.signal.aborted, errored })
  const turns: CanonTurn[] = [user(1, 'start')]
  if (f.assistant) turns.push({ id: 2, role: 'assistant', blocks: f.assistant })
  if (f.cancelled) turns.push({ id: 3, role: 'tool', blocks: f.cancelled })
  else if (f.toolCalls.length) turns.push({ id: 3, role: 'tool', blocks: f.toolCalls.map((c) => ({ t: 'tool_result', id: c.id, text: 'ok' })) })
  turns.push(user(4, 'next'))
  return turns
}

describe.each(['anthropic', 'openai'] as const)('%s: every cut point leaves a valid history (07 C6)', (preset) => {
  it.each(['drop', 'stop'] as const)('%s', async (mode) => {
    const { a, model } = adapter(preset)
    const shapes = new Set<string>()
    for (let k = 0; k <= 32; k++) {
      const turns = await cutAt(a, model, k, mode)
      shapes.add(turns.map((t) => `${t.role}:${t.blocks.map((b) => b.t).join('+')}`).join(' '))
      mock.llm.script({ text: 'fine' })
      const s = a.stream(req(model, turns), att, new AbortController().signal)
      let error: unknown = null
      try {
        for await (const _e of s.events) {
          /* drain */
        }
      } catch (e) {
        error = e
      }
      expect(error, `cut at ${k} (${mode}) → ${JSON.stringify(turns)}`).toBeNull()
    }
    // The sweep really crossed the interesting states: nothing, partial text, complete calls.
    // (OpenAI-style streams complete text and tool calls only at finish_reason, so a dropped connection is all or nothing.)
    expect(shapes.size).toBeGreaterThanOrEqual(mode === 'drop' && preset === 'openai' ? 2 : 3)
  }, 60_000)
})
