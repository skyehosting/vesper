/**
 * Reply finalization rules for one provider round (07 C6): only complete blocks are persisted — signed thinking,
 * finished text, complete tool calls. A stopped round keeps its partial text; a complete tool call that will never get
 * a real result gets a synthetic error result, so the next request is always valid. Pure, so every abort point can be
 * tested.
 */
import type { WireBlock } from '@shared/types/wire'
import type { RoundResult } from '../providers/llm/types'

export type ToolCallBlock = Extract<WireBlock, { t: 'tool_call' }>

export interface FinalRound {
  /** The assistant row to persist, or null when nothing replayable came back. */
  assistant: WireBlock[] | null
  toolCalls: ToolCallBlock[]
  /** Synthetic results for tool calls that will not run (stop / error). */
  cancelled: WireBlock[] | null
}

export function finalizeRound(res: RoundResult, o: { stopped: boolean; errored: boolean; cutText?: string }): FinalRound {
  let blocks = res.blocks
  if (o.cutText !== undefined) blocks = [...blocks.filter((b) => b.t !== 'text'), { t: 'text', text: o.cutText }]
  else if (o.stopped && !o.errored && res.partialText) blocks = [...blocks, { t: 'text', text: res.partialText }]
  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.t === 'tool_call')
  const replayable = blocks.some((b) => b.t === 'text' || b.t === 'tool_call')
  const cancelled = (o.stopped || o.errored) && toolCalls.length ? toolCalls.map((c): WireBlock => ({ t: 'tool_result', id: c.id, text: o.errored ? 'cancelled' : 'cancelled by user', isError: true })) : null
  return { assistant: replayable ? blocks : null, toolCalls, cancelled }
}
