/**
 * Roving focus math for composite widgets (menu, listbox, tabs, radio-like groups — WAI-ARIA APG "keyboard
 * navigation inside components"). Pure: the components own the DOM and call these with the key that was pressed.
 */

export type Orientation = 'horizontal' | 'vertical' | 'both'

export interface RovingOptions {
  orientation: Orientation
  /** Wrap from the last item to the first (menus, tabs) or stop at the ends (listboxes). */
  loop: boolean
  isDisabled?: (index: number) => boolean
  /** Items moved by PageUp/PageDown; omit to ignore those keys. */
  pageSize?: number
}

const enabled = (i: number, o: Pick<RovingOptions, 'isDisabled'>): boolean => !o.isDisabled?.(i)

/** First enabled index at or after `from` (searching forward), or -1. */
export function firstEnabled(count: number, isDisabled?: (i: number) => boolean, from = 0): number {
  for (let i = Math.max(0, from); i < count; i++) if (!isDisabled?.(i)) return i
  return -1
}

/** Last enabled index at or before `from` (searching backward), or -1. */
export function lastEnabled(count: number, isDisabled?: (i: number) => boolean, from = count - 1): number {
  for (let i = Math.min(count - 1, from); i >= 0; i--) if (!isDisabled?.(i)) return i
  return -1
}

/** Step `dir` (±1) from `current`, skipping disabled items; wraps when `loop`. Returns `current` if nothing qualifies. */
export function step(current: number, dir: 1 | -1, count: number, o: Pick<RovingOptions, 'loop' | 'isDisabled'>): number {
  if (count <= 0) return -1
  let i = current
  for (let n = 0; n < count; n++) {
    i += dir
    if (i >= count || i < 0) {
      if (!o.loop) return current >= 0 && current < count && enabled(current, o) ? current : dir > 0 ? lastEnabled(count, o.isDisabled) : firstEnabled(count, o.isDisabled)
      i = dir > 0 ? 0 : count - 1
    }
    if (enabled(i, o)) return i
  }
  return current
}

/**
 * The index a key moves to, or null when the key is not a navigation key for this orientation (so the caller can let
 * it through). `current` -1 means "nothing active yet": the first forward key lands on the first enabled item.
 */
export function nextIndex(current: number, key: string, count: number, o: RovingOptions): number | null {
  if (count <= 0) return null
  const fwd = o.orientation === 'horizontal' ? ['ArrowRight'] : o.orientation === 'vertical' ? ['ArrowDown'] : ['ArrowRight', 'ArrowDown']
  const back = o.orientation === 'horizontal' ? ['ArrowLeft'] : o.orientation === 'vertical' ? ['ArrowUp'] : ['ArrowLeft', 'ArrowUp']
  if (fwd.includes(key)) return current < 0 ? firstEnabled(count, o.isDisabled) : step(current, 1, count, o)
  if (back.includes(key)) return current < 0 ? lastEnabled(count, o.isDisabled) : step(current, -1, count, o)
  if (key === 'Home') return firstEnabled(count, o.isDisabled)
  if (key === 'End') return lastEnabled(count, o.isDisabled)
  if (o.pageSize && (key === 'PageDown' || key === 'PageUp')) {
    const target = key === 'PageDown' ? Math.min(count - 1, Math.max(current, 0) + o.pageSize) : Math.max(0, current - o.pageSize)
    const found = key === 'PageDown' ? lastEnabled(count, o.isDisabled, target) : firstEnabled(count, o.isDisabled, target)
    // Nothing enabled in that direction within reach: search the other way from the target.
    if (found < 0 || (key === 'PageDown' && found < current) || (key === 'PageUp' && found > current && current >= 0)) {
      const alt = key === 'PageDown' ? firstEnabled(count, o.isDisabled, target) : lastEnabled(count, o.isDisabled, target)
      return alt >= 0 ? alt : current
    }
    return found
  }
  return null
}
