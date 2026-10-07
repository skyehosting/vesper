/**
 * StreamTidy (R14, 07 C14): tidying while streaming gives exactly tidyAfterTags of the whole text, for any split —
 * so deltas, speech chunk texts and the stored body are one string. @R14
 */
import { describe, expect, it } from 'vitest'
import { tidyAfterTags } from '@shared/tags'
import { StreamTidy } from '@server/chat/tidy'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = ['a', 'word', ' ', '  ', '\t', '\n', '\n\n', '\n\n\n', ' \n', '\t\n \n', ' ', '\r\n', '**b**', '`c`', '.', ' ', 'é']

function run(parts: string[]): string {
  const t = new StreamTidy()
  let out = ''
  for (const p of parts) out += t.push(p)
  t.end()
  return out
}

describe('StreamTidy @R14', () => {
  it('matches tidyAfterTags for fixed cases', () => {
    const cases = ['  Hello', '\n  hi', 'a  \n\n\n\nb   ', '   ', '', 'x\t\n\ty', 'a \n \n \nb', 'end\n\n']
    for (const c of cases) {
      expect(run([c])).toBe(tidyAfterTags(c))
      expect(run([...c])).toBe(tidyAfterTags(c))
    }
  })

  it('equals tidyAfterTags of the whole text for 2,000 random texts and splits', () => {
    const r = rng(7)
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 30)
      let text = ''
      for (let k = 0; k < n; k++) text += PIECES[Math.floor(r() * PIECES.length)]
      const parts: string[] = []
      for (let at = 0; at < text.length; ) {
        const len = 1 + Math.floor(r() * 6)
        parts.push(text.slice(at, at + len))
        at += len
      }
      expect(run(parts)).toBe(tidyAfterTags(text))
    }
  })

  it('maps raw offsets beyond the pushed text to tidied positions (tone tags)', () => {
    const t = new StreamTidy()
    expect(t.push('Hello friend. ')).toBe('Hello friend.')
    // The held space would be released before the next visible character: offset 14 in raw → 14 tidied.
    expect(t.position(14)).toBe(14)
    expect(t.position(20)).toBe(20)
    expect(t.rawLength).toBe(14)
    expect(t.length).toBe(13)
  })
})
