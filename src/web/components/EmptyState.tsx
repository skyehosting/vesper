/**
 * EmptyState (07 D13) — a calm placeholder for "nothing here yet": first run (the Star + suggestion chips), an empty
 * session, a search with no results, memory off. Not an error: use ErrorState for failures.
 *
 *   <EmptyState title="No chats match “tokyo”" description="Try fewer words." icon={<SearchX/>} />
 *   <EmptyState star title="Good evening" suggestions={['Plan my week', …]} onSuggestion={send} />
 */
import type { ReactNode } from 'react'
import { Avatar } from './Avatar'
import { Chip } from './Badge'
import { cx } from './internal/cx'
import './EmptyState.css'

export interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode
  /** A lucide icon in a soft disc. */
  icon?: ReactNode
  /** Show the mini Star instead of an icon (first run, empty chat). */
  star?: boolean
  actions?: ReactNode
  suggestions?: readonly string[]
  onSuggestion?: (text: string) => void
  /** Extra content under the actions (a setup checklist). */
  children?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  headingLevel?: 2 | 3
  className?: string
}

export function EmptyState({ title, description, icon, star = false, actions, suggestions, onSuggestion, children, size = 'md', headingLevel = 2, className }: EmptyStateProps): ReactNode {
  const H = `h${headingLevel}` as 'h2' | 'h3'
  return (
    <div className={cx('empty-state', `empty-state--${size}`, className)}>
      {star ? (
        <Avatar kind="ai" size={size === 'lg' ? 64 : size === 'sm' ? 32 : 48} />
      ) : icon ? (
        <span className="empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <H className="empty-state__title">{title}</H>
      {description ? <p className="empty-state__desc">{description}</p> : null}
      {actions ? <div className="empty-state__actions">{actions}</div> : null}
      {suggestions && suggestions.length > 0 ? (
        <ul className="empty-state__suggestions" aria-label="Suggestions">
          {suggestions.map((s) => (
            <li key={s}>
              <Chip onClick={onSuggestion ? () => onSuggestion(s) : undefined}>{s}</Chip>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  )
}
