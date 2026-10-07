/**
 * Kbd — a keyboard shortcut as key caps. `keys="Mod+Shift+K"` renders Ctrl Shift K on Windows and ⌘ ⇧ K on Apple
 * devices, with a spoken label ("Control Shift K") for screen readers; children render a single literal key.
 *
 *   <Kbd keys="Mod+K" />   <Kbd>Esc</Kbd>
 */
import type { ReactNode } from 'react'
import { cx } from './internal/cx'
import { detectPlatform, parseShortcut, spokenShortcut } from './internal/kbd.logic'
import './Kbd.css'

export interface KbdProps {
  keys?: string
  children?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

const platform = typeof navigator === 'undefined' ? 'other' : detectPlatform()

export function Kbd({ keys, children, size = 'sm', className }: KbdProps): ReactNode {
  if (keys === undefined) return <kbd className={cx('kbd', `kbd--${size}`, className)}>{children}</kbd>
  const parts = parseShortcut(keys, platform)
  return (
    <kbd className={cx('kbd-combo', className)}>
      <span className="sr-only">{spokenShortcut(parts)}</span>
      {parts.map((k, i) => (
        <kbd key={i} className={cx('kbd', `kbd--${size}`)} aria-hidden="true">
          {k}
        </kbd>
      ))}
    </kbd>
  )
}
