/**
 * ProgressBar / ProgressRing (04; model downloads with size + SHA check, indexing, uploads). Determinate when `value`
 * is a number (0–1), indeterminate otherwise. `role="progressbar"` with `aria-valuetext` from `valueText` ("212 MB
 * of 640 MB") so screen readers hear what sighted users read.
 *
 *   <ProgressBar label="Parakeet TDT 0.6B" value={got / total} valueText={`${formatBytes(got)} of ${formatBytes(total)}`} />
 *   <ProgressRing value={0.42} size={28} label="Indexing" />
 */
import type { ReactNode } from 'react'
import { cx } from './internal/cx'
import './Progress.css'

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger'

export interface ProgressBarProps {
  /** 0–1; omit for indeterminate. */
  value?: number
  label?: ReactNode
  /** Accessible name when the label isn't plain text. */
  'aria-label'?: string
  /** Human value ("212 MB of 640 MB · 1.2 MB/s"); default the percentage. */
  valueText?: string
  /** Show the value text on the label row (default true when there is a label). */
  showValue?: boolean
  tone?: ProgressTone
  size?: 'sm' | 'md'
  className?: string
}

const pctOf = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 100)

export function ProgressBar({ value, label, 'aria-label': ariaLabel, valueText, showValue, tone = 'accent', size = 'md', className }: ProgressBarProps): ReactNode {
  const det = typeof value === 'number' && Number.isFinite(value)
  const pct = det ? pctOf(value) : 0
  const text = valueText ?? (det ? `${pct}%` : undefined)
  const show = showValue ?? label !== undefined
  return (
    <div className={cx('progress', `progress--${tone}`, `progress--${size}`, !det && 'is-indeterminate', className)}>
      {label !== undefined || (show && text) ? (
        <div className="progress__head">
          {label !== undefined ? <span className="progress__label">{label}</span> : <span />}
          {show && text ? <span className="progress__value">{text}</span> : null}
        </div>
      ) : null}
      <div
        className="progress__track"
        role="progressbar"
        aria-label={typeof label === 'string' ? label : ariaLabel}
        aria-valuemin={det ? 0 : undefined}
        aria-valuemax={det ? 100 : undefined}
        aria-valuenow={det ? pct : undefined}
        aria-valuetext={text}
      >
        <div className="progress__fill" style={det ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  )
}

export interface ProgressRingProps {
  value?: number
  size?: number
  thickness?: number
  label: string
  valueText?: string
  /** Print the percentage in the middle (needs size ≥ 36). */
  showValue?: boolean
  tone?: ProgressTone
  className?: string
}

export function ProgressRing({ value, size = 28, thickness = 3, label, valueText, showValue = false, tone = 'accent', className }: ProgressRingProps): ReactNode {
  const det = typeof value === 'number' && Number.isFinite(value)
  const pct = det ? pctOf(value) : 25
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      className={cx('progress-ring', `progress--${tone}`, !det && 'is-indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={det ? 0 : undefined}
      aria-valuemax={det ? 100 : undefined}
      aria-valuenow={det ? pct : undefined}
      aria-valuetext={valueText ?? (det ? `${pct}%` : undefined)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="progress-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={thickness} fill="none" />
        <circle
          className="progress-ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={thickness}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(c * pct) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {showValue && det && size >= 36 ? (
        <span className="progress-ring__value" aria-hidden="true">
          {pct}%
        </span>
      ) : null}
    </span>
  )
}
