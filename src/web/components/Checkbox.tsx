/**
 * Checkbox — a native checkbox (keyboard, forms and screen readers for free) drawn in the kit's style, with an
 * optional description and the mixed state.
 *
 *   <Checkbox label="Link both ways" checked={both} onChange={setBoth} />
 */
import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react'
import { Check, Minus } from 'lucide-react'
import { cx } from './internal/cx'
import './Checkbox.css'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  'aria-label'?: string
  /** Mixed state ("some sessions selected"); shown instead of the check. */
  indeterminate?: boolean
  disabled?: boolean
  name?: string
  value?: string
  id?: string
  className?: string
  ref?: Ref<HTMLInputElement>
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  'aria-label': ariaLabel,
  indeterminate = false,
  disabled = false,
  name,
  value,
  id,
  className,
  ref
}: CheckboxProps): ReactNode {
  const auto = useId()
  const cid = id ?? `cb${auto}`
  const inner = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className={cx('checkbox', disabled && 'is-disabled', !label && 'checkbox--bare', className)}>
      <span className="checkbox__box">
        <input
          ref={(el) => {
            inner.current = el
            if (typeof ref === 'function') ref(el)
            else if (ref) ref.current = el
          }}
          id={cid}
          type="checkbox"
          className="checkbox__input"
          checked={checked}
          disabled={disabled}
          name={name}
          value={value}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={description ? `${cid}-desc` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="checkbox__mark" aria-hidden="true">
          {indeterminate ? <Minus /> : <Check />}
        </span>
      </span>
      {label || description ? (
        <span className="checkbox__text">
          {label ? <span className="checkbox__label">{label}</span> : null}
          {description ? (
            <span id={`${cid}-desc`} className="checkbox__desc">
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  )
}
