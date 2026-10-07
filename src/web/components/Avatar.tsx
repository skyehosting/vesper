/**
 * Avatar — the mini Star for AI messages (04: static SVG/CSS, never a WebGL context — 07 D5) or the user's initials
 * / picture. The newest AI avatar may mirror the Star's state through CSS (`state`), and stays still under reduced
 * motion.
 *
 *   <Avatar kind="ai" state="speaking" />   <Avatar kind="user" name="Skye" />
 */
import { useId, useState, type ReactNode } from 'react'
import { cx } from './internal/cx'
import './Avatar.css'

export type AvatarState = 'idle' | 'thinking' | 'speaking' | 'listening'

export interface AvatarProps {
  kind: 'ai' | 'user'
  /** User: initials come from this; also the accessible name when `label` is not given. */
  name?: string
  /** Picture URL (attachment/blob/data only — remote images are not loaded, 07 B8). */
  src?: string
  size?: number
  state?: AvatarState
  /** Accessible name; omit when the avatar sits next to the visible name (it is then decorative). */
  label?: string
  className?: string
}

export function initialsOf(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ''
  return (first + last).toUpperCase()
}

const SAFE_SRC = /^(blob:|data:image\/|\/api\/attachments\/)/

export function Avatar({ kind, name, src, size = 28, state = 'idle', label, className }: AvatarProps): ReactNode {
  const [broken, setBroken] = useState(false)
  const gid = useId()
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }
  if (kind === 'ai') {
    return (
      <span className={cx('avatar', 'avatar--ai', `is-${state}`, className)} style={style} {...a11y}>
        <svg viewBox="0 0 24 24" width={size} height={size} focusable="false" aria-hidden="true">
          <defs>
            <radialGradient id={`${gid}g`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle className="avatar__glow" cx="12" cy="12" r="11.5" fill={`url(#${gid}g)`} />
          <path className="avatar__star" d="M12 4.2c.45 4.1 2.2 5.85 6.3 6.3v.02c-4.1.45-5.85 2.2-6.3 6.3h-.02c-.45-4.1-2.2-5.85-6.3-6.3v-.02c4.1-.45 5.85-2.2 6.3-6.3z" transform="translate(0 1.15)" fill="var(--accent)" />
        </svg>
      </span>
    )
  }
  return (
    <span className={cx('avatar', 'avatar--user', className)} style={style} {...a11y}>
      {src && SAFE_SRC.test(src) && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <span className="avatar__initials">{initialsOf(name)}</span>}
    </span>
  )
}
