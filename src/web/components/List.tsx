/**
 * List / ListItem — rows with a leading icon or avatar, title, description, meta and trailing actions (devices,
 * sessions in a picker, models, backups, pinned facts). A row with `onClick` (or `href`) makes its main area one
 * button/link, and actions stay separate buttons beside it (never nested interactive elements). Actions show on hover
 * or focus with a mouse, and always on touch.
 *
 *   <List aria-label="Devices">
 *     <ListItem icon={<Smartphone/>} title="Pixel 9" description="LAN · last seen 2 min ago" actions={<Button size="sm">Revoke</Button>} />
 *   </List>
 */
import type { ReactNode } from 'react'
import { cx } from './internal/cx'
import './List.css'

export interface ListProps {
  children: ReactNode
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Hairlines between rows. */
  dividers?: boolean
  /** Card-like container with an outer border. */
  inset?: boolean
  className?: string
}

export function List({ children, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, dividers = false, inset = false, className }: ListProps): ReactNode {
  return (
    <ul className={cx('list', dividers && 'list--dividers', inset && 'list--inset', className)} aria-label={ariaLabel} aria-labelledby={labelledBy}>
      {children}
    </ul>
  )
}

export interface ListItemProps {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  /** Always show actions (not only on hover). */
  actionsVisible?: boolean
  onClick?: () => void
  href?: string
  selected?: boolean
  disabled?: boolean
  className?: string
}

export function ListItem({ title, description, icon, meta, actions, actionsVisible = false, onClick, href, selected, disabled, className }: ListItemProps): ReactNode {
  const body = (
    <>
      {icon ? (
        <span className="list-item__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="list-item__text">
        <span className="list-item__title">{title}</span>
        {description ? <span className="list-item__desc">{description}</span> : null}
      </span>
      {meta ? <span className="list-item__meta">{meta}</span> : null}
    </>
  )
  return (
    <li className={cx('list-item', (onClick || href) && 'list-item--interactive', selected && 'is-selected', disabled && 'is-disabled', actionsVisible && 'list-item--actions-visible', className)}>
      {href ? (
        <a className="list-item__main" href={href} aria-current={selected ? 'page' : undefined}>
          {body}
        </a>
      ) : onClick ? (
        <button type="button" className="list-item__main" onClick={onClick} disabled={disabled} aria-pressed={selected}>
          {body}
        </button>
      ) : (
        <div className="list-item__main">{body}</div>
      )}
      {actions ? <div className="list-item__actions">{actions}</div> : null}
    </li>
  )
}
