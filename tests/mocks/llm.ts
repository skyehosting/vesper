/**
 * Mock LLM providers (owner: llm-engine; foundation version by test-infra).
 *
 *   OpenAI-compatible  POST …/chat/completions (SSE or JSON) · GET …/models
 *   Anthropic          POST /v1/messages (SSE or JSON)        · GET /v1/models[/:id] (with capabilities)
 *
 * With nothing scripted every request gets the echo turn: "Echo: <text of the last user message>" (the `[Now: …]`
 * header of 07 C2 removed). Tests queue semantic turns with `mock.llm.script({...})`; the module renders them in the
 * wire format of whichever endpoint the request hit, so one script works for both adapters.
 *
 * Validation mirrors the real APIs where the app could plausibly get it wrong: Anthropic thinking signatures must be
 * the ones this mock issued (preserved-thinking safety), and tool calls / tool results must pair up (07 C6).
 */
import type { ServerResponse } from 'node:http'
import { bearer, estimateTokens, fnv1a, header, isRecord, sendJson, sendText, SseWriter, type MockRequest } from './http'
import type { MockModule } from './module'

export type LlmApi = 'openai' | 'anthropic'

export interface LlmToolCall {
  id?: string
  name: string
  input: Record<string, unknown>
}

export interface LlmError {
  status: number
  /** Provider error type (defaults per status, e.g. 429 → rate_limit_error / rate_limit_exceeded). */
  type?: string
  message?: string
  /** Sets the `retry-after` header (seconds). */
  retryAfterSec?: number
}

export interface LlmTurn {
  /** Visible reply text. Default: the echo of the last user message. Use '' for a tool-only turn. */
  text?: string
  /** Reasoning text: `reasoning_content` (or `reasoning`) deltas on OpenAI, a signed thinking block on Anthropic. */
  reasoning?: string
  reasoningField?: 'reasoning_content' | 'reasoning'
  /** Override the Anthropic thinking signature (e.g. to provoke the app's handling of a bad one). */
  signature?: string
  toolCalls?: LlmToolCall[]
  /** Anthropic stop_reason "refusal" / OpenAI finish_reason "content_filter". */
  refusal?: boolean
  /** Override the stop/finish reason (e.g. 'max_tokens' / 'length'). */
  stopReason?: string
  usage?: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number }
  /** Answer with an HTTP error instead of a reply. */
  error?: LlmError
  /** Send an in-stream error event after N events, then end the stream. */
  midStreamError?: { afterEvents: number; type?: string; message?: string }
  /** Characters per text delta (default 8). */
  chunkChars?: number
  /** Delay between SSE events (slow stream). */
  delayMs?: number
  firstByteDelayMs?: number
  /** Destroy the socket after N SSE events (a dropped connection). */
  abortAfterEvents?: number
  /** Answer with this exact body instead of an API reply (e.g. a web UI's index.html at the base URL). */
  raw?: { status?: number; contentType: string; body: string }
  /** Answer a streaming request with the non-stream JSON completion (a server that ignores `stream: true`). */
  ignoreStream?: boolean
  /** A stream with no events but `data: [DONE]` (OpenAI) / message_start + message_stop (Anthropic). */
  emptyStream?: boolean
  /** Never answer (timeouts). The socket is released when the mock closes. */
  hang?: boolean
  /** Only consume this turn for a matching request; others fall through to later turns or the default. */
  match?: { api?: LlmApi; model?: string | RegExp; lastUserIncludes?: string }
}

export interface LlmMock {
  /** Queue turns, consumed in order by matching requests. */
  script(...turns: LlmTurn[]): void
  /** Turn used when the queue has nothing matching (default: echo). */
  setDefault(turn: LlmTurn | ((req: LlmRequestInfo) => LlmTurn) | null): void
  /** Require this key (Bearer or x-api-key); null = accept any or none (default). */
  requireKey(key: string | null): void
  /** Model ids for the OpenAI-style `/models` list. */
  setModels(ids: string[]): void
  /** Toggle request validation (signatures, tool pairing). Default on. */
  setValidation(on: boolean): void
  /**
   * Provider echo rules (07 C7), off by default:
   *   'deepseek'  — OpenAI-style requests that carry `tools` must echo `reasoning_content` on every assistant message
   *                 the mock answered with reasoning (DeepSeek returns 400 otherwise, research 01 §2.1);
   *   'mistral9'  — tool call ids must be exactly 9 characters [a-zA-Z0-9] (Mistral).
   */
  setEchoRule(rule: 'deepseek' | 'mistral9' | null): void
  pending(): number
  /** Throws if scripted turns were never used (a test expected more requests than happened). */
  assertConsumed(): void
}

export interface LlmRequestInfo {
  api: LlmApi
  model: string
  stream: boolean
  /** Text of the last user message with the `[Now: …]` header removed ('' for tool results). */
  lastUserText: string
  body: Record<string, unknown>
}

export const DEFAULT_OPENAI_MODELS = ['mock-echo', 'mock-tools', 'mock-reasoning']

/** Anthropic `/v1/models` entries: one with full capabilities, one with `capabilities: null` (nullable per the API). */
export const ANTHROPIC_MODELS = [
  {
    type: 'model',
    id: 'claude-mock-5',
    display_name: 'Claude Mock 5',
    created_at: '2026-01-01T00:00:00Z',
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: false },
      context_management: { supported: true },
      effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } }
    }
  },
  {
    type: 'model',
    id: 'claude-mock-legacy',
    display_name: 'Claude Mock Legacy',
    created_at: '2025-01-01T00:00:00Z',
    max_input_tokens: null,
    max_tokens: null,
    capabilities: null
  }
] as const

/** The signature this mock issues for a thinking text; anything else is rejected like a tampered block. */
export function thinkingSignature(thinking: string): string {
  const h = (fnv1a(thinking).toString(16) + fnv1a(thinking, 0x1234567).toString(16)).padStart(16, '0')
  return `mocksig_${Buffer.from(h).toString('base64')}`
}

const NOW_HEADER = /^\s*\[(?:Now:|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b)[^\]\n]*\]\s*/
/** Recalled-memory text appended after the user's own words (07 B7) is not part of what the user said. */
const APPENDIX = /\n\s*(?:<memory_result|Vesper \(not the user\))/

/** The user's own words in a stored user turn: header stripped, appended recall blocks cut. */
export function userWords(text: string): string {
  let t = text
  while (NOW_HEADER.test(t)) t = t.replace(NOW_HEADER, '')
  const cut = APPENDIX.exec(t)
  if (cut) t = t.slice(0, cut.index)
  return t.trim()
}

function firstText(content: unknown): { text: string; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolResult: false }
  if (!Array.isArray(content)) return { text: '', toolResult: false }
  let toolResult = false
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'tool_result') toolResult = true
    if (part.type === 'text' && typeof part.text === 'string') return { text: part.text, toolResult }
  }
  return { text: '', toolResult }
}

function lastUser(body: Record<string, unknown>, api: LlmApi): { text: string; toolResult: boolean } {
  const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : []
  const last = msgs[msgs.length - 1]
  if (api === 'openai' && isRecord(last) && last.role === 'tool') return { text: '', toolResult: true }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (isRecord(m) && m.role === 'user') return firstText(m.content)
  }
  return { text: '', toolResult: false }
}

export function echoTurn(info: LlmRequestInfo): LlmTurn {
  return { text: info.lastUserText ? `Echo: ${info.lastUserText}` : 'Echo: tool result received' }
}

function chunks(text: string, size: number): string[] {
  const cps = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''))
  return out
}

// ── Errors ────────────────────────────────────────────────────────────────────────────────────
const OPENAI_ERR: Record<number, { type: string; code: string | null; message: string }> = {
  400: { type: 'invalid_request_error', code: null, message: 'Invalid request.' },
  401: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided.' },
  403: { type: 'permission_error', code: 'unsupported_country_region_territory', message: 'Permission denied.' },
  404: { type: 'invalid_request_error', code: 'model_not_found', message: 'The model does not exist.' },
  429: { type: 'requests', code: 'rate_limit_exceeded', message: 'Rate limit reached for requests.' },
  500: { type: 'server_error', code: null, message: 'The server had an error while processing your request.' },
  503: { type: 'server_error', code: 'overloaded', message: 'The engine is currently overloaded.' }
}
const ANTHROPIC_ERR: Record<number, { type: string; message: string }> = {
  400: { type: 'invalid_request_error', message: 'Invalid request.' },
  401: { type: 'authentication_error', message: 'invalid x-api-key' },
  403: { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' },
  404: { type: 'not_found_error', message: 'The requested resource could not be found.' },
  413: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' },
  429: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' },
  500: { type: 'api_error', message: 'Internal server error.' },
  529: { type: 'overloaded_error', message: 'Overloaded' }
}

export function sendLlmError(res: ServerResponse, api: LlmApi, e: LlmError): void {
  const headers: Record<string, string> = {}
  if (e.retryAfterSec !== undefined) headers['retry-after'] = String(e.retryAfterSec)
  if (api === 'anthropic') {
    const d = ANTHROPIC_ERR[e.status] ?? ANTHROPIC_ERR[500]
    headers['request-id'] = `req_mock_${e.status}`
    sendJson(res, e.status, { type: 'error', error: { type: e.type ?? d.type, message: e.message ?? d.message }, request_id: headers['request-id'] }, headers)
  } else {
    const d = OPENAI_ERR[e.status] ?? OPENAI_ERR[500]
    sendJson(res, e.status, { error: { message: e.message ?? d.message, type: e.type ?? d.type, param: null, code: d.code } }, headers)
  }
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────
function validateAnthropic(body: Record<string, unknown>): string | null {
  if (typeof body.model !== 'string' || !body.model) return 'model: Field required'
  if (typeof body.max_tokens !== 'number') return 'max_tokens: Field required'
  const msgs = body.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return 'messages: at least one message is required'
  if (!isRecord(msgs[0]) || msgs[0].role !== 'user') return 'messages: first message must use the "user" role'
  const sys = validateSystemRole(msgs)
  if (sys) return sys
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!isRecord(m) || !Array.isArray(m.content)) continue
    const blocks = m.content as unknown[]
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[j]
      if (isRecord(b) && b.type === 'thinking' && (typeof b.thinking !== 'string' || b.signature !== thinkingSignature(b.thinking)))
        return `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block`
    }
    if (m.role === 'assistant') {
      const ids = blocks.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_use').map((b) => String(b.id))
      if (!ids.length || i === msgs.length - 1) continue
      const next = msgs[i + 1]
      const results = isRecord(next) && Array.isArray(next.content) ? (next.content as unknown[]).filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_result').map((b) => String(b.tool_use_id)) : []
      const missing = ids.filter((id) => !results.includes(id))
      if (missing.length)
        return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`
    }
    if (m.role === 'user') {
      const prev = msgs[i - 1]
      const uses = isRecord(prev) && prev.role === 'assistant' && Array.isArray(prev.content) ? (prev.content as unknown[]).filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_use').map((b) => String(b.id)) : []
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j]
        if (isRecord(b) && b.type === 'tool_result' && !uses.includes(String(b.tool_use_id)))
          return `messages.${i}.content.${j}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(b.tool_use_id)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`
      }
    }
  }
  return null
}

/** Anthropic mid-conversation system messages: never first, after a user turn, last or before an assistant turn. */
function validateSystemRole(msgs: unknown[]): string | null {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!isRecord(m) || m.role !== 'system') continue
    if (i === 0) return 'messages.0: a system message cannot be the first message'
    const prev = msgs[i - 1]
    if (!isRecord(prev) || prev.role !== 'user') return `messages.${i}: a system message must follow a user message`
    const next = msgs[i + 1]
    if (next !== undefined && (!isRecord(next) || next.role !== 'assistant')) return `messages.${i}: a system message must be last or followed by an assistant message`
  }
  return null
}

function validateEchoRule(body: Record<string, unknown>, rule: 'deepseek' | 'mistral9', issued: Map<string, string>): string | null {
  const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!isRecord(m)) continue
    if (rule === 'deepseek' && Array.isArray(body.tools) && m.role === 'assistant') {
      const want = issued.get(String(m.content ?? ''))
      if (want !== undefined && m.reasoning_content !== want) return `messages[${i}]: The reasoning_content in the thinking mode must be passed back to the API.`
    }
    if (rule === 'mistral9') {
      const ids: string[] = []
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls as unknown[]) if (isRecord(c)) ids.push(String(c.id))
      if (m.role === 'tool') ids.push(String(m.tool_call_id))
      const bad = ids.find((x) => !/^[a-zA-Z0-9]{9}$/.test(x))
      if (bad !== undefined) return `Tool call id was ${bad} but must be a-z, A-Z, 0-9, with a length of 9.`
    }
  }
  return null
}

function validateOpenai(body: Record<string, unknown>): string | null {
  if (typeof body.model !== 'string' || !body.model) return 'you must provide a model parameter'
  const msgs = body.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return "Invalid 'messages': empty array."
  const open = new Set<string>()
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!isRecord(m)) return `Invalid 'messages[${i}]'`
    if (m.role === 'tool') {
      const id = String(m.tool_call_id)
      if (!open.has(id)) return `Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.`
      open.delete(id)
      continue
    }
    if (open.size) return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...open].join(', ')}`
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls as unknown[]) if (isRecord(c)) open.add(String(c.id))
  }
  return null
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────
interface Resolved {
  text: string
  reasoning: string
  toolCalls: Array<Required<LlmToolCall>>
  turn: LlmTurn
  inTokens: number
  outTokens: number
}

async function streamOpenai(res: ServerResponse, info: LlmRequestInfo, r: Resolved, seq: number): Promise<void> {
  const t = r.turn
  const sse = new SseWriter(res, { delayMs: t.delayMs, abortAfterEvents: t.abortAfterEvents, firstByteDelayMs: t.firstByteDelayMs })
  await sse.open()
  const base = { id: `chatcmpl-mock-${seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: info.model, system_fingerprint: 'fp_mock' }
  let events = 0
  const send = async (payload: unknown): Promise<boolean> => {
    if (t.midStreamError && events === t.midStreamError.afterEvents) {
      await sse.event({ error: { message: t.midStreamError.message ?? 'The server had an error while processing your request.', type: t.midStreamError.type ?? 'server_error', param: null, code: null } })
      sse.end()
      return false
    }
    events++
    return sse.event(payload)
  }
  const delta = (d: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({ ...base, choices: [{ index: 0, delta: d, logprobs: null, finish_reason: finish }] })
  const size = t.chunkChars ?? 8
  if (!(await send(delta({ role: 'assistant', content: '' })))) return
  const field = t.reasoningField ?? 'reasoning_content'
  for (const piece of chunks(r.reasoning, size)) if (!(await send(delta({ [field]: piece })))) return
  for (const piece of chunks(r.text, size)) if (!(await send(delta({ content: piece })))) return
  if (r.toolCalls.length) {
    // Headers first, then argument fragments interleaved across calls (as parallel tool calls really arrive).
    for (let i = 0; i < r.toolCalls.length; i++) {
      const c = r.toolCalls[i]
      if (!(await send(delta({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] })))) return
    }
    const parts = r.toolCalls.map((c) => chunks(JSON.stringify(c.input), Math.max(4, size)))
    const longest = Math.max(...parts.map((p) => p.length))
    for (let k = 0; k < longest; k++)
      for (let i = 0; i < parts.length; i++) if (parts[i][k] !== undefined && !(await send(delta({ tool_calls: [{ index: i, function: { arguments: parts[i][k] } }] })))) return
  }
  const finish = t.stopReason ?? (t.refusal ? 'content_filter' : r.toolCalls.length ? 'tool_calls' : 'stop')
  if (!(await send(delta({}, finish)))) return
  const opts = info.body.stream_options
  if (isRecord(opts) && opts.include_usage) {
    const usage = {
      prompt_tokens: r.inTokens,
      completion_tokens: r.outTokens,
      total_tokens: r.inTokens + r.outTokens,
      prompt_tokens_details: { cached_tokens: t.usage?.cacheRead ?? 0 },
      completion_tokens_details: { reasoning_tokens: r.reasoning ? estimateTokens(r.reasoning) : 0 }
    }
    if (!(await send({ ...base, choices: [], usage }))) return
  }
  if (!(await sse.event('[DONE]'))) return
  sse.end()
}

function jsonOpenai(info: LlmRequestInfo, r: Resolved, seq: number): Record<string, unknown> {
  const t = r.turn
  const message: Record<string, unknown> = { role: 'assistant', content: r.text || (r.toolCalls.length ? null : ''), refusal: null }
  if (r.reasoning) message[t.reasoningField ?? 'reasoning_content'] = r.reasoning
  if (r.toolCalls.length) message.tool_calls = r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }))
  return {
    id: `chatcmpl-mock-${seq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: info.model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: t.stopReason ?? (t.refusal ? 'content_filter' : r.toolCalls.length ? 'tool_calls' : 'stop') }],
    usage: { prompt_tokens: r.inTokens, completion_tokens: r.outTokens, total_tokens: r.inTokens + r.outTokens }
  }
}

function anthropicStop(r: Resolved): string {
  return r.turn.stopReason ?? (r.turn.refusal ? 'refusal' : r.toolCalls.length ? 'tool_use' : 'end_turn')
}

function anthropicUsage(r: Resolved): Record<string, number> {
  return { input_tokens: r.inTokens, cache_creation_input_tokens: r.turn.usage?.cacheWrite ?? 0, cache_read_input_tokens: r.turn.usage?.cacheRead ?? 0, output_tokens: r.outTokens }
}

async function streamAnthropic(res: ServerResponse, info: LlmRequestInfo, r: Resolved, seq: number): Promise<void> {
  const t = r.turn
  const sse = new SseWriter(res, { delayMs: t.delayMs, abortAfterEvents: t.abortAfterEvents, firstByteDelayMs: t.firstByteDelayMs })
  await sse.open()
  let events = 0
  const send = async (type: string, payload: Record<string, unknown>): Promise<boolean> => {
    if (t.midStreamError && events === t.midStreamError.afterEvents) {
      await sse.event({ type: 'error', error: { type: t.midStreamError.type ?? 'overloaded_error', message: t.midStreamError.message ?? 'Overloaded' } }, 'error')
      sse.end()
      return false
    }
    events++
    return sse.event({ type, ...payload }, type)
  }
  const size = t.chunkChars ?? 8
  const start = { id: `msg_mock_${seq}`, type: 'message', role: 'assistant', model: info.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...anthropicUsage(r), output_tokens: 1 } }
  if (!(await send('message_start', { message: start }))) return
  if (!(await send('ping', {}))) return
  let index = 0
  if (r.reasoning) {
    if (!(await send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }))) return
    for (const piece of chunks(r.reasoning, size)) if (!(await send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } }))) return
    if (!(await send('content_block_delta', { index, delta: { type: 'signature_delta', signature: t.signature ?? thinkingSignature(r.reasoning) } }))) return
    if (!(await send('content_block_stop', { index }))) return
    index++
  }
  if (r.text) {
    if (!(await send('content_block_start', { index, content_block: { type: 'text', text: '' } }))) return
    for (const piece of chunks(r.text, size)) if (!(await send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } }))) return
    if (!(await send('content_block_stop', { index }))) return
    index++
  }
  for (const c of r.toolCalls) {
    if (!(await send('content_block_start', { index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }))) return
    for (const piece of chunks(JSON.stringify(c.input), Math.max(4, size))) if (!(await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } }))) return
    if (!(await send('content_block_stop', { index }))) return
    index++
  }
  if (!(await send('message_delta', { delta: { stop_reason: anthropicStop(r), stop_sequence: null }, usage: { output_tokens: r.outTokens } }))) return
  if (!(await send('message_stop', {}))) return
  sse.end()
}

function jsonAnthropic(info: LlmRequestInfo, r: Resolved, seq: number): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (r.reasoning) content.push({ type: 'thinking', thinking: r.reasoning, signature: r.turn.signature ?? thinkingSignature(r.reasoning) })
  if (r.text) content.push({ type: 'text', text: r.text })
  for (const c of r.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  return { id: `msg_mock_${seq}`, type: 'message', role: 'assistant', model: info.model, content, stop_reason: anthropicStop(r), stop_sequence: null, usage: anthropicUsage(r) }
}

// ── Module ────────────────────────────────────────────────────────────────────────────────────
function turnMatches(t: LlmTurn, info: LlmRequestInfo): boolean {
  const m = t.match
  if (!m) return true
  if (m.api && m.api !== info.api) return false
  if (m.model !== undefined && !(typeof m.model === 'string' ? m.model === info.model : m.model.test(info.model))) return false
  if (m.lastUserIncludes !== undefined && !info.lastUserText.includes(m.lastUserIncludes)) return false
  return true
}

export function createLlmMock(): LlmMock & MockModule {
  let queue: LlmTurn[] = []
  let fallback: LlmTurn | ((req: LlmRequestInfo) => LlmTurn) | null = null
  let key: string | null = null
  let models = [...DEFAULT_OPENAI_MODELS]
  let validate = true
  let echoRule: 'deepseek' | 'mistral9' | null = null
  /** Reply text → reasoning the mock issued with it (for the 'deepseek' echo rule). */
  const issuedReasoning = new Map<string, string>()
  let seq = 0

  const isAnthropicRequest = (req: MockRequest): boolean => req.forced === 'anthropic' || (req.forced !== 'openai' && (header(req, 'anthropic-version') !== undefined || header(req, 'x-api-key') !== undefined))

  const authorized = (req: MockRequest, api: LlmApi): boolean => {
    if (key === null) return true
    return (api === 'anthropic' ? header(req, 'x-api-key') : bearer(req)) === key
  }

  async function chat(req: MockRequest, res: ServerResponse, api: LlmApi): Promise<void> {
    if (!authorized(req, api)) return sendLlmError(res, api, { status: 401 })
    const body = isRecord(req.json) ? req.json : null
    if (!body) return sendLlmError(res, api, { status: 400, message: 'Request body must be a JSON object.' })
    const problem = validate
      ? (api === 'anthropic' ? validateAnthropic(body) : validateOpenai(body)) ?? (echoRule && api === 'openai' ? validateEchoRule(body, echoRule, issuedReasoning) : null)
      : null
    if (problem) return sendLlmError(res, api, { status: 400, message: problem })
    const lu = lastUser(body, api)
    const info: LlmRequestInfo = { api, model: String(body.model ?? ''), stream: body.stream === true, lastUserText: lu.toolResult && !lu.text ? '' : userWords(lu.text), body }
    const idx = queue.findIndex((t) => turnMatches(t, info))
    const turn: LlmTurn = idx >= 0 ? queue.splice(idx, 1)[0] : typeof fallback === 'function' ? fallback(info) : (fallback ?? echoTurn(info))
    if (turn.hang) return // left open on purpose; the server destroys sockets on close
    if (turn.error) return sendLlmError(res, api, turn.error)
    if (turn.raw) return sendText(res, turn.raw.status ?? 200, turn.raw.body, turn.raw.contentType)
    if (turn.emptyStream && info.stream) {
      const sse = new SseWriter(res, {})
      await sse.open()
      if (api === 'openai') await sse.event('[DONE]')
      sse.end()
      return
    }
    const n = ++seq
    const text = turn.text ?? echoTurn(info).text ?? ''
    const reasoning = turn.reasoning ?? ''
    const toolCalls = (turn.toolCalls ?? []).map((c, i) => ({ id: c.id ?? (api === 'anthropic' ? `toolu_mock${n}_${i}` : `call_mock${n}_${i}`), name: c.name, input: c.input }))
    if (reasoning && api === 'openai') issuedReasoning.set(text || '', reasoning)
    const outText = text + reasoning + toolCalls.map((c) => JSON.stringify(c.input)).join('')
    const resolved: Resolved = {
      text,
      reasoning,
      toolCalls,
      turn,
      inTokens: turn.usage?.in ?? estimateTokens(JSON.stringify(body.messages ?? '') + JSON.stringify(body.system ?? '')),
      outTokens: turn.usage?.out ?? estimateTokens(outText)
    }
    if (api === 'anthropic') {
      if (info.stream && !turn.ignoreStream) await streamAnthropic(res, info, resolved, n)
      else sendJson(res, 200, jsonAnthropic(info, resolved, n), { 'request-id': `req_mock_${n}` })
    } else if (info.stream && !turn.ignoreStream) await streamOpenai(res, info, resolved, n)
    else sendJson(res, 200, jsonOpenai(info, resolved, n))
  }

  return {
    name: 'llm',
    prefixes: ['openai', 'anthropic', 'groq'],
    script(...turns) {
      queue.push(...turns)
    },
    setDefault(turn) {
      fallback = turn
    },
    requireKey(k) {
      key = k
    },
    setModels(ids) {
      models = [...ids]
    },
    setValidation(on) {
      validate = on
    },
    setEchoRule(rule) {
      echoRule = rule
    },
    pending() {
      return queue.length
    },
    assertConsumed() {
      if (queue.length) throw new Error(`mock llm: ${queue.length} scripted turn(s) were never requested`)
    },
    reset() {
      queue = []
      fallback = null
      key = null
      models = [...DEFAULT_OPENAI_MODELS]
      validate = true
      echoRule = null
      issuedReasoning.clear()
    },
    async handle(req, res) {
      if (req.forced && !this.prefixes.includes(req.forced)) return false
      if (req.method === 'POST' && req.path === '/v1/messages') {
        await chat(req, res, 'anthropic')
        return true
      }
      if (req.method === 'POST' && req.path.endsWith('/chat/completions')) {
        await chat(req, res, 'openai')
        return true
      }
      if (req.method === 'GET' && (req.path === '/v1/models' || /^\/v1\/models\/[^/]+$/.test(req.path)) && isAnthropicRequest(req)) {
        if (!authorized(req, 'anthropic')) {
          sendLlmError(res, 'anthropic', { status: 401 })
          return true
        }
        const id = req.path.split('/')[3]
        if (id) {
          const m = ANTHROPIC_MODELS.find((x) => x.id === decodeURIComponent(id))
          if (m) sendJson(res, 200, m)
          else sendLlmError(res, 'anthropic', { status: 404, message: `model: ${id}` })
          return true
        }
        sendJson(res, 200, { data: ANTHROPIC_MODELS, has_more: false, first_id: ANTHROPIC_MODELS[0].id, last_id: ANTHROPIC_MODELS[ANTHROPIC_MODELS.length - 1].id })
        return true
      }
      if (req.method === 'GET' && req.path.endsWith('/models') && req.forced !== 'anthropic') {
        if (!authorized(req, 'openai')) {
          sendLlmError(res, 'openai', { status: 401 })
          return true
        }
        sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 1767225600, owned_by: 'vesper-mock' })) })
        return true
      }
      return false
    }
  }
}
