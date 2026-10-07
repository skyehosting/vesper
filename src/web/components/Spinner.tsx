/**
 * Spinner — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these props.
 *
 * Decorative by default (aria-hidden). Pass `label` when the spinner is the only sign of progress; it then becomes a
 * polite status ("Loading messages").
 */
import type { ReactNode } from 'react'
import './Spinner.css'

export interface SpinnerProps {
  /** Pixel size (default 16). */
  size?: number
  /** Accessible text; omit for a decorative spinner next to visible text. */
  label?: string
  className?: string
}

export function Spinner({ size = 16, label, className }: SpinnerProps): ReactNode {
  return (
    <span
      className={['spinner', className].filter(Boolean).join(' ')}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  )
}
