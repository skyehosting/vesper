/**
 * SpeechTracker (voice-client): per-reply speech state for useReplySpeech — held text in index order, done/failed/
 * interrupted transitions, the 6 s rule (07 C14), barge-in bookkeeping (07 C15). @R14 @R17
 */
import { describe, expect, it } from 'vitest'
import type { SpeechChunkHeader } from '@shared/ws/binary'
import { CHUNK_DEADLINE_MS, MAX_FINISHED, NO_SPEECH, SpeechTracker, spokenOffset, type ReplySpeech } from '../../../../src/web/features/voice/speech.logic'

interface Harness {
  t: SpeechTracker
  log: string[]
  published: Map<string, ReplySpeech | null>
  enqueued: number[]
  tick(ms: number): void
  timers(): number
}

function harness(): Harness {
  const log: string[] = []
  const published = new Map<string, ReplySpeech | null>()
  const enqueued: number[] = []
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const t = new SpeechTracker({
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h) => void timers.delete(h as number),
    effects: {
      enqueue: (h) => void enqueued.push(h.index),
      stop: (id) => void log.push(`stop:${id}`),
      finishReveal: (id) => void log.push(`finish:${id}`),
      sendCancel: (id, n, before) => void log.push(`cancel:${id}:${n}${before ? ':before-audio' : ''}`),
      sendPlayed: (id, i, n) => void log.push(`played:${id}:${i}:${n}`),
      unavailable: (id, why) => void log.push(`unavailable:${id}:${why}`),
      publish: (id, s) => void published.set(id, s)
    }
  })
  return {
    t,
    log,
    published,
    enqueued,
    tick(ms) {
      now += ms
      for (const [id, x] of [...timers]) {
        if (x.at <= now) {
          timers.delete(id)
          x.fn()
        }
      }
    },
    timers: () => timers.size
  }
}

const BODY = 'Hello there, friend. This is the second sentence. And a third.'

function chunks(replyId = 'r1', cuts = [20, 50, BODY.length], final = true): SpeechChunkHeader[] {
  const out: SpeechChunkHeader[] = []
  let a = 0
  cuts.forEach((b, index) => {
    const text = BODY.slice(a, b)
    out.push({
      sessionUid: 's',
      evSeq: 0,
      replyId,
      index,
      src: [a, b],
      text,
      spoken: text.trim(),
      timeline: null,
      durationMs: 1000,
      mime: 'audio/wav',
      instant: false,
      final: final && index === cuts.length - 1
    })
    a = b
  })
  return out
}

const P = new Uint8Array(4)

describe('SpeechTracker', () => {
  it('holds chunk text in index order, even when chunks arrive out of order', () => {
    const h = harness()
    h.t.expect('r1')
    expect(h.t.get('r1').state).toBe('waiting')
    const [c0, c1, c2] = chunks()
    h.t.chunk(c1, P)
    expect(h.t.get('r1').heldText).toBe('')
    h.t.chunk(c0, P)
    expect(h.t.get('r1').heldText).toBe(BODY.slice(0, 50))
    h.t.chunk(c2, P)
    expect(h.t.get('r1').heldText).toBe(BODY)
    expect(h.t.get('r1').headers.map((x) => x.index)).toEqual([0, 1, 2])
    expect(h.enqueued).toEqual([1, 0, 2])
    // duplicates are ignored
    h.t.chunk(c2, P)
    expect(h.enqueued).toHaveLength(3)
  })

  it('waiting → speaking → done after speech.end and every chunk played; acks speech.played', () => {
    const h = harness()
    h.t.expect('r1')
    for (const c of chunks('r1', undefined, false)) h.t.chunk(c, P)
    h.t.chunkStart('r1', 0, 100)
    expect(h.t.get('r1').state).toBe('speaking')
    h.t.chunkEnd('r1', 0)
    expect(h.log).toContain('played:r1:0:20')
    h.t.speechEnd('r1')
    expect(h.t.get('r1').state).toBe('speaking')
    h.t.chunkEnd('r1', 1)
    h.t.chunkEnd('r1', 2)
    expect(h.t.get('r1').state).toBe('done')
    expect(h.t.get('r1').heldText).toBe(BODY)
    // No final:true replyEnd from the engine → the client closes the reveal and the engine queue itself.
    expect(h.log).toEqual(expect.arrayContaining(['finish:r1', 'stop:r1']))
    expect(h.log.indexOf('finish:r1')).toBeLessThan(h.log.indexOf('stop:r1'))
  })

  it("a final:true chunk waits for the engine's own replyEnd (the reveal completes on the audio clock)", () => {
    const h = harness()
    h.t.expect('r1')
    for (const c of chunks()) h.t.chunk(c, P)
    h.t.chunkStart('r1', 0, 0)
    h.t.speechEnd('r1')
    for (const i of [0, 1, 2]) h.t.chunkEnd('r1', i)
    expect(h.t.get('r1').state).toBe('speaking')
    h.t.replyEnd('r1', false)
    expect(h.t.get('r1').state).toBe('done')
    expect(h.log.filter((x) => x.startsWith('stop') || x.startsWith('finish'))).toEqual([])
  })

  it('speech.end without a final chunk finalizes the engine queue at the last chunk received', () => {
    const finals: string[] = []
    const h = harness()
    const t = new SpeechTracker({
      setTimer: () => 1,
      clearTimer: () => {},
      effects: {
        enqueue: () => {},
        stop: (id) => void h.log.push(`stop:${id}`),
        finishReveal: (id) => void h.log.push(`finish:${id}`),
        finalize: (id, i) => {
          finals.push(`${id}:${i}`)
          return true
        },
        sendCancel: () => {},
        sendPlayed: () => {},
        unavailable: () => {},
        publish: () => {}
      }
    })
    t.expect('r1')
    for (const c of chunks('r1', undefined, false)) t.chunk(c, P)
    t.chunkStart('r1', 0, 0)
    t.speechEnd('r1')
    expect(finals).toEqual(['r1:2'])
    for (const i of [0, 1, 2]) t.chunkEnd('r1', i)
    expect(t.get('r1').state).toBe('speaking')
    t.replyEnd('r1', false)
    expect(t.get('r1').state).toBe('done')
    expect(h.log).toEqual([])
    // A gap (chunk 1 missing) is not finalized: the 6 s rule handles it.
    t.expect('r2')
    const [a, , c] = chunks('r2', undefined, false)
    t.chunk(a, P)
    t.chunk(c, P)
    t.speechEnd('r2')
    expect(finals).toEqual(['r1:2'])
  })

  it('speech.stopped (another device barged in) stops and freezes here without a second speech.cancel', () => {
    const h = harness()
    h.t.expect('r1')
    for (const c of chunks()) h.t.chunk(c, P)
    h.t.chunkStart('r1', 0, 0)
    h.t.stopped('r1')
    expect(h.t.get('r1').state).toBe('interrupted')
    expect(h.log).toContain('stop:r1')
    expect(h.log.some((x) => x.startsWith('cancel'))).toBe(false)
    // Not ours / already over: nothing happens.
    h.t.stopped('r1')
    h.t.stopped('nope')
    expect(h.log.filter((x) => x.startsWith('stop'))).toHaveLength(1)
  })

  it('a naturally ended reply (final chunk) is done without stopping the engine', () => {
    const h = harness()
    h.t.expect('r1')
    for (const c of chunks()) h.t.chunk(c, P)
    h.t.speechEnd('r1')
    h.t.replyEnd('r1', false)
    expect(h.t.get('r1').state).toBe('done')
    expect(h.log.filter((x) => x.startsWith('stop'))).toEqual([])
  })

  it('a reply.delta before any chunk means this client is not the speaker', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.preparing('r1')
    expect(h.timers()).toBe(1)
    h.t.delta('r1')
    expect(h.t.get('r1')).toBe(NO_SPEECH)
    expect(h.published.get('r1')).toBeNull()
    expect(h.timers()).toBe(0)
  })

  it('6 s rule: no first chunk within 6 s of speech.preparing → failed, text-first, one toast', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'thinking')
    h.tick(10_000)
    expect(h.t.get('r1').state).toBe('waiting')
    h.t.status('r1', 'writing')
    h.t.status('r1', 'preparing-voice')
    h.tick(10_000)
    expect(h.t.get('r1').state).toBe('waiting')
    h.t.preparing('r1')
    h.tick(CHUNK_DEADLINE_MS - 1)
    expect(h.t.get('r1').state).toBe('waiting')
    h.tick(1)
    const s = h.t.get('r1')
    expect(s.state).toBe('failed')
    expect(s.heldText).toBeNull()
    expect(h.log).toEqual(['finish:r1', 'stop:r1', 'unavailable:r1:timeout'])
    // Late chunks are not played.
    h.t.chunk(chunks()[0], P)
    expect(h.enqueued).toEqual([])
  })

  it('F32: waitForTone — 10 s of streaming, then reply.done; the chunk 2 s later is spoken', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'thinking')
    h.t.status('r1', 'preparing-voice')
    h.tick(10_000)
    // The server dispatches chunk 0 at end(), just before reply.status 'done' / reply.done.
    h.t.preparing('r1')
    h.t.status('r1', 'done')
    h.t.replyDone('r1')
    h.tick(2000)
    h.t.chunk(chunks()[0], P)
    h.tick(CHUNK_DEADLINE_MS * 2)
    expect(h.t.get('r1').state).toBe('waiting')
    expect(h.log.some((x) => x.startsWith('unavailable'))).toBe(false)
  })

  it('F32: a short lead-in, a memory tool round (recalling → thinking > 6 s), then the answer is still spoken', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'preparing-voice') // "Let me check my memory." (< 40 chars: no chunk yet)
    h.tick(1000)
    h.t.status('r1', 'recalling')
    h.tick(3000)
    h.t.status('r1', 'thinking')
    h.tick(3500)
    h.t.status('r1', 'preparing-voice')
    h.tick(2000)
    h.t.preparing('r1')
    h.tick(2000)
    h.t.chunk(chunks()[0], P)
    expect(h.log.some((x) => x.startsWith('unavailable'))).toBe(false)
    expect(h.timers()).toBe(0)
  })

  it('NEW-2: "speak again" — speech.preparing arrives before the ack (expect); a stalled TTS still times out', () => {
    const h = harness()
    // speech.replay: the server dispatches chunk 0 (speech.preparing) before it acks; the client expects after the ack.
    h.t.preparing('rp_x')
    expect(h.t.get('rp_x')).toBe(NO_SPEECH)
    h.t.expect('rp_x')
    expect(h.t.get('rp_x').state).toBe('waiting')
    // A replay gets no reply.status / reply.done: speech.preparing is the only clock start.
    h.tick(CHUNK_DEADLINE_MS - 1)
    expect(h.t.get('rp_x').state).toBe('waiting')
    h.tick(1)
    expect(h.t.get('rp_x').state).toBe('failed')
    expect(h.log).toEqual(['finish:rp_x', 'stop:rp_x', 'unavailable:rp_x:timeout'])
  })

  it('NEW-2: an early speech.preparing is remembered only for a bounded number of replies and only once', () => {
    const h = harness()
    h.t.preparing('rp_a')
    h.t.expect('rp_a')
    h.t.chunk(chunks('rp_a')[0], P)
    expect(h.timers()).toBe(0)
    // Many unrelated early events do not grow without bound; a reply expected later without one waits for its own.
    for (let i = 0; i < 500; i++) h.t.preparing(`rp_${i}`)
    h.t.expect('rp_new')
    h.tick(CHUNK_DEADLINE_MS * 3)
    expect(h.t.get('rp_new').state).toBe('waiting')
  })

  it('F32: without speech.preparing the clock starts at reply.done at the latest', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'preparing-voice')
    h.tick(30_000)
    h.t.replyDone('r1')
    h.tick(CHUNK_DEADLINE_MS - 1)
    expect(h.t.get('r1').state).toBe('waiting')
    h.tick(1)
    expect(h.t.get('r1').state).toBe('failed')
    expect(h.log.at(-1)).toBe('unavailable:r1:timeout')
  })

  it('6 s rule for later chunks starts at the underrun', () => {
    const h = harness()
    h.t.expect('r1')
    const [c0, c1] = chunks()
    h.t.status('r1', 'writing')
    h.t.chunk(c0, P)
    expect(h.timers()).toBe(0)
    h.t.chunkStart('r1', 0, 0)
    h.t.underrun('r1', 1)
    h.tick(5000)
    h.t.chunk(c1, P)
    expect(h.timers()).toBe(0)
    h.t.underrun('r1', 2)
    h.tick(CHUNK_DEADLINE_MS)
    expect(h.t.get('r1').state).toBe('failed')
  })

  it('speech.error, speech.degraded and a targeted snapshot fail the reply; an untargeted snapshot does not', () => {
    for (const how of ['error', 'degraded', 'snapshot'] as const) {
      const h = harness()
      h.t.expect('r1')
      h.t.chunk(chunks()[0], P)
      if (how === 'error') h.t.speechError('r1')
      if (how === 'degraded') h.t.degraded('r1')
      if (how === 'snapshot') {
        h.t.snapshot('r1', false)
        expect(h.t.get('r1').state).toBe('waiting')
        h.t.snapshot('r1', true)
      }
      expect(h.t.get('r1').state).toBe('failed')
      expect(h.log.at(-1)).toBe(`unavailable:r1:${how}`)
    }
  })

  it('barge-in sends speech.cancel with the spoken offset, stops the audio and keeps the held text', () => {
    const h = harness()
    h.t.expect('r1')
    const cs = chunks()
    cs[1] = { ...cs[1], spoken: 'abcdefghij', timeline: { startsMs: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900], endsMs: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] } }
    for (const c of cs) h.t.chunk(c, P)
    h.t.chunkStart('r1', 0, 1000)
    h.t.chunkEnd('r1', 0)
    h.t.chunkStart('r1', 1, 2000)
    expect(h.t.bargeIn('r1', 2450)).toBe(true)
    // 5 of 10 spoken chars started → half of [20, 50)
    expect(h.log).toContain('cancel:r1:35')
    expect(h.log.at(-1)).toBe('stop:r1')
    expect(h.t.get('r1')).toMatchObject({ state: 'interrupted', heldText: BODY })
    expect(h.t.bargeIn('r1', 3000)).toBe(false)
    expect(h.t.live()).toEqual([])
  })

  it('F31: barge-in before any audio played cancels the speech only — text-first, no "interrupted", no toast', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'preparing-voice')
    expect(h.t.bargeIn('r1', 100)).toBe(true)
    expect(h.log).toEqual(['cancel:r1:0:before-audio', 'finish:r1', 'stop:r1'])
    expect(h.t.get('r1')).toMatchObject({ state: 'cancelled', heldText: null })
    expect(h.t.live()).toEqual([])
    expect(h.timers()).toBe(0)
    // Audio already on its way is not played; nothing toasts later.
    h.t.chunk(chunks()[0], P)
    expect(h.enqueued).toEqual([])
    h.tick(CHUNK_DEADLINE_MS * 2)
    expect(h.log.some((x) => x.startsWith('unavailable'))).toBe(false)
  })

  it('F31: chunks received but none started playing still counts as not heard', () => {
    const h = harness()
    h.t.expect('r1')
    for (const c of chunks()) h.t.chunk(c, P)
    h.t.chunkStart('r1', 0, 500) // scheduled to start at 500 on the audio clock
    expect(h.t.bargeIn('r1', 400)).toBe(true)
    expect(h.log[0]).toBe('cancel:r1:0:before-audio')
    expect(h.t.get('r1').state).toBe('cancelled')
  })

  it('F31: speech.stopped before anything played here → cancelled (text), not a frozen empty reveal', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.chunk(chunks()[0], P)
    h.t.stopped('r1')
    expect(h.t.get('r1')).toMatchObject({ state: 'cancelled', heldText: null })
    expect(h.log).toEqual(['finish:r1', 'stop:r1'])
  })

  it('stopped / errored before any chunk drops the record quietly', () => {
    const h = harness()
    h.t.expect('r1')
    h.t.status('r1', 'stopped')
    expect(h.t.get('r1')).toBe(NO_SPEECH)
    h.t.expect('r2')
    h.t.replyError('r2')
    expect(h.t.get('r2')).toBe(NO_SPEECH)
    h.t.expect('r3')
    h.t.speechEnd('r3')
    expect(h.t.get('r3')).toBe(NO_SPEECH)
    expect(h.log).toEqual([])
  })

  it('keeps at most MAX_FINISHED finished records and no timers after many turns (leak bound)', () => {
    const h = harness()
    for (let i = 0; i < MAX_FINISHED + 40; i++) {
      const id = `r${i}`
      h.t.expect(id)
      h.t.status(id, 'writing')
      for (const c of chunks(id)) h.t.chunk(c, P)
      h.t.speechEnd(id)
      h.t.replyEnd(id, false)
    }
    expect(h.t.stats()).toEqual({ records: MAX_FINISHED, timers: 0, live: 0 })
    expect(h.timers()).toBe(0)
    h.t.reset()
    expect(h.t.stats().records).toBe(0)
  })
})

describe('spokenOffset', () => {
  const base = { src: [10, 30] as [number, number], spoken: 'abcdefghij', durationMs: 1000, instant: false }
  it('uses the timeline when present, else the duration', () => {
    expect(spokenOffset({ ...base, timeline: null }, 0)).toBe(10)
    expect(spokenOffset({ ...base, timeline: null }, 500)).toBe(20)
    expect(spokenOffset({ ...base, timeline: null }, 5000)).toBe(30)
    const timeline = { startsMs: [0, 0, 0, 0, 0, 900, 900, 900, 900, 900], endsMs: [] as number[] }
    expect(spokenOffset({ ...base, timeline }, 100)).toBe(20)
  })
  it('instant chunks count as spoken once reached', () => {
    expect(spokenOffset({ ...base, instant: true, spoken: '', timeline: null }, 1)).toBe(30)
  })
})
