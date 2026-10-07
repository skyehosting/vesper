/**
 * The provider-neutral contract between the chat engine and the two LLM adapters (research 01 §4.1). The engine works
 * only in canonical wire blocks (shared/types/wire.ts); an adapter renders them into its provider's request bytes
 * purely (same input → same bytes, 07 C1/C7) and turns the provider's stream back into canonical blocks.
 */
import type { Preset } from '@shared/presets'
import type { LlmProfile } from '@shared/settings'
import type { ModelInfo, ToolMode, Usage } from '@shared/types/domain'
import type { WireBlock, WireRole } from '@shared/types/wire'

/** A canonical tool definition as frozen in `epochs.tools_json` (07 C1). */
export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** A profile with everything a request needs resolved: preset, effective URL, key, headers, capabilities. */
export interface ResolvedProfile {
  id: string
  label: string
  preset: Preset
  adapter: 'openai' | 'anthropic'
  /** The configured base URL (the key is bound to its origin, 07 B1). */
  baseUrl: string
  /** Where requests go: the configured URL, or the mock origin in test mode (05 §2). */
  requestBaseUrl: string
  model: string
  /** The API key, or null for key-less presets (local servers, custom URLs without a key). */
  key: string | null
  /** Extra headers (custom auth header from `llm-header:<id>`). A null value removes an SDK default. */
  headers: Record<string, string | null>
  options: LlmProfile['options']
  caps: { tools: boolean; vision: boolean; pdf: boolean; contextWindow: number }
  /** Provider-opaque extras/reasoning are echoed only to targets with the same key (07 C7). */
  echoKey: string
}

/** One transcript row as the adapters see it. `id` orders rows; it is compared with the thinking-strip watermark. */
export interface CanonTurn {
  id: number
  role: WireRole
  blocks: WireBlock[]
}

export interface LlmRequest {
  model: string
  system: { text: string }[]
  tools: ToolDef[]
  toolMode: ToolMode
  turns: CanonTurn[]
  maxTokens: number
  effort?: LlmProfile['options']['effort']
  temperature?: number
  reasoningDisplay: 'hidden' | 'summarized'
  /** Reasoning blocks of rows with id < this are dropped (07 C5). */
  stripThinkingBefore: number | null
  /** Utility requests (titles, recaps) ask for no thinking where the model allows it. */
  utility?: boolean
}

/** Reads attachment bytes/text for rendering (07 C8). Bytes are frozen at ingestion, so replay stays byte-exact. */
export interface AttachmentSource {
  bytes(sha: string): Buffer | null
  text(sha: string): string | null
  /** Deterministic per-attachment boundary for the untrusted() wrapper (07 B7). */
  boundary(sha: string): string
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' | 'aborted' | 'other'

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'usage'; usage: Usage }

/** What a round produced, valid at any moment (also after an abort): only complete blocks (07 C6). */
export interface RoundResult {
  /** Complete canonical blocks in order (reasoning with signatures, finished text blocks, complete tool calls). */
  blocks: WireBlock[]
  /** Text of a text block that was still streaming (kept only for stopped replies). */
  partialText: string
  stopReason: StopReason | null
  usage: Usage
}

export interface LlmStream {
  events: AsyncIterable<LlmEvent>
  result(): RoundResult
}

export interface LlmAdapter {
  /** Render the provider request body (pure; exported for byte-stability tests). */
  render(req: LlmRequest, att: AttachmentSource): Record<string, unknown>
  stream(req: LlmRequest, att: AttachmentSource, signal: AbortSignal): LlmStream
  listModels(signal: AbortSignal): Promise<ModelInfo[]>
}
