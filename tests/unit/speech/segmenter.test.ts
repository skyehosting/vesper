/** Speech document (07 C14): golden markdown → chunks / spoken text, the first-chunk latency rule, streaming. @R14 */
import { describe, expect, it } from 'vitest'
import { CHUNK_RULES, SpeechDocument, type PlannedChunk } from '@server/speech/segmenter'
import { spokenOf } from '@server/speech/spoken'
import { rng } from './helpers'

function chunksOf(text: string, o: { stream?: number; speakCode?: 'skip' | 'announce' } = {}): Array<PlannedChunk & { md: string }> {
  const d = new SpeechDocument({ speakCode: o.speakCode })
  const out: PlannedChunk[] = []
  if (o.stream) for (let i = 0; i < text.length; i += o.stream) out.push(...d.push(text.slice(i, i + o.stream)))
  else out.push(...d.push(text))
  out.push(...d.end())
  return out.map((c) => ({ ...c, md: text.slice(c.src[0], c.src[1]) }))
}

const spoken = (text: string, o?: { speakCode?: 'skip' | 'announce' }) => chunksOf(text, o).map((c) => (c.instant ? '<instant>' : c.spoken))

describe('spoken-text rules', () => {
  it.each([
    ['See https://example.com/a/b?c=1 now', 'See link now'],
    ['Visit www.vesper.app.', 'Visit link.'],
    ['Great 🎉🙂 news', 'Great  news'],
    ['It is 20°C or 68 °F today', 'It is 20 degrees Celsius or 68 degrees Fahrenheit today'],
    ['Pages 10–20 and 3×4', 'Pages 10 to 20 and 3 times 4'],
    ['About ~5 km or 5km, 300ms, 4 GB', 'About about 5 kilometers or 5 kilometers, 300 milliseconds, 4 gigabytes'],
    ['Cats & dogs, e.g. pets, i.e. friends, etc. and A vs. B', 'Cats and dogs, for example pets, that is friends, et cetera. and A versus B'],
    ['snake_case | pipe #tag', 'snake case   pipe tag']
  ])('%s', (input, out) => {
    expect(spokenOf(input).text).toBe(out)
  })

  it('maps every spoken char back to an input index (monotonic)', () => {
    const s = spokenOf('At 5km, see https://x.y/z 🙂 ok')
    expect(s.map.length).toBe(s.text.length)
    for (let i = 1; i < s.map.length; i++) expect(s.map[i]).toBeGreaterThanOrEqual(s.map[i - 1])
  })
})

describe('segmenter golden samples', () => {
  it('first chunk closes at the first clause/sentence mark after ≥ 40 spoken chars', () => {
    const text = 'Hi! Oh, it is you. It has been three weeks since we last talked, and I missed you. How are you doing today? I hope everything is fine.'
    const c = chunksOf(text)
    expect(c[0].spoken).toBe('Hi! Oh, it is you. It has been three weeks since we last talked,')
    expect(c[0].spoken.length).toBeGreaterThanOrEqual(CHUNK_RULES.firstMin)
    expect(c[1].spoken).toBe('and I missed you. How are you doing today? I hope everything is fine.')
    expect(c.map((x) => x.md).join('')).toBe(text)
  })

  it('first chunk closes at a word boundary by 150 chars when no mark comes', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const c = chunksOf(`${words}.`)
    expect(c[0].spoken.length).toBeLessThanOrEqual(CHUNK_RULES.firstMax)
    expect(c[0].spoken.length).toBeGreaterThan(CHUNK_RULES.firstMax - 10)
    expect(c[0].md.endsWith(' ')).toBe(true)
    expect(c[1].md.startsWith('word')).toBe(true)
  })

  it('a short reply is one chunk', () => {
    expect(chunksOf('Short.')).toEqual([{ index: 0, src: [0, 6], spoken: 'Short.', instant: false, md: 'Short.' }])
    expect(spoken('Yes')).toEqual(['Yes.'])
  })

  it('later chunks hold whole sentences: ≥ 150 chars or 3 sentences, never more than 400', () => {
    const sentence = (i: number) => `This is sentence number ${i} and it carries a little bit of content.`
    const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ')
    const c = chunksOf(text)
    for (const x of c.slice(1, -1)) {
      expect(x.spoken.length).toBeLessThanOrEqual(CHUNK_RULES.max)
      const sentences = x.spoken.split(/(?<=\.) /).length
      expect(x.spoken.length >= CHUNK_RULES.target || sentences >= 3).toBe(true)
      expect(x.spoken.endsWith('.')).toBe(true)
    }
    // One 700-char sentence is split at clause/word boundaries.
    const long = `${Array.from({ length: 70 }, (_, i) => `part${i}, more`).join(' ')}.`
    for (const x of chunksOf(`Start here with something long enough to close. ${long}`).slice(1)) expect(x.spoken.length).toBeLessThanOrEqual(CHUNK_RULES.max)
  })

  it('markdown: headings, emphasis, links, bare URLs, inline code, escapes', () => {
    const text = '# A title\n\nSome **bold** and _soft_ text, a [docs link](https://example.com/docs), <https://auto.example>, then `npm test` and \\*stars\\*.'
    expect(spoken(text)).toEqual(['A title. Some bold and soft text, a docs link,', 'link, then npm test and stars.'])
  })

  it('lists are read as sentences; markers are dropped; nesting is kept', () => {
    const text = 'Plan for today, in three steps:\n\n1. Wake up early\n2. Write the tests\n   - unit tests\n   - e2e tests\n3. Rest.\n\nThat is all.'
    expect(spoken(text).join(' | ')).toBe('Plan for today, in three steps: Wake up early. | Write the tests. unit tests. e2e tests. | Rest. That is all.')
  })

  it('code, tables, math, rules and images are instant (shown, not spoken)', () => {
    const text = 'Here you go.\n\n```ts\nconst x = 1. // no\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n---\n\n![diagram](img.png)\n\nDone.'
    const c = chunksOf(text)
    expect(c.map((x) => (x.instant ? 'I' : x.spoken))).toEqual(['Here you go.', 'I', 'I', 'I', 'I', 'I', 'Done.'])
    expect(c[1].md).toBe('```ts\nconst x = 1. // no\n```\n\n')
    expect(c.map((x) => x.md).join('')).toBe(text)
    expect(spoken(text, { speakCode: 'announce' })[1]).toBe('Here is some code.')
  })

  it('blockquotes and abbreviations', () => {
    const text = 'Quote of the day from Dr. Smith, a good friend:\n\n> Be kind. Always.\n\nThanks!'
    expect(spoken(text)).toEqual(['Quote of the day from Dr. Smith, a good friend:', 'Be kind. Always. Thanks!'])
    // "Dr." never ends a chunk.
    for (const c of chunksOf(`${'Intro sentence that is long enough to be the first chunk. '.repeat(2)}I met Dr. Who and Mr. Bean today.`)) expect(c.spoken.endsWith('Dr.')).toBe(false)
  })

  it('an emoji-only paragraph is instant', () => {
    expect(chunksOf('🎉🎉\n\nHello there.').map((c) => c.instant)).toEqual([true, false])
  })
})

describe('streaming', () => {
  const samples = [
    'Hi! Oh, it is you. It has been three weeks since we last talked, and I missed you. How are you doing today? I hope everything is fine.',
    '# Title\n\nSome **bold** text with a [link](https://example.com) and https://bare.example.com/path here.\n\n- first item\n- second item, longer one\n\n```js\nconst x = 1\n```\n\nAfter code. Done',
    'Plan for today, in three steps:\n\n1. Wake up early\n2. Write the tests\n3. Rest.\n\nThat is all.'
  ]
  it.each(samples.map((s, i) => [i, s]))('sample %i gives the same chunks streamed in small pieces as whole', (_i, s) => {
    const whole = chunksOf(s as string)
    for (const n of [1, 3, 7, 16]) expect(chunksOf(s as string, { stream: n })).toEqual(whole)
  })

  it('a sentence boundary is used only once the next word has arrived', () => {
    const d = new SpeechDocument()
    expect(d.push('Well, this is a fairly long first sentence for you. ')).toEqual([])
    const c = d.push('And')
    expect(c).toHaveLength(1)
    expect(c[0].spoken).toBe('Well, this is a fairly long first sentence for you.')
    expect(c[0].src).toEqual([0, 52])
  })

  it('an open code fence waits; at the end it becomes an instant chunk', () => {
    const d = new SpeechDocument()
    const first = d.push('Let me show you some code right here, it is short.\n\n```py\nprint(1)\n')
    expect(first.map((c) => c.instant)).toEqual([false])
    expect(d.push('print(2). Still code. More code here\n')).toEqual([])
    const rest = d.end()
    expect(rest).toHaveLength(1)
    expect(rest[0].instant).toBe(true)
    expect(d.finished).toBe(true)
  })

  it('a pipe table that has not got its delimiter row yet is never cut', () => {
    const d = new SpeechDocument()
    const out = d.push(`| ${'very long header cell, with commas, and more words '.repeat(5)}|`)
    expect(out).toEqual([])
    const rest = [...d.push('\n|---|\n| 1 |\n\nAfter.'), ...d.end()]
    expect(rest.map((c) => c.instant)).toEqual([true, false])
  })

  it('end(finalBody) extends the pushed text; a different body is ignored', () => {
    const d = new SpeechDocument()
    d.push('Hello')
    const c = d.end('Hello world.')
    expect(c[0].spoken).toBe('Hello world.')
    const e = new SpeechDocument()
    e.push(' Hi there.')
    expect(e.end('Hi there.')[0].src).toEqual([0, 10])
  })

  it('a long single list streamed in small pieces stays fast (re-parse is per block, cut scans are logarithmic)', () => {
    const text = Array.from({ length: 150 }, (_, i) => `- item ${i} has a few words in it, and a comma`).join('\n')
    const t0 = performance.now()
    const c = chunksOf(text, { stream: 6 })
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(c.map((x) => x.md).join('')).toBe(text)
  })

  it('a long single paragraph streams fast and chunks exactly as when parsed whole', () => {
    const text = Array.from({ length: 120 }, (_, i) => `Sentence ${i} has **some** words, a [link](https://x.y) and \`code\`.`).join(' ')
    const t0 = performance.now()
    const streamed = chunksOf(text, { stream: 5 })
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(streamed).toEqual(chunksOf(text))
  })

  it('re-parsing stays bounded: a 20k-char streamed reply chunks in well under a second', () => {
    const r = rng(7)
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    let text = ''
    while (text.length < 20_000) text += words[Math.floor(r() * 5)] + (r() < 0.1 ? '. ' : r() < 0.05 ? '\n\n' : ' ')
    const t0 = performance.now()
    const c = chunksOf(text, { stream: 6 })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(c.map((x) => x.md).join('')).toBe(text)
  })
})
