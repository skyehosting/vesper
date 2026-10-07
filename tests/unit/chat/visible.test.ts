/** The visible-text pipeline: tags out, tone positions, leading stamp/whitespace, inline <think> (R9, R13, 07 C2). */
import { describe, expect, it } from 'vitest'
import { ThinkFilter, StampFilter, VisiblePipeline } from '@server/chat/visible'

function run(chunks: string[]): { text: string; reasoning: string; tags: { name: string; value?: string; at: number }[] } {
  const p = new VisiblePipeline()
  let text = ''
  let reasoning = ''
  const tags: { name: string; value?: string; at: number }[] = []
  for (const c of [...chunks.map((x) => p.push(x)), p.end()]) {
    text += c.text
    reasoning += c.reasoning
    for (const t of c.tags) tags.push({ name: t.name, value: t.attrs.value ?? t.attrs.query, at: t.at })
  }
  return { text, reasoning, tags }
}

function splits(s: string, seed: number): string[] {
  let x = seed
  const rnd = (): number => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const n = 1 + Math.floor(rnd() * 7)
    out.push(s.slice(i, i + n))
    i += n
  }
  return out
}

describe('VisiblePipeline @R13 @R9', () => {
  const cases: [string, string, { name: string; value?: string; at: number }[]][] = [
    ['[tone=warm] Hello there.', 'Hello there.', [{ name: 'tone', value: 'warm', at: 0 }]],
    ['Hi! [tone=excited, bright] Great news.', 'Hi!  Great news.', [{ name: 'tone', value: 'excited, bright', at: 4 }]],
    ['[Now: Mon 5 Oct 2026 14:03 (UTC+02:00)] Hello', 'Hello', []],
    ['[Mon 5 Oct 2026 2:03 PM] [tone=calm] Hello', 'Hello', [{ name: 'tone', value: 'calm', at: 0 }]],
    ['Let me check.\n[memory_search query="lisbon trip"]', 'Let me check.\n', [{ name: 'memory_search', value: 'lisbon trip', at: 14 }]],
    ['A link [x](y) and a[0] stay.', 'A link [x](y) and a[0] stay.', []],
    ['<think>pondering</think>The answer', 'The answer', []],
    ['   \n  plain', 'plain', []]
  ]
  it.each(cases)('%j', (raw, text, tags) => {
    const whole = run([raw])
    expect(whole.text).toBe(text)
    expect(whole.tags).toEqual(tags)
    // Any chunking gives the same result.
    for (let seed = 1; seed < 200; seed++) {
      const r = run(splits(raw, seed))
      expect(r.text).toBe(text)
      expect(r.tags).toEqual(tags)
    }
  })

  it('routes a leading <think> block to reasoning, even split mid-tag', () => {
    for (let seed = 1; seed < 100; seed++) {
      const r = run(splits('<think>step one, step two</think>Done.', seed))
      expect(r.reasoning).toBe('step one, step two')
      expect(r.text).toBe('Done.')
    }
  })

  it('ThinkFilter passes text that only looks like the start of <think>', () => {
    const f = new ThinkFilter()
    expect(f.push('<th').content).toBe('')
    expect(f.push('e table>').content).toBe('<the table>')
  })

  it('StampFilter decides within 200 characters', () => {
    const f = new StampFilter()
    expect(f.push('[not a stamp')).toBe('')
    expect(f.push(' but long'.repeat(30)).length).toBeGreaterThan(200)
  })
})
