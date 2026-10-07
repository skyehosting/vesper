/**
 * Route pattern matching for the small history router (no library). Patterns: static segments, `:name` params and
 * one optional trailing `:name?` param — enough for '/', '/s/:uid', '/settings/:section?'.
 */

export interface CompiledPattern {
  pattern: string
  regex: RegExp
  keys: string[]
}

export type RouteParams = Record<string, string | undefined>

const cache = new Map<string, CompiledPattern>()

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compilePattern(pattern: string): CompiledPattern {
  const hit = cache.get(pattern)
  if (hit) return hit
  if (!pattern.startsWith('/')) throw new Error(`route pattern must start with '/': ${pattern}`)
  const keys: string[] = []
  let re = ''
  const segments = pattern.split('/').filter(Boolean)
  segments.forEach((seg, i) => {
    const m = /^:([A-Za-z_][A-Za-z0-9_]*)(\?)?$/.exec(seg)
    if (!m) {
      re += `/${escapeRe(seg)}`
      return
    }
    if (m[2] && i !== segments.length - 1) throw new Error(`only the last param may be optional: ${pattern}`)
    keys.push(m[1])
    re += m[2] ? '(?:/([^/]+))?' : '/([^/]+)'
  })
  const compiled = { pattern, regex: new RegExp(`^${re}/?$`), keys }
  cache.set(pattern, compiled)
  return compiled
}

/** Params of `pathname` for `pattern`, or null. Malformed percent-encoding is a non-match, not a crash. */
export function matchPattern(pattern: string, pathname: string): RouteParams | null {
  const c = compilePattern(pattern)
  const m = c.regex.exec(pathname === '' ? '/' : pathname)
  if (!m) return null
  const params: RouteParams = {}
  try {
    c.keys.forEach((k, i) => {
      const raw = m[i + 1]
      params[k] = raw === undefined ? undefined : decodeURIComponent(raw)
    })
  } catch {
    return null
  }
  return params
}

/** First route whose pattern matches (registry order wins). */
export function matchRoute<R extends { path: string }>(routes: readonly R[], pathname: string): { route: R; params: RouteParams } | null {
  for (const route of routes) {
    const params = matchPattern(route.path, pathname)
    if (params) return { route, params }
  }
  return null
}

/** Split "/a/b?x=1#h" into its parts (no URL parser needed; works for app-internal paths only). */
export function splitPath(path: string): { pathname: string; search: string; hash: string } {
  let rest = path
  let hash = ''
  const h = rest.indexOf('#')
  if (h >= 0) {
    hash = rest.slice(h)
    rest = rest.slice(0, h)
  }
  let search = ''
  const q = rest.indexOf('?')
  if (q >= 0) {
    search = rest.slice(q)
    rest = rest.slice(0, q)
  }
  return { pathname: rest || '/', search, hash }
}

/** Only same-app absolute paths may be navigated to programmatically (no "//evil.example", no schemes). */
export function isAppPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}
