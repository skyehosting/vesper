/** Embedding input and FTS query rules (research 02 §5.2/§5.3, 07 A1/A3). @R7 */
import { describe, expect, it } from 'vitest'
import { chunkByParagraph, cleanForIndex, embedInputs, ftsAndQuery, ftsOrQuery, isTrivial, overlapScore, queryTerms, rerankDocument } from '@server/memory/engine/text'

describe('embed inputs @R7', () => {
  it('prefixes the role tag and adds reply context', () => {
    const user = embedInputs({ tag: 'user response', body: 'I am thinking of moving to Denver next spring', prev: null })
    expect(user).toEqual(['user response: I am thinking of moving to Denver next spring'])
    const ai = embedInputs({ tag: 'ai response', body: 'Denver has great hiking and sunny winters.', prev: { tag: 'user response', body: 'Where should I move?' } })
    expect(ai).toEqual(['In reply to: Where should I move?\nai response: Denver has great hiking and sunny winters.'])
    // A short user reply carries the AI message before it; a long one does not.
    const short = embedInputs({ tag: 'user response', body: 'yes that one please thanks', prev: { tag: 'ai response', body: 'Should I book the 9am train?' } })
    expect(short[0]).toBe('Replying to: Should I book the 9am train?\nuser response: yes that one please thanks')
  })

  it('skips trivial messages but keeps them searchable (07 A1)', () => {
    expect(isTrivial('ok thanks')).toBe(true)
    expect(isTrivial('👍🎉')).toBe(true)
    expect(embedInputs({ tag: 'user response', body: 'ok 👍', prev: null })).toEqual([])
  })

  it('never embeds control tags or a turn header (07 A3) @R13', () => {
    const body = '[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York)] [tone=warm] I loved the concert [memory_search query="x"] last night'
    const [input] = embedInputs({ tag: 'ai response', body, prev: null })
    expect(input).not.toMatch(/\[tone=|\[memory_|\[Now:/)
    expect(cleanForIndex(body)).toBe('I loved the concert  last night')
  })

  it('splits long messages by paragraph into ~400-token chunks', () => {
    const para = 'Sentence about gardens and rivers. '.repeat(40).trim()
    const long = Array.from({ length: 12 }, () => para).join('\n\n')
    const parts = embedInputs({ tag: 'ai response', body: long, prev: null })
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) {
      expect(p.startsWith('ai response: ')).toBe(true)
      expect(p.length).toBeLessThan(2200)
    }
    expect(chunkByParagraph('x'.repeat(5000), 2000).every((c) => c.length <= 2000)).toBe(true)
  })

  it('formats rerank documents with role and date, clipped', () => {
    const d = rerankDocument('user response', 'Sat 12 Sep 2026', 'a'.repeat(3000))
    expect(d.startsWith('[user response, Sat 12 Sep 2026] ')).toBe(true)
    expect(d.length).toBeLessThan(1250)
  })
})

describe('FTS queries', () => {
  it('drops stop words, dedupes and caps terms', () => {
    expect(queryTerms('Where was I planning to move? move!')).toEqual(['planning', 'move'])
    expect(queryTerms('the and of')).toEqual(['the', 'and', 'of'])
    expect(queryTerms('a b c d e f g h i j k l m n o p'.split(' ').map((x) => x + 'x').join(' ')).length).toBe(8)
  })

  it('quotes terms so FTS syntax in user text is inert', () => {
    expect(ftsOrQuery('coffee "berlin" NEAR(x)')).toBe('"coffee" OR "berlin" OR "near" OR "x"')
    expect(ftsAndQuery('lisbon tri')).toBe('"lisbon" AND "tri"*')
    expect(ftsOrQuery('!!! ???')).toBeNull()
  })

  it('scores term overlap 0..1', () => {
    expect(overlapScore('trip to Lisbon', 'We planned a trip to Lisbon')).toBe(1)
    expect(overlapScore('trip to Lisbon', 'A trip to Porto')).toBe(0.5)
    expect(overlapScore('trip', 'nothing here')).toBe(0)
  })
})
