/**
 * Keep a fixed-position floating element next to its anchor while open: measures on open, then follows window
 * resizes, any scroll (capture) and size changes of either element, at most once per animation frame. Writes left/top
 * and the max size straight to the element's style (no React render per scroll). Everything is released on close.
 */
import { useLayoutEffect, type RefObject } from 'react'
import { computePosition, type Placement, type Rect } from './position.logic'
import { track } from './stats'

/** An element, or a point (context menus open at the pointer). */
export type AnchorRef = { readonly current: HTMLElement | { x: number; y: number } | null }

export interface UsePositionOptions {
  placement: Placement
  offset?: number
  margin?: number
  /** min-width = anchor width (listboxes under a select). */
  matchWidth?: boolean
}

function anchorRect(a: HTMLElement | { x: number; y: number }): Rect {
  if (a instanceof HTMLElement) {
    const r = a.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }
  return { x: a.x, y: a.y, width: 0, height: 0 }
}

export function usePosition(open: boolean, anchor: AnchorRef, floating: RefObject<HTMLElement | null>, o: UsePositionOptions): void {
  const { placement, offset, margin, matchWidth } = o
  useLayoutEffect(() => {
    if (!open) return
    const el = floating.current
    if (!el) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const a = anchor.current
      if (!a) return
      if (a instanceof HTMLElement && !a.isConnected) return
      const ar = anchorRect(a)
      if (matchWidth) el.style.minWidth = `${Math.round(ar.width)}px`
      // Measure at natural size: drop the previous max-height first.
      el.style.maxHeight = ''
      const box = { width: el.offsetWidth, height: el.offsetHeight }
      const p = computePosition(ar, box, { width: window.innerWidth, height: window.innerHeight }, { placement, offset, margin })
      el.style.left = `${p.x}px`
      el.style.top = `${p.y}px`
      el.style.maxHeight = `${p.maxHeight}px`
      el.style.setProperty('--avail-w', `${p.maxWidth}px`)
      el.dataset.placement = p.placement
      el.style.visibility = 'visible'
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    // Scrolling inside the floating element (a long listbox) doesn't move it.
    const onScroll = (e: Event): void => {
      if (!(e.target instanceof Node && el.contains(e.target))) schedule()
    }
    el.style.visibility = 'hidden'
    update()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', onScroll, true)
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const a = anchor.current
    if (a instanceof HTMLElement) ro.observe(a)
    track('kit.positioners', 1)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onScroll, true)
      ro.disconnect()
      track('kit.positioners', -1)
    }
  }, [open, anchor, floating, placement, offset, margin, matchWidth])
}
