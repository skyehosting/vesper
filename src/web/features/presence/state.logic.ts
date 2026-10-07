/**
 * Which state the Star shows (pure; research 07 §2.4 + 07 D6). Priority, highest first:
 *   offline (socket down for a while) · speaking (audio playing here) · warming-up (speech model loading) ·
 *   listening / transcribing (the mic is live and not muted) · preparing-voice · thinking (a reply in progress) ·
 *   error (a reply failed in the last few seconds) · muted (mic muted in Talk mode) · idle.
 * Speaking wins over everything but a lost connection: the voice is the presence.
 */
import type { ReplyState } from '@shared/types/domain'
import type { StarState } from '../../lib/store/presence.logic'

/** The voice slice's `stt` (structurally the same as SttUiState; not imported, so this file stays store-free). */
export type SttLike = 'idle' | 'warming-up' | 'listening' | 'transcribing' | 'error'

export interface StarInputs {
  /** The socket has been down long enough to say so (the banner's own delay). */
  offline: boolean
  /** Audio of a reply is scheduled or playing on this device. */
  speaking: boolean
  stt: SttLike
  muted: boolean
  /** States of the replies in progress in the sessions this client follows. */
  replies: readonly ReplyState[]
  /** A reply failed recently (ms timestamp), or null. */
  errorAt: number | null
  now: number
}

/** How long a failed reply tints the Star. */
export const ERROR_HOLD_MS = 4000

const WORKING: ReadonlySet<ReplyState> = new Set<ReplyState>(['queued', 'thinking', 'recalling', 'writing', 'summarizing', 'recapping'])

export function deriveStarState(i: StarInputs): StarState {
  if (i.offline) return 'offline'
  if (i.speaking) return 'speaking'
  if (i.stt === 'warming-up') return 'warming-up'
  if (!i.muted && i.stt === 'listening') return 'listening'
  if (!i.muted && i.stt === 'transcribing') return 'transcribing'
  if (i.replies.includes('preparing-voice')) return 'preparing-voice'
  if (i.replies.includes('speaking')) return 'preparing-voice' // the server says speaking; our audio hasn't started
  if (i.replies.some((r) => WORKING.has(r))) return 'thinking'
  if (i.errorAt !== null && i.now - i.errorAt < ERROR_HOLD_MS) return 'error'
  if (i.muted) return 'muted'
  return 'idle'
}

/**
 * Replies whose text is finished (reply.done seen) and that this client speaks, still waiting for their first audio
 * (P02): the Star keeps saying "Preparing voice…" for them. Returns the ids still waiting; the others are dropped.
 */
export function waitingVoices(finished: Iterable<string>, speechState: (replyId: string) => string | undefined): string[] {
  const out: string[] = []
  for (const id of finished) if (speechState(id) === 'waiting') out.push(id)
  return out
}

/** States with live audio levels (the analyser is polled only in these, 07 D4). */
export function isAudioState(s: StarState): boolean {
  return s === 'speaking' || s === 'listening'
}

/** States where something is in progress (thinking-rate frames). */
export function isBusyState(s: StarState): boolean {
  return s === 'thinking' || s === 'preparing-voice' || s === 'transcribing' || s === 'warming-up'
}

/** The words for each state (the canvas is aria-hidden; this text carries the state, 07 D9 / WCAG 1.4.1). */
export const STAR_STATE_TEXT: Record<StarState, string> = {
  idle: 'Here with you',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  'preparing-voice': 'Preparing voice…',
  speaking: 'Speaking',
  muted: 'Microphone muted',
  'warming-up': 'Warming up…',
  error: 'Something went wrong',
  offline: 'Offline'
}
