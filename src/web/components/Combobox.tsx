/**
 * Combobox (04: searchable — voices, models): an editable input with a filtered listbox (APG combobox, list
 * autocomplete). Typing filters and makes the best match active; arrows move, Enter chooses, Esc closes the list (a
 * second Esc restores the chosen value), leaving the field restores the chosen label. Matches are highlighted.
 *
 *   <Combobox label="Voice" value={voiceId} onChange={setVoiceId} options={voices.map(v => ({ value: v.id, label: v.name, description: v.accent }))} />
 *
 * For server-side search pass `onQueryChange` (filtering is then yours) and `loading`.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { Field } from './Field'
import type { SelectOption } from './Select'
import { filterItems } from './internal/combobox.logic'
import { cx } from './internal/cx'
import { ListboxPopup, optionId } from './internal/ListboxPopup'
import type { Placement } from './internal/position.logic'
import { firstEnabled, nextIndex } from './internal/roving.logic'
import './Select.css'

export interface ComboboxProps<V extends string = string> {
  value: V | null
  onChange: (value: V | null) => void
  options: readonly SelectOption<V>[]
  label?: ReactNode
  labelHidden?: boolean
  labelExtra?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  id?: string
  'aria-label'?: string
  /** Shown when nothing matches. */
  emptyText?: ReactNode
  loading?: boolean
  /** Called as the user types (server-side search); the kit then shows `options` unfiltered. */
  onQueryChange?: (query: string) => void
  /** Show a clear button; clearing (or emptying the field and leaving) sets the value to null. */
  clearable?: boolean
  placement?: Placement
  className?: string
  wrapClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function Combobox<V extends string = string>({
  value,
  onChange,
  options,
  label,
  labelHidden,
  labelExtra,
  hint,
  error,
  required,
  placeholder = 'Search…',
  disabled = false,
  size = 'md',
  id,
  'aria-label': ariaLabel,
  emptyText,
  loading = false,
  onQueryChange,
  clearable = false,
  placement,
  className,
  wrapClassName,
  ref
}: ComboboxProps<V>): ReactNode {
  const listId = `cb${useId()}`
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  /** null = not editing: the input shows the chosen option's label. */
  const [query, setQuery] = useState<string | null>(null)

  const selected = options.find((o) => o.value === value) ?? null
  const shown = onQueryChange || query === null ? options : filterItems(options, query)
  const isDisabled = (i: number): boolean => !!shown[i]?.disabled
  const text = query ?? selected?.label ?? ''

  const setRefs = (el: HTMLInputElement | null): void => {
    inputRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const close = (): void => {
    setOpen(false)
    setActive(-1)
  }
  const openList = (): void => {
    if (disabled) return
    const sel = shown.findIndex((o) => o.value === value)
    setActive(sel >= 0 ? sel : firstEnabled(shown.length, isDisabled))
    setOpen(true)
  }
  const pick = (i: number): void => {
    const o = shown[i]
    if (!o || o.disabled) return
    setQuery(null)
    close()
    if (o.value !== value) onChange(o.value)
  }
  const updateQuery = (q: string): void => {
    setQuery(q)
    onQueryChange?.(q)
    const list = onQueryChange ? options : filterItems(options, q)
    setActive(q.trim() ? firstEnabled(list.length, (i) => !!list[i]?.disabled) : -1)
    setOpen(true)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openList()
        return
      }
      if (e.altKey && e.key === 'ArrowUp') {
        close()
        return
      }
      const next = nextIndex(active, e.key, shown.length, { orientation: 'vertical', loop: false, isDisabled })
      if (next !== null) setActive(next)
      return
    }
    if (open && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault()
      const next = nextIndex(active, e.key, shown.length, { orientation: 'vertical', loop: false, isDisabled, pageSize: 8 })
      if (next !== null) setActive(next)
      return
    }
    if (e.key === 'Enter' && open) {
      e.preventDefault()
      if (active >= 0) pick(active)
      return
    }
    // Esc with the list closed: give back the chosen value (the open list's Esc is handled by its layer).
    if (e.key === 'Escape' && !open && query !== null) {
      e.preventDefault()
      e.stopPropagation()
      setQuery(null)
    }
  }

  return (
    <Field label={label} labelHidden={labelHidden} labelExtra={labelExtra} hint={hint} error={error} required={required} id={id} className={wrapClassName}>
      {(f) => (
        <>
          <div
            ref={boxRef}
            className={cx('input', 'combobox', size === 'sm' && 'input--sm', disabled && 'is-disabled', className)}
            data-open={open || undefined}
          >
            <span className="input__affix" aria-hidden="true">
              {selected?.icon && query === null ? selected.icon : <Search />}
            </span>
            <input
              ref={setRefs}
              id={f.id}
              className="input__control"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? optionId(listId, active) : undefined}
              aria-label={label === undefined ? ariaLabel : undefined}
              {...f.aria}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={placeholder}
              disabled={disabled}
              value={text}
              onChange={(e) => updateQuery(e.target.value)}
              onKeyDown={onKeyDown}
              onClick={() => {
                if (!open) openList()
              }}
              onBlur={() => {
                close()
                if (clearable && query !== null && query.trim() === '' && value !== null) onChange(null)
                setQuery(null)
              }}
            />
            {clearable && value !== null && !disabled ? (
              <button
                type="button"
                className="combobox__toggle"
                aria-label="Clear"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery(null)
                  onChange(null)
                  inputRef.current?.focus()
                }}
              >
                <X />
              </button>
            ) : null}
            <button
              type="button"
              className="combobox__toggle"
              aria-label={open ? 'Hide options' : 'Show options'}
              tabIndex={-1}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                inputRef.current?.focus()
                if (open) close()
                else openList()
              }}
            >
              <ChevronDown />
            </button>
          </div>
          <ListboxPopup
            open={open}
            id={listId}
            anchorRef={boxRef}
            options={shown}
            activeIndex={active}
            selected={value}
            labelledBy={label !== undefined ? f.labelId : undefined}
            label={ariaLabel}
            onPick={pick}
            onActive={setActive}
            onClose={close}
            query={query ?? undefined}
            empty={emptyText}
            loading={loading}
            placement={placement}
          />
        </>
      )}
    </Field>
  )
}
