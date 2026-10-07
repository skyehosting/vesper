/**
 * Live-resource counters for leak tests (07 D14, R17): kit components count the document listeners, observers,
 * timers and workers they hold, so a spec can open/close things N times and assert the counts return to baseline.
 * Compiled out of release builds (07 B10).
 */
const counts: Record<string, number> = {}

export function track(kind: string, delta: 1 | -1): void {
  if (!__VESPER_TEST__) return
  counts[kind] = (counts[kind] ?? 0) + delta
}

/** Snapshot of the counters (zero entries included). */
export function kitStats(): Record<string, number> {
  return { ...counts }
}
