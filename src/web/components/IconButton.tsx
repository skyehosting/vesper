/**
 * IconButton — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these props.
 *
 *   <IconButton label="New chat" icon={<Plus />} onClick={…} />
 *
 * `label` is required: it is the accessible name and the tooltip text (an icon alone is not a name).
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Spinner } from './Spinner'
import { Tooltip, type TooltipSide } from './Tooltip'
import './IconButton.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string
  icon: ReactNode
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  /** Toggle buttons: sets aria-pressed. */
  pressed?: boolean
  loading?: boolean
  /** Show `label` as a tooltip (default true). */
  tooltip?: boolean
  tooltipSide?: TooltipSide
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  pressed,
  loading = false,
  tooltip = true,
  tooltipSide,
  className,
  type = 'button',
  onClick,
  ref,
  ...rest
}: IconButtonProps): ReactNode {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      className={['icon-btn', `icon-btn--${variant}`, `icon-btn--${size}`, className].filter(Boolean).join(' ')}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : icon}
    </button>
  )
  return tooltip ? (
    <Tooltip content={label} side={tooltipSide} describe={false}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
