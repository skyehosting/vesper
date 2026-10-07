/**
 * One reply being spoken (the SpeechSink handed to the chat engine, 07 E2/C14/C15/C16).
 *
 * Text streams in through push(); the SpeechDocument turns it into chunks; at most two chunks synthesize at a time
 * (look-ahead while the client plays) and they are sent strictly in order as binary `speech.chunk` frames to the
 * speaking clients. Instant chunks (code, tables…) go out as empty frames. A chunk that fails twice (or once with a
 * non-retryable error such as a rejected key) ends speech for the reply: `speech.error` then `speech.end`, and the
 * clients reveal the rest as text. A socket over the backpressure limit gets `speech.degraded` and no more audio.
 * Every path ends in finish(): the job's AbortController aborts in-flight synthesis, nothing is retained, `speech.end`
 * is emitted once and `done` resolves.
 */
import type { ApiError, ErrorCode } from '@shared/errors'
import type { Settings } from '@shared/settings'
import type { SpeechChunkHeader } from '@shared/ws'
import type { Hub, Log, SpeechSink, SpeechSinkEvent, SpeechTarget } from '../services'
import type { SynthResult } from '../providers/tts/types'
import { isAbort } from '../providers/tts/http'
import { SpeechDocument, type PlannedChunk } from './segmenter'

export interface SinkResult {
  chunks: number
  spokenChars: number
  interrupted: boolean
  failed: boolean
}

/**
 * 'cancelled' = speech.cancel before anyone could have heard audio (F31): speech stops everywhere, every speaker is
 * handed the text (as for text-first), and the reply itself carries on — it is not a barge-in (07 C15 is about speech
 * being heard).
 */
export type JobOutcome = 'complete' | 'barge-in' | 'cancelled' | 'stopped' | 'error' | 'failed' | 'backpressure' | 'speaker-left'

export interface JobDeps {
  hub: Hub
  log: Log
  now(): number
  toApiError(e: unknown): ApiError
  /** `toneMode` is the mode in force for this reply (H-v11-tone: 'off' when the voice in use can't use a tone). */
  tts: Pick<Settings['voice']['tts'], 'toneMode' | 'tonePlacement' | 'waitForTone' | 'speakCode'>
  /**
   * The chat's current tone (07 A2: used until this reply's tag lands; H-v11-tone: in 'conversation' mode it carries
   * on through replies that write no tag).
   */
  initialTone: string | null
  synth(chunk: PlannedChunk, o: { tone: string | null; prevText?: string; nextText?: string }, signal: AbortSignal): Promise<SynthResult>
  onTone?(value: string): void
  onFinish?(job: SpeechJob, outcome: JobOutcome, result: SinkResult): void
  /** The opener's view of the job (07 C16 synced reveal): first audio, a client degraded to text, failure. */
  onEvent?(e: SpeechSinkEvent): void
  maxInFlight?: number
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['network', 'provider_overloaded', 'provider_rate', 'tts_failed', 'internal'])
/** 07 A2: with tonePlacement 'end', replies up to this many visible chars wait for the whole text (and its tag). */
const END_TONE_WAIT_CHARS = 600
/** 07 A2: with the tag at the start, never wait beyond this many visible chars for it. */
const START_TONE_WAIT_CHARS = 40

interface Ready {
  plan: PlannedChunk
  result: SynthResult | null
}

export class SpeechJob implements SpeechSink {
  readonly done: Promise<SinkResult>
  private resolveDone!: (r: SinkResult) => void
  private readonly doc: SpeechDocument
  private readonly plans: PlannedChunk[] = []
  private readonly ready = new Map<number, Ready>()
  private readonly clients: Set<string>
  private readonly tones: Array<{ value: string; at: number }> = []
  private readonly controller = new AbortController()
  private dispatched = 0
  private inFlight = 0
  private nextSend = 0
  private sent = 0
  private ended = false
  private finished = false
  private visible = 0
  private revealed = 0
  private waitedForEnd = false
  private readonly openedAt: number
  private firstAudioAt: number | null = null

  constructor(
    readonly target: SpeechTarget,
    private readonly deps: JobDeps
  ) {
    this.done = new Promise((r) => (this.resolveDone = r))
    this.doc = new SpeechDocument({ speakCode: deps.tts.speakCode })
    this.clients = new Set(target.clientIds)
    this.openedAt = deps.now()
    // Nobody to speak to: done at once, silently (the caller still gets a sink it can push to).
    if (!this.clients.size) this.finish('speaker-left', false)
  }

  get replyId(): string {
    return this.target.replyId
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** Counters for leak tests. */
  stats(): { inFlight: number; ready: number; plans: number; clients: number } {
    return { inFlight: this.inFlight, ready: this.ready.size, plans: this.plans.length, clients: this.clients.size }
  }

  push(text: string): void {
    if (this.finished || this.ended || typeof text !== 'string' || !text) return
    this.visible += text.length
    this.plans.push(...this.doc.push(text))
    this.pump()
  }

  tone(value: string, at: number): void {
    if (this.finished || typeof value !== 'string' || !value.trim()) return
    this.tones.push({ value, at: Number.isFinite(at) ? at : this.visible })
    this.deps.onTone?.(value)
    this.pump()
  }

  end(finalBody: string): void {
    if (this.finished || this.ended) return
    this.plans.push(...this.doc.end(finalBody))
    this.ended = true
    this.pump()
  }

  abort(reason: 'barge-in' | 'stopped' | 'error'): void {
    this.finish(reason === 'barge-in' ? 'barge-in' : reason === 'stopped' ? 'stopped' : 'error')
  }

  /**
   * speech.cancel from any device: stops speech everywhere (07 C15/C16). It is a barge-in (the turn stops, the reply is
   * stored as interrupted) only when someone may have heard audio. Before that — no audio sent to anyone, or the
   * canceller says it heard nothing and is the only speaker — every speaker gets the text instead and the reply
   * carries on (F31: typing right after sending must not discard the answer).
   */
  cancel(spokenChars?: number, o: { beforeAudio?: boolean; byClientId?: string } = {}): SinkResult | null {
    if (this.finished) return null
    if (this.unheard(o)) {
      for (const id of [...this.clients]) {
        this.clients.delete(id)
        this.event({ kind: 'degraded', clientId: id, reason: 'text-first' })
      }
      return this.finish('cancelled')
    }
    if (typeof spokenChars === 'number' && Number.isFinite(spokenChars)) this.revealed = Math.max(0, Math.min(Math.trunc(spokenChars), this.doc.source.length))
    return this.finish('barge-in')
  }

  /** Nobody can have heard this reply yet (see cancel). */
  private unheard(o: { beforeAudio?: boolean; byClientId?: string }): boolean {
    if (this.firstAudioAt === null) return true
    if (!o.beforeAudio || !o.byClientId) return false
    for (const id of this.clients) if (id !== o.byClientId) return false
    return true
  }

  /** speech.played acknowledgement: how far the client has revealed (barge-in bookkeeping). */
  played(index: number, revealedChars: number): void {
    if (this.finished || !Number.isFinite(revealedChars)) return
    void index
    this.revealed = Math.max(this.revealed, Math.min(Math.trunc(revealedChars), this.doc.source.length))
  }

  /**
   * speech.textFirst (07 C14 client-side 6 s rule): this client gave up waiting for audio. It gets no more audio and
   * the opener hands it the text (targeted snapshot + deltas); the other speakers keep their audio. With no speaker
   * left, synthesis stops.
   */
  dropClient(clientId: string): void {
    if (this.finished || !this.clients.delete(clientId)) return
    this.event({ kind: 'degraded', clientId, reason: 'text-first' })
    if (!this.clients.size) this.finish('speaker-left')
  }

  clientGone(clientId: string): void {
    if (this.finished || !this.clients.delete(clientId)) return
    this.event({ kind: 'degraded', clientId, reason: 'speaker-left' })
    if (!this.clients.size) this.finish('speaker-left')
  }

  /** Tell the opener; its failures never break speech. */
  private event(e: SpeechSinkEvent): void {
    try {
      this.deps.onEvent?.(e)
    } catch (err) {
      this.deps.log.warn('speech event handler failed', { error: err })
    }
  }

  /** 07 A2 gating: may chunks be synthesized yet (the tone may still be coming)? */
  private mayDispatch(): boolean {
    const t = this.deps.tts
    if (t.toneMode === 'off' || this.ended) return true
    if (t.waitForTone) return false
    if (t.tonePlacement === 'end') return this.visible > END_TONE_WAIT_CHARS
    return this.tones.length > 0 || this.visible >= START_TONE_WAIT_CHARS
  }

  /** "A tag applies from its chunk until the next tag" (07 A2); before any tag, the session's last tone. */
  private toneFor(p: PlannedChunk): string | null {
    if (this.deps.tts.toneMode === 'off') return null
    const atEnd = this.ended && p.src[1] >= this.doc.source.length
    let tone: string | null = null
    for (const t of this.tones) if (t.at < p.src[1] || atEnd) tone = t.value
    if (tone === null && this.waitedForEnd && this.tones.length) tone = this.tones[this.tones.length - 1].value
    return tone ?? this.deps.initialTone
  }

  private pump(): void {
    if (this.finished || !this.mayDispatch()) return
    if (this.dispatched === 0 && this.ended) this.waitedForEnd = true
    const max = this.deps.maxInFlight ?? 2
    while (this.dispatched < this.plans.length && (this.inFlight < max || this.plans[this.dispatched].instant)) {
      const p = this.plans[this.dispatched++]
      if (p.index === 0) this.preparing()
      if (p.instant) this.ready.set(p.index, { plan: p, result: null })
      else void this.run(p)
    }
    this.flush()
  }

  /** Tell the speakers that chunk 0 is now being made: their 6 s first-chunk clock starts here (07 C14, F32). */
  private preparing(): void {
    for (const id of this.clients) this.deps.hub.emit(this.target.sessionUid, { t: 'speech.preparing', sessionUid: this.target.sessionUid, replyId: this.replyId, index: 0 }, { only: id })
  }

  private async run(p: PlannedChunk): Promise<void> {
    this.inFlight++
    const signal = this.controller.signal
    const o = { tone: this.toneFor(p), prevText: this.plans[p.index - 1]?.spoken || undefined, nextText: this.plans[p.index + 1]?.spoken || undefined }
    let result: SynthResult | null = null
    let error: unknown = null
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
      try {
        result = await this.deps.synth(p, o, signal)
        error = null
        break
      } catch (e) {
        error = e
        if (isAbort(e) || signal.aborted) break
        const code = this.deps.toApiError(e).code
        if (!RETRYABLE.has(code)) break
        this.deps.log.debug('speech chunk retry', { replyId: this.replyId, index: p.index, code })
      }
    }
    this.inFlight--
    if (this.finished || signal.aborted) return
    if (!result) {
      this.fail(p.index, error)
      return
    }
    this.ready.set(p.index, { plan: p, result })
    this.pump()
  }

  private flush(): void {
    while (!this.finished && this.ready.has(this.nextSend)) {
      const item = this.ready.get(this.nextSend)!
      this.ready.delete(this.nextSend)
      this.nextSend++
      this.send(item)
    }
    if (!this.finished && this.ended && this.doc.finished && this.nextSend >= this.plans.length && this.inFlight === 0) this.finish('complete')
  }

  private send({ plan, result }: Ready): void {
    const last = this.ended && this.doc.finished && plan.index === this.plans.length - 1
    const header: SpeechChunkHeader = {
      sessionUid: this.target.sessionUid,
      evSeq: 0,
      replyId: this.replyId,
      index: plan.index,
      src: plan.src,
      text: this.doc.source.slice(plan.src[0], plan.src[1]),
      spoken: result ? plan.spoken : '',
      timeline: result?.timeline ?? null,
      durationMs: result ? Math.round(result.durationMs * 10) / 10 : 0,
      mime: result?.mime ?? 'audio/wav',
      instant: !result,
      final: last
    }
    const audio = result?.audio ?? new Uint8Array(0)
    for (const id of [...this.clients]) {
      const c = this.deps.hub.client(id)
      if (!c) {
        this.clients.delete(id)
        this.event({ kind: 'degraded', clientId: id, reason: 'speaker-left' })
        continue
      }
      if (!c.sendSpeech(header, audio)) {
        // 07 C16: this socket is too far behind — text-first for it, no more audio.
        this.clients.delete(id)
        this.deps.hub.emit(this.target.sessionUid, { t: 'speech.degraded', sessionUid: this.target.sessionUid, replyId: this.replyId, reason: 'backpressure' }, { only: id })
        this.event({ kind: 'degraded', clientId: id, reason: 'backpressure' })
      }
    }
    this.sent++
    if (result && this.firstAudioAt === null && this.clients.size) {
      this.firstAudioAt = this.deps.now()
      // Same origin as the chat engine's marks (ms since the turn was received; replays: since speech opened).
      const t0 = this.target.receivedAt ?? this.openedAt
      this.deps.hub.emit(this.target.sessionUid, { t: 'reply.timing', sessionUid: this.target.sessionUid, replyId: this.replyId, marks: { speechOpen: this.openedAt - t0, firstAudioSent: this.firstAudioAt - t0 } })
      this.event({ kind: 'first-audio' })
    }
    if (!this.clients.size) this.finish('backpressure')
  }

  private fail(index: number, e: unknown): void {
    if (this.finished) return
    const error = this.deps.toApiError(e)
    this.deps.log.warn('speech chunk failed', { replyId: this.replyId, index, code: error.code, upstreamStatus: error.upstreamStatus })
    this.deps.hub.emit(this.target.sessionUid, { t: 'speech.error', sessionUid: this.target.sessionUid, replyId: this.replyId, index, error })
    this.event({ kind: 'failed', index })
    this.finish('failed')
  }

  private finish(outcome: JobOutcome, announce = true): SinkResult {
    const complete = outcome === 'complete'
    const result: SinkResult = {
      chunks: this.sent,
      spokenChars: complete ? this.doc.source.length : this.revealed,
      interrupted: outcome === 'barge-in',
      failed: outcome === 'failed' || outcome === 'backpressure' || outcome === 'error'
    }
    if (this.finished) return result
    this.finished = true
    this.controller.abort()
    this.ready.clear()
    if (announce) {
      // Other devices learn that the speaker left (they already have the text); speech.end always closes the reply.
      if (outcome === 'speaker-left') this.deps.hub.emit(this.target.sessionUid, { t: 'speech.degraded', sessionUid: this.target.sessionUid, replyId: this.replyId, reason: 'speaker-left' })
      this.deps.hub.emit(this.target.sessionUid, { t: 'speech.end', sessionUid: this.target.sessionUid, replyId: this.replyId })
    }
    this.resolveDone(result)
    this.deps.onFinish?.(this, outcome, result)
    return result
  }
}
