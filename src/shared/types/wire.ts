/**
 * Canonical, provider-neutral wire transcript blocks (03 §1.2, 07 C2/C7/C8/B7). Stored as deterministic JSON
 * (djson) in `transcript.blocks` and rendered by adapters to provider formats purely: the same blocks always produce
 * the same request bytes, which Anthropic preserved thinking and prompt caching require.
 */

/** Provider-opaque data echoed back only when the target matches `echoKey` (e.g. Gemini thought signatures). */
export interface Extra {
  echoKey: string
  data: unknown
}

export type WireBlock =
  | { t: 'text'; text: string; extra?: Extra }
  | { t: 'image'; sha: string; mime: string; name: string; width: number; height: number }
  | { t: 'document'; sha: string; mime: 'application/pdf'; name: string }
  /** Extracted text of an attachment (always present next to a document, or alone for docx/txt). */
  | { t: 'file_text'; sha: string; name: string }
  | { t: 'tool_call'; id: string; name: MemoryFunctionName; input: Record<string, unknown>; extra?: Extra }
  | { t: 'tool_result'; id: string; text: string; isError?: boolean }
  /** Opaque reasoning payload (Anthropic thinking+signature, DeepSeek reasoning_content, OpenRouter reasoning_details). */
  | { t: 'reasoning'; echoKey: string; payload: unknown }
  /** Recalled records / recap rendered by `untrusted()` — data, never instructions (07 B7). */
  | { t: 'memory_result'; text: string }
  /** Appended operator instruction (state changes, prompt updates, manifests, interruption notes, regenerate clock). */
  | { t: 'system_note'; text: string }

export type MemoryFunctionName = 'memory_search' | 'memory_recall' | 'memory_sessions'

export type WireRole = 'user' | 'assistant' | 'tool' | 'system'

export interface WireTurn {
  /** transcript.id */
  id: number
  messageUid: string
  part: number
  role: WireRole
  blocks: WireBlock[]
  provider: string | null
  model: string | null
}

/** What an epoch freezes (07 C1): the exact system blocks and tool definitions sent for its whole life. */
export interface EpochSnapshot {
  id: number
  sessionUid: string
  startMessageUid: string
  system: { text: string }[]
  tools: unknown[]
  protocolsHash: string
  toolsVersion: number
  toolMode: 'native' | 'text'
  recap: string | null
  thinkingStripBefore: number | null
}
