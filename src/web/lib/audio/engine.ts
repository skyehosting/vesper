/**
 * AudioEngine (07 E4, C14, C15, D4): decodes `speech.chunk` payloads and plays them back to back on the shared
 * AudioContext. Graph (research 07 §2.5):
 *
 *   source(chunk) → replyGain (stop fade) → analyser (output levels) → master (volume / test mute) → destination
 *                                                       └→ scope (the waveform, ≥ 60 ms: Armilla's oscilloscope)
 *
 * The analyser sits before the volume, so visuals stay alive at low volume and in muted test mode (gain 0, audio still
 * scheduled and the clock still moving). Every node, buffer and timer is owned by a reply and released when the reply
 * ends or is stopped (leak counters in ./counters).
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'
import type { ContextHost } from './context'
import { count } from './counters'
import { AnalyserLevels, configureAnalyser, configureScope } from './levelSource'
import { isSilentChunk, parseL16, pcm16ToFloat } from './pcm.logic'
import { ReplyQueue } from './schedule.logic'
import type { AudioEngine, AudioEngineEvent, AudioEngineEventMap } from './types'

/** Stop fade (C15 "fast fade"): long enough to avoid a click, short enough to feel instant. */
export const STOP_FADE_S = 0.03
/** A reply that ran dry and received nothing for this long is dropped (its producer is gone). */
export const STALL_MS = 60_000
/** Replies remembered after they end, so late or duplicate chunks are dropped instead of starting a new queue. */
const ENDED_MEMORY = 64
let instances = 0

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

export interface EngineOptions {
  host: ContextHost
  timers?: Timers
  /** performance.now-like clock for level envelopes and now() interpolation. */
  perfNow?: () => number
  /** Initial master volume 0–1 (Settings voice.tts.volume). */
  volume?: number
  /** Test mode: master gain 0, everything else unchanged (07 E10). */
  muted?: boolean
  stallMs?: number
}

interface Chunk {
  header: SpeechChunkHeader
  buffer: AudioBuffer | null
  durationS: number
}

interface Playing {
  index: number
  header: SpeechChunkHeader
  at: number
  end: number
  source: AudioBufferSourceNode | null
  hasBuffer: boolean
  startTimer: unknown
  endTimer: unknown
  started: boolean
  released: boolean
}

interface Reply {
  id: string
  queue: ReplyQueue<Chunk>
  received: Set<number>
  gain: GainNode | null
  playing: Set<Playing>
  decoding: number
  stopped: boolean
  stallTimer: unknown
}

interface Graph {
  ctx: AudioContext
  analyser: AnalyserNode
  scope: AnalyserNode
  master: GainNode
}

type Listeners = { [E in AudioEngineEvent]: Set<(e: AudioEngineEventMap[E]) => void> }

export interface EngineStats {
  replies: number
  playing: number
  decodeErrors: number
  contextState: AudioContextState | 'none'
}

export class WebAudioEngine implements AudioEngine {
  readonly output: AnalyserLevels
  private readonly host: ContextHost
  private readonly timers: Timers
  private readonly perfNow: () => number
  private readonly stallMs: number
  private graph: Graph | null = null
  private readonly replies = new Map<string, Reply>()
  private readonly ended: string[] = []
  private readonly liveTimers = new Set<unknown>()
  private readonly listeners: Listeners = { chunkStart: new Set(), chunkEnd: new Set(), replyEnd: new Set(), underrun: new Set() }
  private volume: number
  private muted: boolean
  private decodeErrors = 0
  private lastNow = 0
  private clockCtx: AudioContext | null = null
  private readonly holdKey = `engine#${++instances}`

  constructor(o: EngineOptions) {
    this.host = o.host
    this.timers = o.timers ?? realTimers
    this.perfNow = o.perfNow ?? (() => performance.now())
    this.stallMs = o.stallMs ?? STALL_MS
    this.volume = clampVolume(o.volume ?? 0.9)
    this.muted = o.muted ?? false
    this.output = new AnalyserLevels(() => this.isPlaying(), this.perfNow)
  }

  async unlock(): Promise<boolean> {
    const ok = await this.host.unlock()
    this.ensureGraph()
    return ok
  }

  enqueue(header: SpeechChunkHeader, bytes: ArrayBuffer): void {
    const id = header.replyId
    // Frames come off the WebSocket as `unknown` cast to the header type: refuse what would wedge a queue.
    if (typeof id !== 'string' || !Number.isInteger(header.index) || header.index < 0) return
    if (this.ended.includes(id)) return
    let r = this.replies.get(id)
    if (!r) r = this.createReply(id)
    if (header.index < r.queue.nextIndex || r.received.has(header.index)) return
    r.received.add(header.index)
    this.disarmStall(r)
    r.decoding++
    void this.decode(header, bytes).then((buffer) => {
      r.decoding--
      if (r.stopped) {
        if (buffer) count('buffers', -1)
        return
      }
      const durationS = buffer ? buffer.duration : 0
      r.queue.add(header.index, { header, buffer, durationS }, durationS, header.final)
      this.pump(r)
    })
  }

  stop(replyId?: string): void {
    const targets = replyId === undefined ? [...this.replies.values()] : [this.replies.get(replyId)].filter((r): r is Reply => !!r)
    if (replyId !== undefined && targets.length === 0) this.remember(replyId)
    for (const r of targets) this.endReply(r, true)
  }

  /**
   * No chunk after `lastIndex` will come for `replyId` (voice-client, on `speech.end` when no chunk carried
   * `final`): the reply ends naturally (`replyEnd {interrupted:false}`) when that chunk's audio ends, or at once when
   * it already has. Returns false when the engine does not know the reply (already ended or stopped).
   */
  finalize(replyId: string, lastIndex: number): boolean {
    const r = this.replies.get(replyId)
    if (!r || r.stopped) return false
    r.queue.markFinal(lastIndex)
    if (r.queue.complete && r.playing.size === 0 && r.decoding === 0) this.endReply(r, false)
    else if (r.queue.finalIndex !== null) for (const p of r.playing) if (p.index === r.queue.finalIndex) p.header = { ...p.header, final: true }
    return true
  }

  now(): number {
    const ctx = this.host.peek()
    if (!ctx) return this.lastNow
    if (ctx !== this.clockCtx) {
      // A new context starts its clock at 0 (the old one was closed): restart the monotonic guard with it.
      this.clockCtx = ctx
      this.lastNow = 0
    }
    let t = ctx.currentTime
    // The output timestamp is what the listener hears now (currentTime runs ahead by the output buffer); interpolate
    // between render callbacks with performance.now so a 60 fps reveal moves smoothly.
    if (ctx.state === 'running' && typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp()
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.contextTime > 0) {
        const est = ts.contextTime + (this.perfNow() - ts.performanceTime) / 1000
        if (est <= t && t - est < 0.5) t = est
      }
    }
    const ms = t * 1000
    if (ms > this.lastNow) this.lastNow = ms
    return this.lastNow
  }

  /**
   * Seconds from the newest sample the output analyser holds to what the speakers play now: currentTime less the
   * output timestamp (the clock `now()` reads, interpolated), else AudioContext.outputLatency + baseLatency; 0 when
   * unknown (no context, not running, no estimate). Armilla's oscilloscope draws the frame from this long ago.
   */
  outputDelayS(): number {
    const ctx = this.host.peek()
    if (!ctx || ctx.state !== 'running') return 0
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp()
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.contextTime > 0) {
        const d = ctx.currentTime - (ts.contextTime + (this.perfNow() - ts.performanceTime) / 1000)
        if (d > 0 && d < 0.5) return d
      }
    }
    const out = (ctx as { outputLatency?: number }).outputLatency
    if (typeof out !== 'number' || !Number.isFinite(out) || out <= 0) return 0
    const d = out + (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0)
    return d < 0.5 ? d : 0
  }

  on<E extends AudioEngineEvent>(ev: E, cb: (e: AudioEngineEventMap[E]) => void): () => void {
    const set = this.listeners[ev] as Set<(e: AudioEngineEventMap[E]) => void>
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  // ── extras for voice-client / gallery / tests (not part of the frozen interface) ──────────────────────────────

  /** Master volume 0–1 (Settings voice.tts.volume). */
  setVolume(v: number): void {
    this.volume = clampVolume(v)
    this.applyMaster()
  }

  /** Test mode mute (gain 0; scheduling, clock and levels unchanged). */
  setMuted(m: boolean): void {
    this.muted = m
    this.applyMaster()
  }

  get isMuted(): boolean {
    return this.muted
  }

  /** True while any reply has audio scheduled or playing. */
  isPlaying(): boolean {
    for (const r of this.replies.values()) if (r.playing.size > 0) return true
    return false
  }

  /** The reply currently audible (first started, unfinished), for voice state. */
  activeReplyId(): string | null {
    for (const r of this.replies.values()) for (const p of r.playing) if (p.started) return r.id
    return null
  }

  stats(): EngineStats {
    let playing = 0
    for (const r of this.replies.values()) playing += r.playing.size
    return { replies: this.replies.size, playing, decodeErrors: this.decodeErrors, contextState: this.host.peek()?.state ?? 'none' }
  }

  /** Stop everything and drop the graph (page teardown, tests). The context itself belongs to the host. */
  dispose(): void {
    this.stop()
    const g = this.graph
    this.graph = null
    this.output.attach(null)
    if (g) {
      g.analyser.disconnect()
      g.scope.disconnect()
      g.master.disconnect()
      count('nodes', -3)
    }
    for (const set of Object.values(this.listeners)) set.clear()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private ensureGraph(): Graph {
    const ctx = this.host.get()
    if (this.graph && this.graph.ctx === ctx) return this.graph
    const analyser = configureAnalyser(ctx.createAnalyser())
    // The waveform twin: an output-less branch (Chromium pulls analysers on its own, as with the mic's).
    const scope = configureScope(ctx.createAnalyser())
    const master = ctx.createGain()
    count('nodes', 3)
    analyser.connect(master)
    analyser.connect(scope)
    master.connect(ctx.destination)
    this.graph = { ctx, analyser, scope, master }
    this.output.attach(analyser, scope)
    this.applyMaster()
    return this.graph
  }

  private applyMaster(): void {
    const g = this.graph
    if (!g) return
    g.master.gain.value = this.muted ? 0 : this.volume
  }

  private createReply(id: string): Reply {
    const r: Reply = { id, queue: new ReplyQueue<Chunk>(), received: new Set(), gain: null, playing: new Set(), decoding: 0, stopped: false, stallTimer: null }
    if (this.replies.size === 0) void this.host.hold(this.holdKey)
    this.replies.set(id, r)
    count('replies', 1)
    return r
  }

  private async decode(header: SpeechChunkHeader, bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    if (isSilentChunk(header.instant, bytes.byteLength)) return null
    const ctx = this.ensureGraph().ctx
    try {
      const pcm = parseL16(header.mime)
      let buffer: AudioBuffer
      if (pcm) {
        const channels = pcm16ToFloat(bytes, pcm)
        if (channels[0].length === 0) return null
        buffer = ctx.createBuffer(channels.length, channels[0].length, pcm.rate)
        channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c))
      } else {
        buffer = await ctx.decodeAudioData(bytes)
      }
      count('buffers', 1)
      return buffer
    } catch {
      // Undecodable audio plays as a zero-length chunk: the reveal moves on, the reply is not stuck (C14 failure
      // handling — text-first and the toast — is the voice client's, driven by speech.error).
      this.decodeErrors++
      return null
    }
  }

  private pump(r: Reply): void {
    if (r.stopped) return
    const g = this.ensureGraph()
    if (!r.gain) {
      r.gain = g.ctx.createGain()
      count('nodes', 1)
      r.gain.connect(g.analyser)
    }
    const now = g.ctx.currentTime
    for (const s of r.queue.drain(now)) this.schedule(r, g, s.index, s.item, s.at, s.end)
    if (r.queue.complete && r.playing.size === 0) this.endReply(r, false)
    // Waiting on a predecessor that may never come: the stall timer bounds how long the reply holds resources.
    else if (r.playing.size === 0 && r.decoding === 0) this.armStall(r)
  }

  private schedule(r: Reply, g: Graph, index: number, chunk: Chunk, at: number, end: number): void {
    const p: Playing = { index, header: chunk.header, at, end, source: null, hasBuffer: !!chunk.buffer, startTimer: null, endTimer: null, started: false, released: false }
    const now = g.ctx.currentTime
    if (chunk.buffer) {
      const src = g.ctx.createBufferSource()
      src.buffer = chunk.buffer
      src.connect(r.gain as GainNode)
      src.onended = () => this.chunkEnded(r, p)
      src.start(at)
      p.source = src
      count('nodes', 1)
      count('sources', 1)
    } else {
      const fireEnd = (): void => {
        p.endTimer = null
        const wait = this.untilAudio(g.ctx, end)
        if (wait > 0) p.endTimer = this.timer(fireEnd, wait)
        else this.chunkEnded(r, p)
      }
      p.endTimer = this.timer(fireEnd, (end - now) * 1000)
    }
    const fireStart = (): void => {
      p.startTimer = null
      // Timers run on wall time; the audio clock may lag (context still suspended before unlock, resuming).
      const wait = this.untilAudio(g.ctx, at)
      if (wait > 0) {
        p.startTimer = this.timer(fireStart, wait)
        return
      }
      p.started = true
      const header = { ...p.header, durationMs: (p.end - p.at) * 1000, final: p.header.final || r.queue.finalIndex === index }
      this.emit('chunkStart', { replyId: r.id, index, at: p.at * 1000, header })
    }
    p.startTimer = this.timer(fireStart, (at - now) * 1000)
    r.playing.add(p)
  }

  /** Milliseconds until the context clock reaches `t` (0 when reached; re-polls every 50 ms while not running). */
  private untilAudio(ctx: AudioContext, t: number): number {
    const rem = (t - ctx.currentTime) * 1000
    if (rem <= 4) return 0
    return ctx.state === 'running' ? rem : 50
  }

  private chunkEnded(r: Reply, p: Playing): void {
    if (p.released) return
    // A source can end before its start timer fired (timer clamping in background tabs): emit in order anyway.
    if (p.startTimer !== null) {
      this.clearTimer(p.startTimer)
      p.startTimer = null
      p.started = true
      this.emit('chunkStart', { replyId: r.id, index: p.index, at: p.at * 1000, header: { ...p.header, durationMs: (p.end - p.at) * 1000 } })
    }
    this.releasePlaying(r, p)
    this.emit('chunkEnd', { replyId: r.id, index: p.index, at: p.end * 1000 })
    if (r.stopped) return
    if (r.queue.complete && r.playing.size === 0) {
      this.endReply(r, false)
      return
    }
    if (r.playing.size === 0) {
      this.emit('underrun', { replyId: r.id, index: r.queue.nextIndex })
      this.armStall(r)
    }
  }

  private releasePlaying(r: Reply, p: Playing): void {
    if (p.released) return
    p.released = true
    if (p.startTimer !== null) this.clearTimer(p.startTimer)
    if (p.endTimer !== null) this.clearTimer(p.endTimer)
    p.startTimer = p.endTimer = null
    if (p.source) {
      p.source.onended = null
      p.source.disconnect()
      p.source = null
      count('nodes', -1)
      count('sources', -1)
    }
    if (p.hasBuffer) count('buffers', -1)
    r.playing.delete(p)
  }

  private endReply(r: Reply, interrupted: boolean): void {
    if (r.stopped) return
    r.stopped = true
    this.disarmStall(r)
    for (const c of r.queue.waiting()) if (c.buffer) count('buffers', -1)
    r.queue.clear()
    const g = this.graph
    const gain = r.gain
    r.gain = null
    if (interrupted && g && gain && r.playing.size > 0) {
      // Fast fade on this reply only, then stop and release its sources (C15).
      const t = g.ctx.currentTime
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0, t + STOP_FADE_S)
      const playing = [...r.playing]
      for (const p of playing) {
        if (p.startTimer !== null) {
          this.clearTimer(p.startTimer)
          p.startTimer = null
        }
        if (p.source) {
          const src = p.source
          src.onended = () => this.releasePlaying(r, p)
          try {
            src.stop(t + STOP_FADE_S)
          } catch {
            this.releasePlaying(r, p)
          }
        } else {
          this.releasePlaying(r, p)
        }
      }
      // Release whatever onended did not (a suspended context never fires it), then the reply's gain.
      this.timer(() => {
        for (const p of [...r.playing]) this.releasePlaying(r, p)
        gain.disconnect()
        count('nodes', -1)
      }, STOP_FADE_S * 1000 + 60)
    } else {
      for (const p of [...r.playing]) this.releasePlaying(r, p)
      if (gain) {
        gain.disconnect()
        count('nodes', -1)
      }
    }
    this.replies.delete(r.id)
    count('replies', -1)
    this.remember(r.id)
    if (this.replies.size === 0) this.host.release(this.holdKey)
    this.emit('replyEnd', { replyId: r.id, interrupted })
  }

  private armStall(r: Reply): void {
    this.disarmStall(r)
    r.stallTimer = this.timer(() => {
      r.stallTimer = null
      if (r.playing.size === 0 && r.decoding === 0) this.endReply(r, true)
    }, this.stallMs)
  }

  private disarmStall(r: Reply): void {
    if (r.stallTimer === null) return
    this.clearTimer(r.stallTimer)
    r.stallTimer = null
  }

  private remember(id: string): void {
    if (this.ended.includes(id)) return
    this.ended.push(id)
    if (this.ended.length > ENDED_MEMORY) this.ended.shift()
  }

  /** Counted timer: the handle is uncounted when it fires or is cleared. */
  private timer(fn: () => void, ms: number): unknown {
    count('timers', 1)
    const handle = this.timers.setTimeout(() => {
      this.liveTimers.delete(handle)
      count('timers', -1)
      fn()
    }, Math.max(0, ms))
    this.liveTimers.add(handle)
    return handle
  }

  private clearTimer(handle: unknown): void {
    if (!this.liveTimers.delete(handle)) return
    this.timers.clearTimeout(handle)
    count('timers', -1)
  }

  private emit<E extends AudioEngineEvent>(ev: E, e: AudioEngineEventMap[E]): void {
    for (const cb of [...(this.listeners[ev] as Set<(x: AudioEngineEventMap[E]) => void>)]) {
      try {
        cb(e)
      } catch (err) {
        // A listener bug must not break playback for the others.
        console.error(err)
      }
    }
  }
}

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.9
}
