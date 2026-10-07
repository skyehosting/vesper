/**
 * Messages between the server and the STT utility process (07 C17). The process runs either as an Electron
 * utilityProcess (parentPort) or as a Node child (fork + IPC with `serialization: 'advanced'`); both structured-clone
 * the messages, so typed arrays travel as typed arrays. True ArrayBuffer *transfer* is not available on either channel
 * (Electron's utilityProcess only transfers MessagePortMain objects); a 32 ms frame is 1 KiB, so the copy is noise.
 *
 * One shared recognizer per process, one VAD + endpointer per open mic (`micId`).
 */
import type { ModelEntry } from '@shared/models'

export type SttMode = 'dictate' | 'ptt' | 'conversation'
export type BargeIn = 'off' | 'tap' | 'voice'

/** What the process should load. `model: null` = VAD only (a cloud provider transcribes the utterance audio). */
export interface LoadSpec {
  /** Stable key: model id + dir + fake flag (a different key means a fresh process). */
  key: string
  model: { id: string; family: ModelEntry['family']; dir: string } | null
  vadModel: string
  threads: number
  /** Recognition language for families that take one at load time (Whisper, SenseVoice); 'auto' otherwise. */
  lang: string
  /** VESPER_STT_FAKE (test builds only): scripted transcripts, real Silero VAD. */
  fake: boolean
  /** Scripted transcripts for the fake recognizer (one per final; the last one repeats). */
  fakeTexts?: string[]
}

export interface MicOptions {
  mode: SttMode
  /** Silence after the last speech before the utterance is final (07 E12: 1200 ms default, 300–5000). */
  silenceMs: number
  lang: string
  ttsActive: boolean
  bargeIn: BargeIn
  vadThreshold: number
  preRollMs: number
  maxUtteranceMs: number
  /** Return the utterance PCM with the final (cloud providers transcribe it on the server). */
  wantAudio: boolean
  /** Decode closed segments for live partials (local recognizers only). */
  partials: boolean
}

export type ToProcess =
  | { t: 'load'; spec: LoadSpec }
  | { t: 'open'; micId: string; o: MicOptions }
  | { t: 'update'; micId: string; o: Partial<Pick<MicOptions, 'silenceMs' | 'vadThreshold' | 'preRollMs' | 'maxUtteranceMs' | 'bargeIn'>> }
  | { t: 'frames'; micId: string; pcm: Int16Array }
  | { t: 'ttsActive'; micId: string; active: boolean }
  /** stop = finish the current utterance now (push-to-talk release); cancel = drop it. */
  | { t: 'close'; micId: string; reason: 'stop' | 'cancel' }
  | { t: 'stats' }
  | { t: 'unload' }

export type DropReason = 'short' | 'empty' | 'hallucination'

export interface ProcessStats {
  sessions: number
  /** Samples held in pre-roll/utterance buffers across all sessions. */
  bufferedSamples: number
  /** VAD instances alive (open sessions + the idle pool). */
  vads: number
  decodesQueued: number
  rssMB: number
  loaded: string | null
}

export type FromProcess =
  | { t: 'hello'; pid: number }
  | { t: 'loaded'; key: string; ms: number }
  | { t: 'loadError'; key: string; code: 'stt_model_missing' | 'stt_unavailable'; detail: string }
  | { t: 'vad'; micId: string; speaking: boolean }
  /** The silence wait elapsed (or stop/max length): the final decode starts. */
  | { t: 'endpoint'; micId: string }
  | { t: 'partial'; micId: string; text: string }
  | { t: 'final'; micId: string; text: string; durationMs: number; speechMs: number; dropped?: DropReason; audio?: Int16Array }
  | { t: 'closed'; micId: string }
  | { t: 'error'; micId?: string; code: 'stt_unavailable' | 'stt_model_missing' | 'internal'; detail?: string }
  | { t: 'stats'; stats: ProcessStats }
  | { t: 'unloaded' }

export const SAMPLE_RATE = 16_000
/** Silero window (32 ms at 16 kHz). */
export const VAD_WINDOW = 512
/** First-stage segmentation silence (07 C17: ~400 ms segments → partials). */
export const SEGMENT_SILENCE_MS = 400
/** Finals with less detected speech than this are dropped (07 C17). */
export const MIN_SPEECH_MS = 300
/** While TTS plays with voice barge-in, speech must last this long before `vad{speaking:true}` (research 05 §2.6). */
export const BARGE_IN_CONFIRM_MS = 300
/** Research 05 §3.5: 4 threads (8 is only ~7 % faster for Parakeet and takes twice the cores). */
export const DEFAULT_THREADS = 4
