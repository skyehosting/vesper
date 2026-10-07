/**
 * MicCapture (07 E4, 02 §6.2): getUserMedia (audio only) → MediaStreamSource → { analyser (input levels),
 * AudioWorklet (16 kHz Int16 frames of 512) }. Nothing is connected to the destination (no feedback; research 07
 * §2.3). The worklet module is a same-origin file under /worklets/ (CSP-safe, spike S6).
 *
 * Lifecycle: `start` replaces any running capture; `stop` stops the tracks, disconnects every node, tells the
 * processor to finish and closes its port, and releases the shared context. A `stop` during a pending `start` wins
 * (the late stream is stopped at once).
 */
import { apiError } from '@shared/errors'
import { ApiErrorException } from '../errors.logic'
import type { ContextHost } from '../audio/context'
import { count } from '../audio/counters'
import { AnalyserLevels, configureAnalyser, configureScope } from '../audio/levelSource'
import type { MicCapture, MicConstraints } from '../audio/types'
import { micEnvironmentError, micErrorCode, type MicEnvironment } from './errors.logic'

export const WORKLET_URL = '/worklets/mic-capture.js'
export const PROCESSOR_NAME = 'vesper-mic-capture'
export const MIC_RATE = 16000
export const FRAME_SAMPLES = 512
let instances = 0

interface Session {
  /** Context hold of this capture (one per start, so an abandoned start never releases a newer one's hold). */
  hold: string
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  scope: AnalyserNode
  node: AudioWorkletNode
}

export interface MicStats {
  active: boolean
  frames: number
  /** performance.now() of the first and the latest frame of this capture. */
  firstFrameAt: number
  lastFrameAt: number
  /** Length of the latest frame (always FRAME_SAMPLES). */
  frameSamples: number
  /** The track's settings as granted (echo cancellation etc.), for diagnostics. */
  settings: MediaTrackSettings | null
}

export interface MicDeps {
  host: ContextHost
  environment?: () => MicEnvironment
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>
  perfNow?: () => number
}

function browserEnvironment(): MicEnvironment {
  const ctor = typeof AudioWorkletNode !== 'undefined'
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    hasGetUserMedia: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasAudioWorklet: ctor
  }
}

interface AudioSessionLike {
  type: string
}

function setAudioSession(type: 'playback' | 'play-and-record'): void {
  const s = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession
  if (s) s.type = type
}

export function audioConstraints(c: MicConstraints, withDevice = true): MediaTrackConstraints {
  return {
    ...(withDevice && c.deviceId ? { deviceId: { exact: c.deviceId } } : {}),
    channelCount: 1,
    echoCancellation: c.echoCancellation ?? true,
    noiseSuppression: c.noiseSuppression ?? true,
    autoGainControl: c.autoGainControl ?? true
  }
}

export class WorkletMicCapture implements MicCapture {
  readonly input: AnalyserLevels
  private readonly host: ContextHost
  private readonly env: () => MicEnvironment
  private readonly gum: (c: MediaStreamConstraints) => Promise<MediaStream>
  private readonly perfNow: () => number
  private session: Session | null = null
  private gen = 0
  private readonly frameCbs = new Set<(pcm16: Int16Array) => void>()
  private readonly endedCbs = new Set<(code: 'mic_os_blocked') => void>()
  private readonly modules = new WeakMap<BaseAudioContext, Promise<void>>()
  private frames = 0
  private firstFrameAt = 0
  private lastFrameAt = 0
  private frameSamples = 0
  private readonly holdKey = `mic#${++instances}`

  constructor(d: MicDeps) {
    this.host = d.host
    this.env = d.environment ?? browserEnvironment
    this.gum = d.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c))
    this.perfNow = d.perfNow ?? (() => performance.now())
    this.input = new AnalyserLevels(() => this.session !== null, this.perfNow)
  }

  async start(constraints: MicConstraints = {}): Promise<void> {
    this.stop()
    const gen = ++this.gen
    const pre = micEnvironmentError(this.env())
    if (pre) throw new ApiErrorException(apiError(pre))

    const stream = await this.open(constraints)
    count('streams', 1)
    const abandon = (): void => {
      stopTracks(stream)
      count('streams', -1)
    }
    if (gen !== this.gen) return abandon()

    const hold = `${this.holdKey}.${gen}`
    let ctx: AudioContext
    try {
      setAudioSession('play-and-record')
      await this.host.hold(hold)
      ctx = this.host.get()
      await this.loadModule(ctx)
    } catch {
      abandon()
      this.host.release(hold)
      setAudioSession('playback')
      // The worklet module failed to load (missing file, CSP) or the context could not start.
      throw new ApiErrorException(apiError('internal'))
    }
    if (gen !== this.gen) {
      // stop() ran while the worklet loaded.
      abandon()
      this.host.release(hold)
      setAudioSession('playback')
      return
    }

    const source = ctx.createMediaStreamSource(stream)
    const analyser = configureAnalyser(ctx.createAnalyser())
    const scope = configureScope(ctx.createAnalyser())
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      // No outputs: Chromium pulls output-less worklet nodes on its own, and nothing can leak to the speakers.
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { targetRate: MIC_RATE, frameSamples: FRAME_SAMPLES }
    })
    count('nodes', 4)
    count('ports', 1)
    source.connect(analyser)
    source.connect(scope)
    source.connect(node)
    node.port.onmessage = (e: MessageEvent<Int16Array>) => this.deliver(e.data)
    this.frames = 0
    this.firstFrameAt = this.lastFrameAt = 0
    this.session = { hold, stream, source, analyser, scope, node }
    this.input.attach(analyser, scope)
    for (const t of stream.getAudioTracks()) {
      // Unplugged device or the OS revoked access mid-capture.
      t.onended = () => {
        if (this.session?.stream !== stream) return
        this.stop()
        for (const cb of [...this.endedCbs]) cb('mic_os_blocked')
      }
    }
  }

  stop(): void {
    this.gen++
    const s = this.session
    if (!s) return
    this.session = null
    this.input.attach(null)
    s.node.port.onmessage = null
    try {
      s.node.port.postMessage({ type: 'stop' })
    } catch {
      /* port already closed */
    }
    s.node.port.close()
    count('ports', -1)
    s.source.disconnect()
    s.analyser.disconnect()
    s.scope.disconnect()
    s.node.disconnect()
    count('nodes', -4)
    for (const t of s.stream.getAudioTracks()) t.onended = null
    stopTracks(s.stream)
    count('streams', -1)
    this.host.release(s.hold)
    setAudioSession('playback')
  }

  onFrames(cb: (pcm16: Int16Array) => void): () => void {
    this.frameCbs.add(cb)
    return () => {
      this.frameCbs.delete(cb)
    }
  }

  // ── extras (not part of the frozen interface) ─────────────────────────────────────────────────────────────────

  /** The capture ended without `stop()` (device unplugged, OS revoked). Returns unsubscribe. */
  onEnded(cb: (code: 'mic_os_blocked') => void): () => void {
    this.endedCbs.add(cb)
    return () => {
      this.endedCbs.delete(cb)
    }
  }

  get active(): boolean {
    return this.session !== null
  }

  stats(): MicStats {
    const track = this.session?.stream.getAudioTracks()[0]
    return {
      active: this.session !== null,
      frames: this.frames,
      firstFrameAt: this.firstFrameAt,
      lastFrameAt: this.lastFrameAt,
      frameSamples: this.frameSamples,
      settings: track ? track.getSettings() : null
    }
  }

  private async open(c: MicConstraints): Promise<MediaStream> {
    try {
      return await this.gum({ audio: audioConstraints(c), video: false })
    } catch (e) {
      const name = (e as { name?: string } | null)?.name
      // The saved device is gone: fall back to the default input instead of failing.
      if (c.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        try {
          return await this.gum({ audio: audioConstraints(c, false), video: false })
        } catch (e2) {
          throw new ApiErrorException(apiError(micErrorCode(e2)))
        }
      }
      throw new ApiErrorException(apiError(micErrorCode(e)))
    }
  }

  private loadModule(ctx: BaseAudioContext): Promise<void> {
    let p = this.modules.get(ctx)
    if (!p) {
      p = ctx.audioWorklet.addModule(WORKLET_URL)
      // A failed load may be retried on the next start.
      p.catch(() => this.modules.delete(ctx))
      this.modules.set(ctx, p)
    }
    return p
  }

  private deliver(pcm: Int16Array): void {
    const now = this.perfNow()
    if (this.frames === 0) this.firstFrameAt = now
    this.lastFrameAt = now
    this.frameSamples = pcm.length
    this.frames++
    for (const cb of [...this.frameCbs]) {
      try {
        cb(pcm)
      } catch (err) {
        console.error(err)
      }
    }
  }
}

function stopTracks(s: MediaStream): void {
  for (const t of s.getTracks()) t.stop()
}
