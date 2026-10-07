/**
 * RadioGroup — one choice from a few, as plain radios or as **radio cards** (04: wizard choices such as Quick start vs
 * Guided, This PC / LAN / Tailscale). Native radios underneath, so arrow keys move and select, Tab enters at the
 * chosen one, and forms/screen readers work as expected.
 *
 *   <RadioGroup label="Access" variant="cards" value={mode} onChange={setMode} options={[
 *     { value: 'local', label: 'This PC', description: 'Only this computer', icon: <Monitor /> }, …]} />
 */
import { useId, type ReactNode } from 'react'
import { cx } from './internal/cx'
import './RadioGroup.css'

export interface RadioOption<V extends string = string> {
  value: V
  label: ReactNode
  description?: ReactNode
  icon?: ReactNode
  /** Extra content on a card (a badge such as "Recommended" or "Leaves this PC"). */
  badge?: ReactNode
  disabled?: boolean
}

export interface RadioGroupProps<V extends string = string> {
  value: V | null
  onChange: (value: V) => void
  options: readonly RadioOption<V>[]
  /** Group label (a legend); omit only with `aria-label`. */
  label?: ReactNode
  labelHidden?: boolean
  'aria-label'?: string
  hint?: ReactNode
  variant?: 'list' | 'cards'
  /** Cards: columns on wide screens (they stack on phones). */
  columns?: 1 | 2 | 3
  orientation?: 'vertical' | 'horizontal'
  name?: string
  disabled?: boolean
  className?: string
}

export function RadioGroup<V extends string = string>({
  value,
  onChange,
  options,
  label,
  labelHidden,
  'aria-label': ariaLabel,
  hint,
  variant = 'list',
  columns = 1,
  orientation = 'vertical',
  name,
  disabled = false,
  className
}: RadioGroupProps<V>): ReactNode {
  const auto = useId()
  const groupName = name ?? `rg${auto}`
  return (
    <fieldset
      className={cx('radio-group', `radio-group--${variant}`, orientation === 'horizontal' && 'radio-group--row', className)}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-describedby={hint ? `${groupName}-hint` : undefined}
      disabled={disabled}
    >
      {label !== undefined ? <legend className={cx('radio-group__legend', labelHidden && 'sr-only')}>{label}</legend> : null}
      {hint ? (
        <p className="radio-group__hint" id={`${groupName}-hint`}>
          {hint}
        </p>
      ) : null}
      <div className="radio-group__items" style={variant === 'cards' ? { ['--cols' as string]: columns } : undefined}>
        {options.map((o) => {
          const checked = o.value === value
          const id = `${groupName}-${o.value}`
          return (
            <label key={o.value} className={cx('radio', variant === 'cards' && 'radio-card', checked && 'is-checked', o.disabled && 'is-disabled')} htmlFor={id}>
              <input
                id={id}
                type="radio"
                className="radio__input"
                name={groupName}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                // Name = the label only; the description is a description (the wrapping <label> would merge them).
                aria-labelledby={`${id}-label`}
                aria-describedby={o.description ? `${id}-desc` : undefined}
                onChange={() => onChange(o.value)}
              />
              {variant === 'cards' && o.icon ? (
                <span className="radio-card__icon" aria-hidden="true">
                  {o.icon}
                </span>
              ) : null}
              <span className="radio__text">
                <span className="radio__label">
                  <span id={`${id}-label`}>{o.label}</span>
                  {o.badge ? <span className="radio__badge">{o.badge}</span> : null}
                </span>
                {o.description ? (
                  <span className="radio__desc" id={`${id}-desc`}>
                    {o.description}
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
