/**
 * The live frame scheduler, for pages that drive the surface directly (Constellation input asks for interaction
 * frames, Talk mode for a crossfade). Set by <PresenceHost> for its lifetime; null before the host loads.
 */
import type { FrameScheduler } from './scheduler'

let current: FrameScheduler | null = null

export function setCurrentScheduler(s: FrameScheduler | null): void {
  current = s
}

export function currentScheduler(): FrameScheduler | null {
  return current
}
