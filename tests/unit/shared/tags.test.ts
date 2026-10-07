import { describe, expect, it } from 'vitest'
import { TagFilter, parseControlTag, stripControlTags, tidyAfterTags, type ControlTag } from '@shared/tags'

const CASES: [string, string, string[]][] = [
  ['Hello! [memory_search query="our trip to Lisbon"] Let me check.', 'Hello!  Let me check.', ['memory_search']],
  ['Arrays like a[0] and [link](http://x) stay. [tone=warm, playful]', 'Arrays like a[0] and [link](http://x) stay. ', ['tone']],
  ['Edge [tone] [toner] [memory_recall session="#K7Q2MX" query="cats"]done', 'Edge [tone] [toner] done', ['memory_recall']],
  // F22: a tag cut off by the end of the stream is swallowed (research 04 §7.3), not shown
  ['Unclosed [memory_search query="never closes... and more text', 'Unclosed ', []],
  ['Unclosed [memory_search query="cut\nNext line', 'Unclosed \nNext line', []],
  ['[[tone=calm]] nested-ish, and [memory_searching] is not a tag.', '[] nested-ish, and [memory_searching] is not a tag.', ['tone']],
  ["[tone=gentle]\nIt's been a while. [tone=excited] Wow!", "\nIt's been a while.  Wow!", ['tone', 'tone']],
  ["single quotes [memory_recall session='K7Q2MX' last=20] ok", 'single quotes  ok', ['memory_recall']]
]

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

function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

describe('TagFilter', () => {
  it('strips control tags and leaves look-alikes, for 10,500 random chunk splits', () => {
    const rnd = lcg(42)
    for (const [input, expected, names] of CASES) {
      for (let i = 0; i < 1500; i++) {
        const r = runSplit(input, rnd)
        expect(r.text).toBe(expected)
        expect(r.tags.map((t) => t.name)).toEqual(names)
      }
    }
  })

  it('reports where each tag fell in the visible text, whatever the chunking', () => {
    const input = "[tone=gentle]\nIt's been a while. [tone=excited] Wow!"
    const expected = [
      ['gentle', 0],
      ['excited', "\nIt's been a while. ".length]
    ]
    expect(stripControlTags(input).tags.map((t) => [t.attrs.value, t.at])).toEqual(expected)
    const rnd = lcg(7)
    for (let i = 0; i < 500; i++) expect(runSplit(input, rnd).tags.map((t) => [t.attrs.value, t.at])).toEqual(expected)
  })

  it('parses attributes in all quoting styles', () => {
    expect(parseControlTag('[memory_search query="a b" scope="linked" limit="8"]')?.attrs).toEqual({ query: 'a b', scope: 'linked', limit: '8' })
    expect(parseControlTag("[memory_recall session='K7Q2MX' last=20]")?.attrs).toEqual({ session: 'K7Q2MX', last: '20' })
    expect(parseControlTag('[tone="soft and low"]')?.attrs).toEqual({ value: 'soft and low' })
    expect(parseControlTag('[tone]')).toBeNull()
    expect(parseControlTag('[toner=x]')).toBeNull()
    expect(parseControlTag('[memory_search]')?.name).toBe('memory_search')
  })

  it('tidies whitespace left behind', () => {
    expect(tidyAfterTags(' Hello  \n\n\n\nthere\n')).toBe('Hello\n\nthere')
  })
})
