/**
 * Skeleton — placeholder shapes while content loads (decorative: `aria-hidden`; put `aria-busy` on the region that
 * is loading). Shimmer stops under reduced motion. Never uses `data-loading`, which the test hooks treat as "app busy".
 *
 *   <Skeleton lines={3} />   <Skeleton variant="circle" width={32} />   <Skeleton variant="rect" height={120} />
 */
import type { CSSProperties, ReactNode } from 'react'
import { cx } from './internal/cx'
import './Skeleton.css'

export interface SkeletonProps {
  variant?: 'text' | 'rect' | 'circle'
  /** Text: number of lines (the last one shorter). */
  lines?: number
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
}

const px = (v: number | string | undefined): string | undefined => (typeof v === 'number' ? `${v}px` : v)

export function Skeleton({ variant = 'text', lines = 1, width, height, radius, className }: SkeletonProps): ReactNode {
  if (variant === 'text') {
    return (
      <span className={cx('skeleton-lines', className)} aria-hidden="true" style={{ width: px(width) }}>
        {Array.from({ length: Math.max(1, lines) }, (_, i) => (
          <span key={i} className="skeleton skeleton--text" style={lines > 1 && i === lines - 1 ? { width: '62%' } : undefined} />
        ))}
      </span>
    )
  }
  const style: CSSProperties = {
    width: px(width ?? (variant === 'circle' ? 32 : '100%')),
    height: px(height ?? (variant === 'circle' ? width ?? 32 : 80)),
    borderRadius: px(radius)
  }
  return <span className={cx('skeleton', `skeleton--${variant}`, className)} aria-hidden="true" style={style} />
}
