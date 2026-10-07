/**
 * Anthropic Messages adapter (@anthropic-ai/sdk 0.131.0; research 01 §2.2/§2.3).
 *
 * Rendering (07 C1/C5/C7): `system` = the epoch's frozen text blocks (cache breakpoint on the last), `tools` = the
 * frozen definitions, then the transcript replayed block for block. Thinking blocks (with their signatures) go back
 * unmodified to the same model only, and never for rows below the epoch's strip watermark. A system_note is a
 * mid-conversation `{role:'system'}` message where the model accepts one (it must follow a user turn and be last or
 * followed by an assistant turn), else a user text block. Adaptive thinking + effort on models that support them.
 * Streaming is read from raw events so partial state is known at every moment (07 C6).
 */
import Anthropic from '@anthropic-ai/sdk'
import type { ModelInfo, Usage } from '@shared/types/domain'
import type { MemoryFunctionName, WireBlock } from '@shared/types/wire'
import { answerKind, getJson, guardedFetch, notAnApi, rawAuthHeaders, REQUEST_TIMEOUT_MS } from './client'
import { anthropicAdaptive, anthropicSystemRole, bracketCall, fileText, imagePlaceholder, noteAsText } from './render'
import type { AttachmentSource, CanonTurn, LlmAdapter, LlmEvent, LlmRequest, LlmStream, ResolvedProfile, RoundResult, StopReason } from './types'

type Json = Record<string, unknown>

export function renderAnthropic(p: ResolvedProfile, req: LlmRequest, att: AttachmentSource): Json {
  const native = req.toolMode === 'native'
  const systemRole = anthropicSystemRole(req.model)
  const echo = (key: string, rowId: number): boolean => key === p.echoKey && (req.stripThinkingBefore === null || rowId >= req.stripThinkingBefore)
  const messages: Json[] = []

  const userContent = (t: CanonTurn): Json[] => {
    const out: Json[] = []
    const nativePdf = new Set<string>()
    for (const b of t.blocks) {
      switch (b.t) {
        case 'text':
          if (b.text) out.push({ type: 'text', text: b.text })
          break
        case 'image': {
          const bytes = p.caps.vision ? att.bytes(b.sha) : null
          if (bytes) out.push({ type: 'image', source: { type: 'base64', media_type: b.mime, data: bytes.toString('base64') } })
          else out.push({ type: 'text', text: imagePlaceholder(b) })
          break
        }
        case 'document': {
          const bytes = p.caps.pdf ? att.bytes(b.sha) : null
          if (bytes) {
            nativePdf.add(b.sha)
            out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: b.name })
          }
          break
        }
        case 'file_text':
          if (!nativePdf.has(b.sha)) out.push({ type: 'text', text: fileText(b, att) })
          break
        case 'memory_result':
          if (b.text) out.push({ type: 'text', text: b.text })
          break
        case 'system_note':
          out.push({ type: 'text', text: noteAsText(b.text) })
          break
        case 'tool_result':
          out.push({ type: 'tool_result', tool_use_id: b.id, content: b.text || '(empty)', ...(b.isError ? { is_error: true } : {}) })
          break
        default:
          break
      }
    }
    return out
  }

  const notesOf = (t: CanonTurn): string[] => t.blocks.flatMap((b) => (b.t === 'system_note' ? [b.text] : []))

  for (let i = 0; i < req.turns.length; i++) {
    const t = req.turns[i]
    if (t.role === 'user' || t.role === 'tool') {
      const content = userContent(t)
      if (!native && t.role === 'tool') {
        // Text mode: results arrive as user text (tool_result → plain text).
        for (let k = 0; k < content.length; k++) if (content[k].type === 'tool_result') content[k] = { type: 'text', text: String(content[k].content) }
      }
      const notes: string[] = []
      while (i + 1 < req.turns.length && req.turns[i + 1].role === 'system') notes.push(...notesOf(req.turns[++i]))
      // A system message must be last or followed by an assistant turn; otherwise it rides in the user turn.
      const next = req.turns[i + 1]
      const asRole = systemRole && notes.length > 0 && (next === undefined || next.role === 'assistant')
      if (!asRole) for (const n of notes) content.push({ type: 'text', text: noteAsText(n) })
      if (content.length) messages.push({ role: 'user', content })
      if (asRole) messages.push({ role: 'system', content: notes.join('\n\n') })
    } else if (t.role === 'system') {
      const notes = notesOf(t)
      if (notes.length) messages.push({ role: 'user', content: notes.map((n) => ({ type: 'text', text: noteAsText(n) })) })
    } else if (t.role === 'assistant') {
      const content: Json[] = []
      for (const b of t.blocks) {
        if (b.t === 'reasoning') {
          if (echo(b.echoKey, t.id) && b.payload && typeof b.payload === 'object') content.push(b.payload as Json)
        } else if (b.t === 'text') {
          if (b.text) content.push({ type: 'text', text: b.text })
        } else if (b.t === 'tool_call') {
          if (native) content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
          else content.push({ type: 'text', text: bracketCall(b.name, b.input) })
        }
      }
      // Thinking alone is not a turn (e.g. another model's thinking was dropped).
      if (content.some((c) => c.type !== 'thinking' && c.type !== 'redacted_thinking')) messages.push({ role: 'assistant', content })
    }
  }

  // Cache breakpoints (moving them never changes the cached prefix): the last system block and the last content block
  // of the last user/assistant message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content
    if (Array.isArray(c) && c.length) {
      const last = c[c.length - 1] as Json
      if (last.type !== 'thinking' && last.type !== 'redacted_thinking') c[c.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
      break
    }
  }
  const system = req.system
    .filter((s) => s.text)
    .map((s, i, all) => (i === all.length - 1 ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: s.text }))

  const body: Json = { model: req.model, max_tokens: req.maxTokens }
  if (system.length) body.system = system
  if (native && req.tools.length) body.tools = req.tools.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }))
  body.messages = messages
  const adaptive = anthropicAdaptive(req.model)
  if (adaptive && !req.utility) body.thinking = { type: 'adaptive', display: req.reasoningDisplay === 'summarized' ? 'summarized' : 'omitted' }
  if (adaptive && (req.effort || req.utility)) body.output_config = { effort: req.effort ?? 'low' }
  if (req.temperature !== undefined && !adaptive) body.temperature = req.temperature
  body.stream = true
  return body
}

// ── Streaming ──────────────────────────────────────────────────────────────────────────────────
interface BlockAcc {
  type: string
  text: string
  signature: string
  data: string
  id: string
  name: string
  json: string
  done: boolean
}

class Acc {
  blocks = new Map<number, BlockAcc>()
  stop: string | null = null
  usage: Usage = {}

  /** A whole (non-stream) message, from a server that ignored `stream: true` (F63): the same events. */
  public *fromJson(j: Json): Generator<LlmEvent> {
    const u = (j.usage ?? {}) as Json
    this.usage = { in: Number(u.input_tokens ?? 0), out: Number(u.output_tokens ?? 0) }
    const content = Array.isArray(j.content) ? (j.content as Json[]) : []
    for (let i = 0; i < content.length; i++) {
      const cb = content[i]
      const b: BlockAcc = { type: String(cb.type), text: '', signature: '', data: '', id: '', name: '', json: '', done: true }
      if (cb.type === 'text' && typeof cb.text === 'string') b.text = cb.text
      if (cb.type === 'thinking') {
        b.text = typeof cb.thinking === 'string' ? cb.thinking : ''
        b.signature = typeof cb.signature === 'string' ? cb.signature : ''
      }
      if (cb.type === 'redacted_thinking') b.data = typeof cb.data === 'string' ? cb.data : ''
      if (cb.type === 'tool_use') {
        b.id = String(cb.id ?? '')
        b.name = String(cb.name ?? '')
        b.json = JSON.stringify(cb.input ?? {})
      }
      this.blocks.set(i, b)
      if (b.type === 'text' && b.text) yield { type: 'text', text: b.text }
      if (b.type === 'thinking' && b.text) yield { type: 'reasoning', text: b.text }
      if (b.type === 'tool_use') yield { type: 'tool_start', id: b.id, name: b.name }
    }
    if (typeof j.stop_reason === 'string') this.stop = j.stop_reason
    yield { type: 'usage', usage: { ...this.usage } }
  }

  result(p: ResolvedProfile): RoundResult {
    const out: WireBlock[] = []
    let partialText = ''
    for (const [, b] of [...this.blocks.entries()].sort((a, c) => a[0] - c[0])) {
      if (b.type === 'thinking') {
        // Unsigned thinking can never be replayed (07 C6).
        if (b.done && b.signature) out.push({ t: 'reasoning', echoKey: p.echoKey, payload: { type: 'thinking', thinking: b.text, signature: b.signature } })
      } else if (b.type === 'redacted_thinking') {
        if (b.done && b.data) out.push({ t: 'reasoning', echoKey: p.echoKey, payload: { type: 'redacted_thinking', data: b.data } })
      } else if (b.type === 'text') {
        if (b.done) {
          if (b.text) out.push({ t: 'text', text: b.text })
        } else partialText += b.text
      } else if (b.type === 'tool_use') {
        if (!b.done) continue
        let input: Record<string, unknown> = {}
        try {
          const v: unknown = b.json.trim() ? JSON.parse(b.json) : {}
          if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>
        } catch {
          continue
        }
        out.push({ t: 'tool_call', id: b.id, name: b.name as MemoryFunctionName, input })
      }
    }
    return { blocks: out, partialText, stopReason: mapStop(this.stop), usage: { ...this.usage } }
  }
}

function mapStop(s: string | null): StopReason | null {
  switch (s) {
    case null:
      return null
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

export function createAnthropicAdapter(p: ResolvedProfile): LlmAdapter {
  const client = (): Anthropic =>
    new Anthropic({
      apiKey: p.key,
      authToken: null,
      baseURL: p.requestBaseUrl,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
      fetch: guardedFetch(),
      defaultHeaders: p.headers
    })

  return {
    render: (req, att) => renderAnthropic(p, req, att),

    stream(req, att, signal): LlmStream {
      const acc = new Acc()
      const body = renderAnthropic(p, req, att)
      async function* run(): AsyncGenerator<LlmEvent> {
        const { data, response } = await client().messages.create(body as unknown as Anthropic.MessageCreateParamsStreaming, { signal }).withResponse()
        const kind = answerKind(response)
        if (kind === 'html') throw notAnApi(response)
        if (kind === 'json') {
          yield* acc.fromJson((await response.json()) as Json)
          return
        }
        const stream = data as unknown as AsyncIterable<Json>
        for await (const ev of stream) {
          switch (ev.type) {
            case 'message_start': {
              const u = ((ev.message as Json | undefined)?.usage ?? {}) as Json
              acc.usage.in = Number(u.input_tokens ?? 0)
              if (typeof u.cache_read_input_tokens === 'number' && u.cache_read_input_tokens) acc.usage.cacheRead = u.cache_read_input_tokens
              if (typeof u.cache_creation_input_tokens === 'number' && u.cache_creation_input_tokens) acc.usage.cacheWrite = u.cache_creation_input_tokens
              break
            }
            case 'content_block_start': {
              const cb = (ev.content_block ?? {}) as Json
              const b: BlockAcc = { type: String(cb.type), text: '', signature: '', data: '', id: '', name: '', json: '', done: false }
              if (cb.type === 'text') b.text = typeof cb.text === 'string' ? cb.text : ''
              if (cb.type === 'thinking') {
                b.text = typeof cb.thinking === 'string' ? cb.thinking : ''
                b.signature = typeof cb.signature === 'string' ? cb.signature : ''
              }
              if (cb.type === 'redacted_thinking') b.data = typeof cb.data === 'string' ? cb.data : ''
              if (cb.type === 'tool_use') {
                b.id = String(cb.id ?? '')
                b.name = String(cb.name ?? '')
              }
              acc.blocks.set(Number(ev.index), b)
              if (cb.type === 'text' && b.text) yield { type: 'text', text: b.text }
              if (cb.type === 'tool_use') yield { type: 'tool_start', id: b.id, name: b.name }
              break
            }
            case 'content_block_delta': {
              const b = acc.blocks.get(Number(ev.index))
              const d = (ev.delta ?? {}) as Json
              if (!b) break
              if (d.type === 'text_delta' && typeof d.text === 'string') {
                b.text += d.text
                yield { type: 'text', text: d.text }
              } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
                b.text += d.thinking
                yield { type: 'reasoning', text: d.thinking }
              } else if (d.type === 'signature_delta' && typeof d.signature === 'string') b.signature += d.signature
              else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') b.json += d.partial_json
              break
            }
            case 'content_block_stop': {
              const b = acc.blocks.get(Number(ev.index))
              if (b) b.done = true
              break
            }
            case 'message_delta': {
              const d = (ev.delta ?? {}) as Json
              if (typeof d.stop_reason === 'string') acc.stop = d.stop_reason
              const u = (ev.usage ?? {}) as Json
              if (typeof u.output_tokens === 'number') acc.usage.out = u.output_tokens
              yield { type: 'usage', usage: { ...acc.usage } }
              break
            }
            default:
              break
          }
        }
      }
      return { events: run(), result: () => acc.result(p) }
    },

    async listModels(signal): Promise<ModelInfo[]> {
      const base = p.requestBaseUrl.replace(/\/$/, '')
      const body = (await getJson(`${base}/v1/models?limit=1000`, rawAuthHeaders(p), signal)) as Json | null
      const list = Array.isArray(body?.data) ? (body.data as Json[]) : []
      const sup = (v: unknown): boolean | undefined => (v && typeof v === 'object' && typeof (v as Json).supported === 'boolean' ? ((v as Json).supported as boolean) : undefined)
      return list
        .filter((m) => typeof m.id === 'string')
        .map((m) => {
          const caps = (m.capabilities ?? null) as Json | null
          const info: ModelInfo = { id: String(m.id), contextWindow: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : null, maxOutput: typeof m.max_tokens === 'number' ? m.max_tokens : null }
          if (typeof m.display_name === 'string') info.label = m.display_name
          info.caps = { tools: true }
          if (caps) {
            const v = sup(caps.image_input)
            const pdf = sup(caps.pdf_input)
            const th = sup(caps.thinking)
            if (v !== undefined) info.caps.vision = v
            if (pdf !== undefined) info.caps.pdf = pdf
            if (th !== undefined) info.caps.reasoning = th
          }
          return info
        })
    }
  }
}
