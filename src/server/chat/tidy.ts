/**
 * Streaming `tidyAfterTags` (R14, 07 C14/C16): the reply text is tidied AS IT STREAMS, so the concatenation of every
 * `reply.delta`, the speech document the voice service segments (and with it every `SpeechChunkHeader.text`), the
 * in-flight snapshot and the stored body are one and the same string — no offset drift between what a client reveals
 * and what reply.done finally says.
 *
 * tidyAfterTags only touches whitespace: a leading run of spaces/tabs, spaces/tabs before a newline, 3+ newlines, and
 * the trailing run. Each of those lives inside one maximal whitespace run, so a run is held back until the next
 * visible character arrives and is then released normalized; the run still held at the end is dropped (trimEnd).
 * Property (fuzz-tested): `push(a) + push(b) + … === tidyAfterTags(a + b + …)`.
 */
const WS = /\s/

function normalizeRun(run: string, atStart: boolean): string {
  const r = atStart ? run.replace(/^[ \t]+/, '') : run
  return r.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}

export class StreamTidy {
  /** Whitespace held until the next visible character (or dropped at the end). */
  private held = ''
  /** Tidied characters released so far. */
  private outLen = 0
  /** Raw characters pushed so far. */
  private rawLen = 0

  /** Feed raw visible text; returns the tidied text that can be released now. */
  push(text: string): string {
    let out = ''
    let i = 0
    while (i < text.length) {
      let j = i
      if (WS.test(text[i])) {
        while (j < text.length && WS.test(text[j])) j++
        this.held += text.slice(i, j)
      } else {
        while (j < text.length && !WS.test(text[j])) j++
        // A visible run releases the whitespace held before it, normalized.
        if (this.held) out += normalizeRun(this.held, this.outLen + out.length === 0)
        this.held = ''
        out += text.slice(i, j)
      }
      i = j
    }
    this.rawLen += text.length
    this.outLen += out.length
    return out
  }

  /** The reply ended: the held trailing whitespace is dropped (trimEnd). */
  end(): void {
    this.held = ''
  }

  /** Tidied characters released so far. */
  get length(): number {
    return this.outLen
  }

  /** Raw characters pushed so far. */
  get rawLength(): number {
    return this.rawLen
  }

  /** The held whitespace as it would be released if visible text followed. */
  get pending(): string {
    return this.held ? normalizeRun(this.held, this.outLen === 0) : ''
  }

  /**
   * Map a raw offset at or beyond everything pushed so far to the tidied text (± the held run). Used for tone-tag
   * positions, which only need chunk precision; earlier offsets map to the current end.
   */
  position(rawOffset: number): number {
    const ahead = rawOffset - this.rawLen
    return ahead >= 0 ? this.outLen + this.pending.length + ahead : this.outLen
  }
}
