/**
 * Resource counters for the audio core (07 D14 leak gates). Every AudioNode, scheduled source, decoded buffer,
 * context, worklet port, media stream and timer the core creates is counted here and uncounted when released, so a
 * test can assert "back to baseline" after N play/stop cycles. Plain integer bumps: cheap enough to keep in release.
 */
export interface AudioCounters {
  /** AudioNodes created by the core and not yet disconnected/released. */
  nodes: number
  /** AudioBufferSourceNodes scheduled and not yet ended or stopped. */
  sources: number
  /** Decoded AudioBuffers still referenced by a reply queue. */
  buffers: number
  /** AudioContexts open (created and not closed). */
  contexts: number
  /** Mic worklet ports open. */
  ports: number
  /** MediaStreams with live tracks owned by the core. */
  streams: number
  /** Pending timers owned by the core (chunk starts, idle suspend, stop cleanups). */
  timers: number
  /** Reply queues alive in the engine. */
  replies: number
  /** Replies bound to the reveal controller. */
  reveals: number
}

export type CounterName = keyof AudioCounters

const counters: AudioCounters = { nodes: 0, sources: 0, buffers: 0, contexts: 0, ports: 0, streams: 0, timers: 0, replies: 0, reveals: 0 }

export function count(name: CounterName, delta: number): void {
  counters[name] += delta
}

export function snapshotCounters(): AudioCounters {
  return { ...counters }
}
