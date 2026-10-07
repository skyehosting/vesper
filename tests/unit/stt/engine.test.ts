/**
 * The STT process's engine in-process with the REAL bundled Silero VAD and the fake recognizer (VESPER_STT_FAKE,
 * 05 §5) @R19: endpoint timing against real speech, pre-roll, partials, guards, VAD reuse.
 */
import { describe, expect, it } from 'vitest'
import { SttEngine, fakeRecognizer, FAKE_DEFAULT_TEXT } from '../../../src/server/providers/stt/engine'
import type { FromProcess, LoadSpec, MicOptions } from '../../../src/server/providers/stt/protocol'
import { createVad } from '../../../src/server/providers/stt/sherpa'
import { concat, fixture, frames, silence, sleep, VAD_MODEL, waitFor } from './helpers'

const SPEC: LoadSpec = { key: 'fake', model: { id: 'x', family: 'moonshine', dir: '' }, vadModel: VAD_MODEL, threads: 1, lang: 'auto', fake: true }

function opts(o: Partial<MicOptions> = {}): MicOptions {
  return { mode: 'dictate', silenceMs: 1200, lang: 'auto', ttsActive: false, bargeIn: 'tap', vadThreshold: 0.5, preRollMs: 400, maxUtteranceMs: 60_000, wantAudio: false, partials: true, ...o }
}

function engine(texts?: string[]) {
  const out: { m: FromProcess; atMs: number }[] = []
  let fed = 0
  let vads = 0
  const e = new SttEngine({
    post: (m) => out.push({ m, atMs: Math.round(fed / 16) }),
    createVad: (c) => {
      vads++
      return createVad(c)
    },
    createRecognizer: async (spec) => (spec.fake ? fakeRecognizer(texts) : null)
  })
  return {
    e,
    out,
    vadsCreated: () => vads,
    feed(micId: string, pcm: Int16Array) {
      for (const f of frames(pcm)) {
        fed += f.length
        e.handle({ t: 'frames', micId, pcm: f })
      }
    },
    of<T extends FromProcess['t']>(t: T) {
      return out.filter((x) => x.m.t === t) as { m: Extract<FromProcess, { t: T }>; atMs: number }[]
    }
  }
}

/** Last sample louder than -36 dBFS: where the fixture's speech really ends. */
function speechEndMs(pcm: Int16Array): number {
  for (let i = pcm.length - 1; i >= 0; i--) if (Math.abs(pcm[i]) > 500) return Math.round(i / 16)
  return 0
}

function trim(pcm: Int16Array): Int16Array {
  let a = 0
  while (a < pcm.length && Math.abs(pcm[a]) <= 500) a++
  return pcm.slice(Math.max(0, a - 16 * 50), Math.min(pcm.length, speechEndMs(pcm) * 16 + 16 * 100))
}

async function loaded(x: ReturnType<typeof engine>, spec = SPEC) {
  x.e.handle({ t: 'load', spec })
  await waitFor(() => x.of('loaded').length > 0 || x.of('loadError').length > 0)
}

describe('STT engine with the real Silero VAD @R19', () => {
  it('hello.wav → one final with the scripted text, silenceMs ± 150 ms after the speech ends', async () => {
    for (const silenceMs of [800, 1200, 2000]) {
      const x = engine()
      await loaded(x)
      x.e.handle({ t: 'open', micId: 'm1', o: opts({ silenceMs }) })
      const hello = fixture('hello')
      const pcm = concat(silence(500), hello.pcm, silence(3000))
      x.feed('m1', pcm)
      const end = 500 + speechEndMs(hello.pcm)
      await waitFor(() => x.of('final').length > 0)
      const ep = x.of('endpoint')
      expect(ep).toHaveLength(1)
      expect(Math.abs(ep[0].atMs - (end + silenceMs))).toBeLessThanOrEqual(150)
      const f = x.of('final')
      expect(f).toHaveLength(1)
      expect(f[0].m).toMatchObject({ text: FAKE_DEFAULT_TEXT, micId: 'm1' })
      expect(f[0].m.dropped).toBeUndefined()
      // pre-roll: the utterance audio starts ~400 ms before the detected onset
      expect(f[0].m.durationMs).toBeGreaterThan(speechEndMs(hello.pcm) - 300)
      expect(x.of('vad').map((v) => v.m.speaking)).toEqual([true, false])
    }
  })

  it('a long pause inside one utterance gives partials, then one final; finals consume the script', async () => {
    const x = engine(['first sentence', 'second sentence'])
    await loaded(x)
    x.e.handle({ t: 'open', micId: 'm', o: opts({ silenceMs: 1500 }) })
    // The SAPI fixtures carry their own leading/trailing silence: trim it so the pauses below are exact.
    const s = trim(fixture('search').pcm)
    const h = trim(fixture('hello').pcm)
    // Fed in real-time-ish steps: a partial decode is skipped when its utterance already ended (the final supersedes it).
    x.feed('m', concat(silence(300), h, silence(800)))
    await waitFor(() => x.of('partial').length >= 1)
    x.feed('m', concat(s, silence(1000)))
    await waitFor(() => x.of('partial').length >= 2)
    x.feed('m', concat(silence(1500), h, silence(2500)))
    await waitFor(() => x.of('final').length >= 2)
    await sleep(50)
    expect(x.of('final').map((f) => f.m.text)).toEqual(['first sentence', 'second sentence'])
    expect(x.of('partial').length).toBeGreaterThanOrEqual(2)
    expect(x.of('partial')[0].m.text).toBe('first sentence')
  })

  it('drops a click shorter than the minimum speech (guards) and stays quiet on silence', async () => {
    const x = engine()
    await loaded(x)
    x.e.handle({ t: 'open', micId: 'm', o: opts() })
    x.feed('m', silence(5000))
    const click = new Int16Array(16 * 120).map((_, i) => Math.round(Math.sin(i / 3) * 12000))
    x.feed('m', concat(click, silence(3000)))
    await sleep(100)
    expect(x.of('final').filter((f) => !f.m.dropped)).toHaveLength(0)
  })

  it('stop finishes the utterance at once (push-to-talk), then closes; cancel drops it', async () => {
    const x = engine()
    await loaded(x)
    x.e.handle({ t: 'open', micId: 'p', o: opts({ mode: 'ptt' }) })
    x.feed('p', concat(silence(300), fixture('hello').pcm.subarray(0, 16 * 1500)))
    expect(x.of('final')).toHaveLength(0)
    x.e.handle({ t: 'close', micId: 'p', reason: 'stop' })
    await waitFor(() => x.of('closed').length > 0)
    const order = x.out.map((o) => o.m.t).filter((t) => t === 'final' || t === 'closed')
    expect(order).toEqual(['final', 'closed'])
    expect(x.of('final')[0].m.text).toBe(FAKE_DEFAULT_TEXT)

    x.e.handle({ t: 'open', micId: 'c', o: opts() })
    x.feed('c', concat(silence(300), fixture('hello').pcm.subarray(0, 16 * 1500)))
    x.e.handle({ t: 'close', micId: 'c', reason: 'cancel' })
    await waitFor(() => x.of('closed').length > 1)
    expect(x.of('final')).toHaveLength(1)
  })

  it('returns the utterance audio for cloud transcription (VAD only, no recognizer)', async () => {
    const x = engine()
    await loaded(x, { ...SPEC, key: 'vad', model: null, fake: false })
    x.e.handle({ t: 'open', micId: 'k', o: opts({ wantAudio: true, partials: false, silenceMs: 600 }) })
    x.feed('k', concat(silence(300), fixture('hello').pcm, silence(1500)))
    await waitFor(() => x.of('final').length > 0)
    const f = x.of('final')[0].m
    expect(f.text).toBe('')
    expect(f.audio).toBeInstanceOf(Int16Array)
    expect(f.audio!.length / 16).toBeCloseTo(f.durationMs, -1)
    expect(x.of('partial')).toHaveLength(0)
  })

  it('reuses VADs across sessions and holds no audio once sessions close @R17', async () => {
    const x = engine()
    await loaded(x)
    for (let i = 0; i < 100; i++) {
      x.e.handle({ t: 'open', micId: `s${i}`, o: opts() })
      x.feed(`s${i}`, silence(200))
      x.e.handle({ t: 'close', micId: `s${i}`, reason: i % 2 ? 'stop' : 'cancel' })
    }
    await waitFor(() => x.of('closed').length === 100)
    const st = x.e.stats()
    expect(st.sessions).toBe(0)
    expect(st.bufferedSamples).toBe(0)
    expect(st.vads).toBeLessThanOrEqual(4)
    expect(x.vadsCreated()).toBeLessThanOrEqual(2)
  })

  it('reports a missing model as stt_model_missing', async () => {
    const out: FromProcess[] = []
    const e = new SttEngine({
      post: (m) => out.push(m),
      createVad,
      createRecognizer: async () => {
        const err = new Error('missing encoder')
        err.name = 'ModelFilesMissing'
        throw err
      }
    })
    e.handle({ t: 'load', spec: { ...SPEC, fake: false } })
    await waitFor(() => out.length > 0)
    expect(out[0]).toMatchObject({ t: 'loadError', code: 'stt_model_missing' })
    e.handle({ t: 'open', micId: 'z', o: opts() })
    await waitFor(() => out.length > 1)
    expect(out[1]).toMatchObject({ t: 'error', micId: 'z', code: 'stt_unavailable' })
  })
})
