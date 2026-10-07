/**
 * Audio-core frozen API (07 E4, BLD-4). audio-core implements these in Phase 2; chat-ui, voice-client and presence
 * consume them in Phase 3. Owners replace implementations, never these signatures.
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'

/**
 * Audio levels for visuals (research 07 §2.3): every field is 0–1 after an attack/release envelope (30/250 ms).
 * `onset` is a decaying spectral-flux pulse (1 at a detected onset).
 */
export interface Levels {
  rms: number
  low: number
  mid: number
  high: number
  onset: number
}

/**
 * Something that can be sampled once per frame. `read` fills `out` in place (no allocation per frame, so the Star can
 * poll at 60 fps without GC churn). A silent/idle source writes zeros.
 */
export interface LevelSource {
  read(out: Levels): void
}

export type AudioEngineEvent = 'chunkStart' | 'chunkEnd' | 'replyEnd' | 'underrun'

export interface AudioEngineEventMap {
  /** A chunk's audio starts playing; `at` is on the `now()` clock. */
  chunkStart: { replyId: string; index: number; at: number; header: SpeechChunkHeader }
  chunkEnd: { replyId: string; index: number; at: number }
  /** The final chunk finished, or the reply was stopped (`interrupted`). */
  replyEnd: { replyId: string; interrupted: boolean }
  /** Playback reached a chunk that hasn't arrived yet. */
  underrun: { replyId: string; index: number }
}

/**
 * One AudioContext for the app; speech chunks are decoded and scheduled back to back (02 §6.1). Created lazily,
 * suspended after 30 s without audio (07 D4).
 */
export interface AudioEngine {
  /** Resume/create the AudioContext from a user gesture. Resolves true when audio can play. */
  unlock(): Promise<boolean>
  /** Queue a chunk (binary `speech.chunk` frame). Out-of-order chunks wait for their predecessors. */
  enqueue(header: SpeechChunkHeader, bytes: ArrayBuffer): void
  /** Stop playback of one reply (barge-in, speech.cancel), or everything when omitted. */
  stop(replyId?: string): void
  /** The audio clock in ms (AudioContext.currentTime based). */
  now(): number
  /** Output levels of what is playing (the Star's speaking visuals). */
  readonly output: LevelSource
  on<E extends AudioEngineEvent>(ev: E, cb: (e: AudioEngineEventMap[E]) => void): () => void
}

export interface MicConstraints {
  deviceId?: string
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
}

/** Microphone → AudioWorklet → 16 kHz mono Int16 frames (02 §6.2). */
export interface MicCapture {
  start(constraints?: MicConstraints): Promise<void>
  stop(): void
  /** Input levels (listening visuals, level meters). */
  readonly input: LevelSource
  /** 16 kHz Int16 LE mono frames, ~32 ms each. Returns unsubscribe. */
  onFrames(cb: (pcm16: Int16Array) => void): () => void
}

/**
 * Synced reveal (07 C14): text is hidden until its audio plays, then revealed in time with it via the CSS Custom
 * Highlight API. chat-ui binds each reply's rendered root; later chunks are picked up from the AudioEngine.
 */
export interface RevealController {
  /**
   * Start revealing `replyId` inside `el` using the chunk headers known so far. Returns an unbind function (call it
   * on unmount/eviction; highlights are removed).
   */
  bind(replyId: string, el: HTMLElement, chunks: readonly SpeechChunkHeader[]): () => void
  /** Reveal everything now (done, barge-in, failure → text-first). */
  finish(replyId: string): void
  /** 0–1 share of the reply's text revealed so far (1 when unknown/finished). */
  progress(replyId: string): number
}
