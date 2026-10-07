import { describe, expect, it } from 'vitest'
import { buildRevealMap } from '@shared/revealMap'
import {
  alignChunkEnd,
  countAtOrBefore,
  createFrameState,
  FADE_MS,
  FADE_STEPS,
  frameState,
  replyVisibleTimes,
  segmentChunks,
  sentenceEnd,
  sourceWords,
  spokenWords,
  TAIL_WARP_MS,
  visibleTimes,
  wordEnd,
  wordsOf,
  type Block,
  type ChunkInfo
} from '../../../../src/web/lib/audio/reveal.logic'
import { SpeechDocument } from '@server/speech/segmenter'

function chunk(index: number, src: [number, number], spoken: string, o: Partial<ChunkInfo> = {}): ChunkInfo {
  return { index, src, spoken, instant: false, final: false, ...o }
}

/** Proportional synthetic map: char i of n starts at i/n · d (what an untimed chunk looks like). */
function linearMap(n: number, d: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => (i / n) * d)
}

describe('reveal segmentation (07 C14) @R14', () => {
  it('splits an untagged paragraph at sentence boundaries by aligning spoken words', () => {
    const text = 'Hello there, friend. It has been three weeks! How are you?'
    const parts = ['Hello there, friend. ', 'It has been three weeks! ', 'How are you?']
    let src = 0
    const chunks = parts.map((p, i) => {
      const c = chunk(i, [src, src + p.length], p, { final: i === parts.length - 1 })
      src += p.length
      return c
    })
    const ranges = segmentChunks(text, wordsOf(text), [], chunks)
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(parts)
  })

  it('aligns through markdown leftovers and spoken substitutions (bare URL spoken as "link")', () => {
    const text = 'See https://example.com/a/b for details. Then call me.'
    const w = wordsOf(text)
    const end = alignChunkEnd(text, w, 0, text.length, spokenWords('See link for details. '))
    expect(text.slice(0, end)).toBe('See https://example.com/a/b for details. ')
    // Case and accents do not matter.
    const t2 = 'Café RÉSUMÉ. Next.'
    expect(t2.slice(0, alignChunkEnd(t2, wordsOf(t2), 0, t2.length, spokenWords('cafe resume')))).toBe('Café RÉSUMÉ. ')
  })

  it('uses data-src blocks for exact boundaries, alignment inside a block, and instant chunks as whole blocks', () => {
    // Markdown: "# Title\n\nFirst sentence. Second one.\n\n```js\nx = 1\n```\n\nAfter code."
    const md = '# Title\n\nFirst sentence. Second one.\n\n```js\nx = 1\n```\n\nAfter code.'
    const text = 'TitleFirst sentence. Second one.x = 1\nAfter code.'
    const blocks: Block[] = [
      { srcStart: 0, srcEnd: 7, start: 0, end: 5 },
      { srcStart: 9, srcEnd: 36, start: 5, end: 32 },
      { srcStart: 38, srcEnd: 54, start: 32, end: 38 },
      { srcStart: 56, srcEnd: 67, start: 38, end: 49 }
    ]
    expect(md.slice(9, 36)).toBe('First sentence. Second one.')
    const chunks = [
      chunk(0, [0, 25], 'Title First sentence. '),
      chunk(1, [25, 38], 'Second one.'),
      chunk(2, [38, 56], '', { instant: true }),
      chunk(3, [56, 67], 'After code.', { final: true })
    ]
    const ranges = segmentChunks(text, wordsOf(text), blocks, chunks)
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(['TitleFirst sentence. ', 'Second one.', 'x = 1\n', 'After code.'])
  })

  // F34: the server rewrites spoken words ("~5" → "about 5", "i.e." → "that is", "vs" → "versus"); a rewritten word
  // that also opens the next sentence must not pull that sentence into this chunk.
  for (const [name, md, firstEnd] of [
    ['~5', 'The whole trip there and back will cost you ~5 dollars. Think about it for a moment before you decide. Then tell me what you think of the plan.', 'dollars. '],
    ['i.e.', 'Use the simpler option for this case, i.e. the cache. That is what most people pick when they start out with it.', 'cache. '],
    ['e.g.', 'Bring plenty of snacks for the road, e.g. chips. For the kids there are games in the back seat as well.', 'chips. '],
    ['vs', 'We compared the two plans, plan A vs plan B here. Then versus the third one it still came out ahead by far.', 'here. ']
  ] as const) {
    it(`F34: boundaries come from the chunk's source words, not its rewritten spoken words (${name})`, () => {
      const doc = new SpeechDocument({})
      const planned = [...doc.push(md), ...doc.end(md)]
      expect(planned.length).toBeGreaterThan(1)
      const infos: ChunkInfo[] = planned.map((p, i) => ({ index: p.index, src: p.src, spoken: p.spoken, instant: p.instant, final: i === planned.length - 1, text: md.slice(p.src[0], p.src[1]) }))
      const first = md.slice(0, planned[0].src[1])
      expect(first.endsWith(firstEnd)).toBe(true)
      // The paragraph rendered as one tagged block (how a <p> is tagged) and untagged.
      const para: Block[] = [{ srcStart: 0, srcEnd: md.length, start: 0, end: md.length }]
      for (const blocks of [para, []]) {
        const ranges = segmentChunks(md, wordsOf(md), blocks, infos)
        expect(ranges.map(([s, e]) => md.slice(s, e))).toEqual(planned.map((p) => md.slice(p.src[0], p.src[1])))
      }
    })
  }

  it('F34: a tagged text run that renders its source 1:1 maps the boundary exactly', () => {
    // One text run "It costs ~5 dollars. Think about it. " then "**About**" then " time.": exact offsets, no guessing.
    const md = 'It costs ~5 dollars. Think about it. **About** time.'
    const text = 'It costs ~5 dollars. Think about it. About time.'
    expect([md.slice(0, 37), md.slice(39, 44), md.slice(46)]).toEqual(['It costs ~5 dollars. Think about it. ', 'About', ' time.'])
    const blocks: Block[] = [
      { srcStart: 0, srcEnd: 37, start: 0, end: 37, exact: true },
      { srcStart: 39, srcEnd: 44, start: 37, end: 42, exact: true },
      { srcStart: 46, srcEnd: 52, start: 42, end: 48, exact: true }
    ]
    const chunks: ChunkInfo[] = [
      // Spoken words alone would mislead an alignment: "about" occurs right after the boundary. No source text here.
      chunk(0, [0, 21], 'It costs about 5 dollars. '),
      chunk(1, [21, 37], 'Think about it. '),
      chunk(2, [37, 52], 'About time.', { final: true })
    ]
    const ranges = segmentChunks(text, wordsOf(text), blocks, chunks)
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(['It costs ~5 dollars. ', 'Think about it. ', 'About time.'])
  })

  it('F34: source words drop what renders no words (link targets, list markers, task boxes, entities)', () => {
    expect(sourceWords('See [the archive](https://example.com/x "Title") now')).toEqual(['see', 'the', 'archive', 'now'])
    expect(sourceWords('1. First item\n2. Second\n- [x] done\n> - quoted')).toEqual(['first', 'item', 'second', 'done', 'quoted'])
    expect(sourceWords('Fish &amp; chips[^1] &#169;')).toEqual(['fish', 'chips'])
  })

  it('covers the text contiguously for random sentence splits (fuzz)', () => {
    const sentences = ['Alpha beta gamma.', 'Delta, epsilon; zeta!', 'Eta theta iota?', 'Kappa lambda mu.', '“Nu xi,” omicron said.', 'Pi rho sigma tau.']
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 50; round++) {
      const picked = sentences.filter(() => rnd() < 0.8)
      if (!picked.length) continue
      const text = picked.join(' ')
      // Group sentences into chunks of 1–3.
      const groups: string[] = []
      for (let i = 0; i < picked.length; ) {
        const n = 1 + Math.floor(rnd() * 3)
        groups.push(picked.slice(i, i + n).join(' ') + (i + n < picked.length ? ' ' : ''))
        i += n
      }
      let src = 0
      const chunks = groups.map((g, i) => {
        const c = chunk(i, [src, src + g.length], g, { final: i === groups.length - 1 })
        src += g.length
        return c
      })
      const ranges = segmentChunks(text, wordsOf(text), [], chunks)
      expect(ranges[0][0]).toBe(0)
      expect(ranges[ranges.length - 1][1]).toBe(text.length)
      for (let k = 1; k < ranges.length; k++) expect(ranges[k][0]).toBe(ranges[k - 1][1])
      expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(groups)
    }
  })
})

describe('reveal timing: the last letter appears as the audio ends (07 C14) @R14', () => {
  it('pins each chunk’s last char to its audio end and keeps times monotonic', () => {
    const d = 1834
    const v = visibleTimes(linearMap(40, d), d, false)
    expect(v[39]).toBe(d)
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1])
    // Only the tail is warped: the early part keeps the map's times.
    const map = linearMap(40, d)
    for (let i = 0; i < 40; i++) if (map[i] <= map[39] - TAIL_WARP_MS) expect(v[i]).toBe(map[i])
    // Instant / zero-length chunks reveal at once.
    expect(Array.from(visibleTimes(linearMap(5, 100), 0, false))).toEqual([0, 0, 0, 0, 0])
    expect(Array.from(visibleTimes(linearMap(5, 100), 100, true))).toEqual([0, 0, 0, 0, 0])
  })

  it('clamps out-of-range, NaN and decreasing map entries', () => {
    const v = visibleTimes(Float64Array.from([-5, 30, 20, Number.NaN, 900, 80]), 500, false)
    expect(Array.from(v).every((x, i, a) => x >= 0 && x <= 500 && (i === 0 || x >= a[i - 1]))).toBe(true)
    expect(v[v.length - 1]).toBe(500)
  })

  it('places chunks on the audio clock; unstarted chunks stay hidden; the last char lands on the final audio end', () => {
    const text = 'One two. Three four five.'
    const ranges: Array<[number, number]> = [
      [0, 9],
      [9, 25]
    ]
    const d0 = 700
    const d1 = 1300
    const t0 = 5000
    const t1 = t0 + d0 // gapless
    const c0 = visibleTimes(buildRevealMap(text.slice(0, 9), 'One two.', null, d0), d0, false)
    const c1 = visibleTimes(buildRevealMap(text.slice(9), 'Three four five.', null, d1), d1, false)
    const pending = replyVisibleTimes(text.length, ranges, [
      { startAt: t0, times: c0 },
      { startAt: null, times: c1 }
    ])
    expect(pending[8]).toBe(t0 + d0)
    expect(pending[9]).toBe(Number.POSITIVE_INFINITY)
    const v = replyVisibleTimes(text.length, ranges, [
      { startAt: t0, times: c0 },
      { startAt: t1, times: c1 }
    ])
    expect(v[text.length - 1]).toBe(t1 + d1)
    expect(countAtOrBefore(v, t1 + d1 - 1)).toBeLessThan(text.length)
    expect(countAtOrBefore(v, t1 + d1)).toBe(text.length)
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1])
  })

  it('uses a real timeline when the chunk has one (sine-burst style alignment)', () => {
    const spoken = 'Hi you'
    // H i _ y o u : 55 ms per voiced char, 90 ms per space.
    const startsMs = [0, 55, 110, 200, 255, 310]
    const endsMs = [55, 110, 200, 255, 310, 365]
    const v = visibleTimes(buildRevealMap(spoken, spoken, { startsMs, endsMs }, 365), 365, false)
    expect(v[v.length - 1]).toBe(365)
    expect(v[0]).toBeLessThan(60)
  })
})

describe('frame state: fade bands, words, sentences (07 C14) @R14', () => {
  const text = 'Hello brave new world. Next sentence here.'
  // 100 ms per char from t = 1000.
  const v = Float64Array.from({ length: text.length }, (_, i) => 1000 + i * 100)

  it('fades the frontier over FADE_MS in FADE_STEPS bands, hides the rest', () => {
    const f = frameState(v, text, 1450, 'fade', createFrameState())
    expect(f.full).toBe(5) // v ≤ 1450 → chars 0..4
    expect(f.bands).toHaveLength(FADE_STEPS + 1)
    expect(f.bands[0]).toBe(f.full)
    expect(f.hidden).toBe(countAtOrBefore(v, 1450 + FADE_MS))
    for (let i = 1; i < f.bands.length; i++) expect(f.bands[i]).toBeGreaterThanOrEqual(f.bands[i - 1])
    const before = frameState(v, text, 0, 'fade', createFrameState())
    expect(before.full).toBe(0)
    expect(before.hidden).toBe(0)
    const after = frameState(v, text, 1e9, 'fade', createFrameState())
    expect(after.full).toBe(text.length)
  })

  it('reveals whole words under reduced motion and whole sentences without the Highlight API', () => {
    const w = frameState(v, text, 1000 + 7 * 100, 'words', createFrameState())
    expect(text.slice(0, w.full)).toBe('Hello brave')
    expect(w.hidden).toBe(w.full)
    const s = frameState(v, text, 1000 + 3 * 100, 'sentences', createFrameState())
    expect(text.slice(0, s.full)).toBe('Hello brave new world.')
    expect(frameState(v, text, 0, 'words', createFrameState()).full).toBe(0)
  })

  it('finds word and sentence ends', () => {
    expect(wordEnd('ab cd', 0)).toBe(2)
    expect(wordEnd('ab cd', 2)).toBe(3)
    expect(sentenceEnd('“Yes!” she said. Ok', 1)).toBe(6)
    expect(sentenceEnd('line one\nline two', 2)).toBe(9)
    expect(sentenceEnd('no end', 0)).toBe(6)
  })
})
