/**
 * Two-stage endpointing with synthetic PCM (07 C17, E12) @R19 @R20: tone bursts are "speech", zeros are silence, and an
 * energy VAD with Silero's timing rules (onset after 250 ms of speech, segment closes after the segmentation silence)
 * stands in for the model, so timings are exact and the test needs no native code.
 */
import { describe, expect, it } from 'vitest'
import { Endpointer, guardFinal, PcmBuffer, segmentSilenceMs, type FinalAudio, type VadLike } from '../../../src/server/providers/stt/endpointer'
import type { MicOptions } from '../../../src/server/providers/stt/protocol'

const SR = 16000
const W = 512

class EnergyVad implements VadLike {
  private inSpeech = false
  private run = 0
  private candStart: number | null = null
  private silenceRun = 0
  private segStart = 0
  private lastEnd = 0
  private pos = 0
  private seg: number[] = []
  private readonly out: { start: number; samples: Float32Array }[] = []
  constructor(
    private readonly minSilence: number,
    private readonly minSpeech = 0.25 * SR,
    private readonly thr = 0.02
  ) {}
  acceptWaveform(s: Float32Array): void {
    let e = 0
    for (const v of s) e += v * v
    const speechy = Math.sqrt(e / s.length) > this.thr
    const start = this.pos
    this.pos += s.length
    if (!this.inSpeech) {
      if (speechy) {
        this.candStart ??= start
        this.run += s.length
        this.seg.push(...s)
        if (this.run >= this.minSpeech) {
          this.inSpeech = true
          this.segStart = this.candStart
          this.lastEnd = this.pos
          this.silenceRun = 0
        }
      } else {
        this.run = 0
        this.candStart = null
        this.seg = []
      }
      return
    }
    this.seg.push(...s)
    if (speechy) {
      this.silenceRun = 0
      this.lastEnd = this.pos
    } else {
      this.silenceRun += s.length
      if (this.silenceRun >= this.minSilence) this.close()
    }
  }
  private close(): void {
    const len = this.lastEnd - this.segStart
    this.out.push({ start: this.segStart, samples: Float32Array.from(this.seg.slice(0, len)) })
    this.inSpeech = false
    this.run = 0
    this.candStart = null
    this.seg = []
  }
  isDetected = () => this.inSpeech
  isEmpty = () => this.out.length === 0
  front = () => this.out[0]
  pop = () => void this.out.shift()
  flush(): void {
    if (this.inSpeech) this.close()
  }
  reset(): void {
    this.inSpeech = false
    this.run = 0
    this.candStart = null
    this.seg = []
    this.out.length = 0
  }
}

const tone = (ms: number, amp = 0.3) => Float32Array.from({ length: Math.round((ms / 1000) * SR) }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / SR) * amp)
const quiet = (ms: number) => new Float32Array(Math.round((ms / 1000) * SR))

function opts(o: Partial<MicOptions> = {}): MicOptions {
  return { mode: 'dictate', silenceMs: 1200, lang: 'auto', ttsActive: false, bargeIn: 'tap', vadThreshold: 0.5, preRollMs: 400, maxUtteranceMs: 60_000, wantAudio: false, partials: true, ...o }
}

interface Log {
  events: string[]
  finals: { f: FinalAudio; at: number }[]
  segments: { len: number; at: number }[]
  vad: { speaking: boolean; at: number }[]
}

/** Feed `parts` in 32 ms frames and record when (audio time, ms) each event fired. */
function run(o: Partial<MicOptions>, parts: Float32Array[], before?: (ep: Endpointer) => void): { ep: Endpointer; log: Log } {
  const log: Log = { events: [], finals: [], segments: [], vad: [] }
  let fed = 0
  const now = () => Math.round((fed / SR) * 1000)
  const vad = new EnergyVad((segmentSilenceMs(opts(o).silenceMs) / 1000) * SR)
  const ep = new Endpointer(vad, opts(o), {
    vad: (speaking) => {
      log.events.push(`vad:${speaking}`)
      log.vad.push({ speaking, at: now() })
    },
    segment: (audio) => {
      log.events.push('segment')
      log.segments.push({ len: audio.length, at: now() })
    },
    endpoint: () => log.events.push('endpoint'),
    final: (f) => {
      log.events.push(`final:${f.reason}`)
      log.finals.push({ f, at: now() })
    }
  })
  before?.(ep)
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o2 = 0
  for (const p of parts) {
    all.set(p, o2)
    o2 += p.length
  }
  for (let i = 0; i < all.length; i += W) {
    const f = all.subarray(i, i + W)
    fed += f.length
    ep.push(f)
  }
  return { ep, log }
}

describe('endpointer @R19', () => {
  it('emits exactly one final, silenceMs after the speech ends (07 E12 default 1200 ms)', () => {
    const { log } = run({}, [quiet(500), tone(1500), quiet(3000)])
    expect(log.finals).toHaveLength(1)
    const speechEnd = 500 + 1500
    expect(Math.abs(log.finals[0].at - (speechEnd + 1200))).toBeLessThanOrEqual(64)
    expect(log.events).toEqual(['vad:true', 'segment', 'vad:false', 'endpoint', 'final:silence'])
    // speaking:false comes when the segment closes (segmentation silence after the speech).
    expect(Math.abs(log.vad[1].at - (speechEnd + 400))).toBeLessThanOrEqual(64)
  })

  it('a different silence setting moves the final by the same amount @R20', () => {
    const at = (silenceMs: number) => run({ silenceMs }, [quiet(300), tone(1000), quiet(6000)]).log.finals.map((f) => f.at)
    const short = at(800)
    const long = at(3000)
    expect(short).toHaveLength(1)
    expect(long).toHaveLength(1)
    expect(Math.abs(long[0] - short[0] - 2200)).toBeLessThanOrEqual(64)
    // Below the 400 ms segmentation silence the segment closes earlier too (300 ms setting).
    const tiny = at(300)
    expect(Math.abs(tiny[0] - (1300 + 300))).toBeLessThanOrEqual(64)
  })

  it('a pause shorter than the setting gives partial segments but one final for the whole utterance', () => {
    const { log } = run({}, [quiet(300), tone(1000), quiet(700), tone(1000), quiet(2500)])
    expect(log.segments).toHaveLength(2)
    expect(log.finals).toHaveLength(1)
    const f = log.finals[0].f
    // pre-roll 400 + 1000 speech + 700 pause + 1000 speech + 150 tail (± one 32 ms VAD window at each edge)
    expect(f.durationMs).toBeGreaterThanOrEqual(3100)
    expect(f.durationMs).toBeLessThanOrEqual(3350)
    expect(f.speechMs).toBeGreaterThanOrEqual(2000)
  })

  it('speech resuming just before the silence wait ends is not cut off (onset guard)', () => {
    // The VAD confirms the new onset 256 ms late, i.e. after the 1000 ms wait has "elapsed": the final must wait.
    const { log } = run({ silenceMs: 1000 }, [quiet(300), tone(1000), quiet(900), tone(1000), quiet(3000)])
    expect(log.finals).toHaveLength(1)
    expect(log.finals[0].f.speechMs).toBeGreaterThanOrEqual(1900)
  })

  it('a pause longer than the setting ends the first utterance', () => {
    const { log } = run({ silenceMs: 600 }, [tone(800), quiet(1500), tone(800), quiet(1500)])
    expect(log.finals.map((x) => x.f.reason)).toEqual(['silence', 'silence'])
  })

  it('includes the pre-roll before the detected onset (research 05 §3.7)', () => {
    const a = run({ preRollMs: 400 }, [quiet(1000), tone(1000), quiet(2000)]).log.finals[0].f
    const b = run({ preRollMs: 0 }, [quiet(1000), tone(1000), quiet(2000)]).log.finals[0].f
    expect(a.durationMs - b.durationMs).toBeGreaterThanOrEqual(390)
    expect(a.durationMs - b.durationMs).toBeLessThanOrEqual(410)
    // The pre-roll is the silence before the speech.
    expect(Math.max(...a.audio.subarray(0, 300 * 16).map(Math.abs))).toBe(0)
  })

  it('push-to-talk never ends on silence; stop() ends it', () => {
    const { ep, log } = run({ mode: 'ptt' }, [tone(800), quiet(3000), tone(500)])
    expect(log.finals).toHaveLength(0)
    expect(ep.stop()).toBe(true)
    expect(log.finals).toHaveLength(1)
    expect(log.finals[0].f.reason).toBe('stop')
    expect(ep.stop()).toBe(false)
  })

  it('forces a final at the maximum utterance length', () => {
    const { log } = run({ maxUtteranceMs: 5000 }, [tone(12_000), quiet(1600)])
    expect(log.finals.map((x) => x.f.reason)).toEqual(['max', 'max', 'silence'])
    expect(log.finals[0].f.durationMs).toBeLessThanOrEqual(5000 + 400 + 100)
  })

  it('ignores audio while TTS plays (barge-in tap) and needs 300 ms of speech with voice barge-in (07 D6)', () => {
    const tap = run({ ttsActive: true, bargeIn: 'tap' }, [tone(1500), quiet(2000)])
    expect(tap.log.events).toEqual([])
    expect(tap.ep.bufferedSamples).toBe(0)
    const voice = run({ ttsActive: true, bargeIn: 'voice' }, [quiet(200), tone(1500), quiet(2000)])
    const first = voice.log.vad.find((v) => v.speaking)
    const plain = run({}, [quiet(200), tone(1500), quiet(2000)]).log.vad.find((v) => v.speaking)
    expect(first && plain).toBeTruthy()
    expect(first!.at - plain!.at).toBeGreaterThanOrEqual(280)
  })

  it('F36: push-to-talk is heard while TTS plays with barge-in off, and a reply ending mid-hold keeps the words', () => {
    for (const bargeIn of ['off', 'tap'] as const) {
      const { ep, log } = run({ mode: 'ptt', ttsActive: true, bargeIn }, [tone(1200), quiet(300)])
      expect(ep.bufferedSamples).toBeGreaterThan(0)
      expect(ep.stop()).toBe(true)
      expect(log.finals).toHaveLength(1)
      expect(log.finals[0].f.reason).toBe('stop')
    }
    // The reply's voice ends while the button is still held: the words so far are kept.
    const mid = run({ mode: 'ptt', ttsActive: true, bargeIn: 'off' }, [tone(800)])
    mid.ep.setTtsActive(false)
    mid.ep.push(tone(400))
    expect(mid.ep.stop()).toBe(true)
    expect(mid.log.finals[0].f.durationMs).toBeGreaterThanOrEqual(1100)
    // Dictation keeps waiting for the voice to finish, as the client does.
    const dictate = run({ mode: 'dictate', ttsActive: true, bargeIn: 'off' }, [tone(1200), quiet(2000)])
    expect(dictate.log.events).toEqual([])
  })

  it('cancel drops the utterance', () => {
    const { ep, log } = run({}, [tone(1000)])
    ep.cancel()
    ep.push(quiet(2000))
    expect(log.finals).toHaveLength(0)
    expect(log.events.at(-1)).toBe('vad:false')
  })

  it('holds a bounded amount of audio during long silence', () => {
    const { ep } = run({}, [quiet(60_000)])
    expect(ep.bufferedSamples).toBeLessThanOrEqual(((400 + 700) / 1000) * SR + 2 * W)
  })
})

describe('guards (07 C17)', () => {
  it('drops short speech, empty text and hallucinations on near-silence', () => {
    expect(guardFinal('Hello there.', 250, 0.2)).toBe('short')
    expect(guardFinal(' … ', 900, 0.2)).toBe('empty')
    expect(guardFinal('1.', 400, 0.001)).toBe('hallucination')
    expect(guardFinal('Thank you.', 2000, 0.001)).toBe('hallucination')
    expect(guardFinal('Thank you.', 2000, 0.2)).toBeNull()
    expect(guardFinal('Okay.', 450, 0.08)).toBeNull()
    expect(guardFinal('Hello Vesper, can you hear me?', 1500, 0.1)).toBeNull()
  })
})

describe('PcmBuffer', () => {
  it('slices across chunks by absolute index and drops whole old chunks', () => {
    const b = new PcmBuffer()
    b.append(Float32Array.from([0, 1, 2]))
    b.append(Float32Array.from([3, 4]))
    b.append(Float32Array.from([5, 6, 7]))
    expect([...b.slice(2, 6)]).toEqual([2, 3, 4, 5])
    b.dropBefore(4)
    expect(b.base).toBe(3)
    expect([...b.slice(0, 8)]).toEqual([3, 4, 5, 6, 7])
    b.clear()
    expect(b.size).toBe(0)
  })
})
