/**
 * Voice-input rules (R19, 07 C15/C17/D6/D8, research 07 §3.2), pure so they are unit-tested. micSession.ts applies
 * them to the live mic, the WebSocket and the store.
 */
import { micHeldForTts } from '@shared/micGate'
import { isLoopbackHost } from '@shared/loopback'

export type MicMode = 'dictate' | 'ptt' | 'conversation'
export type BargeIn = 'off' | 'tap' | 'voice'

/** 07 D6: conversation mode listens again this long after the reply's audio ends. */
export const REARM_MS = 250
/** Frames captured before `stt.start` is acked are kept (≤ 2 s) and flushed after it. */
export const MAX_EARLY_FRAMES = 63
/** After stt.stop, the session is torn down even if the server never answers. */
export const STOP_GRACE_MS = 8000
/** stt.prewarm at most this often (hover/focus of the mic). */
export const PREWARM_EVERY_MS = 30_000

/** What to do with a final transcript. */
export type FinalAction = 'send' | 'compose' | 'ignore'

export function finalAction(o: { mode: MicMode; autoSend: boolean; cancelled: boolean; text: string; canSend: boolean }): FinalAction {
  if (!o.text.trim()) return 'ignore'
  if (o.cancelled) return 'compose'
  // Conversation and push-to-talk always send (the server marks them autoSend); dictation per settings / "send now".
  const send = o.mode === 'dictate' ? o.autoSend : true
  return send && o.canSend ? 'send' : 'compose'
}

/** Dictation and push-to-talk end after one utterance; conversation keeps listening. */
export function endsAfterFinal(mode: MicMode): boolean {
  return mode !== 'conversation'
}

/**
 * May mic frames go to the server now? (07 D6: frames are not sent while TTS plays unless barge-in is 'voice'; in
 * conversation mode not while the reply to the last utterance is pending, and only REARM_MS after it ended.)
 */
export function gateOpen(o: { mode: MicMode; muted: boolean; ttsActive: boolean; bargeIn: BargeIn; awaitingReply: boolean; rearmAt: number; now: number }): boolean {
  if (o.muted) return false
  // The same rule as the STT process (shared, F36): push-to-talk is heard while a reply speaks.
  if (micHeldForTts(o)) return false
  if (o.bargeIn === 'voice' || o.mode !== 'conversation') return true
  if (o.awaitingReply) return false
  return o.now >= o.rearmAt
}

/** The countdown ring for the silence wait (null = none). */
export function countdownFor(o: { mode: MicMode; speaking: boolean; endpointInMs: number | undefined; now: number }): { endsAt: number; totalMs: number } | null {
  if (o.mode === 'ptt' || o.speaking || o.endpointInMs === undefined || !(o.endpointInMs > 0)) return null
  return { endsAt: o.now + o.endpointInMs, totalMs: o.endpointInMs }
}

/** 0–1 of the countdown still left. */
export function countdownLeft(c: { endsAt: number; totalMs: number } | null, now: number): number {
  if (!c || c.totalMs <= 0) return 0
  return Math.max(0, Math.min(1, (c.endsAt - now) / c.totalMs))
}

/** A key that means "the user is typing" (cancels the auto-send; research 07 §3.2). */
export function isTypingKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }): boolean {
  if (e.isComposing) return true
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  return e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter'
}

/** Where the page runs, for the mic help (07 D8). */
export interface MicPlace {
  isSecureContext: boolean
  protocol: string
  hostname: string
  desktop: boolean
  /** navigator.userAgent mentions Windows. */
  windows: boolean
}

export interface MicHelp {
  title: string
  body: string
  steps: string[]
  /** The error's own action (open Windows settings, Settings → Access, retry). */
  action: 'open-windows-privacy' | 'settings-access' | 'retry' | 'settings-voice-in' | 'none'
}

/** Clear, specific help per mic/STT failure. */
export function micHelp(code: string, place: MicPlace): MicHelp {
  switch (code) {
    case 'insecure_context':
      return {
        title: 'Voice input needs HTTPS',
        body:
          place.protocol === 'http:' && !isLoopbackHost(place.hostname)
            ? `Browsers only allow the microphone on secure pages, and ${place.hostname} is opened over plain HTTP.`
            : 'Browsers only allow the microphone on secure (HTTPS) pages.',
        steps: [
          'On your PC, open Vesper → Settings → Access & security.',
          'Choose "Local network (HTTPS)" or "Remote via Tailscale".',
          'Open the https:// address it shows on this device and accept the certificate once.'
        ],
        action: place.desktop ? 'settings-access' : 'none'
      }
    case 'mic_os_blocked':
      return place.windows
        ? {
            title: 'Windows is blocking the microphone',
            body: 'Windows privacy settings stop apps from using the microphone, or another app is holding it.',
            steps: [
              'Open Windows Settings → Privacy & security → Microphone.',
              'Turn on "Microphone access" and "Let apps access your microphone".',
              place.desktop ? 'Also turn on "Let desktop apps access your microphone".' : 'Also allow your browser in that list.',
              'Check that a microphone is plugged in, then try again.'
            ],
            action: place.desktop ? 'open-windows-privacy' : 'retry'
          }
        : {
            title: "The microphone can't be used",
            body: 'No microphone was found, or the system or another app is blocking it.',
            steps: ['Check that a microphone is connected and allowed in your system settings.', 'Then try again.'],
            action: 'retry'
          }
    case 'mic_denied':
      return {
        title: 'Microphone access was denied',
        body: place.desktop ? 'Vesper was not allowed to use the microphone.' : 'This browser blocked the microphone for Vesper.',
        steps: place.desktop
          ? ['Try again and allow the microphone when asked.', 'If nothing is asked, check Windows Settings → Privacy & security → Microphone.']
          : ['Click the lock or tune icon next to the address bar.', 'Set Microphone to "Allow", then reload the page.'],
        action: 'retry'
      }
    case 'stt_model_missing':
      return {
        title: 'Download a speech model first',
        body: 'Speech is turned into text on your PC by a model you download once.',
        steps: ['Open Settings → Voice in and download a model (Parakeet is recommended).'],
        action: 'settings-voice-in'
      }
    case 'stt_crashed':
    case 'stt_unavailable':
      return { title: 'Speech recognition is restarting', body: 'It stopped unexpectedly. Try again in a moment.', steps: [], action: 'retry' }
    default:
      return { title: "Voice input didn't work", body: 'Something went wrong while listening.', steps: [], action: 'retry' }
  }
}

export { isLoopbackHost }

/** Labels for the mic button per state (accessible name + tooltip). */
export function micLabel(o: { mode: MicMode; state: 'idle' | 'warming-up' | 'listening' | 'transcribing' | 'error'; countdown: 'send' | 'finish' | null; insecure: boolean }): string {
  if (o.insecure) return 'Voice input needs HTTPS'
  if (o.state === 'error') return 'Voice input problem — show help'
  if (o.mode === 'ptt') return o.state === 'idle' ? 'Hold to talk' : 'Release to send'
  if (o.state === 'idle') return o.mode === 'conversation' ? 'Start conversation' : 'Dictate'
  if (o.countdown) return o.countdown === 'send' ? 'Send now' : 'Finish now'
  if (o.state === 'transcribing') return 'Transcribing…'
  if (o.state === 'warming-up') return 'Starting the microphone…'
  if (o.mode === 'conversation') return 'End conversation'
  return 'Stop dictating'
}
