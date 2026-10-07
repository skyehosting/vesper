/**
 * Talk mode state (07 D6; pure). One reducer turns everything that happens — mic, speech-to-text, the reply, audio,
 * the user's buttons — into the phase the page shows and the action its big button takes. The controller
 * (controller.ts) performs the side effects; this file decides.
 *
 *   starting → warming-up → listening ⇄ transcribing → thinking → speaking → listening …
 *   any → held (Hold) → listening (Talk)          any → error (mic denied, STT failed) → starting (Try again)
 *   muted is a flag: the mic stays open but nothing is sent; Vesper may still speak.
 */
import type { ApiError } from '@shared/errors'
import type { ReplyState } from '@shared/types/domain'
// Type only, from the pure file (this one is compiled in the node project too).
import type { MicHelp } from '../../voice/mic.logic'

export type TalkPhase = 'starting' | 'warming-up' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'held' | 'error' | 'insecure' | 'ended'

export interface TalkState {
  phase: TalkPhase
  muted: boolean
  /** The user's words so far (live), or the last utterance until the reply starts. */
  partial: string
  /** The last utterance sent. */
  said: string
  replyId: string | null
  replyMessageUid: string | null
  error: ApiError | null
  /** The server is loading the speech model (shown as "Warming up…"). */
  sttWarming: boolean
}

export type TalkEvent =
  | { t: 'mic.ready' }
  | { t: 'mic.error'; error: ApiError }
  | { t: 'insecure' }
  | { t: 'stt.state'; state: 'warming-up' | 'listening' | 'transcribing' | 'idle' | 'error'; error?: ApiError }
  | { t: 'stt.partial'; text: string }
  | { t: 'stt.final'; text: string }
  | { t: 'sent'; replyId: string | null; messageUid: string | null }
  | { t: 'send.failed'; error: ApiError }
  | { t: 'reply.status'; replyId: string; messageUid: string; state: ReplyState }
  | { t: 'reply.done'; replyId: string; spoken: boolean }
  | { t: 'reply.error'; replyId: string | null; error: ApiError }
  | { t: 'speech.start'; replyId: string }
  | { t: 'speech.end'; replyId: string }
  | { t: 'mute'; muted: boolean }
  | { t: 'hold' }
  | { t: 'resume' }
  | { t: 'interrupt' }
  | { t: 'retry' }
  | { t: 'end' }

export function initialTalk(): TalkState {
  return { phase: 'starting', muted: false, partial: '', said: '', replyId: null, replyMessageUid: null, error: null, sttWarming: false }
}

const ACTIVE_REPLY: ReadonlySet<TalkPhase> = new Set<TalkPhase>(['thinking', 'speaking'])

export function talkReducer(s: TalkState, e: TalkEvent): TalkState {
  if (s.phase === 'ended') return s
  switch (e.t) {
    case 'insecure':
      return { ...s, phase: 'insecure' }
    case 'mic.ready':
      return s.phase === 'starting' ? { ...s, phase: s.sttWarming ? 'warming-up' : 'listening', error: null } : s
    case 'mic.error':
      return { ...s, phase: 'error', error: e.error }
    case 'stt.state':
      if (e.state === 'error') return { ...s, phase: 'error', error: e.error ?? null, sttWarming: false }
      if (e.state === 'warming-up') return { ...s, sttWarming: true, phase: s.phase === 'starting' || s.phase === 'listening' ? 'warming-up' : s.phase }
      if (e.state === 'listening') {
        const phase = s.phase === 'warming-up' || s.phase === 'transcribing' || s.phase === 'starting' ? 'listening' : s.phase
        return { ...s, sttWarming: false, phase }
      }
      if (e.state === 'transcribing') return { ...s, sttWarming: false, phase: s.phase === 'listening' ? 'transcribing' : s.phase }
      return { ...s, sttWarming: false }
    case 'stt.partial':
      if (s.muted || s.phase === 'held') return s
      return { ...s, partial: e.text }
    case 'stt.final':
      if (s.muted || s.phase === 'held' || !e.text.trim()) return { ...s, partial: s.muted ? s.partial : '' }
      return { ...s, partial: e.text, said: e.text, phase: 'thinking', replyId: null, replyMessageUid: null }
    case 'sent':
      return { ...s, replyId: e.replyId ?? s.replyId, replyMessageUid: e.messageUid ?? s.replyMessageUid }
    case 'send.failed':
      return { ...s, phase: 'listening', error: e.error }
    case 'reply.status':
      if (s.replyId && e.replyId !== s.replyId) return s
      return {
        ...s,
        replyId: e.replyId,
        replyMessageUid: e.messageUid,
        phase: s.phase === 'thinking' || s.phase === 'listening' ? (e.state === 'speaking' ? s.phase : 'thinking') : s.phase
      }
    case 'reply.done':
      if (e.replyId !== s.replyId) return s
      // The audio may still be playing; speech.end takes us back to listening then.
      return s.phase === 'speaking' && e.spoken ? s : { ...s, phase: s.phase === 'held' ? 'held' : 'listening', partial: '' }
    case 'reply.error':
      if (e.replyId !== null && e.replyId !== s.replyId) return s
      if (e.error.code === 'session_busy') return { ...s, error: e.error, phase: s.phase === 'held' ? 'held' : 'listening' }
      return { ...s, error: e.error, phase: s.phase === 'held' ? 'held' : 'listening', partial: '' }
    case 'speech.start':
      if (s.phase === 'held') return s
      return { ...s, phase: 'speaking', replyId: s.replyId ?? e.replyId, partial: '' }
    case 'speech.end':
      return s.phase === 'speaking' ? { ...s, phase: 'listening' } : s
    case 'mute':
      return { ...s, muted: e.muted, partial: e.muted ? '' : s.partial }
    case 'hold':
      return { ...s, phase: 'held', partial: '' }
    case 'resume':
      return s.phase === 'held' ? { ...s, phase: s.sttWarming ? 'warming-up' : 'listening', error: null } : s
    case 'interrupt':
      return ACTIVE_REPLY.has(s.phase) ? { ...s, phase: 'listening', partial: '' } : s
    case 'retry':
      return s.phase === 'error' ? { ...initialTalk(), muted: s.muted } : s
    case 'end':
      return { ...s, phase: 'ended' }
  }
}

/** What the big button does now (and its label). */
export type PrimaryAction = 'send' | 'interrupt' | 'talk' | 'hold' | 'unmute' | 'retry' | 'setup' | 'none'

export function primaryAction(s: TalkState, place: TalkPlace): PrimaryAction {
  if (s.phase === 'error') return talkErrorWayOut(s.error, place).primary
  if (s.phase === 'held') return 'talk'
  if (s.phase === 'thinking' || s.phase === 'speaking') return 'interrupt'
  if (s.muted) return 'unmute'
  // Listening: words so far → send them now; nothing yet → the button pauses listening.
  if (s.phase === 'listening' || s.phase === 'transcribing') return s.partial.trim() ? 'send' : 'hold'
  return 'none'
}

export const TALK_PHASE_TEXT: Record<TalkPhase, string> = {
  starting: 'Starting…',
  'warming-up': 'Warming up the voice…',
  listening: 'Listening…',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  held: 'On hold',
  error: 'Something went wrong',
  insecure: 'Voice needs a secure connection',
  ended: 'Ended'
}

/**
 * The way out of a Talk-mode error (07 D13 "per error code UI actions", review F51). Errors that a retry cannot fix (no
 * speech model, a damaged or refused model) make setup the big button; everything else keeps "Try again" first. Every
 * error also offers Voice-in settings (when they can help) and "Type instead" (back to the chat's composer).
 */
export interface TalkWayOut {
  primary: 'retry' | 'setup'
  /** The setup button's words. */
  setupLabel: string
  /** Offer "Voice in settings" as a secondary action. */
  settings: boolean
  /** Offer "Open Windows settings" (the desktop app, a microphone Windows privacy settings block). */
  windowsSettings: boolean
  /** Replaces the error's text where the fix is elsewhere (off the PC: "…in Vesper on your PC"). */
  note: string | null
  /** Offer "Type instead". */
  text: boolean
}

/**
 * Where Talk mode runs (second pass of F51): setup actions exist only in the desktop app (a phone's Settings → Voice in
 * only says "Download on your PC"), and a mic error's own action comes from the voice feature's micHelp() — the same
 * mapping the composer's ProblemHelp uses — so Talk mode and the composer never disagree.
 */
export interface TalkPlace {
  desktop: boolean
  micAction: (code: string) => MicHelp['action']
}

const SETUP_FIRST: Readonly<Record<string, { label: string; elsewhere: string }>> = {
  stt_model_missing: {
    label: 'Download the speech model',
    elsewhere: 'The speech model isn’t installed yet. Download it in Vesper on your PC (Settings → Voice in), then try again.'
  },
  model_checksum: {
    label: 'Download the speech model',
    elsewhere: 'The speech model is damaged. Download it again in Vesper on your PC (Settings → Voice in), then try again.'
  },
  model_unsafe: {
    label: 'Choose another speech model',
    elsewhere: 'This speech model was refused. Choose another one in Vesper on your PC (Settings → Voice in), then try again.'
  }
}
const STT_CODES: ReadonlySet<string> = new Set(['stt_unavailable', 'stt_crashed', 'stt_model_missing', 'model_checksum', 'model_unsafe'])

export function talkErrorWayOut(e: ApiError | null, place: TalkPlace): TalkWayOut {
  const code = e?.code ?? ''
  const setup = SETUP_FIRST[code]
  const base = { setupLabel: 'Open Voice in settings', settings: false, windowsSettings: false, note: null, text: true }
  if (setup) {
    // Off the PC there is nothing to set up here: Try again (after the PC has it), and say where to fix it.
    return place.desktop ? { ...base, primary: 'setup', setupLabel: setup.label } : { ...base, primary: 'retry', note: setup.elsewhere }
  }
  return {
    ...base,
    primary: 'retry',
    settings: place.desktop && STT_CODES.has(code),
    windowsSettings: place.desktop && place.micAction(code) === 'open-windows-privacy'
  }
}

/** Why Talk mode can't open now, or null (second pass of F51: its entries check first, like the voice-reply toggle). */
export interface TalkBlocked {
  message: string
  /** Offer "Set up voice input" (the desktop app; elsewhere the message says where). */
  setup: boolean
}

export function talkEntry(settings: { voice: { stt: { enabled: boolean } } } | null | undefined, desktop: boolean): TalkBlocked | null {
  if (settings?.voice.stt.enabled) return null
  return desktop
    ? { message: 'Talk mode needs voice input.', setup: true }
    : { message: 'Talk mode needs voice input. Turn it on in Vesper on your PC: Settings → Voice in.', setup: false }
}
