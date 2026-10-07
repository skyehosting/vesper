/**
 * Speech of one reply as seen by this client — frozen signature (07 E4) shared by chat-ui (renders + registers the
 * reveal root) and voice-client (owns the body: binary kind-1 frames → AudioEngine, speech.* events).
 *
 * Synced reveal (R14): when this client asked for speech, the server sends it no reply.delta; each chunk's markdown
 * arrives in `SpeechChunkHeader.text` together with its audio, so `heldText` grows chunk by chunk and chat-ui renders
 * exactly that, revealed by the RevealController. When speech degrades or fails, the server sends this client a
 * targeted `reply.snapshot` with the full text so far and normal deltas resume (`state` becomes 'failed' and
 * `heldText` null) — chat-ui then renders the reply like any text reply.
 *
 * The state machine is in speech.logic.ts; speechClient.ts feeds it and writes `store.speech[replyId]`.
 */
import { useStore } from '../../lib/store'
import { NO_SPEECH, type ReplySpeech } from './speech.logic'

export type { ReplySpeech, ReplySpeechState } from './speech.logic'

export function useReplySpeech(replyId: string | null): ReplySpeech {
  return useStore((s) => (replyId ? (s.speech[replyId] ?? NO_SPEECH) : NO_SPEECH))
}

/** "Speak again" of a stored message: the replay's replyId (while it is known) and its speech. */
export function useMessageReplay(messageUid: string | null | undefined): { replyId: string | null; speech: ReplySpeech } {
  const replyId = useStore((s) => (messageUid ? (s.replays[messageUid] ?? null) : null))
  const speech = useReplySpeech(replyId)
  return { replyId, speech }
}
