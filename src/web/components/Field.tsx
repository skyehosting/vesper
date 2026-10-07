/**
 * Field — label, hint and error around one control, wired for assistive tech: the label names the control, the hint
 * and the error describe it (`aria-describedby`), and an error sets `aria-invalid`. TextField, TextArea, Select,
 * Combobox and SecretInput use it; custom controls get the ids through the render prop.
 *
 *   <Field label="Base URL" hint="https:// unless it's this PC" error={err}>{(f) => <input id={f.id} {...f.aria} />}</Field>
 */
import { useId, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { cx } from './internal/cx'
import './Field.css'

export interface FieldIds {
  /** Put on the control. */
  id: string
  labelId: string
  /** Spread on the control: aria-describedby / aria-invalid / aria-required. */
  aria: { 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true }
  invalid: boolean
}

export interface FieldProps {
  label?: ReactNode
  /** Keep the label for screen readers only (the control's purpose is obvious from context). */
  labelHidden?: boolean
  /** Shown after the label (a badge such as "Leaves this PC", an "Optional" note). */
  labelExtra?: ReactNode
  hint?: ReactNode
  /** Error text; replaces nothing — the hint stays, the error is announced with it. */
  error?: ReactNode
  required?: boolean
  id?: string
  className?: string
  children: (ids: FieldIds) => ReactNode
}

export function useFieldIds(o: { id?: string; hint?: ReactNode; error?: ReactNode; required?: boolean }): FieldIds & { hintId: string; errorId: string } {
  const auto = useId()
  const id = o.id ?? `f${auto}`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const invalid = o.error !== undefined && o.error !== null && o.error !== false && o.error !== ''
  const hasHint = o.hint !== undefined && o.hint !== null && o.hint !== false && o.hint !== ''
  const describedBy = [invalid ? errorId : null, hasHint ? hintId : null].filter(Boolean).join(' ') || undefined
  return {
    id,
    labelId: `${id}-label`,
    hintId,
    errorId,
    invalid,
    aria: { 'aria-describedby': describedBy, 'aria-invalid': invalid ? true : undefined, 'aria-required': o.required ? true : undefined }
  }
}

export function Field({ label, labelHidden, labelExtra, hint, error, required, id, className, children }: FieldProps): ReactNode {
  const ids = useFieldIds({ id, hint, error, required })
  return (
    <div className={cx('field-wrap', ids.invalid && 'is-invalid', className)}>
      {label !== undefined ? (
        <div className={cx('field-label-row', labelHidden && 'sr-only')}>
          <label className="field-label" id={ids.labelId} htmlFor={ids.id}>
            {label}
            {required ? (
              <span className="field-required" aria-hidden="true">
                {' '}
                *
              </span>
            ) : null}
          </label>
          {labelExtra}
        </div>
      ) : null}
      {children(ids)}
      {ids.invalid ? (
        <p className="field-error" id={ids.errorId}>
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      {hint !== undefined && hint !== null && hint !== false && hint !== '' ? (
        <p className="field-hint" id={ids.hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}
