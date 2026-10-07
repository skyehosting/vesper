/** Memory status in words (pure: shared by the settings page, the viewer and `/memory status`). */
import type { Endpoints } from '@shared/api'
import type { MemoryStatus } from '@shared/types/domain'
/** The kit StatusDot's states (components/StatusDot.tsx); repeated here so this file stays DOM-free. */
type Status = 'online' | 'idle' | 'busy' | 'warning' | 'error' | 'offline' | 'live'
import { formatCount, formatDuration, formatUsd, plural } from './format.logic'

const STATE_TEXT: Record<MemoryStatus['state'], { text: string; dot: Status }> = {
  disabled: { text: 'Off', dot: 'offline' },
  'keyword-only': { text: 'Keyword search only', dot: 'idle' },
  loading: { text: 'Loading the index…', dot: 'busy' },
  ready: { text: 'Ready', dot: 'online' },
  degraded: { text: 'Working, with problems', dot: 'warning' },
  error: { text: 'Not working', dot: 'error' }
}

export function statusText(s: MemoryStatus | null): { text: string; dot: Status } {
  if (!s) return { text: 'Checking…', dot: 'idle' }
  const base = STATE_TEXT[s.state]
  if (s.state === 'ready' && s.queued > 0) return { text: `Indexing · ${formatCount(s.queued)} waiting`, dot: 'busy' }
  return base
}

// ── backfill consent (07 C12) ──
export type BackfillEstimate = Endpoints['GET /api/memory/backfill/estimate']['res']
/** Voyage's free allowance for the voyage-4 series (research 02 §2.8). */
export const FREE_TOKENS = 200_000_000

export function backfillQuestion(e: BackfillEstimate): string {
  return `Index ${plural(e.messages, 'message')} from ${plural(e.sessions, 'chat')}?`
}

export function backfillDetail(e: BackfillEstimate): string {
  const cost = e.estUsd > 0 ? `~${formatUsd(e.estUsd)}${e.estTokens <= FREE_TOKENS ? ' (likely within your free tokens)' : ''}` : 'no cost'
  return `About ${formatCount(e.estTokens)} tokens, ${cost}, ${formatDuration(e.estSeconds)} at your current rate limit. Private and temporary chats are never sent.`
}
