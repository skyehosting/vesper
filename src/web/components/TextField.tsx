/**
 * TextField (04 "Input") — a labelled single-line input with optional leading/trailing adornments.
 *
 *   <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
 *   <TextField aria-label="Search chats" leading={<Search />} size="sm" type="search" />
 *
 * Without a visible `label`, pass `aria-label` (or `labelHidden` with a label).
 */
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import { Field } from './Field'
import { cx } from './internal/cx'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  labelHidden?: boolean
  labelExtra?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  size?: 'sm' | 'md'
  /** Icon or text before the value (decorative unless it is a button). */
  leading?: ReactNode
  /** Icon, unit or IconButton after the value. */
  trailing?: ReactNode
  /** Class on the outer field wrapper. */
  wrapClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function TextField({
  label,
  labelHidden,
  labelExtra,
  hint,
  error,
  size = 'md',
  leading,
  trailing,
  wrapClassName,
  className,
  id,
  required,
  disabled,
  readOnly,
  type = 'text',
  ref,
  ...rest
}: TextFieldProps): ReactNode {
  return (
    <Field label={label} labelHidden={labelHidden} labelExtra={labelExtra} hint={hint} error={error} required={required} id={id} className={wrapClassName}>
      {(f) => (
        <div className={cx('input', size === 'sm' && 'input--sm', disabled && 'is-disabled', readOnly && 'is-readonly', className)}>
          {leading ? (
            <span className="input__affix" aria-hidden="true">
              {leading}
            </span>
          ) : null}
          <input
            ref={ref}
            id={f.id}
            type={type}
            className="input__control"
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            {...f.aria}
            {...rest}
          />
          {trailing ? <span className="input__affix input__affix--end">{trailing}</span> : null}
        </div>
      )}
    </Field>
  )
}
