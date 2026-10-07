/**
 * Gapless chunk scheduling for one reply (02 §6.1, research 04 §7.1), as pure math over the context clock (seconds):
 *
 *   start_0 = now + LEAD
 *   start_k = end_{k−1}                 if end_{k−1} ≥ now + SAFETY   (back to back, sample-exact)
 *           = now + LEAD                otherwise                     (the chunk came late: playback restarts)
 *   end_k   = start_k + decoded duration   (the AudioBuffer's, not the server's estimate: trailing silence counts)
 *
 * Chunks may arrive (or finish decoding) out of order; `drain` only ever releases the consecutive run starting at
 * `nextIndex`, so a missing chunk holds back its successors.
 */

/** Lead time for a fresh start: covers the main-thread → render-thread hop and one render callback (07 D6). */
export const LEAD_S = 0.03
/** A successor must be scheduled at least this far ahead of the play-head to stay gapless. */
export const SAFETY_S = 0.012

export interface Scheduled<T> {
  index: number
  item: T
  /** Context seconds. */
  at: number
  end: number
  /** True when this chunk restarted playback after the previous one had already run out (or is the first). */
  restart: boolean
}

export class ReplyQueue<T> {
  /** The next index to schedule. */
  nextIndex = 0
  /** End of the last scheduled chunk (context seconds); null before the first. */
  tail: number | null = null
  /** Index of the chunk flagged `final`, once known. */
  finalIndex: number | null = null
  private readonly ready = new Map<number, { item: T; duration: number }>()

  constructor(private readonly lead = LEAD_S, private readonly safety = SAFETY_S) {}

  /** Add a decoded chunk. Returns false for duplicates and indexes already scheduled. */
  add(index: number, item: T, durationS: number, final = false): boolean {
    if (index < this.nextIndex || this.ready.has(index)) return false
    this.ready.set(index, { item, duration: Math.max(0, durationS) })
    if (final) this.finalIndex = index
    return true
  }

  /** Items decoded but not yet scheduled (released by the caller on stop). */
  waiting(): T[] {
    return [...this.ready.values()].map((r) => r.item)
  }

  clear(): void {
    this.ready.clear()
  }

  /**
   * The producer says nothing after `index` will come (speech.end arrived and the last chunk was sent before the
   * server knew it was the last, so it carries no `final` flag). Never moves an already known final index.
   */
  markFinal(index: number): void {
    if (this.finalIndex === null && Number.isInteger(index) && index >= 0) this.finalIndex = index
  }

  get complete(): boolean {
    return this.finalIndex !== null && this.nextIndex > this.finalIndex
  }

  /** Schedule every consecutive ready chunk from `nextIndex`, given the context's current time. */
  drain(now: number): Array<Scheduled<T>> {
    const out: Array<Scheduled<T>> = []
    for (;;) {
      const r = this.ready.get(this.nextIndex)
      if (!r) break
      this.ready.delete(this.nextIndex)
      const restart = this.tail === null || this.tail < now + this.safety
      const at = restart ? now + this.lead : (this.tail as number)
      const end = at + r.duration
      out.push({ index: this.nextIndex, item: r.item, at, end, restart })
      this.tail = end
      this.nextIndex++
    }
    return out
  }
}

/** Largest gap (seconds) between consecutive scheduled chunks; 0 for back-to-back runs. */
export function maxGap(chunks: ReadonlyArray<{ at: number; end: number }>): number {
  let g = 0
  for (let i = 1; i < chunks.length; i++) g = Math.max(g, chunks[i].at - chunks[i - 1].end)
  return g
}
