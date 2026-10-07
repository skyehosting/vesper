/**
 * Phone layout (07 D8): the sessions sidebar and the session panel become sheets from the left/right edge. Modal
 * through the kit's layer stack (focus trap, Esc, focus return, the app made inert — the sheet is portaled outside
 * #root so it stays usable), a scrim that closes on tap, swipe toward the edge to close, safe-area insets, and a
 * short exit animation (none under reduced motion). Opaque, never glass, on phones (07 D10).
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { focusables, pushLayer } from '../../components/internal/layers'
import { track } from '../../components/internal/stats'

export interface EdgeSheetProps {
  open: boolean
  onClose: () => void
  side: 'start' | 'end'
  label: string
  children: ReactNode
  className?: string
}

/** Matches --dur-3; the sheet stays mounted this long after closing so it can slide out. */
const EXIT_MS = 320
const DISMISS_PX = 80

function reducedMotion(): boolean {
  return document.documentElement.dataset.reduceMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function EdgeSheet({ open, onClose, side, label, children, className }: EdgeSheetProps): ReactNode {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    if (reducedMotion()) {
      setMounted(false)
      return
    }
    setClosing(true)
    const h = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, EXIT_MS)
    track('nav.timers', 1)
    return () => {
      window.clearTimeout(h)
      track('nav.timers', -1)
    }
    // `mounted` is read, not watched: only `open` drives the transition.
  }, [open])

  if (!mounted) return null
  return createPortal(
    <SheetBody side={side} label={label} onClose={onClose} closing={closing} className={className}>
      {children}
    </SheetBody>,
    document.body
  )
}

function SheetBody({ side, label, onClose, closing, className, children }: Omit<EdgeSheetProps, 'open'> & { closing: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const drag = useRef<{ id: number; x0: number; y0: number; dx: number; horizontal: boolean | null } | null>(null)
  const [dx, setDx] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pop = pushLayer({ el, modal: true, onEscape: () => onCloseRef.current() })
    const first = el.querySelector<HTMLElement>('[data-sheet-autofocus]') ?? focusables(el)[0] ?? el
    first.focus({ preventScroll: true })
    return pop
  }, [])

  // Swipe toward the edge closes. Only a mostly-horizontal drag counts, so the list inside still scrolls.
  const sign = side === 'start' ? -1 : 1
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' || closing) return
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, horizontal: null }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const mx = e.clientX - d.x0
    const my = e.clientY - d.y0
    if (d.horizontal === null) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      d.horizontal = Math.abs(mx) > Math.abs(my) * 1.4
      if (d.horizontal) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is already gone (or synthetic): the drag still works without capture.
        }
      }
    }
    if (!d.horizontal) return
    d.dx = sign * Math.max(0, sign * mx)
    setDx(d.dx)
  }
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.horizontal && Math.abs(d.dx) > DISMISS_PX) onCloseRef.current()
    setDx(0)
  }

  return (
    <div className={`edge-sheet edge-sheet--${side}${closing ? ' is-closing' : ''}`}>
      <div className="edge-sheet__scrim" aria-hidden="true" onClick={() => onCloseRef.current()} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`edge-sheet__panel${className ? ` ${className}` : ''}`}
        style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {children}
      </div>
    </div>
  )
}
