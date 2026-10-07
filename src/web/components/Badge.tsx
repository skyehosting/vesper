/**
 * Badge — a small static label (status, capability, count): "Vision", "Free", "3". Chip — an interactive pill
 * (attachment, filter, suggestion, session reference) that can be clicked and/or removed.
 *
 *   <Badge tone="accent">New</Badge>   <Badge tone="warning" dot>Indexing</Badge>
 *   <Chip icon={<FileText/>} onRemove={() => drop(a)} removeLabel={`Remove ${a.name}`}>{a.name}</Chip>
 *   <LeavesPcBadge service="Voyage AI" />                                          // 07 B13
 */
import type { ReactNode } from 'react'
import { CloudUpload, X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { cx } from './internal/cx'
import './Badge.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  size?: 'sm' | 'md'
  icon?: ReactNode
  /** A colored dot before the text. */
  dot?: boolean
  /** Solid fill instead of the soft tint. */
  solid?: boolean
  className?: string
  title?: string
}

export function Badge({ children, tone = 'neutral', size = 'sm', icon, dot = false, solid = false, className, title }: BadgeProps): ReactNode {
  return (
    <span className={cx('badge', `badge--${tone}`, `badge--${size}`, solid && 'badge--solid', className)} title={title}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {icon ? (
        <span className="badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  )
}

/** "Leaves this PC" — shown on model/memory/voice chips whose service receives text (07 B13, B18). */
export function LeavesPcBadge({ service, what = 'text' }: { service: string; what?: string }): ReactNode {
  return (
    <Tooltip content={`Your ${what} is sent to ${service}`}>
      <span className="badge badge--warning badge--sm badge--leaves" tabIndex={0} role="note" aria-label={`Leaves this PC: ${what} is sent to ${service}`}>
        <span className="badge__icon" aria-hidden="true">
          <CloudUpload />
        </span>
        Leaves this PC
      </span>
    </Tooltip>
  )
}

export interface ChipProps {
  children: ReactNode
  icon?: ReactNode
  /** Makes the chip a button. */
  onClick?: () => void
  /** Shows a remove (×) button. */
  onRemove?: () => void
  removeLabel?: string
  /** Toggle chips (filters): sets aria-pressed. */
  selected?: boolean
  tone?: 'neutral' | 'accent'
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Full text when the label is truncated. */
  title?: string
  className?: string
}

export function Chip({ children, icon, onClick, onRemove, removeLabel = 'Remove', selected, tone = 'neutral', size = 'md', disabled = false, title, className }: ChipProps): ReactNode {
  const body = (
    <>
      {icon ? (
        <span className="chip__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="chip__label">{children}</span>
    </>
  )
  return (
    <span className={cx('chip', `chip--${tone}`, `chip--${size}`, selected && 'is-selected', disabled && 'is-disabled', onRemove && 'chip--removable', className)} title={title}>
      {onClick ? (
        <button type="button" className="chip__main" onClick={onClick} disabled={disabled} aria-pressed={selected}>
          {body}
        </button>
      ) : (
        <span className="chip__main">{body}</span>
      )}
      {onRemove ? (
        <button type="button" className="chip__remove" aria-label={removeLabel} onClick={onRemove} disabled={disabled}>
          <X />
        </button>
      ) : null}
    </span>
  )
}
