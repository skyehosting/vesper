/**
 * The floating listbox shared by Select and Combobox. Focus never enters it: the trigger keeps focus and points at
 * the active option with `aria-activedescendant` (APG combobox pattern), so typing and screen readers stay on the
 * control. It sits in the layer stack (Esc and outside clicks close it) and keeps the active option scrolled into view.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { highlightParts } from './combobox.logic'
import { cx } from './cx'
import { pushLayer } from './layers'
import type { Placement } from './position.logic'
import { usePosition } from './usePosition'
import '../Popup.css'

export interface ListOption {
  value: string
  label: string
  description?: string
  icon?: ReactNode
  /** Right-aligned extra (a price, "leaves this PC", a size). */
  meta?: ReactNode
  disabled?: boolean
  keywords?: string[]
}

export const optionId = (listId: string, i: number): string => `${listId}-o${i}`

export interface ListboxPopupProps {
  open: boolean
  id: string
  anchorRef: RefObject<HTMLElement | null>
  options: readonly ListOption[]
  activeIndex: number
  selected: string | null
  /** Label for the listbox (usually the field's label id). */
  labelledBy?: string
  label?: string
  onPick: (index: number) => void
  onActive: (index: number) => void
  onClose: () => void
  /** Highlight this query in labels (Combobox). */
  query?: string
  empty?: ReactNode
  loading?: boolean
  placement?: Placement
}

export function ListboxPopup(p: ListboxPopupProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const closeRef = useRef(p.onClose)
  closeRef.current = p.onClose
  usePosition(p.open, p.anchorRef, ref, { placement: p.placement ?? 'bottom-start', matchWidth: true, offset: 4 })

  useEffect(() => {
    const el = ref.current
    if (!p.open || !el) return
    return pushLayer({
      el,
      modal: false,
      restoreFocus: false,
      inside: () => [p.anchorRef.current],
      onEscape: () => closeRef.current(),
      onOutsidePointer: () => closeRef.current()
    })
  }, [p.open, p.anchorRef])

  useLayoutEffect(() => {
    if (!p.open || p.activeIndex < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${p.activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [p.open, p.activeIndex])

  if (!p.open) return null
  return createPortal(
    <div
      ref={ref}
      className="popup glass listbox-popup"
      // Clicking an option must not blur the control that owns focus.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="popup__scroll">
        {p.options.length === 0 ? (
          <div className="popup-empty" role="status">
            {p.loading ? 'Loading…' : (p.empty ?? 'No matches')}
          </div>
        ) : null}
        <ul
          ref={listRef}
          id={p.id}
          role="listbox"
          aria-labelledby={p.labelledBy}
          aria-label={p.labelledBy ? undefined : p.label}
          aria-busy={p.loading || undefined}
          hidden={p.options.length === 0}
        >
          {p.options.map((o, i) => {
            const selected = o.value === p.selected
            const [a, m, b] = p.query ? highlightParts(o.label, p.query) : [o.label, '', '']
            return (
              <li
                key={o.value}
                id={optionId(p.id, i)}
                data-index={i}
                role="option"
                aria-selected={selected}
                aria-disabled={o.disabled || undefined}
                data-active={i === p.activeIndex || undefined}
                className="popup-row"
                onPointerMove={() => {
                  if (!o.disabled && i !== p.activeIndex) p.onActive(i)
                }}
                onClick={() => {
                  if (!o.disabled) p.onPick(i)
                }}
              >
                <span className="popup-row__check" aria-hidden="true">
                  {selected ? <Check /> : null}
                </span>
                {o.icon ? (
                  <span className="popup-row__icon" aria-hidden="true">
                    {o.icon}
                  </span>
                ) : null}
                <span className="popup-row__text">
                  <span className={cx('popup-row__label')}>
                    {a}
                    {m ? <mark>{m}</mark> : null}
                    {b}
                  </span>
                  {o.description ? <span className="popup-row__desc">{o.description}</span> : null}
                </span>
                {o.meta ? <span className="popup-row__meta">{o.meta}</span> : null}
              </li>
            )
          })}
        </ul>
      </div>
    </div>,
    document.body
  )
}
