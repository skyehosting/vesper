/**
 * Voice state shared by the composer, Talk mode and the Star (voice-client, Phase 3).
 *
 *   voice   — what presence / Talk mode / the top bar read (`useVoiceState()`): mic state, live partial, the reply
 *             whose audio is playing, the per-device "speak replies" toggle.
 *   speech  — per-reply speech as seen by this client (`useReplySpeech(replyId)`, chat-ui renders from it).
 *   replays — messageUid → replyId of a running "Speak again".
 */
import type { ErrorCode } from '@shared/errors'
import type { ReplySpeech } from '../../features/voice/speech.logic'
import type { SliceCreator } from './types'

export type SttUiState = 'idle' | 'warming-up' | 'listening' | 'transcribing' | 'error'
export type MicModeState = 'dictate' | 'ptt' | 'conversation'

export interface VoiceState {
  stt: SttUiState
  /** Live partial transcript of the current utterance. */
  partial: string
  /** The reply whose audio is playing on this device. */
  speakingReplyId: string | null
  /** This client fell back to text for the current reply (backpressure, failures). */
  degraded: boolean
  muted: boolean
  /** Per-device "speak replies" (top-bar toggle, 07 D8 DevicePrefs.autoSpeak). */
  autoSpeak: boolean
  /** The open mic session's mode (null = mic off). */
  micMode: MicModeState | null
  /** The session the open mic belongs to. */
  micSessionUid: string | null
  /** Last mic/STT failure (cleared on the next start). */
  micError: ErrorCode | null
  /** Silence countdown: `performance.now()` deadline of the auto-end, and its length (null = no countdown). */
  countdown: { endsAt: number; totalMs: number; autoSend: boolean } | null
  /** The user typed during the countdown: the transcript goes into the composer instead of being sent. */
  autoSendCancelled: boolean
  /** Audio of a reply is playing (mic frames are held back unless barge-in is 'voice', 07 D6). */
  ttsActive: boolean
  /** The open mic's frames are held back right now (reply pending or speaking; conversation re-arms after it). */
  micHeld: boolean
}

export interface VoiceSlice {
  voice: VoiceState
  speech: Record<string, ReplySpeech>
  replays: Record<string, string>
  setVoice(patch: Partial<VoiceState>): void
  setReplySpeech(replyId: string, speech: ReplySpeech | null): void
  setReplay(messageUid: string, replyId: string | null): void
}

export const initialVoiceState: VoiceState = {
  stt: 'idle',
  partial: '',
  speakingReplyId: null,
  degraded: false,
  muted: false,
  autoSpeak: true,
  micMode: null,
  micSessionUid: null,
  micError: null,
  countdown: null,
  autoSendCancelled: false,
  ttsActive: false,
  micHeld: false
}

function shallowSame<T extends object>(a: T, patch: Partial<T>): boolean {
  for (const k of Object.keys(patch) as Array<keyof T>) if (a[k] !== patch[k]) return false
  return true
}

export const createVoiceSlice: SliceCreator<VoiceSlice> = (set) => ({
  voice: initialVoiceState,
  speech: {},
  replays: {},
  // No-op patches don't notify: the mic and speech clients patch often (every vad/partial event).
  setVoice: (patch) => set((s) => (shallowSame(s.voice, patch) ? {} : { voice: { ...s.voice, ...patch } })),
  setReplySpeech: (replyId, speech) =>
    set((s) => {
      if (speech === null) {
        if (!(replyId in s.speech)) return {}
        const next = { ...s.speech }
        delete next[replyId]
        return { speech: next }
      }
      if (s.speech[replyId] === speech) return {}
      return { speech: { ...s.speech, [replyId]: speech } }
    }),
  setReplay: (messageUid, replyId) =>
    set((s) => {
      if (replyId === null) {
        if (!(messageUid in s.replays)) return {}
        const next = { ...s.replays }
        delete next[messageUid]
        return { replays: next }
      }
      return s.replays[messageUid] === replyId ? {} : { replays: { ...s.replays, [messageUid]: replyId } }
    })
})
