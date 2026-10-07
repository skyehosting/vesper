/**
 * OpenAI-compatible Chat Completions adapter (openai 7.28.0; research 01 §2.1/§2.4). Covers OpenAI, Gemini, OpenRouter,
 * Groq, Mistral, xAI, DeepSeek, Together, Ollama, LM Studio and custom URLs.
 *
 * Rendering (07 C1/C7/C8): one `system` message from the epoch's frozen system blocks; system_notes become a `system`
 * message after the user turn on OpenAI itself and a user-turn text part elsewhere (many compatible servers reject a
 * mid-conversation system message); reasoning fields (`reasoning_content`, `reasoning`, `reasoning_details`) and
 * provider extras are echoed only to the same echoKey; Mistral tool ids are remapped. Parsing accepts string or array
 * `content`, the known reasoning fields, interleaved parallel tool-call deltas and the trailing usage chunk.
 */
import OpenAI from 'openai'
import { djson } from '@shared/djson'
import type { ModelInfo, Usage } from '@shared/types/domain'
import type { Extra, MemoryFunctionName, WireBlock } from '@shared/types/wire'
import { answerKind, getJson, guardedFetch, notAnApi, rawAuthHeaders, REQUEST_TIMEOUT_MS } from './client'
import { bracketCall, fileText, imagePlaceholder, mistralId, noteAsText } from './render'
import type { AttachmentSource, CanonTurn, LlmAdapter, LlmEvent, LlmRequest, LlmStream, ResolvedProfile, RoundResult, StopReason } from './types'

type Json = Record<string, unknown>
type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'file'; file: { filename: string; file_data: string } }


function textOnly(parts: Part[]): string | Part[] {
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
}

export function renderOpenai(p: ResolvedProfile, req: LlmRequest, att: AttachmentSource): Json {
  const native = req.toolMode === 'native'
  const idOf = (id: string): string => (p.preset.toolCallIdRule === 'mistral9' ? mistralId(id) : id)
  const systemRole = p.preset.id === 'openai'
  const echo = (key: string, rowId: number): boolean => key === p.echoKey && (req.stripThinkingBefore === null || rowId >= req.stripThinkingBefore)
  const messages: Json[] = []
  const sys = req.system.map((s) => s.text).filter(Boolean).join('\n\n')
  if (sys) messages.push({ role: 'system', content: sys })

  const userParts = (t: CanonTurn): Part[] => {
    const parts: Part[] = []
    const nativePdf = new Set<string>()
    for (const b of t.blocks) {
      if (b.t === 'document' && p.caps.pdf && p.preset.pdfMode === 'file-part') {
        const bytes = att.bytes(b.sha)
        if (bytes) {
          nativePdf.add(b.sha)
          parts.push({ type: 'file', file: { filename: b.name, file_data: `data:application/pdf;base64,${bytes.toString('base64')}` } })
        }
      }
    }
    for (const b of t.blocks) {
      switch (b.t) {
        case 'text':
          if (b.text) parts.push({ type: 'text', text: b.text })
          break
        case 'image': {
          const bytes = p.caps.vision ? att.bytes(b.sha) : null
          if (bytes) parts.push({ type: 'image_url', image_url: { url: `data:${b.mime};base64,${bytes.toString('base64')}` } })
          else parts.push({ type: 'text', text: imagePlaceholder(b) })
          break
        }
        case 'file_text':
          if (!nativePdf.has(b.sha)) parts.push({ type: 'text', text: fileText(b, att) })
          break
        case 'memory_result':
          parts.push({ type: 'text', text: b.text })
          break
        case 'system_note':
          parts.push({ type: 'text', text: noteAsText(b.text) })
          break
        case 'tool_result':
          parts.push({ type: 'text', text: b.text })
          break
        default:
          break
      }
    }
    return parts
  }

  const notesOf = (t: CanonTurn): string[] => t.blocks.flatMap((b) => (b.t === 'system_note' ? [b.text] : []))

  for (let i = 0; i < req.turns.length; i++) {
    const t = req.turns[i]
    if (t.role === 'user') {
      const parts = userParts(t)
      const notes: string[] = []
      while (i + 1 < req.turns.length && req.turns[i + 1].role === 'system') notes.push(...notesOf(req.turns[++i]))
      if (!systemRole) for (const n of notes) parts.push({ type: 'text', text: noteAsText(n) })
      if (parts.length) messages.push({ role: 'user', content: textOnly(parts) })
      if (systemRole && notes.length) messages.push({ role: 'system', content: notes.join('\n\n') })
    } else if (t.role === 'system') {
      const notes = notesOf(t)
      if (notes.length) messages.push(systemRole ? { role: 'system', content: notes.join('\n\n') } : { role: 'user', content: notes.map(noteAsText).join('\n\n') })
    } else if (t.role === 'assistant') {
      const msg: Json = { role: 'assistant' }
      let text = ''
      const calls: Json[] = []
      const extras: Json[] = []
      for (const b of t.blocks) {
        if (b.t === 'text') {
          text += b.text
          if (b.extra && echo(b.extra.echoKey, t.id)) extras.push(b.extra.data as Json)
        } else if (b.t === 'tool_call') {
          if (native) {
            const call: Json = { id: idOf(b.id), type: 'function', function: { name: b.name, arguments: djson(b.input) } }
            if (b.extra && echo(b.extra.echoKey, t.id) && b.extra.data && typeof b.extra.data === 'object') Object.assign(call, b.extra.data)
            calls.push(call)
          } else text += `${text && !text.endsWith('\n') ? '\n' : ''}${bracketCall(b.name, b.input)}`
        } else if (b.t === 'reasoning' && echo(b.echoKey, t.id) && b.payload && typeof b.payload === 'object') {
          extras.push(b.payload as Json)
        }
      }
      if (!text && !calls.length) continue
      msg.content = text || (calls.length ? null : '')
      for (const x of extras) for (const k of Object.keys(x).sort()) msg[k] = x[k]
      if (calls.length) msg.tool_calls = calls
      messages.push(msg)
    } else if (t.role === 'tool') {
      const texts: string[] = []
      for (const b of t.blocks) {
        if (b.t === 'tool_result') {
          if (native) messages.push({ role: 'tool', tool_call_id: idOf(b.id), content: b.isError ? `[error] ${b.text}` : b.text })
          else texts.push(b.text)
        } else if (b.t === 'memory_result') texts.push(b.text)
      }
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n\n') })
    }
  }

  const body: Json = { model: req.model, messages }
  if (native && req.tools.length) {
    body.tools = req.tools.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } }))
  }
  body[p.preset.maxTokensField] = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.effort) {
    if (p.preset.id === 'openrouter') body.reasoning = { effort: req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort }
    else body.reasoning_effort = req.effort
  }
  if (p.preset.id === 'openrouter') {
    // 07 B18: never route to hosts that train on prompts unless the profile allows it; ZDR when chosen.
    const provider: Json = {}
    if (p.options.openrouterNoTraining) provider.data_collection = 'deny'
    if (p.options.openrouterZdr) provider.zdr = true
    if (Object.keys(provider).length) body.provider = provider
  }
  body.stream = true
  if (p.preset.sendStreamUsage) body.stream_options = { include_usage: true }
  return body
}

// ── Streaming ──────────────────────────────────────────────────────────────────────────────────
interface ToolAcc {
  id: string
  name: string
  args: string
  extra: Json | null
}

class Acc {
  text = ''
  reasoningField: 'reasoning_content' | 'reasoning' | null = null
  reasoning = ''
  details: unknown[] = []
  messageExtra: Json | null = null
  tools = new Map<number, ToolAcc>()
  finish: string | null = null
  /** The stream ended on its own (some local servers never send a finish_reason). */
  ended = false
  usage: Usage = {}

  /** A whole (non-stream) chat.completion, from a server that ignored `stream: true` (F63): the same events. */
  public *fromJson(j: Json): Generator<LlmEvent> {
    const choice = (Array.isArray(j.choices) ? j.choices[0] : undefined) as Json | undefined
    const m = (choice?.message ?? {}) as Json
    const u = j.usage as Json | undefined | null
    if (u) {
      this.usage = { in: Number(u.prompt_tokens ?? 0), out: Number(u.completion_tokens ?? 0) }
      yield { type: 'usage', usage: { ...this.usage } }
    }
    for (const f of ['reasoning_content', 'reasoning'] as const) {
      const r = m[f]
      if (typeof r === 'string' && r) {
        this.reasoningField ??= f
        this.reasoning += r
        yield { type: 'reasoning', text: r }
      }
    }
    if (typeof m.content === 'string' && m.content) {
      this.text += m.content
      yield { type: 'text', text: m.content }
    }
    const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as Json[]) : []
    for (let i = 0; i < calls.length; i++) {
      const fn = (calls[i].function ?? {}) as Json
      const c: ToolAcc = { id: typeof calls[i].id === 'string' ? (calls[i].id as string) : '', name: typeof fn.name === 'string' ? fn.name : '', args: typeof fn.arguments === 'string' ? fn.arguments : '', extra: null }
      this.tools.set(i, c)
      if (c.id && c.name) yield { type: 'tool_start', id: c.id, name: c.name }
    }
    if (typeof choice?.finish_reason === 'string') this.finish = choice.finish_reason
    this.ended = true
  }

  result(p: ResolvedProfile): RoundResult {
    const blocks: WireBlock[] = []
    if (this.reasoning || this.details.length) {
      const payload: Json = {}
      if (this.reasoning) payload[this.reasoningField ?? 'reasoning_content'] = this.reasoning
      if (this.details.length) payload.reasoning_details = this.details
      blocks.push({ t: 'reasoning', echoKey: p.echoKey, payload })
    }
    const finished = this.finish !== null || this.ended
    if (finished && this.text) {
      const b: WireBlock = { t: 'text', text: this.text }
      if (this.messageExtra) b.extra = { echoKey: p.echoKey, data: this.messageExtra } satisfies Extra
      blocks.push(b)
    }
    if (finished) {
      for (const [, c] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
        if (!c.id || !c.name) continue
        let input: Record<string, unknown> = {}
        try {
          const v: unknown = c.args.trim() ? JSON.parse(c.args) : {}
          if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>
        } catch {
          input = { _invalid: c.args.slice(0, 2000) }
        }
        const b: WireBlock = { t: 'tool_call', id: c.id, name: c.name as MemoryFunctionName, input }
        if (c.extra) b.extra = { echoKey: p.echoKey, data: c.extra }
        blocks.push(b)
      }
    }
    return { blocks, partialText: finished ? '' : this.text, stopReason: mapFinish(this.finish ?? (this.ended ? (this.tools.size ? 'tool_calls' : 'stop') : null)), usage: { ...this.usage } }
  }
}

function mapFinish(f: string | null): StopReason | null {
  switch (f) {
    case null:
      return null
    case 'stop':
      return 'end'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'error':
      return 'error'
    default:
      return 'other'
  }
}

const strip = (s: unknown): string => (typeof s === 'string' ? s : '')

/**
 * OpenRouter streams `reasoning_details` as fragments keyed by `index`; they must be echoed back as the complete
 * blocks the model produced (research 01 §2.1), so fragments of one index are joined (string fields appended).
 */
export function mergeDetails(into: unknown[], incoming: unknown[]): void {
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Json
    const at = typeof d.index === 'number' ? into.findIndex((x) => (x as Json).index === d.index) : -1
    if (at < 0) {
      into.push({ ...d })
      continue
    }
    const cur = into[at] as Json
    for (const [k, v] of Object.entries(d)) {
      if (k === 'index' || k === 'type') continue
      cur[k] = typeof v === 'string' && typeof cur[k] === 'string' ? `${cur[k] as string}${v}` : v
    }
  }
}

export function createOpenaiAdapter(p: ResolvedProfile): LlmAdapter {
  const client = (): OpenAI =>
    new OpenAI({
      apiKey: p.key ?? 'unused',
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: p.requestBaseUrl,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
      fetch: guardedFetch(),
      defaultHeaders: p.headers
    })

  return {
    render: (req, att) => renderOpenai(p, req, att),

    stream(req, att, signal): LlmStream {
      const acc = new Acc()
      const body = renderOpenai(p, req, att)
      async function* run(): AsyncGenerator<LlmEvent> {
        // The SDK sends the body verbatim (unknown keys included), so this object IS the request bytes.
        const { data, response } = await client().chat.completions.create(body as unknown as OpenAI.ChatCompletionCreateParamsStreaming, { signal }).withResponse()
        const kind = answerKind(response)
        if (kind === 'html') throw notAnApi(response)
        if (kind === 'json') {
          yield* acc.fromJson((await response.json()) as Json)
          return
        }
        const stream = data as unknown as AsyncIterable<Json>
        const started = new Set<number>()
        for await (const chunk of stream) {
          const usage = chunk.usage as Json | undefined | null
          if (usage) {
            const pd = (usage.prompt_tokens_details ?? {}) as Json
            const cd = (usage.completion_tokens_details ?? {}) as Json
            acc.usage = { in: Number(usage.prompt_tokens ?? 0), out: Number(usage.completion_tokens ?? 0) }
            if (typeof pd.cached_tokens === 'number' && pd.cached_tokens) acc.usage.cacheRead = pd.cached_tokens
            if (typeof cd.reasoning_tokens === 'number' && cd.reasoning_tokens) acc.usage.reasoning = cd.reasoning_tokens
            yield { type: 'usage', usage: { ...acc.usage } }
          }
          const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Json | undefined
          if (!choice) continue
          const d = (choice.delta ?? {}) as Json
          // Content: a string, or (Mistral) an array of text / thinking chunks.
          if (typeof d.content === 'string' && d.content) {
            acc.text += d.content
            yield { type: 'text', text: d.content }
          } else if (Array.isArray(d.content)) {
            for (const part of d.content as Json[]) {
              if (part.type === 'text' && typeof part.text === 'string') {
                acc.text += part.text
                yield { type: 'text', text: part.text }
              } else if (part.type === 'thinking') {
                const t = Array.isArray(part.thinking) ? (part.thinking as Json[]).map((x) => strip(x.text)).join('') : strip(part.thinking)
                if (t) {
                  acc.reasoning += t
                  acc.reasoningField ??= 'reasoning_content'
                  yield { type: 'reasoning', text: t }
                }
              }
            }
          }
          for (const f of ['reasoning_content', 'reasoning'] as const) {
            const r = d[f]
            if (typeof r === 'string' && r) {
              acc.reasoningField ??= f
              acc.reasoning += r
              yield { type: 'reasoning', text: r }
            }
          }
          if (Array.isArray(d.reasoning_details)) mergeDetails(acc.details, d.reasoning_details as unknown[])
          if (d.extra_content && typeof d.extra_content === 'object') acc.messageExtra = { extra_content: d.extra_content }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls as Json[]) {
              const index = typeof tc.index === 'number' ? tc.index : 0
              const fn = (tc.function ?? {}) as Json
              let c = acc.tools.get(index)
              if (!c) {
                c = { id: '', name: '', args: '', extra: null }
                acc.tools.set(index, c)
              }
              if (typeof tc.id === 'string' && tc.id) c.id = tc.id
              if (typeof fn.name === 'string' && fn.name && !c.name) c.name = fn.name
              if (typeof fn.arguments === 'string') c.args += fn.arguments
              if (tc.extra_content && typeof tc.extra_content === 'object') c.extra = { extra_content: tc.extra_content }
              if (c.id && c.name && !started.has(index)) {
                started.add(index)
                yield { type: 'tool_start', id: c.id, name: c.name }
              }
            }
          }
          if (typeof choice.finish_reason === 'string') acc.finish = choice.finish_reason
        }
        // An aborted openai stream ends the loop quietly instead of throwing (research 01 §3.3).
        if (!signal.aborted) acc.ended = true
      }
      return { events: run(), result: () => acc.result(p) }
    },

    async listModels(signal): Promise<ModelInfo[]> {
      const base = p.requestBaseUrl.replace(/\/$/, '')
      const body = await getJson(`${base}/models`, rawAuthHeaders(p), signal)
      const list: unknown[] = Array.isArray(body) ? body : Array.isArray((body as Json | null)?.data) ? ((body as Json).data as unknown[]) : []
      const out: ModelInfo[] = []
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Json
        if (typeof m.id !== 'string') continue
        const info: ModelInfo = { id: m.id }
        if (typeof m.name === 'string') info.label = m.name
        // OpenRouter: context_length, supported_parameters, architecture.input_modalities (research 01 §3.8).
        if (typeof m.context_length === 'number') info.contextWindow = m.context_length
        const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : null
        const mods = Array.isArray((m.architecture as Json | undefined)?.input_modalities) ? ((m.architecture as Json).input_modalities as unknown[]) : null
        if (params || mods) {
          info.caps = {}
          if (params) {
            info.caps.tools = params.includes('tools')
            info.caps.reasoning = params.includes('reasoning')
          }
          if (mods) {
            info.caps.vision = mods.includes('image')
            info.caps.pdf = mods.includes('file')
          }
        }
        out.push(info)
      }
      return out.sort((a, b) => a.id.localeCompare(b.id))
    }
  }
}
