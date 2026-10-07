/**
 * Two-stage endpointing for one mic session (07 C17, research 05 §2.5/§4.5). Pure and synchronous: it runs inside the
 * STT process around a VAD (Silero in production, anything `VadLike` in tests) and reports what to decode.
 *
 *   stage 1 — the VAD closes a segment after SEGMENT_SILENCE_MS (~400 ms) of silence → `segment()` (live partials);
 *   stage 2 — when the silence since the last speech reaches the user's setting → `final()` with the whole utterance
 *             (pre-roll included) for one full re-decode. Push-to-talk never ends on silence: `stop()` ends it.
 *
 * Pre-roll: Silero places segment starts late enough to clip the first word ("The quick" lost, research 05 §3.7), so
 * every decode starts `preRollMs` (400 ms default) before the segment. Audio before that is dropped as it ages, so a
 * session holds at most max-utterance + pre-roll seconds of audio.
 */
import { micHeldForTts } from '@shared/micGate'
import { BARGE_IN_CONFIRM_MS, MIN_SPEECH_MS, SAMPLE_RATE, SEGMENT_SILENCE_MS, VAD_WINDOW, type MicOptions } from './protocol'
import { rms } from './pcm'

export interface VadLike {
  acceptWaveform(samples: Float32Array): void
  /** True while the detector is inside speech (sherpa: from min-speech after the onset until min-silence after it). */
  isDetected(): boolean
  isEmpty(): boolean
  /** The oldest closed segment (absolute sample index of its start). Must return a copy. */
  front(): { start: number; samples: Float32Array }
  pop(): void
  /** Close the open segment now (stop / max length). */
  flush(): void
  reset(): void
}

export interface FinalAudio {
  audio: Float32Array
  durationMs: number
  /** Speech the VAD detected inside the utterance (guards). */
  speechMs: number
  rms: number
  reason: 'silence' | 'stop' | 'max'
}

export interface EndpointerEvents {
  vad(speaking: boolean): void
  /** A first-stage segment closed: decode it (with pre-roll) for a live partial. `utt` identifies the utterance. */
  segment(audio: Float32Array, utt: number): void
  /** The utterance ended: the final decode starts (the process tells the client "transcribing"). */
  endpoint(utt: number): void
  final(f: FinalAudio, utt: number): void
}

/** Detection can begin this long after the real onset (min speech 250 ms + windows); used until the segment lands. */
const ONSET_LOOKBACK_MS = 700
/** Speech tail kept after the segment end, so the last phoneme is not cut. */
const TAIL_MS = 150
/**
 * Onset guard. Silero reports new speech only after its min-speech time (~250 ms + a window), so when the user resumes
 * talking just before the silence wait runs out, the detector still says "silence" and the utterance would be cut in
 * two (seen with research 05's 0.83 s pause: "…last Tuesday?" lost "I think it was…"). If the most recent audio is
 * loud compared with the utterance's speech, the final waits — at most ONSET_DEFER_MS — for the detector to decide.
 */
const ONSET_GUARD_MS = 320
const ONSET_DEFER_MS = 480

const ms = (n: number) => Math.round((n / SAMPLE_RATE) * 1000)
const samples = (msv: number) => Math.round((msv / 1000) * SAMPLE_RATE)

/** Segmentation silence for a user silence setting: never longer than the setting itself. */
export function segmentSilenceMs(silenceMs: number): number {
  return Math.min(SEGMENT_SILENCE_MS, silenceMs)
}

/** Absolute-indexed sample store that drops old audio in whole chunks. */
export class PcmBuffer {
  private chunks: Float32Array[] = []
  /** Absolute index of the first sample held. */
  base = 0
  /** Absolute index one past the last sample held. */
  end = 0

  append(s: Float32Array): void {
    if (!s.length) return
    this.chunks.push(s)
    this.end += s.length
  }

  get size(): number {
    return this.end - this.base
  }

  /** Copy of [from, to) clamped to what is held. */
  slice(from: number, to: number): Float32Array {
    const a = Math.max(from, this.base)
    const b = Math.min(to, this.end)
    if (b <= a) return new Float32Array(0)
    const out = new Float32Array(b - a)
    let pos = this.base
    for (const c of this.chunks) {
      const cEnd = pos + c.length
      if (cEnd > a && pos < b) {
        const s = Math.max(a, pos)
        const e = Math.min(b, cEnd)
        out.set(c.subarray(s - pos, e - pos), s - a)
      }
      if (cEnd >= b) break
      pos = cEnd
    }
    return out
  }

  /** Forget whole chunks that end at or before `abs`. */
  dropBefore(abs: number): void {
    while (this.chunks.length && this.base + this.chunks[0].length <= abs) {
      this.base += this.chunks[0].length
      this.chunks.shift()
    }
  }

  clear(): void {
    this.chunks = []
    this.base = this.end
  }
}

interface Utterance {
  /** Absolute start of speech (provisional until the first segment lands). */
  start: number
  provisional: boolean
  /** Absolute end of the last closed segment (-1 = none yet). */
  lastEnd: number
  /** Last window in which the detector was inside speech. */
  lastDetected: number
  speech: number
  /** Sum of squares of the segment samples (speech loudness, for the onset guard). */
  energy: number
  /** Window at which a due final was first deferred by the onset guard. */
  deferredSince: number | null
}

export class Endpointer {
  private readonly buf = new PcmBuffer()
  private pending = new Float32Array(0)
  /** Samples fed to the VAD (absolute clock of this session). */
  private total = 0
  private utt: Utterance | null = null
  private uttSeq = 1
  private detectedSince: number | null = null
  private speaking = false
  private o: MicOptions

  constructor(
    private vad: VadLike,
    o: MicOptions,
    private readonly ev: EndpointerEvents
  ) {
    this.o = { ...o }
  }

  get options(): Readonly<MicOptions> {
    return this.o
  }

  /** Audio held right now (pre-roll + current utterance + the unfed remainder). */
  get bufferedSamples(): number {
    return this.buf.size + this.pending.length
  }

  get utterance(): number {
    return this.uttSeq
  }

  /** Swap the VAD (segmentation silence changed); the current utterance is dropped. */
  replaceVad(vad: VadLike): VadLike {
    const old = this.vad
    this.vad = vad
    this.resetState()
    return old
  }

  update(o: Partial<MicOptions>): void {
    this.o = { ...this.o, ...o }
  }

  /**
   * Frames are ignored while TTS plays unless voice barge-in is on (07 D6); either edge starts from a clean state.
   * Push-to-talk is always heard (the shared rule, F36), and a reply ending mid-hold keeps what was said so far.
   */
  setTtsActive(active: boolean): void {
    if (active === this.o.ttsActive) return
    const was = micHeldForTts(this.o)
    this.o.ttsActive = active
    if (was !== micHeldForTts(this.o)) this.resetState()
  }

  push(frame: Float32Array): void {
    if (micHeldForTts(this.o)) return
    this.buf.append(frame)
    let data = frame
    if (this.pending.length) {
      data = new Float32Array(this.pending.length + frame.length)
      data.set(this.pending)
      data.set(frame, this.pending.length)
    }
    let off = 0
    for (; off + VAD_WINDOW <= data.length; off += VAD_WINDOW) this.window(data.subarray(off, off + VAD_WINDOW))
    this.pending = off < data.length ? data.slice(off) : new Float32Array(0)
    this.trim()
  }

  /** End the utterance now (push-to-talk release, stt.stop). Returns false when there was nothing to finish. */
  stop(): boolean {
    if (this.pending.length) {
      const pad = new Float32Array(VAD_WINDOW)
      pad.set(this.pending)
      this.pending = new Float32Array(0)
      this.vad.acceptWaveform(pad)
      this.total += VAD_WINDOW
    }
    this.vad.flush()
    this.drain(false)
    const had = !!this.utt && (this.utt.lastEnd >= 0 || this.utt.speech > 0)
    if (had) this.finalize('stop', true)
    else this.resetState()
    return had
  }

  /** Drop everything (stt.cancel, disconnect). */
  cancel(): void {
    this.resetState()
  }

  private resetState(): void {
    this.vad.reset()
    this.buf.clear()
    this.pending = new Float32Array(0)
    if (this.utt) this.uttSeq++
    this.utt = null
    this.detectedSince = null
    if (this.speaking) {
      this.speaking = false
      this.ev.vad(false)
    }
  }

  private window(w: Float32Array): void {
    this.vad.acceptWaveform(w)
    this.total += VAD_WINDOW
    const det = this.vad.isDetected()
    if (det) {
      this.detectedSince ??= this.total
      this.utt ??= { start: Math.max(0, this.total - samples(ONSET_LOOKBACK_MS)), provisional: true, lastEnd: -1, lastDetected: this.total, speech: 0, energy: 0, deferredSince: null }
      this.utt.lastDetected = this.total
      this.utt.deferredSince = null
      // While TTS plays (voice barge-in), the speaker's echo must not interrupt: require sustained speech first.
      const confirmed = !this.o.ttsActive || this.total - this.detectedSince >= samples(BARGE_IN_CONFIRM_MS)
      if (!this.speaking && confirmed) {
        this.speaking = true
        this.ev.vad(true)
      }
    } else this.detectedSince = null
    this.drain(det)
    if (!det && this.speaking) {
      this.speaking = false
      this.ev.vad(false)
    }
    const u = this.utt
    if (!u) return
    if (u.lastEnd < 0 && !det && this.total - u.lastDetected > samples(SEGMENT_SILENCE_MS + 300)) {
      // Detection blipped but no segment ever closed: nothing to transcribe.
      this.utt = null
      return
    }
    if (this.o.mode !== 'ptt' && !det && u.lastEnd >= 0 && this.total - u.lastEnd >= samples(this.o.silenceMs)) {
      if (this.onsetPending(u)) {
        u.deferredSince ??= this.total
        if (this.total - u.deferredSince < samples(ONSET_DEFER_MS)) return
      }
      return this.finalize('silence', false)
    }
    if (this.total - u.start >= samples(this.o.maxUtteranceMs)) {
      this.vad.flush()
      this.drain(false)
      this.finalize('max', true)
    }
  }

  private drain(det: boolean): void {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front()
      this.vad.pop()
      const end = seg.start + seg.samples.length
      const u = (this.utt ??= { start: seg.start, provisional: false, lastEnd: -1, lastDetected: this.total, speech: 0, energy: 0, deferredSince: null })
      if (u.provisional || seg.start < u.start) {
        u.start = seg.start
        u.provisional = false
      }
      u.lastEnd = Math.max(u.lastEnd, end)
      u.speech += seg.samples.length
      for (let i = 0; i < seg.samples.length; i++) u.energy += seg.samples[i] * seg.samples[i]
      u.deferredSince = null
      if (this.o.partials) this.ev.segment(this.buf.slice(seg.start - samples(this.o.preRollMs), Math.min(this.total, end + samples(TAIL_MS))), this.uttSeq)
      if (this.speaking && !det) {
        this.speaking = false
        this.ev.vad(false)
      }
    }
  }

  /** Is the latest audio loud enough to be the start of more speech the VAD has not confirmed yet? */
  private onsetPending(u: Utterance): boolean {
    if (!u.speech) return false
    const speechRms = Math.sqrt(u.energy / u.speech)
    const tail = rms(this.buf.slice(this.total - samples(ONSET_GUARD_MS), this.total))
    // The quiet stretch right after the speech is the room's noise floor.
    const floor = rms(this.buf.slice(u.lastEnd + samples(TAIL_MS), u.lastEnd + samples(TAIL_MS + 200)))
    return tail > Math.max(0.008, speechRms * 0.3, floor * 2)
  }

  private finalize(reason: FinalAudio['reason'], resetVad: boolean): void {
    const u = this.utt
    if (!u) return
    const from = u.start - samples(this.o.preRollMs)
    const to = reason === 'silence' ? Math.min(this.total, u.lastEnd + samples(TAIL_MS)) : this.total
    const audio = this.buf.slice(from, to)
    const utt = this.uttSeq++
    this.utt = null
    this.detectedSince = null
    if (resetVad) this.vad.reset()
    if (this.speaking) {
      this.speaking = false
      this.ev.vad(false)
    }
    this.ev.endpoint(utt)
    this.ev.final({ audio, durationMs: ms(audio.length), speechMs: ms(u.speech), rms: rms(audio), reason }, utt)
    this.trim()
  }

  private trim(): void {
    const keep = this.utt ? this.utt.start - samples(this.o.preRollMs) - samples(ONSET_LOOKBACK_MS) : this.total - samples(this.o.preRollMs + ONSET_LOOKBACK_MS)
    this.buf.dropBefore(keep)
  }
}

/**
 * Transcripts that ASR models produce from near-silence (research 05 §3.9: Moonshine wrote "1."; Whisper-style
 * models are known for "Thank you." / "Thanks for watching."). Only dropped when the audio really was near-silent, so a
 * user who says "Thank you." is still heard.
 */
const HALLUCINATIONS = new Set(['1', 'thank you', 'thanks for watching', 'thank you for watching', 'thank you very much', 'you', 'bye'])
/** RMS below this counts as near-silence (≈ -40 dBFS). */
const NEAR_SILENCE_RMS = 0.01

export function normalizeForGuard(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 07 C17 guards: finals under 300 ms of speech, empty/punctuation-only text, and known hallucinations on near-silence. */
export function guardFinal(text: string, speechMs: number, level: number): 'short' | 'empty' | 'hallucination' | null {
  if (speechMs < MIN_SPEECH_MS) return 'short'
  const n = normalizeForGuard(text)
  if (!n) return 'empty'
  if (HALLUCINATIONS.has(n) && level < NEAR_SILENCE_RMS) return 'hallucination'
  return null
}
