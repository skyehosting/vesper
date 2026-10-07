/**
 * ContextMenu — the same menu, opened at the pointer by right-click, by a long press on touch (iOS has no
 * contextmenu event for non-links), or from the keyboard with Shift+F10 / the Menu key on the focused element.
 *
 *   <ContextMenu aria-label="Message actions" items={…}><article tabIndex={0}>…</article></ContextMenu>
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { MenuPopup, type MenuItem } from './internal/MenuPopup'
import { track } from './internal/stats'

interface TargetProps {
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void
  onPointerMove?: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel?: (e: PointerEvent<HTMLElement>) => void
  'aria-haspopup'?: 'menu'
}

export interface ContextMenuProps {
  /** One element; it should be focusable (tabIndex 0) so keyboard users can open the menu. */
  children: ReactElement
  items: readonly MenuItem[]
  'aria-label': string
  disabled?: boolean
  /** Long-press duration on touch (ms). */
  longPressMs?: number
}

type Point = { x: number; y: number }

export function ContextMenu({ children, items, 'aria-label': ariaLabel, disabled = false, longPressMs = 500 }: ContextMenuProps): ReactNode {
  const id = `cm${useId()}`
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement | Point | null>(null)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)

  const cancelPress = (): void => {
    if (!press.current) return
    window.clearTimeout(press.current.timer)
    press.current = null
    track('kit.timers', -1)
  }
  useEffect(() => cancelPress, [])

  if (!isValidElement<TargetProps>(children)) return children
  const own = children.props
  const openAt = (a: HTMLElement | Point): void => {
    anchor.current = a
    setOpen(true)
  }

  const el = cloneElement(children, {
    'aria-haspopup': 'menu',
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      own.onContextMenu?.(e)
      if (disabled || e.defaultPrevented) return
      e.preventDefault()
      openAt({ x: e.clientX, y: e.clientY })
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      own.onKeyDown?.(e)
      if (disabled || e.defaultPrevented) return
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault()
        openAt(e.currentTarget)
      }
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      own.onPointerDown?.(e)
      if (disabled || e.pointerType !== 'touch') return
      cancelPress()
      const x = e.clientX
      const y = e.clientY
      track('kit.timers', 1)
      press.current = {
        x,
        y,
        timer: window.setTimeout(() => {
          press.current = null
          track('kit.timers', -1)
          if (!open) openAt({ x, y })
        }, longPressMs)
      }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      own.onPointerMove?.(e)
      const p = press.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress()
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      own.onPointerUp?.(e)
      cancelPress()
    },
    onPointerCancel: (e: PointerEvent<HTMLElement>) => {
      own.onPointerCancel?.(e)
      cancelPress()
    }
  } satisfies TargetProps)

  return (
    <>
      {el}
      <MenuPopup open={open} id={id} anchor={anchor} items={items} focus="first" placement="bottom-start" aria-label={ariaLabel} onClose={() => setOpen(false)} />
    </>
  )
}
