/** The coarse bit index (07 C10): scan correctness, filters, flags, compaction. */
import { describe, expect, it } from 'vitest'
import { BitIndex, FLAG_DEAD, FLAG_OFF_PATH, signBits } from '@server/memory/engine/bitIndex'
import { mockEmbedding, quantize } from '../../mocks/voyage'

function bitsOf(text: string, dim = 1024): Uint8Array {
  return signBits(quantize(mockEmbedding(text, dim), 'int8'))
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i]
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('BitIndex', () => {
  it('packs sign bits MSB-first', () => {
    expect(Array.from(signBits([1, -1, 0, 5, -3, 2, 2, 2, 9, 0, 0, 0, 0, 0, 0, 0]))).toEqual([0b10010111, 0b10000000])
  })

  it('finds the planted nearest neighbour and agrees with brute force', () => {
    const idx = new BitIndex(1024)
    const r = rng(7)
    const all: Uint8Array[] = []
    for (let i = 1; i <= 5000; i++) {
      const b = new Uint8Array(128)
      for (let j = 0; j < 128; j++) b[j] = Math.floor(r() * 256)
      all.push(b)
      idx.add(i, 1 + (i % 10), i * 1000, b)
    }
    const q = all[1233].slice()
    q[0] ^= 1 // one bit away from message 1234
    const top = idx.scan(q, { allowed: null, after: null, before: null }, 10)
    expect(idx.msgIds[top[0]]).toBe(1234)
    // With the coarse pool covering everything, the best 10 by full Hamming distance equal brute force (ties aside).
    // (The 256-bit prefix pass is approximate on random bits; real Matryoshka embeddings keep prefix and full aligned.)
    const exact = idx.scan(q, { allowed: null, after: null, before: null }, 10, 5000)
    const brute = all.map((b, i) => ({ id: i + 1, d: hamming(b, q) })).sort((a, b) => a.d - b.d)
    const got = exact.map((s) => hamming(all[idx.msgIds[s] - 1], q))
    expect(got).toEqual(brute.slice(0, 10).map((x) => x.d))
  })

  it('ranks semantically similar mock embeddings first', () => {
    const idx = new BitIndex(1024)
    const texts = ['We planned a trip to Lisbon in spring', 'my sourdough starter died again', 'the cat knocked over my coffee', 'Lisbon trip spring tram', 'quarterly tax forms']
    texts.forEach((t, i) => idx.add(i + 1, 1, i, bitsOf(t)))
    const top = idx.scan(bitsOf('Lisbon trip in spring'), { allowed: null, after: null, before: null }, 2)
    expect(top.map((s) => idx.msgIds[s]).sort()).toEqual([1, 4])
  })

  it('filters by session, time window and flags', () => {
    const idx = new BitIndex(256)
    const b = bitsOf('hello there friend', 256)
    idx.add(1, 1, 100, b)
    idx.add(2, 2, 200, b)
    idx.add(3, 3, 300, b)
    idx.add(4, 2, 400, b)
    const allowed = new Uint8Array(4)
    allowed[2] = 1
    const ids = (f: Parameters<BitIndex['scan']>[1]) =>
      idx
        .scan(b, f, 10)
        .map((s) => idx.msgIds[s])
        .sort()
    expect(ids({ allowed, after: null, before: null })).toEqual([2, 4])
    expect(ids({ allowed: null, after: 200, before: 400 })).toEqual([2, 3])
    idx.flagMessages(new Set([2]), FLAG_OFF_PATH, true)
    expect(ids({ allowed, after: null, before: null })).toEqual([4])
    idx.flagMessages(new Set([2]), FLAG_OFF_PATH, false)
    idx.flagMessages(new Set([4]), FLAG_DEAD, true)
    expect(ids({ allowed, after: null, before: null })).toEqual([2])
    expect(idx.killSession(1)).toBe(1)
    expect(idx.live).toBe(2)
  })

  it('compacts once more than 10 % are dead, keeping order and data', () => {
    const idx = new BitIndex(256)
    for (let i = 1; i <= 100; i++) idx.add(i, 1, i, bitsOf(`message number ${i} about things`, 256))
    idx.flagMessages(new Set([1, 2, 3, 4, 5]), FLAG_DEAD, true)
    expect(idx.compactIfNeeded()).toBe(false)
    idx.flagMessages(new Set(Array.from({ length: 10 }, (_, i) => 10 + i)), FLAG_DEAD, true)
    expect(idx.compactIfNeeded()).toBe(true)
    expect(idx.size).toBe(85)
    expect(idx.dead).toBe(0)
    const top = idx.scan(bitsOf('message number 50 about things', 256), { allowed: null, after: null, before: null }, 1)
    expect(idx.msgIds[top[0]]).toBe(50)
  })

  it('grows across shards (64K entries each)', () => {
    const idx = new BitIndex(256)
    const b = new Uint8Array(32)
    for (let i = 0; i < 70_000; i++) idx.add(i + 1, 1, i, b)
    const q = new Uint8Array(32).fill(255)
    const last = new Uint8Array(32).fill(255)
    idx.add(999_999, 1, 1, last)
    expect(idx.msgIds[idx.scan(q, { allowed: null, after: null, before: null }, 1)[0]]).toBe(999_999)
    expect(idx.size).toBe(70_001)
  })
})
