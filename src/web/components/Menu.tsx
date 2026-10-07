/**
 * Menu — a menu button (APG): the trigger (any Button/IconButton) gets `aria-haspopup="menu"`/`aria-expanded`;
 * click, Enter, Space or ↓ open the menu on the first item, ↑ on the last. Items are actions, checkboxes or radios,
 * with separators and group labels.
 *
 *   <Menu aria-label="Chat actions" trigger={<IconButton label="More" icon={<Ellipsis/>} />} items={[
 *     { id: 'rename', label: 'Rename', icon: <Pencil/>, onSelect: rename },
 *     { kind: 'separator' },
 *     { id: 'delete', label: 'Delete', icon: <Trash2/>, danger: true, onSelect: askDelete }]} />
 */
import { cloneElement, isValidElement, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { MenuPopup, type MenuItem } from './internal/MenuPopup'
import type { Placement } from './internal/position.logic'

export type { MenuItem } from './internal/MenuPopup'

interface TriggerProps {
  ref?: Ref<HTMLElement>
  onClick?: (e: MouseEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  'aria-haspopup'?: 'menu'
  'aria-expanded'?: boolean
  'aria-controls'?: string
}

export interface MenuProps {
  /** One element that accepts ref, onClick and onKeyDown (Button, IconButton, a <button>). */
  trigger: ReactElement
  items: readonly MenuItem[]
  /** Accessible name for the menu (defaults to the trigger's name via aria-labelledby when the trigger has an id). */
  'aria-label'?: string
  placement?: Placement
  /** Controlled open state (optional). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Menu({ trigger, items, 'aria-label': ariaLabel, placement = 'bottom-start', open: openProp, onOpenChange }: MenuProps): ReactNode {
  const menuId = `mn${useId()}`
  const triggerRef = useRef<HTMLElement | null>(null)
  const [openState, setOpenState] = useState(false)
  const [focus, setFocus] = useState<'first' | 'last'>('first')
  const open = openProp ?? openState
  const setOpen = (v: boolean): void => {
    if (openProp === undefined) setOpenState(v)
    onOpenChange?.(v)
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
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      own.onClick?.(e)
      if (e.defaultPrevented) return
      setFocus('first')
      setOpen(!open)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      own.onKeyDown?.(e)
      if (e.defaultPrevented) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocus(e.key === 'ArrowUp' ? 'last' : 'first')
        setOpen(true)
      }
    }
  } satisfies TriggerProps)

  return (
    <>
      {el}
      <MenuPopup
        open={open}
        id={menuId}
        anchor={triggerRef}
        items={items}
        focus={focus}
        placement={placement}
        aria-label={ariaLabel}
        inside={() => [triggerRef.current]}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
