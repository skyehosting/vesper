/**
 * Speech of each reply as seen by this client (07 C14, C15, R14) — the state machine behind `useReplySpeech`.
 * Pure: no DOM, no WebSocket, no AudioContext. speechClient.ts feeds it WS events and AudioEngine events and carries
 * out its effects (enqueue audio, stop, finish the reveal, speech.cancel / speech.played, the "Voice unavailable" toast).
 *
 *   none ──expect/chunk──▶ waiting ──chunkStart──▶ speaking ──speech.end + every chunk played──▶ done
 *                            │                        │
 *                            │  reply.delta to us /   ├──barge-in (typing, Stop, voice)──▶ interrupted
 *                            │  error, no chunk yet   └──speech.error / degraded / targeted snapshot / 6 s──▶ failed
 *                            ▼
 *                          none (not the speaker: chat-ui renders deltas)
 *
 *   waiting/speaking with no chunk playing here yet ──barge-in / speech.stopped──▶ cancelled (F31: nothing was heard,
 *   so the speech stops but the reply is not interrupted: the server hands us its text, no toast)
 *
 * The 6 s rule (07 C14): the first chunk must arrive within 6 s of the server starting to make it (`speech.preparing`;
 * F32: not from the first text — the server legitimately holds speech back for 07 A2 waitForTone / 'end' placement, a
 * first sentence still being written, a memory tool round), at the latest 6 s after reply.done; a later chunk within
 * 6 s of playback reaching it (engine `underrun`). Otherwise the reply goes text-first. A speech.preparing that beats
 * `expect()` ("speak again": chunk 0 starts before the ack) is remembered and arms the clock at expect() (NEW-2).
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'

export type ReplySpeechState =
  /** This client is not the speaker for the reply (render from reply.delta). */
  | 'none'
  /** Speaker; waiting for the first chunk's audio. */
  | 'waiting'
  | 'speaking'
  | 'done'
  /** Barge-in: keep what was revealed, offer "show rest". */
  | 'interrupted'
  /** Voice unavailable for this reply: text-first. */
  | 'failed'
  /** Speech was cancelled before any of it played here (typing, dictation, Stop): text, no "interrupted", no toast. */
  | 'cancelled'

export interface ReplySpeech {
  state: ReplySpeechState
  /** Concatenated chunk markdown received so far while this client is the speaker; null otherwise. */
  heldText: string | null
  /** Chunk headers in index order (for registerRevealRoot). */
  headers: readonly SpeechChunkHeader[]
}

export const NO_SPEECH: ReplySpeech = Object.freeze({ state: 'none', heldText: null, headers: Object.freeze([]) as readonly SpeechChunkHeader[] }) as ReplySpeech

/** 07 C14: a chunk not ready within this long → text-first. */
export const CHUNK_DEADLINE_MS = 6000
/** Finished records kept for late readers (chat-ui re-mounting a reply). */
export const MAX_FINISHED = 64

export type FailReason = 'timeout' | 'error' | 'degraded' | 'snapshot'

export interface TrackerEffects {
  enqueue(header: SpeechChunkHeader, payload: Uint8Array): void
  /** Stop this reply's audio in the engine. */
  stop(replyId: string): void
  /** Reveal all of the reply's text now (text-first, or the audio already ended). */
  finishReveal(replyId: string): void
  /**
   * Tell the engine that no chunk after `lastIndex` will come (speech.end when no chunk carried `final`), so it ends
   * the reply naturally when that audio ends. Returns false when the engine no longer knows the reply.
   */
  finalize?(replyId: string, lastIndex: number): boolean
  /** speech.cancel; `beforeAudio`: nothing of the reply played here yet (F31). */
  sendCancel(replyId: string, spokenChars: number, beforeAudio: boolean): void
  sendPlayed(replyId: string, index: number, revealedChars: number): void
  /** Show "Voice unavailable" once for the reply. */
  unavailable(replyId: string, reason: FailReason): void
  publish(replyId: string, speech: ReplySpeech | null): void
}

export interface TrackerDeps {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  effects: TrackerEffects
}

interface Rec {
  replyId: string
  state: ReplySpeechState
  chunks: Map<number, SpeechChunkHeader>
  /** Next index not yet received (heldText covers [0, contiguous)). */
  contiguous: number
  held: string
  headers: SpeechChunkHeader[]
  started: Map<number, number>
  endedChunks: Set<number>
  serverEnded: boolean
  /** The engine ended the reply by itself (the last chunk carried final:true). */
  audioEnded: boolean
  /** The engine knows the reply's last chunk (a final:true header, or finalize()): it will emit replyEnd itself. */
  engineFinal: boolean
  timer: unknown
  /** Which chunk index the 6 s timer waits for. */
  waitingFor: number | null
  toasted: boolean
  published: ReplySpeech
}

const LIVE: ReadonlySet<ReplySpeechState> = new Set(['waiting', 'speaking'])

/** Offset into the reply text reached `elapsedMs` into a chunk's audio (barge-in bookkeeping, 07 C15). */
export function spokenOffset(h: Pick<SpeechChunkHeader, 'src' | 'spoken' | 'timeline' | 'durationMs' | 'instant'>, elapsedMs: number): number {
  const [a, b] = h.src
  if (elapsedMs <= 0) return a
  const len = h.spoken.length
  if (h.instant || len === 0) return b
  let n: number
  if (h.timeline && h.timeline.startsMs.length === len) {
    let lo = 0
    let hi = len
    // Chars whose start time has passed (startsMs is non-decreasing).
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (h.timeline.startsMs[mid] <= elapsedMs) lo = mid + 1
      else hi = mid
    }
    n = lo
  } else {
    const d = h.durationMs > 0 ? h.durationMs : 1
    n = Math.round(len * Math.min(1, elapsedMs / d))
  }
  return a + Math.round(((b - a) * n) / len)
}

/** speech.preparing events remembered for replies this client has not expected yet (NEW-2). */
const MAX_EARLY = 16

export class SpeechTracker {
  private readonly recs = new Map<string, Rec>()
  /**
   * NEW-2: speech.preparing that arrived before `expect()`. "Speak again" dispatches chunk 0 (and so emits
   * speech.preparing) before the server acks speech.replay, and a replay gets no reply.status/reply.done — without
   * this the replay had no first-chunk clock at all. speech.preparing is targeted to speaking clients only, so a
   * remembered id is ours; the set is bounded and each entry is used once.
   */
  private readonly early = new Set<string>()
  private readonly d: TrackerDeps

  constructor(d: TrackerDeps) {
    this.d = d
  }

  // ── inputs ──────────────────────────────────────────────────────────────────────────────────

  /** This client asked for a spoken reply (chat.send/regenerate/edit with speak, or speech.replay). */
  expect(replyId: string): void {
    const r = this.recs.get(replyId) ?? this.create(replyId)
    if (r.state === 'none') this.set(r, 'waiting')
    if (this.early.delete(replyId) && r.state === 'waiting' && r.chunks.size === 0) this.arm(r, 0)
  }

  isExpected(replyId: string): boolean {
    const r = this.recs.get(replyId)
    return !!r && r.state !== 'none'
  }

  /** A binary kind-1 frame. Audio for a reply that already left the live states is dropped. */
  chunk(h: SpeechChunkHeader, payload: Uint8Array): void {
    let r = this.recs.get(h.replyId)
    if (!r) r = this.create(h.replyId)
    if (r.state === 'none') r.state = 'waiting'
    if (!LIVE.has(r.state) || r.chunks.has(h.index)) return
    r.chunks.set(h.index, h)
    if (h.final) r.engineFinal = true
    r.headers = [...r.chunks.values()].sort((x, y) => x.index - y.index)
    while (r.chunks.has(r.contiguous)) {
      r.held += (r.chunks.get(r.contiguous) as SpeechChunkHeader).text
      r.contiguous++
    }
    if (r.waitingFor !== null && r.waitingFor <= h.index) this.clearTimer(r)
    this.d.effects.enqueue(h, payload)
    this.publish(r)
  }

  /**
   * reply.status for any reply. A stopped/failed reply with no audio yet is not spoken. Writing / 'preparing-voice'
   * do NOT start the first-chunk clock (F32): the server may be holding speech back on purpose (07 A2), so the clock
   * starts at `speech.preparing` (or, at the latest, reply.done).
   */
  status(replyId: string, state: string): void {
    const r = this.recs.get(replyId)
    if (!r || r.state !== 'waiting') return
    if (state === 'stopped' || state === 'error') {
      if (r.chunks.size === 0) this.drop(r)
      return
    }
    if (state === 'done' && r.chunks.size === 0) this.arm(r, 0)
  }

  /** speech.preparing: the server started making the first chunk — it now has 6 s (07 C14). */
  preparing(replyId: string): void {
    const r = this.recs.get(replyId)
    if (!r) {
      // Not expected yet (a replay's ack is still on its way): remember it for expect().
      this.early.delete(replyId)
      this.early.add(replyId)
      if (this.early.size > MAX_EARLY) this.early.delete(this.early.values().next().value as string)
      return
    }
    if (r.state === 'waiting' && r.chunks.size === 0) this.arm(r, 0)
  }

  /** reply.delta reached this client: in synced mode the speaker gets none, so we are not the speaker. */
  delta(replyId: string): void {
    const r = this.recs.get(replyId)
    if (r && r.state === 'waiting' && r.chunks.size === 0) this.drop(r)
  }

  /** reply.done: the text is complete; speech must follow soon (the clock starts here if speech.preparing has not). */
  replyDone(replyId: string): void {
    const r = this.recs.get(replyId)
    if (r && r.state === 'waiting' && r.chunks.size === 0) this.arm(r, 0)
  }

  replyError(replyId: string): void {
    const r = this.recs.get(replyId)
    if (r && r.state === 'waiting' && r.chunks.size === 0) this.drop(r)
  }

  /** A targeted reply.snapshot (evSeq 0) for a reply we speak: the server switched us to text. */
  snapshot(replyId: string, targeted: boolean): void {
    const r = this.recs.get(replyId)
    if (targeted && r && LIVE.has(r.state)) this.fail(r, 'snapshot')
  }

  speechError(replyId: string): void {
    const r = this.recs.get(replyId)
    if (r && LIVE.has(r.state)) this.fail(r, 'error')
  }

  degraded(replyId: string): void {
    const r = this.recs.get(replyId)
    if (r && LIVE.has(r.state)) this.fail(r, 'degraded')
  }

  speechEnd(replyId: string): void {
    const r = this.recs.get(replyId)
    if (!r) return
    r.serverEnded = true
    this.clearTimer(r)
    if (r.state === 'waiting' && r.chunks.size === 0) return this.drop(r)
    // The last chunk went out before the server knew it was the last: tell the engine, so the reply ends with its
    // audio (a natural replyEnd: the reveal completes on the audio clock instead of being cut short).
    if (LIVE.has(r.state) && !r.engineFinal && r.contiguous === r.chunks.size && r.contiguous > 0) {
      r.engineFinal = this.d.effects.finalize?.(r.replyId, r.contiguous - 1) ?? false
    }
    this.maybeDone(r)
  }

  // ── engine events ───────────────────────────────────────────────────────────────────────────

  chunkStart(replyId: string, index: number, at: number): void {
    const r = this.recs.get(replyId)
    if (!r) return
    r.started.set(index, at)
    if (r.state === 'waiting') this.set(r, 'speaking')
  }

  chunkEnd(replyId: string, index: number): void {
    const r = this.recs.get(replyId)
    if (!r) return
    r.endedChunks.add(index)
    const h = r.chunks.get(index)
    if (h && LIVE.has(r.state)) this.d.effects.sendPlayed(replyId, index, h.src[1])
    this.maybeDone(r)
  }

  replyEnd(replyId: string, interrupted: boolean): void {
    const r = this.recs.get(replyId)
    if (!r || interrupted) return
    r.audioEnded = true
    this.maybeDone(r)
  }

  /** Playback reached a chunk that has not arrived: it now has 6 s. */
  underrun(replyId: string, index: number): void {
    const r = this.recs.get(replyId)
    if (!r || !LIVE.has(r.state) || r.serverEnded || r.chunks.has(index)) return
    this.arm(r, index)
  }

  // ── commands ────────────────────────────────────────────────────────────────────────────────

  /**
   * Barge-in (07 C15): stop this reply's speech everywhere, freeze the reveal, keep what was revealed. `now` is the
   * engine clock (for spokenChars). Returns false when the reply was not speaking here.
   */
  bargeIn(replyId: string, now: number): boolean {
    const r = this.recs.get(replyId)
    if (!r || !LIVE.has(r.state)) return false
    this.clearTimer(r)
    // F31: nothing has played here yet (still 'preparing voice'): cancel the speech, keep the reply — the server only
    // treats it as a barge-in if another device may have heard it.
    const unheard = !this.heard(r, now)
    this.d.effects.sendCancel(replyId, this.spokenChars(r, now), unheard)
    if (unheard) this.cancelled(r)
    else {
      this.set(r, 'interrupted')
      this.d.effects.stop(replyId)
    }
    return true
  }

  /**
   * Another device interrupted the reply (`speech.stopped`, 07 C16: a barge-in anywhere stops speech everywhere): stop
   * here too and freeze the reveal, without sending a second speech.cancel.
   */
  stopped(replyId: string, now = Number.POSITIVE_INFINITY): void {
    const r = this.recs.get(replyId)
    if (!r || !LIVE.has(r.state)) return
    this.clearTimer(r)
    // Nothing played here: there is no revealed text to freeze; the server hands every speaker the text (F31).
    if (!this.heard(r, now)) return this.cancelled(r)
    this.set(r, 'interrupted')
    this.d.effects.stop(replyId)
  }

  /** Replies currently waiting or speaking here. */
  live(): string[] {
    const out: string[] = []
    for (const r of this.recs.values()) if (LIVE.has(r.state)) out.push(r.replyId)
    return out
  }

  get(replyId: string): ReplySpeech {
    return this.recs.get(replyId)?.published ?? NO_SPEECH
  }

  /** Records and armed timers (leak checks). */
  stats(): { records: number; timers: number; live: number } {
    let timers = 0
    let live = 0
    for (const r of this.recs.values()) {
      if (r.timer !== null) timers++
      if (LIVE.has(r.state)) live++
    }
    return { records: this.recs.size, timers, live }
  }

  /** Forget everything (page teardown, tests). */
  reset(): void {
    for (const r of [...this.recs.values()]) {
      this.clearTimer(r)
      this.recs.delete(r.replyId)
      this.d.effects.publish(r.replyId, null)
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private create(replyId: string): Rec {
    const r: Rec = {
      replyId,
      state: 'none',
      chunks: new Map(),
      contiguous: 0,
      held: '',
      headers: [],
      started: new Map(),
      endedChunks: new Set(),
      serverEnded: false,
      audioEnded: false,
      engineFinal: false,
      timer: null,
      waitingFor: null,
      toasted: false,
      published: NO_SPEECH
    }
    this.recs.set(replyId, r)
    return r
  }

  /** Some of the reply's audio has started playing here by `now`. */
  private heard(r: Rec, now: number): boolean {
    for (const at of r.started.values()) if (at <= now) return true
    return false
  }

  /** Speech stopped before anything played here: reveal everything (text from the server), audio off, no toast. */
  private cancelled(r: Rec): void {
    this.set(r, 'cancelled')
    this.d.effects.finishReveal(r.replyId)
    this.d.effects.stop(r.replyId)
    this.prune()
  }

  private spokenChars(r: Rec, now: number): number {
    let best: { index: number; at: number } | null = null
    for (const [index, at] of r.started) if (at <= now && (!best || index > best.index)) best = { index, at }
    if (!best) return r.headers[0]?.src[0] ?? 0
    const h = r.chunks.get(best.index)
    return h ? spokenOffset(h, now - best.at) : 0
  }

  private maybeDone(r: Rec): void {
    if (!LIVE.has(r.state) || !r.serverEnded) return
    let all = true
    for (const i of r.chunks.keys()) if (!r.endedChunks.has(i)) all = false
    // The engine ends the reply itself once the final chunk's audio ends: wait for that replyEnd.
    if (!r.audioEnded && (!all || r.engineFinal)) return
    this.set(r, 'done')
    // Without a final:true chunk the engine and the reveal never learn that the reply ended: close both here (the
    // reveal first, so the engine's "interrupted" stop does not freeze it).
    if (!r.audioEnded) {
      this.d.effects.finishReveal(r.replyId)
      this.d.effects.stop(r.replyId)
    }
    this.prune()
  }

  private fail(r: Rec, reason: FailReason): void {
    this.clearTimer(r)
    this.set(r, 'failed')
    this.d.effects.finishReveal(r.replyId)
    this.d.effects.stop(r.replyId)
    if (!r.toasted) {
      r.toasted = true
      this.d.effects.unavailable(r.replyId, reason)
    }
    this.prune()
  }

  private drop(r: Rec): void {
    this.clearTimer(r)
    this.recs.delete(r.replyId)
    this.d.effects.publish(r.replyId, null)
  }

  private arm(r: Rec, index: number): void {
    if (r.timer !== null) return
    r.waitingFor = index
    r.timer = this.d.setTimer(() => {
      r.timer = null
      r.waitingFor = null
      if (LIVE.has(r.state) && !r.chunks.has(index)) this.fail(r, 'timeout')
    }, CHUNK_DEADLINE_MS)
  }

  private clearTimer(r: Rec): void {
    if (r.timer !== null) this.d.clearTimer(r.timer)
    r.timer = null
    r.waitingFor = null
  }

  private set(r: Rec, state: ReplySpeechState): void {
    r.state = state
    this.publish(r)
  }

  private publish(r: Rec): void {
    const heldText = r.state === 'failed' || r.state === 'cancelled' || r.state === 'none' ? null : r.held
    const p = r.published
    if (p.state === r.state && p.heldText === heldText && p.headers === r.headers) return
    r.published = { state: r.state, heldText, headers: r.headers }
    this.d.effects.publish(r.replyId, r.published)
  }

  /** Keep at most MAX_FINISHED finished records (oldest first); live ones are never pruned. */
  private prune(): void {
    let finished = 0
    for (const r of this.recs.values()) if (!LIVE.has(r.state)) finished++
    if (finished <= MAX_FINISHED) return
    for (const r of [...this.recs.values()]) {
      if (finished <= MAX_FINISHED) break
      if (LIVE.has(r.state)) continue
      this.drop(r)
      finished--
    }
  }
}
