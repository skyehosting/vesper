/**
 * A small history-based router. The route table is app/routes.ts; matching is router.logic.ts.
 * `navigate()` works from anywhere (commands, WS handlers); components read the location with `useLocation()`.
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { isAppPath, splitPath } from './router.logic'

export interface AppLocation {
  pathname: string
  search: string
  /** pathname + search */
  path: string
}

const listeners = new Set<() => void>()
let snapshot = read()

function read(): AppLocation {
  return { pathname: location.pathname, search: location.search, path: location.pathname + location.search }
}

function notify(): void {
  const next = read()
  if (next.path === snapshot.path) return
  snapshot = next
  for (const l of [...listeners]) l()
}

window.addEventListener('popstate', notify)

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function getLocation(): AppLocation {
  return snapshot
}

export function useLocation(): AppLocation {
  return useSyncExternalStore(subscribe, getLocation, getLocation)
}

/** Go to an in-app path. `replace` for redirects so Back doesn't bounce. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (!isAppPath(to)) throw new Error(`navigate: not an app path: ${to}`)
  const { pathname, search, hash } = splitPath(to)
  const target = pathname + search + hash
  if (target === location.pathname + location.search + location.hash) return
  if (opts.replace) history.replaceState(null, '', target)
  else history.pushState(null, '', target)
  notify()
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  replace?: boolean
  children?: ReactNode
}

/** An anchor that navigates in-app on a plain left click and behaves like a link otherwise (new tab, copy link). */
export function Link({ to, replace, onClick, children, ...rest }: LinkProps): ReactNode {
  const handle = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to, { replace })
  }
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
