/**
 * A link to an outside page (provider terms, opt-out pages). In the desktop window it opens in the system browser
 * through the preload bridge (main re-validates the scheme, 07 B8/B11); in a browser it opens a new tab. Shows the
 * real host so the owner sees where it goes (07 B8).
 */
import type { MouseEvent, ReactNode } from 'react'
import { ExternalLink as ExternalIcon } from 'lucide-react'
import './privacy.css'

export function hostOf(href: string): string {
  try {
    return new URL(href).host.replace(/^www\./, '')
  } catch {
    return href
  }
}

export function openExternal(href: string): boolean {
  const bridge = window.vesperDesktop?.openExternal
  if (bridge && /^(https?:|mailto:)/i.test(href)) {
    void bridge(href)
    return true
  }
  return false
}

export function ExternalLink({
  href,
  children,
  showHost = false,
  className
}: {
  href: string
  children?: ReactNode
  showHost?: boolean
  className?: string
}): ReactNode {
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (openExternal(href)) e.preventDefault()
  }
  const label = children ?? hostOf(href)
  return (
    <a className={`xlink${className ? ` ${className}` : ''}`} href={href} target="_blank" rel="noreferrer noopener" onClick={onClick}>
      <span className="xlink__text">{label}</span>
      {showHost && children ? <span className="xlink__host">{hostOf(href)}</span> : null}
      <ExternalIcon className="xlink__icon" aria-hidden="true" />
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  )
}

/** Human names for the disclosure source pages. */
export function sourceLabel(href: string): string {
  const h = hostOf(href)
  const path = (() => {
    try {
      return new URL(href).pathname
    } catch {
      return ''
    }
  })()
  if (/terms|tos|legal/i.test(path)) return `${h} terms`
  if (/privacy/i.test(path)) return `${h} privacy policy`
  if (/faq/i.test(path)) return `${h} FAQ`
  return h + (path && path !== '/' ? path.replace(/\/$/, '') : '')
}
