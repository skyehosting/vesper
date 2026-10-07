/**
 * Popover — a small non-modal panel anchored to its trigger (link confirmations, the "Add link" picker, quick
 * settings). Focus moves in on open; Esc, a click outside, or tabbing past either end closes it and returns focus to
 * the trigger. Use Dialog/Sheet when the user must decide before continuing.
 *
 *   <Popover title="Open this link?" trigger={<Button>…</Button>}>{(close) => <>…<Button onClick={close}>Cancel</Button></>}</Popover>
 */
import {
  cloneElement,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from './internal/cx'
import { focusables, pushLayer } from './internal/layers'
import type { Placement } from './internal/position.logic'
import { usePosition } from './internal/usePosition'
import './Popup.css'
import './Popover.css'

interface TriggerProps {
  ref?: Ref<HTMLElement>
  onClick?: (e: MouseEvent<HTMLElement>) => void
  'aria-haspopup'?: 'dialog'
  'aria-expanded'?: boolean
  'aria-controls'?: string
}

export interface PopoverProps {
  trigger: ReactElement
  /** Content, or a render function receiving `close`. */
  children: ReactNode | ((close: () => void) => ReactNode)
  title?: ReactNode
  /** Accessible name when there's no title. */
  'aria-label'?: string
  placement?: Placement
  /** CSS width of the panel (default 320px, capped by the viewport). */
  width?: number | string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function Popover({ trigger, children, title, 'aria-label': ariaLabel, placement = 'bottom-start', width = 320, open: openProp, onOpenChange, className }: PopoverProps): ReactNode {
  const id = `pop${useId()}`
  const triggerRef = useRef<HTMLElement | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (v: boolean): void => {
    if (openProp === undefined) setOpenState(v)
    onOpenChange?.(v)
  }
  const closeRef = useRef(() => setOpen(false))
  closeRef.current = () => setOpen(false)

  usePosition(open, triggerRef, ref, { placement, offset: 8 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    const pop = pushLayer({
      el,
      modal: false,
      restoreFocus: triggerRef.current,
      inside: () => [triggerRef.current],
      onEscape: () => closeRef.current(),
      onOutsidePointer: () => closeRef.current()
    })
    ;(focusables(el)[0] ?? el).focus({ preventScroll: true })
    return pop
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const list = focusables(e.currentTarget)
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement
    if (list.length === 0 || (e.shiftKey && (active === first || active === e.currentTarget)) || (!e.shiftKey && active === last)) {
      e.preventDefault()
      closeRef.current()
    }
  }

  if (!isValidElement<TriggerProps>(trigger)) return trigger
  const own = trigger.props
  const el = cloneElement(trigger, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const r = own.ref
      if (typeof r === 'function') r(node)
      else if (r) (r as { current: HTMLElement | null }).current = node
    },
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      own.onClick?.(e)
      if (!e.defaultPrevented) setOpen(!open)
    }
  } satisfies TriggerProps)

  return (
    <>
      {el}
      {open
        ? createPortal(
            <div
              ref={ref}
              id={id}
              role="dialog"
              aria-labelledby={title ? `${id}-title` : undefined}
              aria-label={title ? undefined : ariaLabel}
              tabIndex={-1}
              className={cx('popup', 'glass', 'popover', className)}
              style={{ width: typeof width === 'number' ? `${width}px` : width }}
              onKeyDown={onKeyDown}
            >
              <div className="popover__body">
                {title ? (
                  <h3 className="popover__title" id={`${id}-title`}>
                    {title}
                  </h3>
                ) : null}
                {typeof children === 'function' ? children(() => closeRef.current()) : children}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
