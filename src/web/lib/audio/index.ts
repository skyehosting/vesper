/**
 * Audio-core entry point (07 E4). The exported names and the frozen types in ./types are the contract for chat-ui,
 * voice-client and presence; the classes behind them are audio-core's.
 *
 *   const engine = getAudioEngine()          // one per page; unlock() from the first click/tap
 *   ws.onBinary(BIN_KIND.speechChunk, (h, payload) => engine.enqueue(h as SpeechChunkHeader, payload.slice().buffer))
 *   const stop = registerRevealRoot(replyId, el)   // chat-ui, on mount; call the result on unmount/eviction
 *   const mic = getMicCapture(); await mic.start({ echoCancellation: true }); mic.onFrames(pcm => …)
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'
import { useStore } from '../store'
import { ContextHost } from './context'
import { WebAudioEngine } from './engine'
import { HighlightRevealController } from './reveal'
import { installAudioTestHooks } from './testHooks'
import type { AudioEngine, Levels, LevelSource } from './types'
import { WorkletMicCapture } from '../mic/capture'

export type * from './types'
export { WebAudioEngine } from './engine'
export type { EngineStats } from './engine'
export { HighlightRevealController } from './reveal'
export type { RevealLogEntry } from './reveal'
export { WorkletMicCapture } from '../mic/capture'
export type { MicStats } from '../mic/capture'
export { snapshotCounters } from './counters'
export type { AudioCounters } from './counters'

/** A source that is always silent. */
export const silentLevels: LevelSource = {
  read(out: Levels): void {
    out.rms = 0
    out.low = 0
    out.mid = 0
    out.high = 0
    out.onset = 0
  }
}

export function createLevels(): Levels {
  return { rms: 0, low: 0, mid: 0, high: 0, onset: 0 }
}

let host: ContextHost | null = null

/** The page's single AudioContext owner, shared by playback and capture. */
export function getContextHost(): ContextHost {
  host ??= new ContextHost()
  return host
}

/** Test mode plays nothing audible (07 E10): gain 0, everything else real. */
function testMuted(): boolean {
  return __VESPER_TEST__ && useStore.getState().bootstrap?.isTest === true
}

export function createAudioEngine(): WebAudioEngine {
  const volume = useStore.getState().settings?.voice.tts.volume
  return new WebAudioEngine({ host: getContextHost(), volume, muted: testMuted() })
}

export function createMicCapture(): WorkletMicCapture {
  return new WorkletMicCapture({ host: getContextHost() })
}

export function createRevealController(engine: AudioEngine = getAudioEngine()): HighlightRevealController {
  return new HighlightRevealController({ engine })
}

let engine: WebAudioEngine | null = null
let reveal: HighlightRevealController | null = null
let mic: WorkletMicCapture | null = null

/** The app-wide engine (one AudioContext per page). Follows Settings → Voice out → Volume. */
export function getAudioEngine(): WebAudioEngine {
  if (engine) return engine
  const e = createAudioEngine()
  engine = e
  // Page-lifetime subscription (the engine is a page singleton): volume changes and test mode known after boot.
  useStore.subscribe((s, prev) => {
    const v = s.settings?.voice.tts.volume
    if (v !== undefined && v !== prev.settings?.voice.tts.volume) e.setVolume(v)
    if (__VESPER_TEST__ && s.bootstrap?.isTest !== prev.bootstrap?.isTest && s.bootstrap?.isTest) e.setMuted(true)
  })
  return e
}

/** The app-wide reveal controller (bound to the app-wide engine). */
export function getRevealController(): HighlightRevealController {
  reveal ??= createRevealController(getAudioEngine())
  return reveal
}

/** The app-wide microphone (one capture at a time; `start` replaces a running one). */
export function getMicCapture(): WorkletMicCapture {
  mic ??= createMicCapture()
  return mic
}

const revealRoots = new Map<string, () => void>()

/**
 * chat-ui: register a reply's rendered root for synced reveal (07 C14) on mount; `chunks` are the headers known so
 * far (more are picked up from the engine). Returns the unregister function; `unregisterRevealRoot` does the same.
 */
export function registerRevealRoot(replyId: string, el: HTMLElement, chunks: readonly SpeechChunkHeader[] = []): () => void {
  revealRoots.get(replyId)?.()
  const unbind = getRevealController().bind(replyId, el, chunks)
  const off = (): void => {
    if (revealRoots.get(replyId) === off) revealRoots.delete(replyId)
    unbind()
  }
  revealRoots.set(replyId, off)
  return off
}

export function unregisterRevealRoot(replyId: string): void {
  revealRoots.get(replyId)?.()
}

if (__VESPER_TEST__) installAudioTestHooks({ host: getContextHost, engine: getAudioEngine, reveal: getRevealController, mic: getMicCapture })

