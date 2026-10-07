/**
 * StatusDot — a small state light with a text label (connected devices, services, the tray-style "mic live" dot).
 * The label is always available to screen readers; `showLabel` prints it.
 *
 *   <StatusDot status="online" label="Connected" showLabel />   <StatusDot status="live" label="Microphone on" pulse />
 */
import type { ReactNode } from 'react'
import { cx } from './internal/cx'
import './StatusDot.css'

export type Status = 'online' | 'idle' | 'busy' | 'warning' | 'error' | 'offline' | 'live'

export interface StatusDotProps {
  status: Status
  label: string
  showLabel?: boolean
  /** Gentle pulse (stops under reduced motion). */
  pulse?: boolean
  size?: number
  className?: string
}

export function StatusDot({ status, label, showLabel = false, pulse = false, size = 8, className }: StatusDotProps): ReactNode {
  return (
    <span className={cx('status-dot', `status-dot--${status}`, pulse && 'is-pulsing', className)}>
      <span className="status-dot__light" style={{ width: size, height: size }} aria-hidden="true" />
      {showLabel ? <span className="status-dot__label">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  )
}
