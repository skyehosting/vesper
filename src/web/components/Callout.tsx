/**
 * Callout (04: info / warn / privacy) — an inline note inside a page or form: privacy disclosures (R21, 07 B13 —
 * "what leaves this PC", with a "Learn more" link to the verified source), warnings, tips. Banner — the same tones as
 * a full-width strip for app-level conditions (offline, key rejected, disk full, Funnel is public), optionally
 * dismissible.
 *
 *   <Callout tone="privacy" title="What Voyage receives" learnMore={{ href: src, label: 'Voyage terms' }}>…</Callout>
 *   <Banner tone="danger" actions={<Button size="sm">Fix in Settings</Button>}>The AI service rejected the API key.</Banner>
 */
import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, ExternalLink, Info, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { cx } from './internal/cx'
import './Callout.css'

export type CalloutTone = 'info' | 'warning' | 'privacy' | 'danger' | 'success'

const ICONS: Record<CalloutTone, ReactNode> = {
  info: <Info />,
  warning: <TriangleAlert />,
  privacy: <ShieldCheck />,
  danger: <CircleAlert />,
  success: <CircleCheck />
}

export interface LearnMore {
  label?: string
  /** External http(s) link (opened in the system browser on desktop). */
  href?: string
  onClick?: () => void
}

/** External links open through the desktop bridge (validated in main, 07 B8/B11), else a new tab. */
function openLink(e: { preventDefault(): void }, href: string): void {
  const bridge = window.vesperDesktop?.openExternal
  if (bridge && /^https?:\/\//i.test(href)) {
    e.preventDefault()
    void bridge(href)
  }
}

function LearnMoreLink({ l }: { l: LearnMore }): ReactNode {
  const label = l.label ?? 'Learn more'
  if (l.href) {
    return (
      <a className="callout__link" href={l.href} target="_blank" rel="noreferrer noopener" onClick={(e) => (l.onClick ? (e.preventDefault(), l.onClick()) : openLink(e, l.href!))}>
        {label}
        <ExternalLink aria-hidden="true" />
        <span className="sr-only"> (opens in your browser)</span>
      </a>
    )
  }
  return (
    <button type="button" className="callout__link" onClick={l.onClick}>
      {label}
    </button>
  )
}

export interface CalloutProps {
  tone?: CalloutTone
  title?: ReactNode
  children?: ReactNode
  icon?: ReactNode | false
  learnMore?: LearnMore
  actions?: ReactNode
  onDismiss?: () => void
  className?: string
}

export function Callout({ tone = 'info', title, children, icon, learnMore, actions, onDismiss, className }: CalloutProps): ReactNode {
  return (
    <div className={cx('callout', `callout--${tone}`, className)} role={tone === 'danger' ? 'alert' : 'note'}>
      {icon !== false ? (
        <span className="callout__icon" aria-hidden="true">
          {icon ?? ICONS[tone]}
        </span>
      ) : null}
      <div className="callout__body">
        {title ? <p className="callout__title">{title}</p> : null}
        {children ? <div className="callout__text">{children}</div> : null}
        {learnMore || actions ? (
          <div className="callout__foot">
            {learnMore ? <LearnMoreLink l={learnMore} /> : null}
            {actions}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" className="callout__close" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      ) : null}
    </div>
  )
}

export interface BannerProps {
  tone?: Exclude<CalloutTone, 'privacy'> | 'accent'
  children: ReactNode
  icon?: ReactNode | false
  actions?: ReactNode
  onDismiss?: () => void
  /** Announce politely (status) rather than as an alert. */
  polite?: boolean
  className?: string
}

export function Banner({ tone = 'info', children, icon, actions, onDismiss, polite, className }: BannerProps): ReactNode {
  const ic = tone === 'accent' ? <Info /> : ICONS[tone]
  return (
    <div className={cx('banner', `banner--${tone}`, className)} role={polite || tone === 'info' || tone === 'success' || tone === 'accent' ? 'status' : 'alert'}>
      {icon !== false ? (
        <span className="banner__icon" aria-hidden="true">
          {icon ?? ic}
        </span>
      ) : null}
      <div className="banner__text">{children}</div>
      {actions ? <div className="banner__actions">{actions}</div> : null}
      {onDismiss ? (
        <button type="button" className="banner__close" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      ) : null}
    </div>
  )
}
