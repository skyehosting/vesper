/**
 * Measurement and anchoring math for VirtualList (research 03 §4.2/§4.4, 07 D1). Rows have variable, measured
 * heights (estimates until measured); the list keeps the reader's place by remembering an *anchor* — the first row
 * visible at the top of the viewport and how far its top sits above the viewport — and restoring the scroll offset
 * from it after any change above (prepend, eviction, a row growing as an image loads). Native `overflow-anchor` is not
 * used: it fails at scrollTop 0 and is new in Safari (research 03 §4.2).
 */

export type Key = string | number

export interface Anchor {
  key: Key
  /** Row top minus scrollTop (≤ 0 when the row starts above the viewport top). */
  offset: number
}

/** Prefix sums: offsets[i] = top of row i, offsets[n] = total height. */
export function buildOffsets(count: number, sizeAt: (i: number) => number, gap = 0): Float64Array {
  const out = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) out[i + 1] = out[i] + Math.max(0, sizeAt(i)) + (i < count - 1 ? gap : 0)
  return out
}

/** Index of the row containing y (clamped to [0, n-1]); -1 for an empty list. */
export function indexAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return -1
  if (y <= 0) return 0
  if (y >= offsets[n]) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Rows to render: those intersecting [scrollTop − overscan, scrollTop + viewport + overscan]. Inclusive; null if empty. */
export function visibleRange(offsets: Float64Array, scrollTop: number, viewport: number, overscanPx: number): [number, number] | null {
  const n = offsets.length - 1
  if (n <= 0) return null
  const start = indexAt(offsets, Math.max(0, scrollTop - overscanPx))
  // A row that starts exactly at the bottom edge is not visible.
  const end = indexAt(offsets, Math.max(0, scrollTop + viewport + overscanPx - 0.5))
  return [start, Math.max(start, end)]
}

/** The anchor for a scroll position: the row at the viewport top. */
export function anchorAt(offsets: Float64Array, keys: readonly Key[], scrollTop: number): Anchor | null {
  const i = indexAt(offsets, scrollTop)
  if (i < 0) return null
  return { key: keys[i], offset: offsets[i] - scrollTop }
}

/** scrollTop that puts `anchor` back where it was, or null when its row is gone. */
export function scrollTopFor(offsets: Float64Array, indexOfKey: (k: Key) => number, anchor: Anchor): number | null {
  const i = indexOfKey(anchor.key)
  if (i < 0) return null
  return offsets[i] - anchor.offset
}

export function maxScrollTop(offsets: Float64Array, viewport: number): number {
  return Math.max(0, offsets[offsets.length - 1] - viewport)
}

export function clampScrollTop(v: number, offsets: Float64Array, viewport: number): number {
  return Math.min(maxScrollTop(offsets, viewport), Math.max(0, v))
}

export type ScrollAlign = 'start' | 'center' | 'end' | 'auto'

/**
 * scrollTop that shows row `index` with `align`; 'auto' moves the least (no change if fully visible, else the
 * nearest edge). Clamped to the scrollable range.
 */
export function scrollTopForIndex(offsets: Float64Array, index: number, viewport: number, align: ScrollAlign, current: number, padding = 0): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  const i = Math.min(n - 1, Math.max(0, index))
  const top = offsets[i]
  const bottom = offsets[i + 1]
  let v: number
  switch (align) {
    case 'start':
      v = top - padding
      break
    case 'end':
      v = bottom - viewport + padding
      break
    case 'center':
      v = top + (bottom - top) / 2 - viewport / 2
      break
    default:
      if (top >= current + padding && bottom <= current + viewport - padding) return clampScrollTop(current, offsets, viewport)
      v = top < current + padding || bottom - top > viewport ? top - padding : bottom - viewport + padding
  }
  return clampScrollTop(v, offsets, viewport)
}

export function isAtBottom(scrollTop: number, viewport: number, total: number, threshold = 32): boolean {
  return total - (scrollTop + viewport) <= threshold
}

/**
 * Running mean of measured sizes, used as the estimate for unmeasured rows once a few are known (the caller's
 * estimate is only a starting point; chat rows vary a lot).
 */
export function meanSize(measured: Iterable<number>, fallback: number): number {
  let sum = 0
  let n = 0
  for (const s of measured) {
    sum += s
    n++
  }
  return n >= 3 ? sum / n : fallback
}
