/**
 * F22/F42 (R13, 07 A3): control tags are recognised whatever their casing, the spacing inside the brackets and the
 * separator (`=` or `:`), so a model drifting from the documented `[tone=warm]` never gets its tag shown, spoken,
 * stored or embedded. F38: every documented memory function is a control tag. Fuzzed over random chunk splits.
 */
import { describe, expect, it } from 'vitest'
import { MEMORY_FUNCTIONS } from '@shared/memoryFunctions'
import { CONTROL_TAG_OPEN_RE, neutralizeControlTags, parseControlTag, stripControlTags, TagFilter, type ControlTag } from '@shared/tags'

function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

function runSplit(input: string, rnd: () => number): { text: string; tags: ControlTag[] } {
  const f = new TagFilter()
  let text = ''
  const tags: ControlTag[] = []
  let s = input
  while (s.length) {
    const n = 1 + Math.floor(rnd() * 7)
    const r = f.push(s.slice(0, n))
    text += r.text
    tags.push(...r.tags)
    s = s.slice(n)
  }
  text += f.end().text
  return { text, tags }
}

const TONE_VARIANTS: [string, string][] = [
  ['[Tone=happy]', 'happy'],
  ['[TONE=warm]', 'warm'],
  ['[tone: warm]', 'warm'],
  ['[Tone: playful, light]', 'playful, light'],
  ['[ tone=calm ]', 'calm'],
  ['[  Tone = soft ]', 'soft'],
  ['[tone : "low and slow"]', 'low and slow'],
  ['[tone=warm]', 'warm']
]

const STILL_TEXT = ['[tone]', '[Tone]', '[tone: ]', '[toner=x]', '[Toner: x]', '[ ]', '[x]', '[note: remember this]', '[memory_searching]', '[TONE]', '[1]: footnote']

describe('tone tag variants (F22/F42)', () => {
  it.each(TONE_VARIANTS)('%s is a tone tag', (tag, value) => {
    const t = parseControlTag(tag)
    expect(t?.name).toBe('tone')
    expect(t?.attrs.value).toBe(value)
  })

  it.each(STILL_TEXT)('%s stays visible text', (s) => {
    expect(stripControlTags(`a ${s} b`).text).toBe(`a ${s} b`)
  })

  it('strips every variant from streamed text, whatever the chunking (fuzz)', () => {
    const rnd = lcg(1234)
    for (const [tag, value] of TONE_VARIANTS) {
      const input = `Sure thing, here you go. ${tag}\nAnd more [tone] text.`
      for (let i = 0; i < 400; i++) {
        const r = runSplit(input, rnd)
        expect(r.text).toBe('Sure thing, here you go. \nAnd more [tone] text.')
        expect(r.tags.map((t) => [t.name, t.attrs.value, t.at])).toEqual([['tone', value, 'Sure thing, here you go. '.length]])
      }
    }
  })

  it('memory function names and attribute keys are case-insensitive too, with = or : separators', () => {
    expect(parseControlTag('[Memory_Search Query="lisbon"]')).toMatchObject({ name: 'memory_search', attrs: { query: 'lisbon' } })
    expect(parseControlTag('[memory_search query: "lisbon"]')).toMatchObject({ name: 'memory_search', attrs: { query: 'lisbon' } })
    expect(parseControlTag('[ memory_recall session="#K7Q2MX" last=20 ]')).toMatchObject({ name: 'memory_recall', attrs: { session: '#K7Q2MX', last: '20' } })
    expect(parseControlTag('[memory_search: query="lisbon"]')).toMatchObject({ name: 'memory_search', attrs: { query: 'lisbon' } })
    // A bare value goes to the function's main parameter.
    expect(parseControlTag('[memory_search: the lisbon trip]')).toMatchObject({ name: 'memory_search', attrs: { query: 'the lisbon trip' } })
    expect(parseControlTag('[memory_recall=#K7Q2MX]')).toMatchObject({ name: 'memory_recall', attrs: { session: '#K7Q2MX' } })
  })

  it('neutralizes every variant inside untrusted text (a quoted tag can never fire)', () => {
    for (const [tag] of TONE_VARIANTS) {
      const safe = neutralizeControlTags(`quoted ${tag} here`)
      expect(stripControlTags(safe).tags).toEqual([])
    }
    for (const f of MEMORY_FUNCTIONS) expect(stripControlTags(neutralizeControlTags(f.example)).tags).toEqual([])
    expect(stripControlTags(neutralizeControlTags('[Memory_Search query="x"]')).tags).toEqual([])
    // Ordinary brackets are untouched.
    expect(neutralizeControlTags('a[0] and [link](x) and [toner]')).toBe('a[0] and [link](x) and [toner]')
    expect(CONTROL_TAG_OPEN_RE.flags).toContain('g')
  })
})

describe('end of stream inside a tag (F22 second pass, research 04 §7.3)', () => {
  const SWALLOWED: [string, string][] = [
    ['Hi [tone=warm', 'Hi '],
    ['Hi [Tone: warm', 'Hi '],
    ['Hi [ TONE = soft and', 'Hi '],
    ['Sure thing. [memory_search query="lisb', 'Sure thing. '],
    ['Ok [memory-recall: #K7Q', 'Ok '],
    ['Ok [Memory_Sessions query', 'Ok '],
    ['One [tone=warm\nTwo', 'One \nTwo'],
    ['One [tone=warm\nTwo [tone: x', 'One \nTwo ']
  ]
  const VISIBLE = ['Hi [', 'Hi [to', 'Hi [tone', 'Hi [Tone ', 'Hi [tone of voice', 'Look [x', 'Hi [memory', 'Hi [memory_search', 'a [1']

  it.each(SWALLOWED)('%j ends as %j', (input, want) => {
    expect(stripControlTags(input).text).toBe(want)
    const rnd = lcg(77)
    for (let i = 0; i < 200; i++) expect(runSplit(input, rnd).text).toBe(want)
  })

  it.each(VISIBLE)('%j stays visible at the end', (input) => {
    expect(stripControlTags(input).text).toBe(input)
    const rnd = lcg(78)
    for (let i = 0; i < 200; i++) expect(runSplit(input, rnd).text).toBe(input)
  })
})
