/**
 * VirtualList measurement + anchoring math (R5, 07 D1, research 03 §4.2): prepends, evictions and late-measured rows
 * must not move what the reader sees; jumps land where asked.
 */
import { describe, expect, it } from 'vitest'
import {
  anchorAt,
  buildOffsets,
  clampScrollTop,
  indexAt,
  isAtBottom,
  maxScrollTop,
  meanSize,
  scrollTopFor,
  scrollTopForIndex,
  visibleRange,
  type Key
} from '../../../src/web/components/internal/virtualList.logic'

const sizes = (arr: number[]) => (i: number): number => arr[i]

describe('offsets and lookup', () => {
  const off = buildOffsets(4, sizes([10, 20, 30, 40]))
  it('builds prefix sums', () => {
    expect([...off]).toEqual([0, 10, 30, 60, 100])
    expect([...buildOffsets(3, sizes([10, 10, 10]), 4)]).toEqual([0, 14, 28, 38])
    expect([...buildOffsets(0, sizes([]))]).toEqual([0])
  })
  it('finds the row containing y', () => {
    expect(indexAt(off, -5)).toBe(0)
    expect(indexAt(off, 0)).toBe(0)
    expect(indexAt(off, 9.9)).toBe(0)
    expect(indexAt(off, 10)).toBe(1)
    expect(indexAt(off, 59)).toBe(2)
    expect(indexAt(off, 60)).toBe(3)
    expect(indexAt(off, 1000)).toBe(3)
    expect(indexAt(buildOffsets(0, sizes([])), 0)).toBe(-1)
  })
  it('computes the visible range with overscan', () => {
    expect(visibleRange(off, 0, 25, 0)).toEqual([0, 1])
    expect(visibleRange(off, 15, 20, 0)).toEqual([1, 2])
    expect(visibleRange(off, 30, 30, 0)).toEqual([2, 2])
    expect(visibleRange(off, 30, 30, 15)).toEqual([1, 3])
    expect(visibleRange(buildOffsets(0, sizes([])), 0, 100, 0)).toBeNull()
  })
})

/** Simulate a list: keys + sizes; returns helpers like the component's. */
function model(keys: Key[], size: (k: Key) => number) {
  const offsets = buildOffsets(keys.length, (i) => size(keys[i]))
  const index = new Map(keys.map((k, i) => [k, i]))
  return { offsets, keys, indexOf: (k: Key) => index.get(k) ?? -1 }
}

describe('anchoring', () => {
  const sizeOf = (k: Key): number => 50 + (Number(k) % 7) * 13
  const viewport = 600

  it('keeps the first visible row in place across a prepend of 100 rows (scrollTop 0 too)', () => {
    for (const startTop of [0, 50, 3000]) {
      const before = model(Array.from({ length: 300 }, (_, i) => i + 1000), sizeOf)
      const st = clampScrollTop(startTop, before.offsets, viewport)
      const anchor = anchorAt(before.offsets, before.keys, st)!
      const after = model([...Array.from({ length: 100 }, (_, i) => i + 900), ...before.keys], sizeOf)
      const next = scrollTopFor(after.offsets, after.indexOf, anchor)!
      // The anchor row's top relative to the viewport is unchanged.
      const i = after.indexOf(anchor.key)
      expect(after.offsets[i] - next).toBeCloseTo(before.offsets[before.indexOf(anchor.key)] - st, 6)
      expect(next).toBeGreaterThan(st)
    }
  })

  it('is unaffected by evicting rows below, and compensates evicting rows above', () => {
    const keys = Array.from({ length: 300 }, (_, i) => i)
    const before = model(keys, sizeOf)
    const st = 12000
    const anchor = anchorAt(before.offsets, before.keys, st)!
    const bottomEvicted = model(keys.slice(0, 200), sizeOf)
    expect(scrollTopFor(bottomEvicted.offsets, bottomEvicted.indexOf, anchor)).toBeCloseTo(st, 6)
    const topEvicted = model(keys.slice(100), sizeOf)
    const next = scrollTopFor(topEvicted.offsets, topEvicted.indexOf, anchor)!
    expect(next).toBeCloseTo(st - before.offsets[100], 6)
  })

  it('absorbs a row above the viewport growing after measurement (image loaded)', () => {
    const keys = Array.from({ length: 50 }, (_, i) => i)
    const est = new Map<Key, number>(keys.map((k) => [k, 100]))
    const before = model(keys, (k) => est.get(k)!)
    const st = 2050
    const anchor = anchorAt(before.offsets, before.keys, st)!
    expect(anchor.key).toBe(20)
    expect(anchor.offset).toBe(-50)
    est.set(3, 420)
    const after = model(keys, (k) => est.get(k)!)
    expect(scrollTopFor(after.offsets, after.indexOf, anchor)).toBe(2370)
  })

  it('reports a gone anchor as null', () => {
    const m = model([1, 2, 3], () => 10)
    expect(scrollTopFor(m.offsets, m.indexOf, { key: 99, offset: 0 })).toBeNull()
  })
})

describe('scrollToIndex alignment', () => {
  const off = buildOffsets(100, () => 50)
  const vp = 400
  it('aligns start, center and end, clamped', () => {
    expect(scrollTopForIndex(off, 10, vp, 'start', 0)).toBe(500)
    expect(scrollTopForIndex(off, 10, vp, 'end', 0)).toBe(550 - 400)
    expect(scrollTopForIndex(off, 10, vp, 'center', 0)).toBe(525 - 200)
    expect(scrollTopForIndex(off, 99, vp, 'start', 0)).toBe(maxScrollTop(off, vp))
    expect(scrollTopForIndex(off, 0, vp, 'end', 0)).toBe(0)
    expect(scrollTopForIndex(off, 500, vp, 'start', 0)).toBe(maxScrollTop(off, vp))
  })
  it("'auto' moves the least", () => {
    expect(scrollTopForIndex(off, 3, vp, 'auto', 0)).toBe(0)
    expect(scrollTopForIndex(off, 20, vp, 'auto', 0)).toBe(1050 - 400)
    expect(scrollTopForIndex(off, 2, vp, 'auto', 500)).toBe(100)
  })
  it('detects the bottom within a threshold', () => {
    expect(isAtBottom(4600, 400, 5000)).toBe(true)
    expect(isAtBottom(4570, 400, 5000)).toBe(true)
    expect(isAtBottom(4500, 400, 5000)).toBe(false)
    expect(isAtBottom(0, 400, 300)).toBe(true)
  })
  it('estimates unmeasured rows from the measured mean once a few are known', () => {
    expect(meanSize([], 80)).toBe(80)
    expect(meanSize([100, 200], 80)).toBe(80)
    expect(meanSize([100, 200, 300], 80)).toBe(200)
  })
})
