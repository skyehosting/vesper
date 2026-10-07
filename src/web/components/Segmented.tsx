/**
 * Segmented control — 2–5 short, mutually exclusive options in one pill (theme: Dark · Light · System; Star style).
 * Native radios underneath (arrows move and select); a thumb slides to the chosen segment.
 *
 *   <Segmented aria-label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark', icon: <Moon/> }, …]} />
 */
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { cx } from './internal/cx'
import { track } from './internal/stats'
import './Segmented.css'

export interface SegmentedOption<V extends string = string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  /** Accessible name when the label is only an icon. */
  'aria-label'?: string
  disabled?: boolean
}

export interface SegmentedProps<V extends string = string> {
  value: V
  onChange: (value: V) => void
  options: readonly SegmentedOption<V>[]
  'aria-label'?: string
  /** Id of a visible label element. */
  'aria-labelledby'?: string
  size?: 'sm' | 'md'
  /** Stretch to the container width (segments share it equally). */
  block?: boolean
  disabled?: boolean
  name?: string
  className?: string
}

export function Segmented<V extends string = string>({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  size = 'md',
  block = false,
  disabled = false,
  name,
  className
}: SegmentedProps<V>): ReactNode {
  const auto = useId()
  const groupName = name ?? `sg${auto}`
  const rootRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)

  // The thumb follows the checked segment's box (labels differ in width; fonts load late).
  useLayoutEffect(() => {
    const root = rootRef.current
    const thumb = thumbRef.current
    if (!root || !thumb) return
    const place = (): void => {
      const seg = root.querySelector<HTMLElement>('.segmented__item.is-checked')
      if (!seg) {
        thumb.style.opacity = '0'
        return
      }
      thumb.style.opacity = '1'
      thumb.style.width = `${seg.offsetWidth}px`
      thumb.style.transform = `translateX(${seg.offsetLeft}px)`
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(root)
    track('kit.observers', 1)
    return () => {
      ro.disconnect()
      track('kit.observers', -1)
    }
  }, [value, options])

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className={cx('segmented', size === 'sm' && 'segmented--sm', block && 'segmented--block', disabled && 'is-disabled', className)}
    >
      <span ref={thumbRef} className="segmented__thumb" aria-hidden="true" />
      {options.map((o) => {
        const checked = o.value === value
        return (
          <label key={o.value} className={cx('segmented__item', checked && 'is-checked', (o.disabled || disabled) && 'is-disabled')}>
            <input
              type="radio"
              className="segmented__input"
              name={groupName}
              value={o.value}
              checked={checked}
              disabled={o.disabled || disabled}
              aria-label={o['aria-label']}
              onChange={() => onChange(o.value)}
            />
            {o.icon ? (
              <span className="segmented__icon" aria-hidden="true">
                {o.icon}
              </span>
            ) : null}
            {o.label !== '' && o.label !== null ? <span className="segmented__label">{o.label}</span> : null}
          </label>
        )
      })}
    </div>
  )
}
