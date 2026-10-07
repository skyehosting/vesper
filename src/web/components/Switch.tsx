/**
 * Switch — an on/off setting that applies immediately (`role="switch"`). Settings rows put the label first and the
 * switch at the end; the whole row is the click target.
 *
 *   <Switch label="Speak replies" description="Uses your voice provider" checked={on} onChange={setOn} />
 */
import { useId, type ReactNode, type Ref } from 'react'
import { cx } from './internal/cx'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label; omit and pass `aria-label` for a bare switch. */
  label?: ReactNode
  description?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  /** 'end' (default): label then switch, spread across the row. 'start': switch first, inline. */
  switchPosition?: 'start' | 'end'
  id?: string
  className?: string
  ref?: Ref<HTMLButtonElement>
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  'aria-label': ariaLabel,
  disabled = false,
  size = 'md',
  switchPosition = 'end',
  id,
  className,
  ref
}: SwitchProps): ReactNode {
  const auto = useId()
  const sid = id ?? `sw${auto}`
  const control = (
    <button
      ref={ref}
      id={sid}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-labelledby={label !== undefined ? `${sid}-label` : undefined}
      aria-describedby={description ? `${sid}-desc` : undefined}
      disabled={disabled}
      className={cx('switch', size === 'sm' && 'switch--sm')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" aria-hidden="true" />
    </button>
  )
  if (label === undefined) return <span className={cx('switch-row', 'switch-row--bare', className)}>{control}</span>
  return (
    <div className={cx('switch-row', switchPosition === 'start' && 'switch-row--start', disabled && 'is-disabled', className)}>
      {switchPosition === 'start' ? control : null}
      <span className="switch-row__text">
        {/* The label is a click target too (a <label> can't point at a role=switch button's toggle semantics). */}
        <span id={`${sid}-label`} className="switch-row__label" onClick={() => !disabled && onChange(!checked)}>
          {label}
        </span>
        {description ? (
          <span id={`${sid}-desc`} className="switch-row__desc">
            {description}
          </span>
        ) : null}
      </span>
      {switchPosition === 'end' ? control : null}
    </div>
  )
}
