/**
 * Dialog — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these props.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Delete chat?" footer={<…buttons…/>}>…</Dialog>
 *
 * Modal: `role="dialog"` + `aria-modal`, labelled by the title (and described by `description`). Focus moves in on
 * open (`initialFocus`, else the first field/button, else the dialog), Tab is trapped, Esc and the scrim close it
 * (unless `dismissible={false}`), and focus returns to the opener on close. The app root is made `inert` meanwhile.
 * Nested dialogs stack; only the top one reacts. A body that overflows becomes a tab stop itself, so its text can be
 * scrolled from the keyboard even when it holds no focusable content (axe `scrollable-region-focusable`).
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'
import { focusables, pushLayer } from './internal/layers'
import { track } from './internal/stats'
import './Dialog.css'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Action row (buttons), right-aligned. */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** Element to focus when the dialog opens. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Esc / scrim click close the dialog (default true). False for dialogs that need an explicit choice. */
  dismissible?: boolean
  /** Hide the × button (it is also hidden when not dismissible). */
  hideClose?: boolean
  className?: string
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  initialFocus,
  dismissible = true,
  hideClose = false,
  className
}: DialogProps): ReactNode {
  if (!open) return null
  return (
    <DialogImpl
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      size={size}
      initialFocus={initialFocus}
      dismissible={dismissible}
      hideClose={hideClose}
      className={className}
    >
      {children}
    </DialogImpl>
  )
}

function DialogImpl({
  onClose,
  title,
  description,
  children,
  footer,
  size,
  initialFocus,
  dismissible,
  hideClose,
  className
}: Omit<DialogProps, 'open'>): ReactNode {
  const titleId = useId()
  const descId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissRef = useRef(dismissible)
  dismissRef.current = dismissible

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Esc, Tab trap, focus guard, inert app root and focus return all live in the shared layer stack, so dialogs,
    // sheets and the popovers inside them nest correctly (Esc closes only the top one).
    const pop = pushLayer({
      el,
      modal: true,
      onEscape: () => {
        if (dismissRef.current) onCloseRef.current()
      }
    })
    const target = initialFocus?.current ?? focusables(el.querySelector('.dialog__body') ?? el)[0] ?? focusables(el)[0] ?? el
    target.focus({ preventScroll: true })
    return pop
    // Mount-only on purpose: focus handling must not re-run when the parent re-renders (callbacks are read via refs).
  }, [])

  // Long, read-only content (the shortcuts sheet, licence texts) scrolls inside the body: keyboard users need a stop.
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => syncScrollStop(bodyRef.current))
  useEffect(() => {
    const b = bodyRef.current
    if (!b || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncScrollStop(b))
    ro.observe(b)
    track('kit.observers', 1)
    return () => {
      ro.disconnect()
      track('kit.observers', -1)
    }
  }, [])

  return createPortal(
    <div
      className="dialog-scrim"
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
        className={['dialog', 'glass', `dialog--${size}`, className].filter(Boolean).join(' ')}
      >
        <header className="dialog__header">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          {dismissible && !hideClose ? <IconButton label="Close" icon={<X />} size="sm" tooltip={false} onClick={onClose} /> : null}
        </header>
        {description ? (
          <p id={descId} className="dialog__desc">
            {description}
          </p>
        ) : null}
        {children !== undefined ? <div ref={bodyRef} className="dialog__body">
            {children}
          </div> : null}
        {footer ? <footer className="dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}

/** The body is a tab stop exactly while it overflows (attribute only: React does not own it). */
function syncScrollStop(b: HTMLElement | null): void {
  if (!b) return
  const scrolls = b.scrollHeight > b.clientHeight + 1
  if (scrolls === b.hasAttribute('tabindex')) return
  if (scrolls) b.setAttribute('tabindex', '0')
  else b.removeAttribute('tabindex')
}
