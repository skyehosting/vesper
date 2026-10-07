/**
 * Page building blocks for the memory, privacy, prompts and data pages (04: calm settings layout — a page header,
 * groups with a heading and a quiet card of rows, hairlines between rows). Persistent surfaces are opaque `--bg-2`
 * (07 D10: no glass here). Every row that edits a setting carries `data-setting="<path>"` so the settings-coverage
 * test (07 D12) can find its control.
 */
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from '../../lib/router'
import { cx } from './cx'
import './layout.css'

export function Page({
  title,
  description,
  actions,
  children,
  className,
  wide = false,
  headingLevel = 2
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  wide?: boolean
  headingLevel?: 1 | 2
}): ReactNode {
  const H = `h${headingLevel}` as 'h1' | 'h2'
  return (
    <div className={cx('mp', wide && 'mp--wide', className)}>
      {/* The actions share the title's row, so the intro below always gets the full measure (fix5-ui P15). */}
      <header className="mp__head">
        <div className="mp__titles">
          <H className="mp__title">{title}</H>
          {actions ? <div className="mp__actions">{actions}</div> : null}
        </div>
        {description ? <p className="mp__desc">{description}</p> : null}
      </header>
      {children}
    </div>
  )
}

/**
 * A group: the same section header as Settings' SettingsGroup everywhere (fix5-ui P09: one title size, no icon, the
 * muted line under it) over a card of rows.
 */
export function Group({
  title,
  description,
  actions,
  children,
  id,
  flush = false,
  className
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  id?: string
  flush?: boolean
  className?: string
}): ReactNode {
  const hid = id ? `${id}-title` : undefined
  return (
    <section className={cx('mg', className)} aria-labelledby={hid} id={id}>
      <header className="mg__head">
        <div className="mg__titles">
          <h3 className="mg__title" id={hid}>
            {title}
          </h3>
          {description ? <p className="mg__desc">{description}</p> : null}
        </div>
        {actions ? <div className="mg__actions">{actions}</div> : null}
      </header>
      <div className={cx('mg__card', flush && 'mg__card--flush')}>{children}</div>
    </section>
  )
}

/** One row: text on the left, the control on the right (stacked on phones); `children` render full-width below. */
export function Row({
  label,
  description,
  control,
  children,
  setting,
  htmlFor,
  className,
  stack = false
}: {
  label?: ReactNode
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
  setting?: string
  htmlFor?: string
  className?: string
  stack?: boolean
}): ReactNode {
  return (
    <div className={cx('mr', stack && 'mr--stack', className)} data-setting={setting}>
      {label !== undefined || control !== undefined ? (
        <div className="mr__main">
          {label !== undefined ? (
            <div className="mr__text">
              {htmlFor ? (
                <label className="mr__label" htmlFor={htmlFor}>
                  {label}
                </label>
              ) : (
                <div className="mr__label">{label}</div>
              )}
              {description ? <div className="mr__desc">{description}</div> : null}
            </div>
          ) : null}
          {control !== undefined ? <div className="mr__control">{control}</div> : null}
        </div>
      ) : null}
      {children !== undefined && children !== null && children !== false ? <div className="mr__extra">{children}</div> : null}
    </div>
  )
}

/** A navigation row to another page ("Open the memory viewer"). */
export function LinkRow({
  to,
  icon,
  title,
  description,
  meta
}: {
  to: string
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
}): ReactNode {
  return (
    <Link to={to} className="mlink">
      {icon ? (
        <span className="mlink__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="mlink__text">
        <span className="mlink__title">{title}</span>
        {description ? <span className="mlink__desc">{description}</span> : null}
      </span>
      {meta ? <span className="mlink__meta">{meta}</span> : null}
      <ChevronRight className="mlink__chev" aria-hidden="true" />
    </Link>
  )
}

/** Small numbers in a row ("Indexed 12,034 · Waiting 0 · Errors 0"). */
export function Stats({
  items,
  label
}: {
  items: { label: ReactNode; value: ReactNode; tone?: 'warning' | 'danger' | 'success'; hint?: string }[]
  label: string
}): ReactNode {
  return (
    <dl className="mstats" aria-label={label}>
      {items.map((it, i) => (
        <div key={i} className={cx('mstats__item', it.tone && `mstats__item--${it.tone}`)} title={it.hint}>
          <dt className="mstats__label">{it.label}</dt>
          <dd className="mstats__value tabular">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** "Change these in the Vesper app on your PC" — remote clients see desktop-only settings read-only (07 B2). */
export function DesktopOnlyNote({ children }: { children?: ReactNode }): ReactNode {
  return <p className="mnote">{children ?? 'These settings can only be changed in the Vesper app on your PC.'}</p>
}
