/**
 * Reveal timing (07 C14, R14): estimator (research 04 §7.2 with the verifier's fixes) and buildRevealMap, including a
 * fuzz over random markdown + random tags + random stream splits + mock-provider alignment.
 */
import { describe, expect, it } from 'vitest'
import { analyzeSilence, buildRevealMap, charWeights, estimateTimeline, ESTIMATOR_WEIGHTS, type Timeline } from '@shared/revealMap'
import { TagFilter } from '@shared/tags'
import { SpeechDocument } from '@server/speech/segmenter'
import { synthSpeech } from '../../mocks/audio'
import { randomMarkdown, randomSplits, rng, timelineOf } from './helpers'

function expectRevealProperties(rendered: string, map: Float64Array, dur: number): void {
  expect(map.length).toBe(rendered.length)
  let prev = 0
  for (let i = 0; i < map.length; i++) {
    expect(Number.isFinite(map[i])).toBe(true)
    expect(map[i]).toBeGreaterThanOrEqual(prev)
    expect(map[i]).toBeGreaterThanOrEqual(0)
    expect(map[i]).toBeLessThanOrEqual(dur + 1e-9)
    prev = map[i]
  }
  if (rendered.trim()) expect(map[map.length - 1]).toBe(dur)
}

describe('estimator (research 04 §7.2) @R14', () => {
  it('weights: letters 1, sentence marks only before whitespace, trailing punctuation 0', () => {
    const w = charWeights('Hi, 3.5 ok. Bye!!')
    expect(w[0]).toBe(ESTIMATOR_WEIGHTS.alnum)
    expect(w[2]).toBe(ESTIMATOR_WEIGHTS.clause)
    expect(w[3]).toBe(ESTIMATOR_WEIGHTS.space)
    expect(w[5]).toBe(ESTIMATOR_WEIGHTS.other) // "." inside 3.5
    expect(w[10]).toBe(ESTIMATOR_WEIGHTS.sentence)
    expect(w[15]).toBe(0)
    expect(w[16]).toBe(0)
  })

  it('never yields NaN: total weight 0 puts every char at the span start', () => {
    const t = estimateTimeline('... !!', 1000)
    expect(t.startsMs.every((x) => x === 0)).toBe(true)
    expect(estimateTimeline('', 1000)).toEqual({ startsMs: [], endsMs: [] })
    expect(estimateTimeline('hello', 0).startsMs.every((x) => x === 0)).toBe(true)
  })

  it('spreads over the speech span of the PCM and snaps pauses to silences', () => {
    const text = 'Well, I think so. It has been a while; three weeks, maybe more. Anyway hello again.'
    const s = synthSpeech(text, { sampleRate: 16000, gapMs: 140 })
    // Leading/trailing silence: the span must exclude it.
    const pad = 8000
    const pcm = new Int16Array(s.pcm.length + 2 * pad)
    pcm.set(s.pcm, pad)
    const dur = (pcm.length / 16000) * 1000
    const sil = analyzeSilence({ pcm, sampleRate: 16000 })
    expect(sil.span[0]).toBeGreaterThanOrEqual(490)
    expect(sil.span[1]).toBeLessThanOrEqual(dur - 490)
    expect(sil.gaps.length).toBeGreaterThan(5)
    const truth = timelineOf(text, s).startsMs.map((x) => x + 500)
    const snapped = estimateTimeline(text, dur, { pcm, sampleRate: 16000 })
    const plain = estimateTimeline(text, dur)
    const mae = (t: Timeline) => {
      let sum = 0
      let n = 0
      for (let i = 0; i < text.length; i++) {
        if (/\w/.test(text[i]) && (i === 0 || /\s/.test(text[i - 1]))) {
          sum += Math.abs(t.startsMs[i] - truth[i])
          n++
        }
      }
      return sum / n
    }
    for (let i = 1; i < text.length; i++) expect(snapped.startsMs[i]).toBeGreaterThanOrEqual(snapped.startsMs[i - 1])
    expect(snapped.startsMs[0]).toBeGreaterThanOrEqual(sil.span[0])
    expect(mae(snapped)).toBeLessThan(mae(plain))
    expect(mae(snapped)).toBeLessThan(150)
  })
})

describe('buildRevealMap @R14', () => {
  it('matched letters take their spoken start; markdown remnants interpolate; the last visible char ends with the audio', () => {
    const spoken = 'Hello bold world.'
    const s = synthSpeech(spoken, { sampleRate: 16000 })
    const tl = timelineOf(spoken, s)
    const rendered = '**Hello** _bold_ world.\n'
    const map = buildRevealMap(rendered, spoken, tl, s.durationMs)
    expectRevealProperties(rendered, map, s.durationMs)
    expect(map[rendered.indexOf('H')]).toBe(tl.startsMs[0])
    expect(map[rendered.indexOf('b')]).toBe(tl.startsMs[spoken.indexOf('b')])
    expect(map[rendered.indexOf('w')]).toBe(tl.startsMs[spoken.indexOf('w')])
    expect(map[rendered.indexOf('.')]).toBe(s.durationMs)
  })

  it('is case- and accent-insensitive and survives unmatched spoken words', () => {
    const spoken = 'CAFE naive link'
    const s = synthSpeech(spoken)
    const rendered = 'café naïve https://x.example/'
    const map = buildRevealMap(rendered, spoken, timelineOf(spoken, s), s.durationMs)
    expectRevealProperties(rendered, map, s.durationMs)
    expect(map[rendered.indexOf('n')]).toBe(timelineOf(spoken, s).startsMs[5])
  })

  it('a spoken audio tag that is not on screen never claims a visible character (hidden tags are never revealed)', () => {
    const text = 'happy to see you, I am happy'
    const withTag = `[happy] ${text}`
    const s = synthSpeech(withTag, { audioTags: true })
    const tl = timelineOf(withTag, s)
    const map = buildRevealMap(text, withTag, tl, s.durationMs)
    const off = '[happy] '.length
    for (let i = 0; i < text.length - 1; i++) if (/\w/.test(text[i])) expect(map[i]).toBe(tl.startsMs[i + off])
  })

  it('without a timeline (or with a broken one) it falls back to the estimator', () => {
    const map = buildRevealMap('One. Two three.', 'One. Two three.', null, 2000)
    expectRevealProperties('One. Two three.', map, 2000)
    expect(map[0]).toBe(0)
    const broken = buildRevealMap('abc def', 'abc def', { startsMs: [1, NaN], endsMs: [1] }, 900)
    expectRevealProperties('abc def', broken, 900)
  })

  it('instant chunks and empty input', () => {
    expect(Array.from(buildRevealMap('```code```', '', null, 0))).toEqual(new Array(10).fill(0))
    expect(buildRevealMap('', 'x', null, 100).length).toBe(0)
    const nothingSpoken = buildRevealMap('| a | b |', '', null, 500)
    expectRevealProperties('| a | b |', nothingSpoken, 500)
  })

  it('fuzz: random markdown + tags + stream splits + mock alignment → monotonic, full coverage, ends with the audio, no tag ever spoken or shown', () => {
    const r = rng(20261005)
    let chunksChecked = 0
    for (let round = 0; round < 300; round++) {
      const md = randomMarkdown(r)
      const f = new TagFilter()
      let visible = ''
      for (const part of randomSplits(md, r)) visible += f.push(part).text
      visible += f.end().text
      expect(visible).not.toMatch(/\[tone=/i)
      const doc = new SpeechDocument()
      const chunks = []
      for (const part of randomSplits(visible, r)) chunks.push(...doc.push(part))
      chunks.push(...doc.end())
      // Chunks tile the visible text exactly, in order.
      let at = 0
      chunks.forEach((c, i) => {
        expect(c.index).toBe(i)
        expect(c.src[0]).toBe(at)
        expect(c.src[1]).toBeGreaterThan(c.src[0])
        at = c.src[1]
      })
      expect(at).toBe(visible.length)
      for (const c of chunks) {
        expect(c.spoken).not.toMatch(/\[tone=|https?:\/\/|```|\*\*/)
        const rendered = visible.slice(c.src[0], c.src[1])
        if (c.instant) {
          expect(c.spoken).toBe('')
          // Zero-duration: everything is revealed at once when the chunk is reached.
          expect(buildRevealMap(rendered, '', null, 0).every((x) => x === 0)).toBe(true)
          continue
        }
        // Randomly with the provider's alignment, or the estimator (timeline null).
        const s = synthSpeech(c.spoken, { sampleRate: 8000, audioTags: false })
        const tl = r() < 0.7 ? timelineOf(c.spoken, s) : null
        const map = buildRevealMap(rendered, c.spoken, tl, s.durationMs)
        expectRevealProperties(rendered, map, s.durationMs)
        chunksChecked++
      }
    }
    expect(chunksChecked).toBeGreaterThan(300)
  })
})
