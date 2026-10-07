/**
 * Card — a persistent, opaque surface (07 D10: no glass on persistent surfaces) with an optional header row (icon,
 * title, description, actions) and footer. `interactive` makes the whole card one button (no nested controls then).
 *
 *   <Card title="Voyage AI" description="Memory search" actions={<Switch …/>}>…</Card>
 */
import type { ReactNode } from 'react'
import { cx } from './internal/cx'
import './Card.css'

export interface CardProps {
  title?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  /** Heading level of the title (default 3). */
  headingLevel?: 2 | 3 | 4
  tone?: 'default' | 'muted' | 'accent' | 'danger'
  padding?: 'none' | 'sm' | 'md' | 'lg'
  as?: 'div' | 'section' | 'article' | 'li'
  /** The whole card is a button. */
  onClick?: () => void
  selected?: boolean
  'aria-label'?: string
  className?: string
  'data-testid'?: string
}

export function Card({
  title,
  description,
  icon,
  actions,
  footer,
  children,
  headingLevel = 3,
  tone = 'default',
  padding = 'md',
  as: As = 'div',
  onClick,
  selected,
  'aria-label': ariaLabel,
  className,
  'data-testid': testId
}: CardProps): ReactNode {
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const head =
    title || icon || actions ? (
      <div className="card__head">
        {icon ? (
          <span className="card__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="card__titles">
          {title ? <H className="card__title">{title}</H> : null}
          {description ? <p className="card__desc">{description}</p> : null}
        </div>
        {actions && !onClick ? <div className="card__actions">{actions}</div> : null}
      </div>
    ) : null
  const cls = cx('card', `card--${tone}`, `card--pad-${padding}`, onClick && 'card--interactive', selected && 'is-selected', className)
  if (onClick) {
    return (
      <As className={cls} data-testid={testId}>
        <button type="button" className="card__button" onClick={onClick} aria-label={ariaLabel} aria-pressed={selected}>
          {head}
          {children}
        </button>
      </As>
    )
  }
  return (
    <As className={cls} aria-label={ariaLabel} data-testid={testId}>
      {head}
      {children !== undefined ? <div className="card__body">{children}</div> : null}
      {footer ? <div className="card__footer">{footer}</div> : null}
    </As>
  )
}
