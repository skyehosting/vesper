/**
 * The speech of one reply as chat-ui sees it: voice-client's `useReplySpeech` (07 E4 frozen signature). Test builds
 * can override a reply's speech (`__vesperTest.chat.speech*`), so the synced-reveal binding is testable end to end
 * with real audio from audio-core without depending on how voice-client receives chunks. Release builds compile the
 * override away (`__VESPER_TEST__` is a build constant, so the hook order never changes at runtime).
 */
import { useSyncExternalStore } from 'react'
import { useReplySpeech, type ReplySpeech } from '../voice'

const overrides = new Map<string, ReplySpeech>()
const listeners = new Set<() => void>()
let version = 0

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const getVersion = (): number => version

/** Test builds only: replace (or with null, clear) what `useSpeechFor(replyId)` returns. */
export function setSpeechOverride(replyId: string, s: ReplySpeech | null): void {
  if (!__VESPER_TEST__) return
  if (s) overrides.set(replyId, s)
  else overrides.delete(replyId)
  version++
  for (const l of [...listeners]) l()
}

export function speechOverrideCount(): number {
  return overrides.size
}

export function useSpeechFor(replyId: string | null): ReplySpeech {
  const real = useReplySpeech(replyId)
  if (__VESPER_TEST__) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- build constant: the same branch on every render
    useSyncExternalStore(subscribe, getVersion, getVersion)
    const o = replyId ? overrides.get(replyId) : undefined
    if (o) return o
  }
  return real
}

/** This client renders the reply from held speech text (synced reveal) rather than from deltas. */
export function isHeld(s: ReplySpeech): boolean {
  return s.state === 'waiting' || s.state === 'speaking' || s.state === 'done' || s.state === 'interrupted'
}
