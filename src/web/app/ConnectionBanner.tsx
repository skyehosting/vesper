/**
 * "Reconnecting…" banner (07 C16). Shown only after the socket has been down for a moment, so a quick blip (server
 * hiccup, laptop wake) doesn't flash it. Polite live region; offers "Retry now".
 *
 * Placement (F57): inside the app shell it is an in-flow strip under the top bar (`<ConnectionBanner inline />` in
 * Shell), so it pushes the page down instead of covering the transcript; on phones it is one line with a short label.
 * Bare pages (setup, Talk mode) have no top bar to sit under and keep the floating pill rendered by App, which steps
 * aside while a shell strip is mounted.
 *
 * Toasts (fix5-ui P03): while the strip or pill shows, it publishes the room it takes under the top bar as `--conn-h`
 * on the root element, and the toast region starts below that, so a toast never covers "Retry now".
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { WifiOff } from 'lucide-react'
import { useStore } from '../lib/store'
import { ws } from '../lib/ws'
import './connectionBanner.css'

const GRACE_MS = 1200

// How many in-flow strips are mounted (0 or 1): the floating pill renders only when there is none.
let inlineHosts = 0
const hostListeners = new Set<() => void>()
const subscribeHosts = (fn: () => void): (() => void) => {
  hostListeners.add(fn)
  return () => hostListeners.delete(fn)
}
const hasInlineHost = (): boolean => inlineHosts > 0
const setHosts = (delta: number): void => {
  inlineHosts += delta
  for (const fn of hostListeners) fn()
}

/**
 * Publish how far the notice reaches below the top bar as `--conn-h` (the strip's height; the pill's height plus its
 * 8 px offset), kept current while it shows (a narrow window can wrap it) and removed when it goes.
 */
function useConnHeight(el: HTMLElement | null, inline: boolean): void {
  useLayoutEffect(() => {
    if (!el) return
    const root = document.documentElement
    const put = (): void => root.style.setProperty('--conn-h', `${Math.ceil(el.getBoundingClientRect().height) + (inline ? 0 : 8)}px`)
    put()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(put)
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.style.removeProperty('--conn-h')
    }
  }, [el, inline])
}

export function ConnectionBanner({ inline = false }: { inline?: boolean }): ReactNode {
  const conn = useStore((s) => s.conn)
  const phase = useStore((s) => s.phase)
  const down = phase === 'ready' && (conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'replaced' || conn.status === 'incompatible')
  const [visible, setVisible] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hosted = useSyncExternalStore(subscribeHosts, hasInlineHost, hasInlineHost)
  const [notice, setNotice] = useState<HTMLDivElement | null>(null)
  useConnHeight(notice, inline)

  useLayoutEffect(() => {
    if (!inline) return
    setHosts(1)
    return () => setHosts(-1)
  }, [inline])

  useEffect(() => {
    if (!down) {
      setVisible(false)
      return
    }
    const h = window.setTimeout(() => setVisible(true), GRACE_MS)
    return () => window.clearTimeout(h)
  }, [down])

  useEffect(() => {
    if (!visible || conn.nextRetryAt === null) return
    const h = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(h)
  }, [visible, conn.nextRetryAt])

  if (!inline && hosted) return null
  const live = inline ? 'conn-strip-live' : 'conn-banner-live'
  if (!visible) return <div className={live} role="status" aria-live="polite" />

  // Long text for wide windows, a short one that fits one line next to the button on phones.
  let long = 'Reconnecting to Vesper…'
  let short = 'Reconnecting…'
  let action: ReactNode = (
    <button type="button" className="conn__action" onClick={() => ws.retryNow()}>
      Retry now
    </button>
  )
  if (conn.status === 'replaced') {
    long = 'Vesper is open in another tab or window.'
    short = 'Open in another tab.'
    action = (
      <button type="button" className="conn__action" onClick={() => location.reload()}>
        Use here
      </button>
    )
  } else if (conn.status === 'incompatible') {
    long = 'Vesper was updated. Reload to continue.'
    short = 'Vesper was updated.'
    action = (
      <button type="button" className="conn__action" onClick={() => location.reload()}>
        Reload
      </button>
    )
  } else if (conn.nextRetryAt !== null) {
    const secs = Math.max(0, Math.ceil((conn.nextRetryAt - now) / 1000))
    if (secs > 1) {
      long = `Connection lost. Reconnecting in ${secs} s…`
      short = `Reconnecting in ${secs} s…`
    }
  }

  return (
    <div className={live} role="status" aria-live="polite">
      <div ref={setNotice} className={inline ? 'conn-strip' : 'conn-banner'} data-testid="connection-banner">
        <WifiOff aria-hidden="true" />
        <span className="conn__text" title={long}>
          <span className="conn__long">{long}</span>
          <span className="conn__short">{short}</span>
        </span>
        {action}
      </div>
    </div>
  )
}
