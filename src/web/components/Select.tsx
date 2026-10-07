/**
 * Select — a select-only combobox (APG): a button showing the chosen option that opens a listbox. Focus stays on the
 * button; arrows move the active option, Enter/Space/Tab choose it, Esc closes, typing jumps (typeahead), and the
 * listbox flips above the button when there's no room below.
 *
 *   <Select label="Theme" value={theme} onChange={setTheme}
 *     options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ChevronDown } from 'lucide-react'
import { Field } from './Field'
import { cx } from './internal/cx'
import { ListboxPopup, optionId, type ListOption } from './internal/ListboxPopup'
import type { Placement } from './internal/position.logic'
import { firstEnabled, nextIndex } from './internal/roving.logic'
import { emptyTypeahead, isTypeaheadKey, typeahead } from './internal/typeahead.logic'
import './Select.css'

export interface SelectOption<V extends string = string> extends ListOption {
  value: V
}

export interface SelectProps<V extends string = string> {
  value: V | null
  onChange: (value: V) => void
  options: readonly SelectOption<V>[]
  label?: ReactNode
  labelHidden?: boolean
  labelExtra?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** Shown when nothing is chosen. */
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  id?: string
  /** Accessible name when there is no visible label. */
  'aria-label'?: string
  placement?: Placement
  /** Submits the value with a surrounding <form>. */
  name?: string
  className?: string
  wrapClassName?: string
  ref?: Ref<HTMLButtonElement>
}

const PAGE = 8

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  label,
  labelHidden,
  labelExtra,
  hint,
  error,
  required,
  placeholder = 'Choose…',
  disabled = false,
  size = 'md',
  id,
  'aria-label': ariaLabel,
  placement,
  name,
  className,
  wrapClassName,
  ref
}: SelectProps<V>): ReactNode {
  const listId = `lb${useId()}`
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const ta = useRef(emptyTypeahead())
  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null
  const isDisabled = (i: number): boolean => !!options[i]?.disabled

  const setRefs = (el: HTMLButtonElement | null): void => {
    triggerRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const openAt = (i: number): void => {
    setActive(i)
    setOpen(true)
  }
  const close = (): void => {
    setOpen(false)
    setActive(-1)
  }
  const pick = (i: number): void => {
    const o = options[i]
    if (!o || o.disabled) return
    close()
    if (o.value !== value) onChange(o.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    const labels = options.map((o) => o.label)
    if (isTypeaheadKey(e.key, e)) {
      const r = typeahead(ta.current, e.key, e.timeStamp, labels, open ? active : selectedIndex, isDisabled)
      ta.current = r.state
      if (r.index !== null) openAt(r.index)
      else if (!open) openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(options.length, isDisabled))
      e.preventDefault()
      return
    }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(options.length, isDisabled))
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        openAt(nextIndex(-1, e.key, options.length, { orientation: 'vertical', loop: false, isDisabled }) ?? -1)
      }
      return
    }
    if (e.key === 'Enter' || (e.key === ' ' && ta.current.buffer === '') || (e.key === 'ArrowUp' && e.altKey)) {
      e.preventDefault()
      if (active >= 0) pick(active)
      else close()
      return
    }
    if (e.key === ' ') {
      // Space inside a typeahead word is part of the search ("dusk v…").
      const r = typeahead(ta.current, e.key, e.timeStamp, labels, active, isDisabled)
      ta.current = r.state
      e.preventDefault()
      return
    }
    if (e.key === 'Tab') {
      if (active >= 0) pick(active)
      else close()
      return
    }
    const next = nextIndex(active, e.key, options.length, { orientation: 'vertical', loop: false, isDisabled, pageSize: PAGE })
    if (next !== null) {
      e.preventDefault()
      setActive(next)
    }
  }

  return (
    <Field label={label} labelHidden={labelHidden} labelExtra={labelExtra} hint={hint} error={error} required={required} id={id} className={wrapClassName}>
      {(f) => (
        <>
          <button
            ref={setRefs}
            id={f.id}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active >= 0 ? optionId(listId, active) : undefined}
            aria-labelledby={label !== undefined ? `${f.labelId} ${f.id}-value` : undefined}
            aria-label={label === undefined ? ariaLabel : undefined}
            {...f.aria}
            disabled={disabled}
            className={cx('input', 'select', size === 'sm' && 'input--sm', disabled && 'is-disabled', open && 'is-focused', className)}
            onClick={() => (open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(options.length, isDisabled)))}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (open) close()
            }}
          >
            {selected?.icon ? (
              <span className="input__affix" aria-hidden="true">
                {selected.icon}
              </span>
            ) : null}
            <span id={`${f.id}-value`} className={cx('select__value', !selected && 'is-placeholder')}>
              {selected ? selected.label : placeholder}
            </span>
            {selected?.meta ? <span className="select__meta">{selected.meta}</span> : null}
            <ChevronDown className="select__chevron" aria-hidden="true" />
          </button>
          {name ? <input type="hidden" name={name} value={value ?? ''} /> : null}
          <ListboxPopup
            open={open}
            id={listId}
            anchorRef={triggerRef}
            options={options}
            activeIndex={active}
            selected={value}
            labelledBy={label !== undefined ? f.labelId : undefined}
            label={ariaLabel}
            onPick={(i) => {
              pick(i)
              triggerRef.current?.focus({ preventScroll: true })
            }}
            onActive={setActive}
            onClose={close}
            placement={placement}
          />
        </>
      )}
    </Field>
  )
}
