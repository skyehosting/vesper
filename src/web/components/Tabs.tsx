/**
 * Tabs (APG tabs): a `tablist` with roving tabindex — Tab enters at the selected tab, ←/→ (and Home/End) move between
 * tabs and select them (automatic activation; pass `activation="manual"` to select with Enter/Space instead). Panels
 * are rendered for items that carry `content`; otherwise render your own with `tabPanelProps(idBase, value)`.
 *
 *   <Tabs aria-label="Memory" value={tab} onChange={setTab} items={[
 *     { value: 'facts', label: 'About you', content: <Facts/> }, { value: 'sessions', label: 'Sessions', content: … }]} />
 */
import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './internal/cx'
import { nextIndex } from './internal/roving.logic'
import { track } from './internal/stats'
import './Tabs.css'

export interface TabItem<V extends string = string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  /** A count or badge after the label. */
  badge?: ReactNode
  disabled?: boolean
  content?: ReactNode
}

export interface TabsProps<V extends string = string> {
  value: V
  onChange: (value: V) => void
  items: readonly TabItem<V>[]
  'aria-label'?: string
  'aria-labelledby'?: string
  variant?: 'line' | 'pill'
  activation?: 'automatic' | 'manual'
  /** Stable id prefix (for linking your own panels); generated when omitted. */
  idBase?: string
  /** Keep inactive panels mounted (hidden) to preserve their state. */
  keepMounted?: boolean
  className?: string
  panelClassName?: string
}

export function tabIds(idBase: string, value: string): { tab: string; panel: string } {
  return { tab: `${idBase}-tab-${value}`, panel: `${idBase}-panel-${value}` }
}

/** Props for a panel you render yourself. */
export function tabPanelProps(idBase: string, value: string): { id: string; role: 'tabpanel'; 'aria-labelledby': string; tabIndex: 0 } {
  const ids = tabIds(idBase, value)
  return { id: ids.panel, role: 'tabpanel', 'aria-labelledby': ids.tab, tabIndex: 0 }
}

export function Tabs<V extends string = string>({
  value,
  onChange,
  items,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  variant = 'line',
  activation = 'automatic',
  idBase,
  keepMounted = false,
  className,
  panelClassName
}: TabsProps<V>): ReactNode {
  const auto = useId()
  const base = idBase ?? `tabs${auto.replace(/:/g, '')}`
  const listRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLSpanElement>(null)
  const hasPanels = items.some((i) => i.content !== undefined)

  // The indicator glides to the selected tab.
  useLayoutEffect(() => {
    const list = listRef.current
    const ind = indRef.current
    if (!list || !ind) return
    const place = (): void => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (!tab) {
        ind.style.opacity = '0'
        return
      }
      ind.style.opacity = '1'
      ind.style.width = `${tab.offsetWidth}px`
      ind.style.transform = `translateX(${tab.offsetLeft}px)`
      if (variant === 'pill') ind.style.height = `${tab.offsetHeight}px`
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(list)
    track('kit.observers', 1)
    return () => {
      ro.disconnect()
      track('kit.observers', -1)
    }
  }, [value, items, variant])

  const focusTab = (i: number): void => {
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    const current = tabs.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    if (activation === 'manual' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      const it = items[current]
      if (it && !it.disabled) onChange(it.value)
      return
    }
    const next = nextIndex(current, e.key, items.length, { orientation: 'horizontal', loop: true, isDisabled: (i) => !!items[i]?.disabled })
    if (next === null || next === current) return
    e.preventDefault()
    focusTab(next)
    if (activation === 'automatic') onChange(items[next].value)
  }

  return (
    <div className={cx('tabs', `tabs--${variant}`, className)}>
      <div ref={listRef} role="tablist" aria-label={ariaLabel} aria-labelledby={labelledBy} className="tabs__list" onKeyDown={onKeyDown}>
        <span ref={indRef} className="tabs__indicator" aria-hidden="true" />
        {items.map((it) => {
          const selected = it.value === value
          const ids = tabIds(base, it.value)
          return (
            <button
              key={it.value}
              id={ids.tab}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={hasPanels ? ids.panel : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={it.disabled}
              className={cx('tabs__tab', selected && 'is-selected')}
              onClick={() => onChange(it.value)}
            >
              {it.icon ? (
                <span className="tabs__icon" aria-hidden="true">
                  {it.icon}
                </span>
              ) : null}
              <span>{it.label}</span>
              {it.badge !== undefined && it.badge !== null ? <span className="tabs__badge">{it.badge}</span> : null}
            </button>
          )
        })}
      </div>
      {hasPanels
        ? items.map((it) => {
            const selected = it.value === value
            if (!selected && !keepMounted) return null
            return (
              <div key={it.value} {...tabPanelProps(base, it.value)} hidden={!selected} className={cx('tabs__panel', panelClassName)}>
                {it.content}
              </div>
            )
          })
        : null}
    </div>
  )
}
