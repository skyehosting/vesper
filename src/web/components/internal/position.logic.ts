/**
 * Anchored placement for popovers, menus and listboxes: put the floating box on the preferred side of the anchor,
 * flip to the other side when it doesn't fit and the other side has more room, keep it inside the viewport margin on
 * the cross axis, and report the room left so long lists can scroll instead of overflowing. Pure (rects in, box out).
 */

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'
export type Placement = Side | `${Side}-${'start' | 'end'}`

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface PositionOptions {
  placement: Placement
  /** Gap between anchor and box. */
  offset?: number
  /** Minimum distance from the viewport edges. */
  margin?: number
}

export interface Position {
  x: number
  y: number
  placement: Placement
  /** Room on the chosen side (minus margin): the box's max-height (top/bottom) or max-width (left/right). */
  maxHeight: number
  maxWidth: number
}

export function parsePlacement(p: Placement): { side: Side; align: Align } {
  const [side, align] = p.split('-') as [Side, 'start' | 'end' | undefined]
  return { side, align: align ?? 'center' }
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function room(side: Side, a: Rect, vp: Size, offset: number, margin: number): number {
  switch (side) {
    case 'top':
      return a.y - offset - margin
    case 'bottom':
      return vp.height - (a.y + a.height) - offset - margin
    case 'left':
      return a.x - offset - margin
    case 'right':
      return vp.width - (a.x + a.width) - offset - margin
  }
}

function alignAxis(start: number, length: number, size: number, align: Align): number {
  if (align === 'start') return start
  if (align === 'end') return start + length - size
  return start + length / 2 - size / 2
}

export function computePosition(anchor: Rect, box: Size, viewport: Size, o: PositionOptions): Position {
  const offset = o.offset ?? 6
  const margin = o.margin ?? 8
  const { side: wanted, align } = parsePlacement(o.placement)
  const vertical = wanted === 'top' || wanted === 'bottom'
  const need = vertical ? box.height : box.width
  let side = wanted
  const here = room(wanted, anchor, viewport, offset, margin)
  const there = room(OPPOSITE[wanted], anchor, viewport, offset, margin)
  if (here < need && there > here) side = OPPOSITE[wanted]
  const avail = Math.max(0, room(side, anchor, viewport, offset, margin))

  let x: number
  let y: number
  if (vertical) {
    const h = Math.min(box.height, avail)
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - offset - h
    x = alignAxis(anchor.x, anchor.width, box.width, align)
    x = Math.min(Math.max(margin, x), Math.max(margin, viewport.width - margin - box.width))
  } else {
    const w = Math.min(box.width, avail)
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - offset - w
    y = alignAxis(anchor.y, anchor.height, box.height, align)
    y = Math.min(Math.max(margin, y), Math.max(margin, viewport.height - margin - box.height))
  }
  const placement = (align === 'center' ? side : `${side}-${align}`) as Placement
  return {
    x: Math.round(x),
    y: Math.round(y),
    placement,
    maxHeight: vertical ? Math.floor(avail) : Math.floor(viewport.height - 2 * margin),
    maxWidth: vertical ? Math.floor(viewport.width - 2 * margin) : Math.floor(avail)
  }
}
