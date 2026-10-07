/**
 * TTS provider contract inside voice-out-server (research 04 §9.1). SpeechService talks to providers only through
 * this; keys are read per request through SecretsService.getFor (07 B1) and never leave the server.
 */
import type { TtsProviderId } from '@shared/settings'
import type { ModelInfo, Voice } from '@shared/types/domain'
import type { SpeechMime } from '@shared/ws'
import type { Timeline } from '@shared/revealMap'

export interface SynthRequest {
  /** The spoken text (markdown-free, tag-free). */
  text: string
  voiceId: string | null
  model: string | null
  /** Sanitized or raw tone; each provider applies its own adapter (or ignores it). */
  tone: string | null
  /** 0.7–1.3 user speed (providers clamp to their own range). */
  speed: number
  stability: number
  similarity: number
  /** Neighbouring text for prosody continuity (ElevenLabs v2/flash only). */
  prevText?: string
  nextText?: string
}

export interface SynthResult {
  audio: Uint8Array
  mime: SpeechMime
  durationMs: number
  /** Per char of `SynthRequest.text`, relative to the audio start; null when it cannot be known server-side. */
  timeline: Timeline | null
  /** How the timeline was obtained (diagnostics / tests). */
  timing: 'provider' | 'cues' | 'estimate' | 'none'
}

export interface VoiceList {
  voices: Voice[]
  models: ModelInfo[]
  quota?: { used: number; limit: number }
  /** voiceId → provider preview URL. Server-side only (the client gets a same-origin proxy URL). */
  previews?: Record<string, string>
}

export interface TtsProvider {
  readonly id: TtsProviderId
  /** False when the provider cannot work here (Windows voices off Windows, no base URL configured). */
  available(): boolean
  synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult>
  /** Voices + models (+ quota). `key` tests an unsaved key (wizard Test button). */
  list(signal: AbortSignal, o?: { key?: string; baseUrl?: string }): Promise<VoiceList>
  /** Validate a key before it is stored (07 C22); throws a VesperError to refuse it. */
  validateKey?(key: string, url: string, signal: AbortSignal): Promise<void>
  defaultVoice(list: VoiceList, model: string | null): string | null
  /** The model used when settings say null; `fast` = Talk mode's fast-voice option (07 D6). */
  defaultModel(list: VoiceList, fast: boolean): string | null
  close?(): Promise<void>
}
