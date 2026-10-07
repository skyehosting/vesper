/**
 * The floating `role="menu"` shared by Menu and ContextMenu (APG menu button / menu). Real focus moves into the menu
 * (roving: one item focused at a time); ↑/↓ wrap, Home/End jump, typing jumps (typeahead), Enter/Space/click
 * activate and close, Esc and Tab close; focus then returns to the trigger through the layer stack.
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle } from 'lucide-react'
import { Kbd } from '../Kbd'
import { cx } from './cx'
import { pushLayer } from './layers'
import type { Placement } from './position.logic'
import { nextIndex } from './roving.logic'
import { emptyTypeahead, isTypeaheadKey, typeahead } from './typeahead.logic'
import { usePosition, type AnchorRef } from './usePosition'
import '../Popup.css'

interface ItemBase {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
}

export type MenuItem =
  | (ItemBase & {
      kind?: 'item'
      description?: string
      /** Display only, e.g. "Mod+C" (the shortcut itself is registered elsewhere). */
      shortcut?: string
      danger?: boolean
      onSelect: () => void
    })
  | (ItemBase & { kind: 'checkbox'; checked: boolean; onCheckedChange: (checked: boolean) => void })
  | (ItemBase & { kind: 'radio'; checked: boolean; onSelect: () => void })
  | { kind: 'separator'; id?: string }
  | { kind: 'label'; id?: string; label: string }

type Actionable = Exclude<MenuItem, { kind: 'separator' } | { kind: 'label' }>

export function isActionable(it: MenuItem): it is Actionable {
  return it.kind !== 'separator' && it.kind !== 'label'
}

export interface MenuPopupProps {
  open: boolean
  id: string
  anchor: AnchorRef
  items: readonly MenuItem[]
  /** Which item gets focus on open. */
  focus: 'first' | 'last'
  onClose: () => void
  placement?: Placement
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Extra elements that don't count as "outside" (the trigger). */
  inside?: () => ReadonlyArray<Element | null | undefined>
}

export function MenuPopup(p: MenuPopupProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(p.onClose)
  closeRef.current = p.onClose
  const insideRef = useRef(p.inside)
  insideRef.current = p.inside
  const ta = useRef(emptyTypeahead())
  usePosition(p.open, p.anchor, ref, { placement: p.placement ?? 'bottom-start', offset: 4 })

  const actionable = p.items.map((it) => (isActionable(it) ? it : null))
  const isDisabled = (i: number): boolean => !actionable[i] || !!actionable[i]?.disabled
  const itemEls = (): HTMLElement[] => [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-index]') ?? [])]
  const focusIndex = (i: number): void => {
    itemEls()
      .find((el) => Number(el.dataset.menuIndex) === i)
      ?.focus({ preventScroll: false })
  }

  // A layout effect, ahead of the initial focus below, so the layer records the trigger as the focus to return to.
  useLayoutEffect(() => {
    const el = ref.current
    if (!p.open || !el) return
    return pushLayer({
      el,
      modal: false,
      inside: () => insideRef.current?.() ?? [],
      onEscape: () => closeRef.current(),
      onOutsidePointer: () => closeRef.current()
    })
  }, [p.open])

  // Initial focus once the menu is positioned (focus before layout would scroll the page to 0,0).
  useLayoutEffect(() => {
    if (!p.open) return
    const n = p.items.length
    const start = nextIndex(-1, p.focus === 'last' ? 'End' : 'Home', n, { orientation: 'vertical', loop: true, isDisabled })
    if (start !== null && start >= 0) focusIndex(start)
    else menuRef.current?.focus()
    ta.current = emptyTypeahead()
    // Only on open: re-focusing on every items change would steal focus while the menu is in use.
  }, [p.open])

  const activate = (it: Actionable): void => {
    if (it.disabled) return
    closeRef.current()
    if (it.kind === 'checkbox') it.onCheckedChange(!it.checked)
    else it.onSelect()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const current = Number((document.activeElement as HTMLElement | null)?.dataset?.menuIndex ?? -1)
    if (e.key === 'Tab') {
      e.preventDefault()
      closeRef.current()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const it = actionable[current]
      if (it) activate(it)
      return
    }
    if (isTypeaheadKey(e.key, e)) {
      const labels = p.items.map((it) => (isActionable(it) ? it.label : ''))
      const r = typeahead(ta.current, e.key, e.timeStamp, labels, current, isDisabled)
      ta.current = r.state
      if (r.index !== null) focusIndex(r.index)
      e.preventDefault()
      return
    }
    const next = nextIndex(current, e.key, p.items.length, { orientation: 'vertical', loop: true, isDisabled })
    if (next !== null) {
      e.preventDefault()
      focusIndex(next)
    }
  }

  if (!p.open) return null
  return createPortal(
    <div ref={ref} className="popup glass menu-popup">
      <div
        ref={menuRef}
        id={p.id}
        role="menu"
        tabIndex={-1}
        aria-label={p['aria-label']}
        aria-labelledby={p['aria-labelledby']}
        aria-orientation="vertical"
        className="popup__scroll"
        onKeyDown={onKeyDown}
      >
        {p.items.map((it, i) => {
          if (it.kind === 'separator') return <div key={it.id ?? `sep${i}`} role="separator" className="popup-sep" />
          if (it.kind === 'label')
            return (
              <div key={it.id ?? `lbl${i}`} className="popup-group-label" role="presentation">
                {it.label}
              </div>
            )
          const role = it.kind === 'checkbox' ? 'menuitemcheckbox' : it.kind === 'radio' ? 'menuitemradio' : 'menuitem'
          const checked = it.kind === 'checkbox' || it.kind === 'radio' ? it.checked : undefined
          const danger = (it.kind === undefined || it.kind === 'item') && it.danger
          return (
            <div
              key={it.id}
              role={role}
              tabIndex={-1}
              data-menu-index={i}
              aria-disabled={it.disabled || undefined}
              aria-checked={checked}
              className={cx('popup-row', 'menu-item', danger && 'popup-row--danger')}
              onClick={() => activate(it)}
              onPointerMove={(e) => {
                if (!it.disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true })
              }}
              onFocus={(e) => e.currentTarget.setAttribute('data-active', '')}
              onBlur={(e) => e.currentTarget.removeAttribute('data-active')}
            >
              {checked !== undefined ? (
                <span className="popup-row__check" aria-hidden="true">
                  {checked ? it.kind === 'radio' ? <Circle className="menu-item__dot" /> : <Check /> : null}
                </span>
              ) : null}
              {it.icon ? (
                <span className="popup-row__icon" aria-hidden="true">
                  {it.icon}
                </span>
              ) : null}
              <span className="popup-row__text">
                <span className="popup-row__label">{it.label}</span>
                {(it.kind === undefined || it.kind === 'item') && it.description ? <span className="popup-row__desc">{it.description}</span> : null}
              </span>
              {(it.kind === undefined || it.kind === 'item') && it.shortcut ? (
                <span className="popup-row__meta">
                  <Kbd keys={it.shortcut} />
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
