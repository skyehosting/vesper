/**
 * Tooltip — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these props.
 *
 *   <Tooltip content="New chat"><button …/></Tooltip>
 *
 * Shows on mouse hover (after `delayMs`) and on keyboard focus; Esc hides it. The child gets `aria-describedby`, so
 * the text is announced. Not shown for touch (there is no hover; labels must be visible or in aria-label).
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { topLayerElement } from './internal/layers'
import './Tooltip.css'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  /** One focusable element (button, link). */
  children: ReactElement
  side?: TooltipSide
  delayMs?: number
  disabled?: boolean
  /** Link the tip with aria-describedby (default true). False when it repeats the child's accessible name. */
  describe?: boolean
}

const GAP = 6
const MARGIN = 8

export function Tooltip({ content, children, side = 'top', delayMs = 450, disabled = false, describe = true }: TooltipProps): ReactNode {
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; side: TooltipSide } | null>(null)

  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const show = useCallback(
    (delay: number) => {
      if (disabled || content === null || content === undefined || content === '') return
      clear()
      timer.current = window.setTimeout(() => setOpen(true), delay)
    },
    [disabled, content]
  )
  const hide = useCallback(() => {
    clear()
    setOpen(false)
    setPos(null)
  }, [])

  useEffect(() => () => clear(), [])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Esc belongs to a layer opened on top of this tooltip's trigger (a menu or popover from it, a dialog over it):
      // that layer closes, the tooltip stays as it is.
      const top = topLayerElement()
      if (top && anchorRef.current && !top.contains(anchorRef.current)) return
      hide()
    }
    const onScroll = (): void => hide()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, hide])

  useLayoutEffect(() => {
    if (!open) return
    const a = anchorRef.current?.getBoundingClientRect()
    const t = tipRef.current?.getBoundingClientRect()
    if (!a || !t) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    let s = side
    if (s === 'top' && a.top - t.height - GAP < MARGIN) s = 'bottom'
    else if (s === 'bottom' && a.bottom + t.height + GAP > vh - MARGIN) s = 'top'
    else if (s === 'left' && a.left - t.width - GAP < MARGIN) s = 'right'
    else if (s === 'right' && a.right + t.width + GAP > vw - MARGIN) s = 'left'
    let x: number
    let y: number
    if (s === 'top' || s === 'bottom') {
      x = a.left + a.width / 2 - t.width / 2
      y = s === 'top' ? a.top - t.height - GAP : a.bottom + GAP
    } else {
      x = s === 'left' ? a.left - t.width - GAP : a.right + GAP
      y = a.top + a.height / 2 - t.height / 2
    }
    x = Math.min(Math.max(MARGIN, x), vw - t.width - MARGIN)
    y = Math.min(Math.max(MARGIN, y), vh - t.height - MARGIN)
    setPos({ x, y, side: s })
  }, [open, side, content])

  const child = describe && isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined
      })
    : children

  return (
    <>
      <span
        ref={anchorRef}
        className="tooltip-anchor"
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') show(delayMs)
        }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => {
          if ((e.target as HTMLElement).matches?.(':focus-visible')) show(0)
        }}
        onBlur={hide}
      >
        {child}
      </span>
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              aria-hidden={describe ? undefined : true}
              className="tooltip glass"
              data-side={pos?.side ?? side}
              style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
