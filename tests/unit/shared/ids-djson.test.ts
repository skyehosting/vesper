import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { djson } from '@shared/djson'
import { makeShortId, normalizeShortId, SHORT_ID_ALPHABET } from '@shared/ids'

describe('short ids', () => {
  it('generates 6 Crockford characters that round-trip', () => {
    for (let i = 0; i < 200; i++) {
      const id = makeShortId((n) => randomBytes(n))
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
      expect(normalizeShortId(`#${id.toLowerCase()}`)).toBe(id)
    }
    expect(SHORT_ID_ALPHABET).toHaveLength(32)
  })
  it('normalizes what people type', () => {
    expect(normalizeShortId('#k7q-2mx')).toBe('K7Q2MX')
    expect(normalizeShortId(' kiqomx ')).toBe('K1Q0MX')
    expect(normalizeShortId('#K7Q2M')).toBeNull()
    expect(normalizeShortId('K7Q2MU')).toBeNull()
  })
})

describe('djson', () => {
  it('is independent of key insertion order', () => {
    expect(djson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe(djson({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 }))
    expect(djson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(() => djson({ n: Number.NaN })).toThrow()
  })
})
