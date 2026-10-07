import { describe, expect, it } from 'vitest'
import { LEAD_S, maxGap, ReplyQueue, SAFETY_S } from '../../../../src/web/lib/audio/schedule.logic'
import { isSilentChunk, parseL16, pcm16ToFloat } from '../../../../src/web/lib/audio/pcm.logic'

describe('gapless chunk scheduling (02 §6.1, research 04 §7.1) @R14', () => {
  it('schedules chunks back to back across boundaries from a lead-in start', () => {
    const q = new ReplyQueue<string>()
    const durations = [0.731, 1.2, 0.05, 2.0049]
    durations.forEach((d, i) => q.add(i, `c${i}`, d, i === durations.length - 1))
    const s = q.drain(10)
    expect(s.map((x) => x.index)).toEqual([0, 1, 2, 3])
    expect(s[0].at).toBeCloseTo(10 + LEAD_S, 12)
    for (let k = 1; k < s.length; k++) expect(s[k].at).toBe(s[k - 1].end)
    expect(s[3].end).toBeCloseTo(10 + LEAD_S + durations.reduce((a, b) => a + b), 9)
    expect(maxGap(s)).toBe(0)
    expect(s.map((x) => x.restart)).toEqual([true, false, false, false])
    expect(q.complete).toBe(true)
  })

  it('stays gapless over 50 chunks fed while playing (BLD-13: gap < 5 ms)', () => {
    const q = new ReplyQueue<number>()
    const all: Array<{ at: number; end: number }> = []
    let now = 0
    for (let i = 0; i < 50; i++) {
      q.add(i, i, 0.3 + (i % 7) * 0.037)
      all.push(...q.drain(now))
      // The next chunk arrives while this one is still playing.
      now = all[all.length - 1].at + 0.1
    }
    expect(all).toHaveLength(50)
    expect(maxGap(all)).toBeLessThan(0.005)
  })

  it('holds out-of-order chunks until their predecessors are decoded', () => {
    const q = new ReplyQueue<string>()
    q.add(2, 'c2', 1)
    q.add(1, 'c1', 1)
    expect(q.drain(0)).toEqual([])
    q.add(0, 'c0', 1)
    const s = q.drain(0.5)
    expect(s.map((x) => x.item)).toEqual(['c0', 'c1', 'c2'])
    expect(s[1].at).toBe(s[0].end)
    expect(s[2].at).toBe(s[1].end)
  })

  it('restarts after an underrun instead of scheduling in the past', () => {
    const q = new ReplyQueue<string>()
    q.add(0, 'c0', 1)
    const [first] = q.drain(0)
    // Chunk 1 arrives 0.5 s after chunk 0 ended.
    q.add(1, 'c1', 1)
    const [late] = q.drain(first.end + 0.5)
    expect(late.restart).toBe(true)
    expect(late.at).toBeCloseTo(first.end + 0.5 + LEAD_S, 12)
    // Arriving just before the play-head would reach the tail (inside the safety margin) also restarts.
    q.add(2, 'c2', 1)
    const [close] = q.drain(late.end - SAFETY_S / 2)
    expect(close.restart).toBe(true)
    // With enough margin it is back to back.
    q.add(3, 'c3', 1)
    const [ok] = q.drain(close.end - 0.1)
    expect(ok.at).toBe(close.end)
  })

  it('ignores duplicates and already scheduled indexes; zero-length chunks take no time', () => {
    const q = new ReplyQueue<string>()
    expect(q.add(0, 'a', 1)).toBe(true)
    expect(q.add(0, 'dup', 1)).toBe(false)
    q.drain(0)
    expect(q.add(0, 'late dup', 1)).toBe(false)
    q.add(1, 'instant', 0)
    q.add(2, 'b', 1, true)
    const s = q.drain(0.1)
    expect(s[0].end).toBe(s[0].at)
    expect(s[1].at).toBe(s[0].end)
    expect(q.complete).toBe(true)
    expect(q.waiting()).toEqual([])
  })
})

describe('markFinal: speech.end without a final:true chunk', () => {
  it('completes the queue once the named chunk is scheduled; never moves a known final', () => {
    const q = new ReplyQueue<string>()
    q.add(0, 'a', 1)
    q.add(1, 'b', 1)
    q.drain(0)
    expect(q.complete).toBe(false)
    q.markFinal(1)
    expect(q.complete).toBe(true)
    const r = new ReplyQueue<string>()
    r.add(0, 'a', 1, true)
    r.markFinal(5)
    expect(r.finalIndex).toBe(0)
    const w = new ReplyQueue<string>()
    w.add(0, 'a', 1)
    w.markFinal(1)
    w.drain(0)
    expect(w.complete).toBe(false) // chunk 1 not scheduled yet
    w.add(1, 'b', 1)
    w.drain(1)
    expect(w.complete).toBe(true)
  })
})

describe('chunk payload formats (07 C14)', () => {
  it('parses audio/L16 parameters', () => {
    expect(parseL16('audio/L16;rate=24000')).toEqual({ rate: 24000, channels: 1, bigEndian: false })
    expect(parseL16('audio/l16; rate=16000; channels=2')).toEqual({ rate: 16000, channels: 2, bigEndian: false })
    expect(parseL16('audio/L16;rate=22050;endianness=big-endian')?.bigEndian).toBe(true)
    expect(parseL16('audio/wav')).toBeNull()
    expect(parseL16('audio/mpeg')).toBeNull()
  })

  it('converts little-endian PCM16 (and deinterleaves stereo)', () => {
    const pcm = new Int16Array([0, 16384, -32768, 32767, -16384])
    const [ch] = pcm16ToFloat(new Uint8Array(pcm.buffer), { rate: 16000, channels: 1, bigEndian: false })
    ;[0, 16384 / 32767, -1, 1, -0.5].forEach((x, i) => expect(ch[i]).toBeCloseTo(x, 6))
    const st = new Int16Array([100, -100, 200, -200])
    const [l, r] = pcm16ToFloat(st.buffer, { rate: 16000, channels: 2, bigEndian: false })
    expect(l.length).toBe(2)
    expect(l[1]).toBeCloseTo(200 / 32767, 9)
    expect(r[1]).toBeCloseTo(-200 / 32768, 9)
    // A trailing odd byte is ignored.
    expect(pcm16ToFloat(new Uint8Array(5), { rate: 8000, channels: 1, bigEndian: false })[0].length).toBe(2)
    const be = new Uint8Array([0x40, 0x00])
    expect(pcm16ToFloat(be, { rate: 8000, channels: 1, bigEndian: true })[0][0]).toBeCloseTo(16384 / 32767, 9)
  })

  it('treats instant and empty chunks as silent', () => {
    expect(isSilentChunk(true, 1000)).toBe(true)
    expect(isSilentChunk(false, 0)).toBe(true)
    expect(isSilentChunk(false, 2)).toBe(false)
  })
})
