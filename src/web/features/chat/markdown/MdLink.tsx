/**
 * Links and remote images in rendered replies (07 B8). External links open through the desktop bridge (main
 * re-validates the scheme) or a new tab with noopener/noreferrer; links whose text names something else show the real
 * host; risky destinations ask first. Remote images are never loaded (the CSP forbids it anyway): a chip offers to
 * open them in the browser instead.
 */
import { useState, type MouseEvent, type ReactNode } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'
import { Button } from '../../../components/Button'
import { Popover } from '../../../components/Popover'
import { navigate } from '../../../lib/router'
import { useStore } from '../../../lib/store'
import { displayHost, isLocalImageSrc, linkInfo, parseUrl, remoteImageRisk } from './links.logic'

/** Open an external http(s)/mailto URL outside the app. */
export function openExternal(url: string): void {
  const bridge = window.vesperDesktop?.openExternal
  if (bridge) void bridge(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

export function MdLink({ href = '', children }: { href?: string; children?: ReactNode }): ReactNode {
  const [confirm, setConfirm] = useState(false)
  const info = linkInfo(href, textOf(children))

  if (info.kind === 'invalid') return <span className="md-link md-link--dead">{children}</span>
  if (info.kind === 'anchor') return <a href={href}>{children}</a>
  if (info.kind === 'app') {
    return (
      <a
        href={href}
        className="md-link"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
          e.preventDefault()
          navigate(href)
        }}
      >
        {children}
      </a>
    )
  }

  const open = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.button !== 0) return
    if (info.risky) {
      e.preventDefault()
      setConfirm(true)
      return
    }
    if (window.vesperDesktop?.openExternal) {
      e.preventDefault()
      openExternal(href)
    }
  }
  // Middle-click fires auxclick, not click, and would open a new tab (Electron: setWindowOpenHandler → system browser)
  // with no confirm (F13). A risky link asks first for every button; preventing mousedown also stops autoscroll.
  const aux = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (!info.risky || e.button !== 1) return
    e.preventDefault()
    setConfirm(true)
  }
  const anchor = (
    <a
      href={href}
      className="md-link"
      target="_blank"
      rel="noopener noreferrer"
      onClick={open}
      onAuxClick={aux}
      onMouseDown={(e) => {
        if (info.risky && e.button === 1) e.preventDefault()
      }}
    >
      {children}
      {info.showHost && info.host ? (
        <span className="md-link__host" data-reveal-skip="">
          {' '}
          ({info.host})
        </span>
      ) : null}
    </a>
  )
  if (!info.risky) return anchor
  return (
    <Popover trigger={anchor} open={confirm} onOpenChange={setConfirm} title="Open this link?" width={300} placement="top-start">
      {(close) => (
        <div className="md-confirm" data-reveal-skip="">
          <p className="md-confirm__text">{info.risky}</p>
          <p className="md-confirm__url mono">{href.length > 160 ? `${href.slice(0, 160)}…` : href}</p>
          <div className="md-confirm__actions">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ExternalLink />}
              onClick={() => {
                close()
                openExternal(href)
              }}
            >
              Open
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}

export function MdImage({ src = '', alt = '' }: { src?: string; alt?: string }): ReactNode {
  const policy = useStore((s) => s.settings?.chat.loadRemoteImages ?? 'ask')
  const [confirm, setConfirm] = useState(false)
  if (isLocalImageSrc(src)) return <img className="md-img" src={src} alt={alt} loading="lazy" decoding="async" />
  const u = parseUrl(src)
  // A refused URL (javascript:, data:text/html, …) leaves only its alt text.
  if (!u) return alt ? <span className="md-img-alt">[{alt}]</span> : null
  const host = displayHost(u)
  const label = alt ? `“${alt}” from ${host}` : `Image from ${host}`
  if (policy === 'never') {
    return (
      <span className="md-remote-img" data-reveal-skip="">
        <ImageOff aria-hidden="true" />
        {label} (not shown)
      </span>
    )
  }
  const risk = remoteImageRisk(src)
  const chip = (
    <button type="button" className="md-remote-img md-remote-img--button" data-reveal-skip="" onClick={() => setConfirm(true)}>
      <ImageOff aria-hidden="true" />
      {label}
    </button>
  )
  return (
    <Popover trigger={chip} open={confirm} onOpenChange={setConfirm} title={`Open image from ${host}?`} width={300} placement="top-start">
      {(close) => (
        <div className="md-confirm" data-reveal-skip="">
          <p className="md-confirm__text">Vesper doesn't load images from other sites inside the chat: the site would learn you read this. You can open it in your browser.</p>
          {risk ? (
            <>
              <p className="md-confirm__text">{risk}</p>
              <p className="md-confirm__url mono">{src.length > 160 ? `${src.slice(0, 160)}…` : src}</p>
            </>
          ) : null}
          <div className="md-confirm__actions">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ExternalLink />}
              onClick={() => {
                close()
                openExternal(src)
              }}
            >
              Open in browser
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}
