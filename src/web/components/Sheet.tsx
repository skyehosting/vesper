/**
 * Sheet (04 "Sheet (mobile)") — a modal panel from a screen edge: a bottom sheet on phones (drag the handle down to
 * dismiss) and a side sheet on wider screens. Same focus rules as Dialog (trap, Esc, focus return, inert app) via the
 * shared layer stack; opaque on phones and under reduced transparency (07 D10).
 *
 *   <Sheet open={open} onClose={close} title="Session" side="auto">…</Sheet>
 */
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'
import { cx } from './internal/cx'
import { focusables, pushLayer } from './internal/layers'
import { useIsPhone } from '../lib/useMediaQuery'
import './Sheet.css'

export type SheetSide = 'auto' | 'start' | 'end' | 'bottom'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 'auto' (default): bottom on phones, end (right) elsewhere. */
  side?: SheetSide
  /** Side sheets: width in px (default 400). */
  width?: number
  initialFocus?: RefObject<HTMLElement | null>
  dismissible?: boolean
  className?: string
}

export function Sheet(props: SheetProps): ReactNode {
  if (!props.open) return null
  return <SheetImpl {...props} />
}

const DISMISS_PX = 90

function SheetImpl({ onClose, title, description, children, footer, side = 'auto', width = 400, initialFocus, dismissible = true, className }: SheetProps): ReactNode {
  const phone = useIsPhone()
  const where = side === 'auto' ? (phone ? 'bottom' : 'end') : side
  const titleId = useId()
  const descId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissRef = useRef(dismissible)
  dismissRef.current = dismissible
  const drag = useRef<{ id: number; y0: number; dy: number } | null>(null)
  const [dy, setDy] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pop = pushLayer({
      el,
      modal: true,
      onEscape: () => {
        if (dismissRef.current) onCloseRef.current()
      }
    })
    const target = initialFocus?.current ?? focusables(el.querySelector('.sheet__body') ?? el)[0] ?? el
    target.focus({ preventScroll: true })
    return pop
    // Mount-only, like Dialog: focus handling must not re-run on parent renders.
  }, [])

  const onDragStart = (e: PointerEvent<HTMLDivElement>): void => {
    if (where !== 'bottom' || !dismissible || e.button !== 0) return
    if ((e.target as Element).closest('button, a, input, textarea, select')) return
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    d.dy = Math.max(0, e.clientY - d.y0)
    setDy(d.dy)
  }
  const onDragEnd = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.dy > DISMISS_PX) onCloseRef.current()
    else setDy(0)
  }

  return createPortal(
    <div
      className={cx('sheet-scrim', `sheet-scrim--${where}`)}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx('sheet', `sheet--${where}`, dy > 0 && 'is-dragging', className)}
        style={{
          ...(where === 'bottom' ? {} : { width: `min(${width}px, calc(100vw - 32px))` }),
          ...(dy > 0 ? { transform: `translateY(${dy}px)` } : {})
        }}
      >
        <div className="sheet__head" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
          {where === 'bottom' ? <div className="sheet__handle" aria-hidden="true" /> : null}
          <header className="sheet__header">
            <h2 id={titleId} className="sheet__title">
              {title}
            </h2>
            {dismissible ? <IconButton label="Close" icon={<X />} size="sm" tooltip={false} onClick={onClose} /> : null}
          </header>
          {description ? (
            <p id={descId} className="sheet__desc">
              {description}
            </p>
          ) : null}
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <footer className="sheet__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}
