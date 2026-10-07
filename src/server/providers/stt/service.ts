/**
 * SttService (07 E2, C17, D2, D6): per-client mic sessions over the WebSocket. A client sends `stt.start`, then binary
 * kind-2 frames (16 kHz Int16 mono, 32 ms each), then `stt.stop` / `stt.cancel`; it receives `stt.state`, `stt.vad`,
 * `stt.partial` and `stt.final {text, autoSend, durationMs}` (targeted at that client only, never sequenced).
 *
 * The local recognizer and the VAD run in the STT utility process (SttProcess), spawned on the first start and
 * unloaded after `voice.stt.unloadAfterMin` idle. Cloud providers use the same process for VAD + endpointing (no
 * model, a few MB) and upload each finished utterance as a WAV. The client turns `stt.final {autoSend:true}` into its
 * own `chat.send` (it owns the composer, attachments and the countdown ring), so no chat turn starts here.
 */
import { randomBytes } from 'node:crypto'
import { apiError, VesperError, type ApiError, type ErrorCode } from '@shared/errors'
import type { ModelEntry, SttModelInfo } from '@shared/models'
import type { Settings } from '@shared/settings'
import type { ClientMsg } from '@shared/ws'
import type { WorkerHandle } from '../../platform'
import type { Log, SecretsService, SettingsStore, SttService, WsClient } from '../../services'
import type { ModelManager } from '../../models/manager'
import { CLOUD_PROVIDERS, cloudModel, isCloud, keyFor, providerUrl, transcribe } from './cloud'
import { segmentSilenceMs } from './endpointer'
import { encodeWav, pcmFromBytes } from './pcm'
import { DEFAULT_THREADS, SAMPLE_RATE, type FromProcess, type LoadSpec, type MicOptions, type ProcessStats, type SttMode } from './protocol'
import { SttProcess, type ProcessEvent } from './processClient'

type SttState = 'warming-up' | 'listening' | 'transcribing' | 'idle' | 'error'
type StartMsg = Extract<ClientMsg, { t: 'stt.start' }>
type StopReason = Extract<ClientMsg, { t: 'stt.stop' }>['reason']

export interface SttServiceDeps {
  settings: SettingsStore
  secrets: SecretsService
  log: Log
  now(): number
  manager: ModelManager
  fork(): WorkerHandle
  vadModel: string
  /** VESPER_STT_FAKE (test builds): scripted recognizer, real VAD. */
  fake?: { texts?: string[] } | null
  /** Overrides `voice.stt.unloadAfterMin` (tests). */
  idleUnloadMs?: number
  backoffMs?: readonly number[]
  loadTimeoutMs?: number
  /** Overrides the pause before a cloud transcription is retried (tests). */
  cloudRetryMs?: number
}

interface Mic {
  micId: string
  client: WsClient
  mode: SttMode
  /** The conversation the mic is for (stt.start), for transcript listeners (07 D6 recall prefetch). */
  sessionUid: string | null
  provider: Settings['voice']['stt']['provider']
  autoSendDictation: boolean
  language: string
  cloudModel: string | null
  state: SttState
  /** Latest stt.tts-active from the client (applied at open when it arrives while the model loads). */
  ttsActive: boolean
  /** The process has the session (open was posted). */
  opened: boolean
  /** Frames that arrived while the model was loading (bounded). */
  early: Int16Array[]
  earlySamples: number
  stopReason: StopReason | null
  closing: boolean
  processClosed: boolean
  cloudJobs: Set<AbortController>
}

/** A transcript as it reaches its client (see SttServiceImpl.onTranscript). */
export interface TranscriptEvent {
  clientId: string
  sessionUid: string | null
  mode: SttMode
  kind: 'partial' | 'final'
  text: string
}

/** Frames kept while the model loads (Parakeet takes ~1.2 s; research 05 §3.5). */
const MAX_EARLY_SAMPLES = 20 * SAMPLE_RATE
/** One frame may carry at most a second of audio. */
const MAX_FRAME_SAMPLES = SAMPLE_RATE
/** Cloud transcription errors worth one more try, and the pause before it (07 C19). */
const CLOUD_RETRY_MS: Partial<Record<ErrorCode, number>> = { network: 400, provider_overloaded: 600, provider_rate: 1200 }

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class SttServiceImpl implements SttService {
  readonly proc: SttProcess
  private readonly byClient = new Map<string, Mic>()
  private readonly byMic = new Map<string, Mic>()
  private idleTimer: NodeJS.Timeout | null = null
  private readonly unsubscribe: () => void
  private readonly offProc: () => void
  private lastSpec: LoadSpec | null = null
  private closed = false
  private readonly activity = new Set<(devices: string[]) => void>()
  private readonly transcripts = new Set<(e: TranscriptEvent) => void>()
  private lastActivity = ''

  constructor(private readonly d: SttServiceDeps) {
    this.proc = new SttProcess({ fork: d.fork, log: d.log, now: d.now, backoffMs: d.backoffMs, loadTimeoutMs: d.loadTimeoutMs })
    this.offProc = this.proc.onEvent((e) => this.onProcess(e))
    this.unsubscribe = d.settings.subscribe('voice.stt', (next, prev) => this.onSettings(next, prev))
  }

  // ── SttService ────────────────────────────────────────────────────────────────────────────
  async models(): Promise<SttModelInfo[]> {
    const s = this.d.settings.get().voice.stt
    return this.d.manager.list(s.provider === 'local' ? s.model : null)
  }

  download(id: string): Promise<void> {
    return this.d.manager.download(id)
  }

  async remove(id: string): Promise<void> {
    // A loaded model is unloaded before its files go (Windows cannot delete open files).
    if (this.lastSpec?.model?.id === id && this.proc.alive) {
      this.endAll(apiError('stt_model_missing'))
      await this.proc.stop()
    }
    await this.d.manager.remove(id)
  }

  /** "Unload voice models now" (07 D2): ends open mics and stops the process. */
  async unload(): Promise<void> {
    this.endAll(null)
    this.clearIdle()
    await this.proc.stop()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.offProc()
    this.activity.clear()
    this.clearIdle()
    this.endAll(null)
    await this.proc.close()
    await this.d.manager.close()
  }

  // ── Mic sessions (WS) ─────────────────────────────────────────────────────────────────────
  /** stt.start: validates, answers with ack (or an error with the id), then streams states. */
  async start(client: WsClient, msg: StartMsg): Promise<void> {
    if (this.closed) throw new VesperError('stt_unavailable', { status: 503 })
    if (msg.sampleRate !== SAMPLE_RATE) throw new VesperError('validation', { fields: { sampleRate: 'Only 16000 Hz is supported' } })
    const mode: SttMode = msg.mode === 'ptt' || msg.mode === 'conversation' ? msg.mode : 'dictate'
    const s = this.d.settings.get().voice.stt
    const spec = this.specFor(s)
    let cloud: string | null = null
    if (isCloud(s.provider)) {
      const p = CLOUD_PROVIDERS[s.provider]
      await keyFor(this.d.secrets, p, providerUrl(p.endpoint)) // fail fast without a key
      cloud = cloudModel(p, s.model)
    }
    // One mic per client: a new start replaces the old session (checked after the await, so two racing starts
    // cannot both survive).
    const prev = this.byClient.get(client.id)
    if (prev) this.finish(prev, null, true)
    const mic: Mic = {
      micId: `m_${randomBytes(6).toString('base64url')}`,
      client,
      mode,
      sessionUid: typeof msg.sessionUid === 'string' && msg.sessionUid.length <= 64 ? msg.sessionUid : null,
      provider: s.provider,
      autoSendDictation: s.autoSendDictation,
      language: s.language,
      cloudModel: cloud,
      state: 'idle',
      ttsActive: !!msg.ttsActive,
      opened: false,
      early: [],
      earlySamples: 0,
      stopReason: null,
      closing: false,
      processClosed: false,
      cloudJobs: new Set()
    }
    this.byClient.set(client.id, mic)
    this.notifyActivity()
    this.byMic.set(mic.micId, mic)
    this.clearIdle()
    const opts: MicOptions = {
      mode,
      silenceMs: s.silenceMs,
      lang: s.language,
      ttsActive: !!msg.ttsActive,
      bargeIn: s.bargeIn,
      vadThreshold: s.vadThreshold,
      preRollMs: s.preRollMs,
      maxUtteranceMs: s.maxUtteranceSec * 1000,
      wantAudio: cloud !== null,
      partials: cloud === null
    }
    this.setState(mic, this.proc.loaded === spec.key ? 'listening' : 'warming-up')
    this.lastSpec = spec
    void this.proc.load(spec).then(
      () => {
        if (this.byMic.get(mic.micId) !== mic) return
        this.proc.post({ t: 'open', micId: mic.micId, o: { ...opts, ttsActive: mic.ttsActive } })
        mic.opened = true
        for (const pcm of mic.early) this.proc.post({ t: 'frames', micId: mic.micId, pcm })
        mic.early = []
        mic.earlySamples = 0
        if (mic.closing) this.proc.post({ t: 'close', micId: mic.micId, reason: mic.stopReason ? 'stop' : 'cancel' })
        else this.setState(mic, 'listening')
      },
      (e: unknown) => {
        if (this.byMic.get(mic.micId) !== mic) return
        this.finish(mic, this.toError(e), false)
      }
    )
  }

  /** Binary kind 2: one mic frame. Frames without a session (or malformed) are ignored. */
  frame(client: WsClient, payload: Uint8Array): void {
    const mic = this.byClient.get(client.id)
    if (!mic || mic.closing) return
    const pcm = pcmFromBytes(payload)
    if (!pcm || pcm.length > MAX_FRAME_SAMPLES) return
    if (mic.opened) return this.proc.post({ t: 'frames', micId: mic.micId, pcm })
    if (mic.earlySamples + pcm.length > MAX_EARLY_SAMPLES) return
    mic.early.push(pcm)
    mic.earlySamples += pcm.length
  }

  /** stt.stop: finish the current utterance (push-to-talk release / "send now"), then end the session. */
  stop(client: WsClient, reason: StopReason): void {
    const mic = this.byClient.get(client.id)
    if (!mic || mic.closing) return
    mic.stopReason = reason ?? 'released'
    mic.closing = true
    if (mic.opened) this.proc.post({ t: 'close', micId: mic.micId, reason: 'stop' })
  }

  /** stt.cancel: drop the utterance and end the session at once. */
  cancel(client: WsClient): void {
    const mic = this.byClient.get(client.id)
    if (mic) this.finish(mic, null, true)
  }

  ttsActive(client: WsClient, active: boolean): void {
    const mic = this.byClient.get(client.id)
    if (!mic) return
    mic.ttsActive = !!active
    if (mic.opened) this.proc.post({ t: 'ttsActive', micId: mic.micId, active: mic.ttsActive })
  }

  disconnect(client: WsClient): void {
    const mic = this.byClient.get(client.id)
    if (mic) this.finish(mic, null, true, false)
  }

  /** Device ids streaming mic audio right now (07 B17: the tray's red dot). */
  /**
   * Called whenever the set of devices with an open mic changes (07 B17: the tray's red dot). Returns an unsubscribe.
   */
  onMicActivity(fn: (devices: string[]) => void): () => void {
    this.activity.add(fn)
    return () => void this.activity.delete(fn)
  }

  /**
   * Every stt.partial / stt.final as it is sent to its client (Phase 3 engine-int: the chat engine starts the memory
   * query embedding on the first ≥ 4-word partial, 07 D6). Listeners must be cheap; failures are logged. Returns an
   * unsubscribe.
   */
  onTranscript(fn: (e: TranscriptEvent) => void): () => void {
    this.transcripts.add(fn)
    return () => void this.transcripts.delete(fn)
  }

  private transcript(mic: Mic, kind: 'partial' | 'final', text: string): void {
    for (const fn of this.transcripts) {
      try {
        fn({ clientId: mic.client.id, sessionUid: mic.sessionUid, mode: mic.mode, kind, text })
      } catch (e) {
        this.d.log.warn('transcript listener failed', { error: e })
      }
    }
  }

  private notifyActivity(): void {
    const devices = this.streamingDevices()
    const key = devices.join(',')
    if (key === this.lastActivity) return
    this.lastActivity = key
    for (const fn of this.activity) {
      try {
        fn(devices)
      } catch (e) {
        this.d.log.warn('mic activity listener failed', { error: e })
      }
    }
  }

  streamingDevices(): string[] {
    return [...new Set([...this.byClient.values()].map((m) => m.client.device.id))]
  }

  /** Load the configured model ahead of the first utterance (07 D6: Talk mode opened, mic armed). */
  async prewarm(): Promise<void> {
    const spec = this.specFor(this.d.settings.get().voice.stt)
    this.lastSpec = spec
    await this.proc.load(spec)
    if (!this.byClient.size) this.armIdle()
  }

  async stats(): Promise<{ mics: number; byMic: number; earlyFrames: number; cloudJobs: number; process: ProcessStats | null; alive: boolean; spawned: number; idleTimer: boolean }> {
    let early = 0
    let jobs = 0
    for (const m of this.byClient.values()) {
      early += m.early.length
      jobs += m.cloudJobs.size
    }
    return { mics: this.byClient.size, byMic: this.byMic.size, earlyFrames: early, cloudJobs: jobs, process: await this.proc.stats(), alive: this.proc.alive, spawned: this.proc.spawned, idleTimer: this.idleTimer !== null }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────
  private specFor(s: Settings['voice']['stt']): LoadSpec {
    const fake = !!this.d.fake && s.provider === 'local'
    let model: LoadSpec['model'] = null
    if (s.provider === 'local') {
      const e: ModelEntry | undefined = this.d.manager.entry(s.model)
      if (!e) throw new VesperError('stt_model_missing', { status: 409 })
      const at = this.d.manager.resolve(e.id)
      if (!at && !fake) throw new VesperError('stt_model_missing', { status: 409 })
      model = { id: e.id, family: e.family, dir: at?.dir ?? '' }
    }
    const lang = s.language || 'auto'
    const key = [model?.id ?? 'vad-only', model?.dir ?? '', fake ? 'fake' : 'real', lang, DEFAULT_THREADS].join('|')
    return { key, model, vadModel: this.d.vadModel, threads: DEFAULT_THREADS, lang, fake, ...(fake && this.d.fake?.texts ? { fakeTexts: this.d.fake.texts } : {}) }
  }

  private setState(mic: Mic, state: SttState, error?: ApiError): void {
    if (mic.state === state && !error) return
    mic.state = state
    mic.client.send(error ? { t: 'stt.state', state, error } : { t: 'stt.state', state })
  }

  private toError(e: unknown): ApiError {
    if (e instanceof VesperError) return e.info
    return apiError('stt_unavailable')
  }

  /**
   * End a mic session. `tellProcess` posts a cancel (false when the process is gone). The client gets `idle`, or
   * `error` with the reason (not after a disconnect: nobody is listening).
   */
  private finish(mic: Mic, error: ApiError | null, tellProcess: boolean, notify = true): void {
    if (this.byMic.get(mic.micId) !== mic) return
    this.byMic.delete(mic.micId)
    if (this.byClient.get(mic.client.id) === mic) this.byClient.delete(mic.client.id)
    this.notifyActivity()
    for (const c of mic.cloudJobs) c.abort()
    mic.cloudJobs.clear()
    mic.early = []
    mic.earlySamples = 0
    if (tellProcess && mic.opened && !mic.processClosed) this.proc.post({ t: 'close', micId: mic.micId, reason: 'cancel' })
    if (notify) this.setState(mic, error ? 'error' : 'idle', error ?? undefined)
    if (!this.byClient.size) this.armIdle()
  }

  private endAll(error: ApiError | null): void {
    for (const mic of [...this.byMic.values()]) this.finish(mic, error, true)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** 07 D2: the process exits after `voice.stt.unloadAfterMin` without a mic session. */
  private armIdle(): void {
    this.clearIdle()
    if (this.closed || !this.proc.alive) return
    const ms = this.d.idleUnloadMs ?? this.d.settings.get().voice.stt.unloadAfterMin * 60_000
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.byClient.size) void this.proc.stop()
    }, ms)
    this.idleTimer.unref?.()
  }

  private autoSend(mic: Mic): boolean {
    if (mic.mode === 'conversation' || mic.mode === 'ptt') return true
    return mic.autoSendDictation || mic.stopReason === 'send'
  }

  private onProcess(e: ProcessEvent): void {
    if (e.t === 'exit') return this.onExit(e.expected)
    if (!('micId' in e) || !e.micId) return
    const mic = this.byMic.get(e.micId)
    if (!mic) return
    switch (e.t) {
      case 'vad': {
        // `speaking:false` arrives when the first-stage segment closes, i.e. segmentSilenceMs after the last speech.
        const silence = this.d.settings.get().voice.stt.silenceMs
        const silenceLeft = !e.speaking && mic.mode !== 'ptt' ? Math.max(0, silence - segmentSilenceMs(silence)) : undefined
        mic.client.send(silenceLeft === undefined ? { t: 'stt.vad', speaking: e.speaking } : { t: 'stt.vad', speaking: false, endpointInMs: silenceLeft })
        return
      }
      case 'endpoint':
        return this.setState(mic, 'transcribing')
      case 'partial':
        mic.client.send({ t: 'stt.partial', text: e.text })
        return this.transcript(mic, 'partial', e.text)
      case 'final':
        return this.onFinal(mic, e)
      case 'closed':
        mic.processClosed = true
        return this.maybeDone(mic)
      case 'error':
        if (e.code !== 'internal') this.finish(mic, apiError(e.code), true)
        return
    }
  }

  private onFinal(mic: Mic, f: Extract<FromProcess, { t: 'final' }>): void {
    if (f.dropped) return this.afterFinal(mic)
    if (mic.cloudModel !== null && mic.provider !== 'local') {
      if (!f.audio) return this.afterFinal(mic)
      return void this.cloudFinal(mic, f.audio, f.durationMs)
    }
    mic.client.send({ t: 'stt.final', text: f.text, autoSend: this.autoSend(mic), durationMs: f.durationMs })
    this.transcript(mic, 'final', f.text)
    this.afterFinal(mic)
  }

  /**
   * Upload one utterance to the cloud provider. A transient failure (network, 5xx, 429) is retried once after a short
   * pause (07 C19 "overloaded/network → one retry"). If it still fails the utterance is lost: the mic session ends
   * with the error (F35) — the server never keeps a session the client has given up on (and the STT process can idle
   * out). Talk mode reopens a new session by itself after a transient error.
   */
  private async cloudFinal(mic: Mic, audio: Int16Array, durationMs: number): Promise<void> {
    if (mic.provider === 'local' || mic.cloudModel === null) return
    const p = CLOUD_PROVIDERS[mic.provider]
    const ctrl = new AbortController()
    mic.cloudJobs.add(ctrl)
    const gone = (): boolean => ctrl.signal.aborted || this.byMic.get(mic.micId) !== mic
    let failed: ApiError | null = null
    try {
      const key = await keyFor(this.d.secrets, p, providerUrl(p.endpoint))
      const wav = encodeWav(audio, SAMPLE_RATE)
      let text = ''
      for (let attempt = 0; ; attempt++) {
        try {
          text = await transcribe(p, { wav, model: mic.cloudModel, language: mic.language, key, signal: ctrl.signal })
          break
        } catch (e) {
          if (gone()) return
          const err = this.toError(e)
          const pause = CLOUD_RETRY_MS[err.code]
          if (attempt > 0 || pause === undefined) throw e
          this.d.log.debug('cloud stt retry', { provider: p.id, code: err.code, upstreamStatus: err.upstreamStatus })
          await abortableSleep(this.d.cloudRetryMs ?? pause, ctrl.signal)
          if (gone()) return
        }
      }
      if (gone()) return
      if (text) {
        mic.client.send({ t: 'stt.final', text, autoSend: this.autoSend(mic), durationMs })
        this.transcript(mic, 'final', text)
      }
    } catch (e) {
      if (gone()) return
      failed = this.toError(e)
      this.d.log.warn('cloud stt failed', { provider: p.id, code: failed.code, upstreamStatus: failed.upstreamStatus })
    } finally {
      mic.cloudJobs.delete(ctrl)
    }
    if (failed) return this.finish(mic, failed, true)
    this.afterFinal(mic)
  }

  private afterFinal(mic: Mic): void {
    if (this.byMic.get(mic.micId) !== mic) return
    if (mic.closing) return this.maybeDone(mic)
    this.setState(mic, 'listening')
  }

  private maybeDone(mic: Mic): void {
    if (mic.processClosed && mic.closing && mic.cloudJobs.size === 0) this.finish(mic, null, false)
    else if (mic.processClosed && !mic.closing) this.finish(mic, null, false)
  }

  private onExit(expected: boolean): void {
    if (this.closed) return
    // 07 C17: sessions living in that process fail with stt_crashed. Sessions still waiting for a model belong to the
    // NEXT process (a model switch stops the old one first) and learn their fate from their own load.
    const live = [...this.byMic.values()].filter((m) => m.opened)
    for (const m of live) this.finish(m, expected ? apiError('stt_unavailable') : apiError('stt_crashed'), false)
    const hadMics = live.length > 0
    this.clearIdle()
    if (!expected && hadMics && this.lastSpec) {
      // Restart in the background (backoff inside load) so the client's retry finds a warm model.
      const spec = this.lastSpec
      void this.proc.load(spec).then(
        () => this.armIdle(),
        (e: unknown) => this.d.log.warn('stt restart failed', { code: this.toError(e).code })
      )
    }
  }

  private onSettings(next: Settings, prev: Settings): void {
    const a = prev.voice.stt
    const b = next.voice.stt
    const live: Partial<MicOptions> = {}
    if (a.silenceMs !== b.silenceMs) live.silenceMs = b.silenceMs
    if (a.vadThreshold !== b.vadThreshold) live.vadThreshold = b.vadThreshold
    if (a.preRollMs !== b.preRollMs) live.preRollMs = b.preRollMs
    if (a.maxUtteranceSec !== b.maxUtteranceSec) live.maxUtteranceMs = b.maxUtteranceSec * 1000
    if (a.bargeIn !== b.bargeIn) live.bargeIn = b.bargeIn
    if (Object.keys(live).length) for (const m of this.byMic.values()) if (m.opened) this.proc.post({ t: 'update', micId: m.micId, o: live })
    for (const m of this.byMic.values()) m.autoSendDictation = b.autoSendDictation
    // Another model/provider/language: free the old model now when nobody is talking; else at the next start.
    if ((a.provider !== b.provider || a.model !== b.model || a.language !== b.language) && !this.byMic.size && this.proc.alive) {
      this.clearIdle()
      void this.proc.stop()
    }
    if (a.unloadAfterMin !== b.unloadAfterMin && !this.byClient.size) this.armIdle()
  }
}
