/**
 * External links from the access pages (Tailscale download, admin console, "Open in browser"). In the desktop window
 * they go through the preload bridge (main validates the URL, 07 B8/B11); in a browser they open a new tab.
 */
import type { MouseEvent, ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

export function openExternal(url: string): void {
  const bridge = window.vesperDesktop?.openExternal
  if (bridge && /^https?:\/\//i.test(url)) {
    void bridge(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }): ReactNode {
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (!window.vesperDesktop?.openExternal) return
    e.preventDefault()
    openExternal(href)
  }
  return (
    <a className={className ?? 'acc-link'} href={href} target="_blank" rel="noreferrer noopener" onClick={onClick}>
      {children}
      <ExternalLink aria-hidden="true" />
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  )
}
