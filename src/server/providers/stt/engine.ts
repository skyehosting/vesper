/**
 * The STT process's brain (07 C17), separate from the process shell (src/workers/stt.process.ts) so it can be tested
 * in-process. One shared recognizer, one VAD + Endpointer per open mic. Messages are handled strictly in order; a
 * `load` holds the inbox until the model is ready, so the server may send `open` and frames right behind it.
 * Decodes run one at a time on a separate queue (the recognizer is shared), never blocking the inbox: VAD keeps
 * running in real time while a segment or a final is being transcribed.
 */
import { Endpointer, guardFinal, segmentSilenceMs, type FinalAudio, type VadLike } from './endpointer'
import { float32ToInt16, int16ToFloat32 } from './pcm'
import { MIN_SPEECH_MS, type FromProcess, type LoadSpec, type MicOptions, type ProcessStats, type ToProcess } from './protocol'
import type { VadConfig } from './sherpa'

export interface Recognizer {
  decode(samples: Float32Array, kind: 'partial' | 'final'): Promise<string>
}

export interface EngineDeps {
  post(m: FromProcess): void
  createVad(c: VadConfig): VadLike
  createRecognizer(spec: LoadSpec): Promise<Recognizer | null>
  rssMB?(): number
}

/** The fake recognizer's default transcript: what tests/fixtures/audio/hello.wav says (05 §5, VESPER_STT_FAKE). */
export const FAKE_DEFAULT_TEXT = 'Hello Vesper, can you hear me?'

/** VESPER_STT_FAKE: scripted transcripts (one per final, the last one repeats); partials preview the next one. */
export function fakeRecognizer(texts: readonly string[] | undefined): Recognizer {
  const queue = texts?.length ? [...texts] : [FAKE_DEFAULT_TEXT]
  return {
    async decode(_samples, kind) {
      const text = queue[0]
      if (kind === 'final' && queue.length > 1) queue.shift()
      return text
    }
  }
}

interface Session {
  micId: string
  ep: Endpointer
  /** Pool key of the VAD in use; null once it went back to the pool. */
  vadKey: string | null
  partialTexts: string[]
  closing: boolean
}

const MAX_INBOX = 4096
const VAD_POOL_MAX = 4

export class SttEngine {
  private spec: LoadSpec | null = null
  private recognizer: Recognizer | null = null
  private loading = false
  private readonly inbox: ToProcess[] = []
  private pumping = false
  private readonly sessions = new Map<string, Session>()
  private readonly pool = new Map<string, VadLike[]>()
  private decodeChain: Promise<void> = Promise.resolve()
  private decodesQueued = 0
  private closed = false

  constructor(private readonly deps: EngineDeps) {}

  handle(m: ToProcess): void {
    if (this.closed) return
    if (m.t === 'frames' && !this.loading && !this.inbox.length) return this.frames(m.micId, m.pcm)
    if (this.inbox.length >= MAX_INBOX && m.t === 'frames') return // a stalled load must not grow memory without bound
    this.inbox.push(m)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.inbox.length && !this.closed) {
        const m = this.inbox.shift() as ToProcess
        if (m.t === 'load') await this.load(m.spec)
        else this.dispatch(m)
      }
    } finally {
      this.pumping = false
    }
  }

  private dispatch(m: Exclude<ToProcess, { t: 'load' }>): void {
    switch (m.t) {
      case 'open':
        return this.open(m.micId, m.o)
      case 'update':
        return this.update(m.micId, m.o)
      case 'frames':
        return this.frames(m.micId, m.pcm)
      case 'ttsActive':
        return this.sessions.get(m.micId)?.ep.setTtsActive(m.active)
      case 'close':
        return this.close(m.micId, m.reason)
      case 'stats':
        return this.deps.post({ t: 'stats', stats: this.stats() })
      case 'unload':
        this.unload()
        return this.deps.post({ t: 'unloaded' })
    }
  }

  private async load(spec: LoadSpec): Promise<void> {
    if (this.spec?.key === spec.key && (this.recognizer || !spec.model || spec.fake)) {
      this.deps.post({ t: 'loaded', key: spec.key, ms: 0 })
      return
    }
    this.loading = true
    const t0 = Date.now()
    try {
      this.recognizer = await this.deps.createRecognizer(spec)
      this.spec = spec
      this.deps.post({ t: 'loaded', key: spec.key, ms: Date.now() - t0 })
    } catch (e) {
      this.recognizer = null
      this.spec = null
      const missing = e instanceof Error && e.name === 'ModelFilesMissing'
      this.deps.post({ t: 'loadError', key: spec.key, code: missing ? 'stt_model_missing' : 'stt_unavailable', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      this.loading = false
    }
  }

  private vadConfig(o: MicOptions): VadConfig {
    return { model: this.spec?.vadModel ?? '', threshold: o.vadThreshold, minSilence: segmentSilenceMs(o.silenceMs) / 1000 }
  }

  private takeVad(c: VadConfig): { vad: VadLike; key: string } {
    const key = `${c.threshold}|${c.minSilence}`
    const idle = this.pool.get(key)
    const vad = idle?.pop() ?? this.deps.createVad(c)
    if (idle && !idle.length) this.pool.delete(key)
    return { vad, key }
  }

  /** VADs are reused (reset) rather than left to the native finalizers: 100 mic sessions must not mean 100 detectors. */
  private releaseVad(key: string, vad: VadLike): void {
    let pooled = 0
    for (const l of this.pool.values()) pooled += l.length
    if (pooled >= VAD_POOL_MAX) return
    vad.reset()
    const l = this.pool.get(key) ?? []
    l.push(vad)
    this.pool.set(key, l)
  }

  private open(micId: string, o: MicOptions): void {
    if (!this.spec) return this.deps.post({ t: 'error', micId, code: 'stt_unavailable', detail: 'not loaded' })
    const prev = this.sessions.get(micId)
    if (prev) this.dropSession(prev)
    const { vad, key } = this.takeVad(this.vadConfig(o))
    const s: Session = { micId, ep: null as unknown as Endpointer, vadKey: key, partialTexts: [], closing: false }
    s.ep = new Endpointer(vad, { ...o, partials: o.partials && !!this.recognizer }, {
      vad: (speaking) => this.deps.post({ t: 'vad', micId, speaking }),
      segment: (audio, utt) => this.partial(s, audio, utt),
      endpoint: () => this.deps.post({ t: 'endpoint', micId }),
      final: (f, utt) => this.final(s, f, utt)
    })
    this.sessions.set(micId, s)
  }

  private update(micId: string, o: Partial<MicOptions>): void {
    const s = this.sessions.get(micId)
    if (!s || s.vadKey === null) return
    const before = this.vadConfig(s.ep.options)
    s.ep.update(o)
    const after = this.vadConfig(s.ep.options)
    if (before.threshold !== after.threshold || before.minSilence !== after.minSilence) {
      const { vad, key } = this.takeVad(after)
      this.releaseVad(s.vadKey, s.ep.replaceVad(vad))
      s.vadKey = key
    }
  }

  private frames(micId: string, pcm: Int16Array): void {
    const s = this.sessions.get(micId)
    if (!s || s.closing || !(pcm instanceof Int16Array)) return
    s.ep.push(int16ToFloat32(pcm))
  }

  private close(micId: string, reason: 'stop' | 'cancel'): void {
    const s = this.sessions.get(micId)
    if (!s) return this.deps.post({ t: 'closed', micId })
    if (reason === 'stop') s.ep.stop()
    else s.ep.cancel()
    s.closing = true
    // The final (if any) already holds its audio: the VAD can serve the next session right away.
    this.detachVad(s)
    // `closed` goes behind any final this stop produced, so the server sees final → closed in order.
    this.enqueue(async () => {
      this.dropSession(s)
      this.deps.post({ t: 'closed', micId })
    })
  }

  private detachVad(s: Session): void {
    if (s.vadKey === null) return
    const key = s.vadKey
    s.vadKey = null
    this.releaseVad(key, s.ep.replaceVad(NULL_VAD))
  }

  private dropSession(s: Session): void {
    if (this.sessions.get(s.micId) !== s) return
    this.sessions.delete(s.micId)
    s.ep.cancel()
    this.detachVad(s)
  }

  private enqueue(job: () => Promise<void>): void {
    this.decodesQueued++
    this.decodeChain = this.decodeChain
      .then(job)
      .catch((e: unknown) => this.deps.post({ t: 'error', code: 'internal', detail: e instanceof Error ? e.message : String(e) }))
      .finally(() => void this.decodesQueued--)
  }

  private partial(s: Session, audio: Float32Array, utt: number): void {
    const rec = this.recognizer
    if (!rec) return
    this.enqueue(async () => {
      // Stale once the utterance was finalized or the session went away: the final re-decode supersedes it.
      if (this.sessions.get(s.micId) !== s || s.closing || s.ep.utterance !== utt) return
      const text = await rec.decode(audio, 'partial')
      if (this.sessions.get(s.micId) !== s || s.ep.utterance !== utt || !text) return
      s.partialTexts.push(text)
      this.deps.post({ t: 'partial', micId: s.micId, text: s.partialTexts.join(' ') })
    })
  }

  private final(s: Session, f: FinalAudio, _utt: number): void {
    s.partialTexts = []
    const rec = this.recognizer
    const o = s.ep.options
    this.enqueue(async () => {
      const base = { t: 'final' as const, micId: s.micId, durationMs: f.durationMs, speechMs: f.speechMs }
      if (f.speechMs < MIN_SPEECH_MS) return this.deps.post({ ...base, text: '', dropped: 'short' })
      if (!rec) return this.deps.post({ ...base, text: '', ...(o.wantAudio ? { audio: float32ToInt16(f.audio) } : {}) })
      let text: string
      try {
        text = await rec.decode(f.audio, 'final')
      } catch (e) {
        this.deps.post({ t: 'error', micId: s.micId, code: 'stt_unavailable', detail: e instanceof Error ? e.message : String(e) })
        return this.deps.post({ ...base, text: '', dropped: 'empty' })
      }
      const dropped = guardFinal(text, f.speechMs, f.rms)
      this.deps.post(dropped ? { ...base, text: '', dropped } : { ...base, text, ...(o.wantAudio ? { audio: float32ToInt16(f.audio) } : {}) })
    })
  }

  stats(): ProcessStats {
    let buffered = 0
    for (const s of this.sessions.values()) buffered += s.ep.bufferedSamples
    let pooled = 0
    for (const l of this.pool.values()) pooled += l.length
    return {
      sessions: this.sessions.size,
      bufferedSamples: buffered,
      vads: this.sessions.size + pooled,
      decodesQueued: this.decodesQueued,
      rssMB: this.deps.rssMB?.() ?? 0,
      loaded: this.spec?.key ?? null
    }
  }

  /** Drop the recognizer, sessions and pooled VADs (the host process exits right after, which frees native memory). */
  unload(): void {
    for (const s of [...this.sessions.values()]) this.dropSession(s)
    this.pool.clear()
    this.recognizer = null
    this.spec = null
    this.inbox.length = 0
    this.closed = true
  }
}

/** Placeholder VAD for a dropped session (its real VAD went back to the pool). */
const NULL_VAD: VadLike = {
  acceptWaveform: () => undefined,
  isDetected: () => false,
  isEmpty: () => true,
  front: () => ({ start: 0, samples: new Float32Array(0) }),
  pop: () => undefined,
  flush: () => undefined,
  reset: () => undefined
}
