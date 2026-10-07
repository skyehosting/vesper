/**
 * Button — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these props.
 *
 *   <Button variant="primary" icon={<Plus />} loading={saving} onClick={save}>Save</Button>
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Spinner } from './Spinner'
import './Button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon (lucide element). Replaced by a spinner while loading. */
  icon?: ReactNode
  /** Trailing icon. */
  iconRight?: ReactNode
  /** Shows a spinner, sets aria-busy and blocks clicks (the label stays, so the width doesn't jump). */
  loading?: boolean
  /** Full width. */
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  disabled,
  className,
  children,
  type = 'button',
  onClick,
  ref,
  ...rest
}: ButtonProps): ReactNode {
  const cls = ['btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', loading && 'is-loading', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 18 : 16} /> : icon ? <span className="btn__icon">{icon}</span> : null}
      {children !== undefined && children !== null && children !== false ? <span className="btn__label">{children}</span> : null}
      {iconRight ? <span className="btn__icon">{iconRight}</span> : null}
    </button>
  )
}
