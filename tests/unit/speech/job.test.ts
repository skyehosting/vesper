/**
 * SpeechJob pipeline (07 C14/C15/C16, A2): ordered delivery with ≤ 2 syntheses in flight, instant chunks, barge-in
 * mid-chunk, backpressure → speech.degraded, failure → speech.error + text-first, tone placement rules, speaker
 * leaving, and resource release after many replies. @R12 @R13 @R14
 */
import { describe, expect, it } from 'vitest'
import { VesperError } from '@shared/errors'
import { AUDIO_BACKPRESSURE_BYTES, type ServerMsg } from '@shared/ws'
import type { Hub, WsClient } from '@server/services'
import { SpeechJob, type JobDeps } from '@server/speech/job'
import type { PlannedChunk } from '@server/speech/segmenter'
import type { SynthResult } from '@server/providers/tts/types'
import { toApiError } from '@server/http/errors'
import { FakeWsClient, fakeLog } from '../../fakes'

interface Emitted {
  msg: ServerMsg
  opts?: { only?: string; except?: string }
}

function fakeHub(clients: FakeWsClient[]): Hub & { emitted: Emitted[] } {
  const emitted: Emitted[] = []
  const hub = {
    emitted,
    clients: () => clients.values(),
    client: (id: string) => clients.find((c) => c.id === id && !c.closed) as WsClient | undefined,
    emit: (_uid: string, msg: ServerMsg, opts?: { only?: string; except?: string }) => void emitted.push({ msg, opts }),
    broadcast: (msg: ServerMsg) => void emitted.push({ msg })
  }
  return hub as unknown as Hub & { emitted: Emitted[] }
}

const TEXT = 'Hello there, my friend. It has been a long time since we spoke, and I missed you a lot. Tell me everything. What happened while I was away? Did you finish the project you were working on? I would love to hear about it all. Take your time.'

function result(text: string): SynthResult {
  const bytes = new Uint8Array(100 + text.length)
  return { audio: bytes, mime: 'audio/wav', durationMs: text.length * 50, timeline: { startsMs: [...text].map((_, i) => i * 50), endsMs: [...text].map((_, i) => i * 50 + 50) }, timing: 'provider' }
}

interface Harness {
  job: SpeechJob
  hub: ReturnType<typeof fakeHub>
  clients: FakeWsClient[]
  calls: Array<{ chunk: PlannedChunk; tone: string | null; signal: AbortSignal }>
  maxConcurrent: () => number
}

function harness(o: { clients?: number; synth?: JobDeps['synth']; tts?: Partial<JobDeps['tts']>; initialTone?: string | null; delayMs?: (i: number) => number; onEvent?: JobDeps['onEvent'] } = {}): Harness {
  const clients = Array.from({ length: o.clients ?? 1 }, (_, i) => new FakeWsClient(`c${i}`))
  const hub = fakeHub(clients)
  const calls: Harness['calls'] = []
  let running = 0
  let max = 0
  const synth: JobDeps['synth'] =
    o.synth ??
    (async (chunk, so, signal) => {
      calls.push({ chunk, tone: so.tone, signal })
      running++
      max = Math.max(max, running)
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, o.delayMs ? o.delayMs(chunk.index) : 5)
          signal.addEventListener('abort', () => (clearTimeout(t), reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true })
        })
        return result(chunk.spoken)
      } finally {
        running--
      }
    })
  const job = new SpeechJob(
    { replyId: 'r1', sessionUid: 's1', clientIds: clients.map((c) => c.id) },
    {
      hub,
      log: fakeLog(),
      now: () => Date.now(),
      toApiError,
      tts: { toneMode: 'conversation', tonePlacement: 'start', waitForTone: false, speakCode: 'skip', ...o.tts },
      initialTone: o.initialTone ?? null,
      onEvent: o.onEvent,
      synth: (c, so, s) => {
        if (o.synth) calls.push({ chunk: c, tone: so.tone, signal: s })
        return synth(c, so, s)
      }
    }
  )
  return { job, hub, clients, calls, maxConcurrent: () => max }
}

function streamInto(job: SpeechJob, text: string, step = 9): void {
  for (let i = 0; i < text.length; i += step) job.push(text.slice(i, i + step))
}

/** Emitted event types, without the per-speaker speech.preparing (asserted on its own). */
const types = (h: Harness) => h.hub.emitted.map((e) => e.msg.t).filter((t) => t !== 'speech.preparing')
const preparing = (h: Harness) => h.hub.emitted.filter((e) => e.msg.t === 'speech.preparing')

describe('SpeechJob', () => {
  it('sends chunks in order with ≤ 2 in flight, marks the last one final, then speech.end once', async () => {
    // Later chunks finish first: order must still hold.
    const h = harness({ delayMs: (i) => 40 - i * 8 })
    streamInto(h.job, TEXT)
    h.job.end(TEXT)
    const r = await h.job.done
    const frames = h.clients[0].speech
    expect(frames.length).toBeGreaterThan(2)
    expect(frames.map((f) => f.header.index)).toEqual(frames.map((_, i) => i))
    expect(h.maxConcurrent()).toBeLessThanOrEqual(2)
    expect(frames.at(-1)!.header.final).toBe(true)
    expect(frames.slice(0, -1).every((f) => !f.header.final)).toBe(true)
    // The chunks tile the text and carry the spoken text + timeline.
    expect(frames.map((f) => TEXT.slice(...f.header.src)).join('')).toBe(TEXT)
    // The speaking client gets no reply.delta in synced mode: the chunk texts alone rebuild the reply (R14).
    expect(frames.map((f) => f.header.text).join('')).toBe(TEXT)
    for (const f of frames) expect(f.header.text).toBe(TEXT.slice(...f.header.src))
    for (const f of frames) {
      expect(f.header.timeline!.startsMs).toHaveLength(f.header.spoken.length)
      expect(f.header.evSeq).toBe(0)
      expect(f.header.sessionUid).toBe('s1')
    }
    expect(types(h).filter((t) => t === 'speech.end')).toHaveLength(1)
    expect(types(h)).toContain('reply.timing')
    expect(r).toEqual({ chunks: frames.length, spokenChars: TEXT.length, interrupted: false, failed: false })
  })

  it('instant chunks go out as empty zero-duration frames in their place', async () => {
    const text = 'Here is the snippet you asked for.\n\n```js\nlet a = 1\n```\n\nAnd that is it.'
    const h = harness()
    h.job.push(text)
    h.job.end(text)
    await h.job.done
    const f = h.clients[0].speech
    expect(f.map((x) => x.header.instant)).toEqual([false, true, false])
    expect(f[1].audio.length).toBe(0)
    expect(f[1].header.durationMs).toBe(0)
    expect(f[1].header.spoken).toBe('')
    expect(h.calls).toHaveLength(2)
  })

  it('barge-in mid-chunk aborts synthesis, records spoken chars, sends nothing more @R14', async () => {
    // Chunk 0's audio went out (it may have been heard); the next ones are still synthesizing.
    const h = harness({ delayMs: (i) => (i === 0 ? 1 : 10_000) })
    streamInto(h.job, TEXT)
    await new Promise((r) => setTimeout(r, 40))
    expect(h.clients[0].speech).toHaveLength(1)
    const pending = h.calls.slice(1)
    expect(pending.length).toBeGreaterThan(0)
    const res = h.job.cancel(17)
    expect(res).toMatchObject({ interrupted: true, spokenChars: 17 })
    expect(pending.every((c) => c.signal.aborted)).toBe(true)
    h.job.push(' more text that arrives late.')
    h.job.end(TEXT)
    expect(await h.job.done).toEqual({ chunks: 1, spokenChars: 17, interrupted: true, failed: false })
    expect(h.clients[0].speech).toHaveLength(1)
    expect(types(h).filter((t) => t !== 'reply.timing')).toEqual(['speech.end'])
    await new Promise((r) => setTimeout(r, 0)) // aborted syntheses unwind on the next turn
    expect(h.job.stats()).toMatchObject({ inFlight: 0, ready: 0 })
  })

  it('F31: a cancel before any audio went out is not a barge-in: speech stops, every speaker is handed the text', async () => {
    const events: unknown[] = []
    const h = harness({ clients: 2, delayMs: () => 10_000, onEvent: (e) => void events.push(e) })
    streamInto(h.job, TEXT)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.calls.length).toBe(2)
    const res = h.job.cancel(17, { byClientId: 'c0' })
    expect(res).toMatchObject({ interrupted: false, failed: false })
    expect(h.calls.every((c) => c.signal.aborted)).toBe(true)
    expect(events).toEqual([
      { kind: 'degraded', clientId: 'c0', reason: 'text-first' },
      { kind: 'degraded', clientId: 'c1', reason: 'text-first' }
    ])
    expect(await h.job.done).toMatchObject({ chunks: 0, interrupted: false, failed: false })
    expect(types(h)).toEqual(['speech.end'])
  })

  it('F32: speech.preparing goes to each speaker once, when chunk 0 is dispatched — with waitForTone only at end()', async () => {
    const h = harness({ clients: 2, tts: { waitForTone: true } })
    streamInto(h.job, TEXT)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.calls).toHaveLength(0)
    expect(preparing(h)).toEqual([])
    h.job.end(TEXT)
    expect(preparing(h).map((e) => e.opts?.only)).toEqual(['c0', 'c1'])
    expect(preparing(h)[0].msg).toMatchObject({ replyId: 'r1', index: 0 })
    await h.job.done
    expect(preparing(h)).toHaveLength(2)
    // A short first sentence is not a chunk yet: nothing is being made, so no clock may run.
    const s = harness({ tts: { toneMode: 'off' } })
    s.job.push('Let me check.')
    expect(preparing(s)).toEqual([])
    s.job.push(' I looked through what we said last week and found the notes. Here they are, in order.')
    expect(preparing(s)).toHaveLength(1)
  })

  it('F31: beforeAudio counts only when the canceller is the sole speaker', async () => {
    const solo = harness({ delayMs: (i) => (i === 0 ? 1 : 10_000) })
    streamInto(solo.job, TEXT)
    await new Promise((r) => setTimeout(r, 40))
    expect(solo.clients[0].speech).toHaveLength(1)
    expect(solo.job.cancel(0, { beforeAudio: true, byClientId: 'c0' })).toMatchObject({ interrupted: false })
    const two = harness({ clients: 2, delayMs: (i) => (i === 0 ? 1 : 10_000) })
    streamInto(two.job, TEXT)
    await new Promise((r) => setTimeout(r, 40))
    // c1 may already be hearing chunk 0: a real barge-in.
    expect(two.job.cancel(0, { beforeAudio: true, byClientId: 'c0' })).toMatchObject({ interrupted: true })
  })

  it('speech.played acks feed spoken chars when the cancel carries none', async () => {
    const h = harness()
    streamInto(h.job, TEXT)
    h.job.played(0, 30)
    h.job.played(0, 12) // never goes backwards
    expect(h.job.cancel()).toMatchObject({ spokenChars: 30 })
  })

  it('a socket over the backpressure limit gets speech.degraded and no more audio; the others continue @R14', async () => {
    const h = harness({ clients: 2 })
    h.clients[1].bufferedAmount = AUDIO_BACKPRESSURE_BYTES + 1
    streamInto(h.job, TEXT)
    h.job.end(TEXT)
    const r = await h.job.done
    expect(h.clients[1].speech).toHaveLength(0)
    expect(h.clients[0].speech.length).toBeGreaterThan(1)
    const degraded = h.hub.emitted.filter((e) => e.msg.t === 'speech.degraded')
    expect(degraded).toHaveLength(1)
    expect(degraded[0].opts).toEqual({ only: 'c1' })
    expect(degraded[0].msg).toMatchObject({ reason: 'backpressure', replyId: 'r1' })
    expect(r.failed).toBe(false)
  })

  it('when every speaker is degraded, synthesis stops (no paid calls for nobody)', async () => {
    const h = harness({ delayMs: (i) => (i === 0 ? 1 : 10_000) })
    h.clients[0].bufferedAmount = AUDIO_BACKPRESSURE_BYTES + 1
    streamInto(h.job, TEXT)
    const r = await h.job.done
    expect(r).toMatchObject({ failed: true, chunks: 1 })
    expect(h.calls.slice(1).every((c) => c.signal.aborted)).toBe(true)
  })

  it('a chunk that fails twice ends speech: speech.error then speech.end; text-first for the client @R12', async () => {
    let n = 0
    const h = harness({
      synth: async (c) => {
        if (c.index === 1) {
          n++
          throw new VesperError('provider_overloaded', { upstreamStatus: 503 })
        }
        return result(c.spoken)
      }
    })
    streamInto(h.job, TEXT)
    h.job.end(TEXT)
    const r = await h.job.done
    expect(n).toBe(2)
    expect(r.failed).toBe(true)
    const err = h.hub.emitted.find((e) => e.msg.t === 'speech.error')!.msg as Extract<ServerMsg, { t: 'speech.error' }>
    expect(err).toMatchObject({ replyId: 'r1', index: 1, error: { code: 'provider_overloaded', retryable: true, upstreamStatus: 503 } })
    expect(JSON.stringify(err)).not.toMatch(/stack|Error:/)
    expect(types(h).slice(-2)).toEqual(['speech.error', 'speech.end'])
    expect(h.clients[0].speech.map((f) => f.header.index)).toEqual([0])
  })

  it('a rejected key is not retried', async () => {
    const h = harness({
      synth: async () => {
        throw new VesperError('provider_auth', { upstreamStatus: 401 })
      }
    })
    h.job.push('Hello there. This reply cannot be spoken because the key was rejected.')
    h.job.end('Hello there. This reply cannot be spoken because the key was rejected.')
    await h.job.done
    expect(h.calls).toHaveLength(1)
    expect(h.hub.emitted.find((e) => e.msg.t === 'speech.error')!.msg).toMatchObject({ index: 0, error: { code: 'provider_auth' } })
  })

  describe('tone (07 A2) @R13', () => {
    it('a tag at the start applies to every chunk; before any tag the session tone is used', async () => {
      const h = harness({ initialTone: 'calm' })
      h.job.tone('warm, teasing', 0)
      streamInto(h.job, TEXT)
      h.job.end(TEXT)
      await h.job.done
      expect(h.calls.length).toBeGreaterThan(2)
      expect(h.calls.every((c) => c.tone === 'warm, teasing')).toBe(true)
      const g = harness({ initialTone: 'calm' })
      streamInto(g.job, TEXT)
      g.job.end(TEXT)
      await g.job.done
      expect(g.calls.every((c) => c.tone === 'calm')).toBe(true)
    })

    it('a tag applies from its chunk until the next tag', async () => {
      const h = harness()
      streamInto(h.job, TEXT.slice(0, 120))
      h.job.tone('excited', 120)
      streamInto(h.job, TEXT.slice(120))
      h.job.end(TEXT)
      await h.job.done
      for (const c of h.calls) expect(c.tone).toBe(c.chunk.src[1] > 120 ? 'excited' : null)
      expect(h.calls.some((c) => c.tone === null)).toBe(true)
    })

    it("with the tag at the end, short replies wait for it and it applies to all of them", async () => {
      const short = 'That is wonderful news. I am so glad to hear it, really.'
      const h = harness({ tts: { tonePlacement: 'end' } })
      streamInto(h.job, short)
      await new Promise((r) => setTimeout(r, 10))
      expect(h.calls).toHaveLength(0)
      h.job.tone('delighted', short.length)
      h.job.end(short)
      await h.job.done
      expect(h.calls.length).toBeGreaterThan(0)
      expect(h.calls.every((c) => c.tone === 'delighted')).toBe(true)
    })

    it('with the tag at the start, synthesis never waits past 40 visible chars; waitForTone waits for the end', async () => {
      const h = harness()
      streamInto(h.job, TEXT.slice(0, 80))
      expect(h.calls.length).toBe(1)
      h.job.abort('stopped')
      const w = harness({ tts: { waitForTone: true } })
      streamInto(w.job, TEXT)
      expect(w.calls).toHaveLength(0)
      w.job.end(TEXT)
      await w.job.done
      expect(w.calls.length).toBeGreaterThan(0)
    })

    it('tone off: no tone reaches the provider', async () => {
      const h = harness({ tts: { toneMode: 'off' }, initialTone: 'calm' })
      h.job.tone('warm', 0)
      h.job.push(TEXT)
      h.job.end(TEXT)
      await h.job.done
      expect(h.calls.every((c) => c.tone === null)).toBe(true)
    })
  })

  it('the speaker leaving stops synthesis and tells the others', async () => {
    const h = harness({ delayMs: () => 10_000 })
    streamInto(h.job, TEXT)
    h.job.clientGone('c0')
    const r = await h.job.done
    expect(r).toMatchObject({ interrupted: false, failed: false })
    expect(h.calls.every((c) => c.signal.aborted)).toBe(true)
    expect(h.hub.emitted.filter((e) => e.msg.t !== 'speech.preparing').map((e) => [e.msg.t, (e.msg as { reason?: string }).reason])).toEqual([
      ['speech.degraded', 'speaker-left'],
      ['speech.end', undefined]
    ])
  })

  it('a reply with no speaking client finishes at once and emits nothing', async () => {
    const h = harness({ clients: 0 })
    h.job.push(TEXT)
    expect(await h.job.done).toMatchObject({ chunks: 0 })
    expect(h.hub.emitted).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('100 replies (some cancelled, some failing) leave no timers or pending work behind', async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
    for (let i = 0; i < 100; i++) {
      const h = harness({ delayMs: () => 1 })
      streamInto(h.job, TEXT, 13)
      if (i % 3 === 0) h.job.cancel(10)
      else if (i % 7 === 0) h.job.abort('error')
      else h.job.end(TEXT)
      await h.job.done
      await new Promise((r) => setTimeout(r, 0))
      expect(h.job.stats()).toMatchObject({ inFlight: 0, ready: 0 })
      expect(h.job.isFinished).toBe(true)
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length).toBeLessThanOrEqual(before)
  })
})
