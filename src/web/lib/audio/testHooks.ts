/**
 * `window.__vesperTest.audio` (test builds only, 07 B10): leak counters and engine/reveal/mic introspection for e2e
 * and soak specs. Getters are lazy so registering the hooks creates no AudioContext.
 */
import { registerTestHooks } from '../testHooks'
import type { WorkletMicCapture } from '../mic/capture'
import type { ContextHost } from './context'
import { snapshotCounters } from './counters'
import type { WebAudioEngine } from './engine'
import type { HighlightRevealController } from './reveal'
import type { AudioEngineEvent, AudioEngineEventMap } from './types'

export interface AudioHookDeps {
  host: () => ContextHost
  engine: () => WebAudioEngine
  reveal: () => HighlightRevealController
  mic: () => WorkletMicCapture
}

/** `wall` = engine clock (heard audio) at dispatch; `render` = the context's currentTime (ms) at dispatch. */
export type LoggedEvent = { [E in AudioEngineEvent]: { type: E; wall: number; render: number } & AudioEngineEventMap[E] }[AudioEngineEvent]

const EVENT_LOG = 500

export function installAudioTestHooks(d: AudioHookDeps): void {
  if (!__VESPER_TEST__) return
  const events: LoggedEvent[] = []
  let offs: Array<() => void> | null = null
  const record = (): void => {
    if (offs) return
    const e = d.engine()
    const types: AudioEngineEvent[] = ['chunkStart', 'chunkEnd', 'replyEnd', 'underrun']
    offs = types.map((type) =>
      e.on(type, (ev) => {
        events.push({ type, wall: e.now(), render: (d.host().peek()?.currentTime ?? 0) * 1000, ...ev } as LoggedEvent)
        if (events.length > EVENT_LOG) events.shift()
      })
    )
  }
  registerTestHooks('audio', {
    counters: () => snapshotCounters(),
    idleArmed: () => d.host().idleArmed,
    contextState: () => d.host().peek()?.state ?? 'none',
    unlocked: () => d.host().isUnlocked,
    setIdleMs: (ms: number) => d.host().setIdleMs(ms),
    unlock: () => d.engine().unlock(),
    now: () => d.engine().now(),
    /** The engine clock next to the raw context clock and latencies (ms), for timing diagnostics. */
    clock: () => {
      const c = d.host().peek()
      return { now: d.engine().now(), current: c ? c.currentTime * 1000 : 0, base: (c?.baseLatency ?? 0) * 1000, output: (c?.outputLatency ?? 0) * 1000 }
    },
    stats: () => d.engine().stats(),
    /** One read of the output LevelSource (advances its envelopes like a Star frame would). */
    readOutput: () => {
      const l = { rms: 0, low: 0, mid: 0, high: 0, onset: 0 }
      d.engine().output.read(l)
      return l
    },
    setMuted: (m: boolean) => d.engine().setMuted(m),
    stop: (replyId?: string) => d.engine().stop(replyId),
    /** Start recording engine events (idempotent) and return what was recorded so far. */
    events: () => {
      record()
      return events.map((e) => ({ ...e, header: undefined }))
    },
    clearEvents: () => {
      record()
      events.length = 0
    },
    revealLog: () => d.reveal().recent(),
    revealProgress: (replyId: string) => d.reveal().progress(replyId),
    revealState: (replyId: string) => d.reveal().state(replyId),
    micStats: () => d.mic().stats()
  })
}
