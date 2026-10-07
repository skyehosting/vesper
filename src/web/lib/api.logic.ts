/**
 * Pure helpers behind the REST client (web/lib/api.ts): endpoint key parsing, path/query building. Kept free of DOM
 * types so vitest can import them under the node tsconfig.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** 'PATCH /api/sessions/:uid' → {method: 'PATCH', path: '/api/sessions/:uid'} */
export function splitEndpointKey(key: string): { method: HttpMethod; path: string } {
  const i = key.indexOf(' ')
  const method = key.slice(0, i)
  const path = key.slice(i + 1)
  if (i <= 0 || !METHODS.has(method) || !path.startsWith('/')) throw new Error(`bad endpoint key: ${key}`)
  return { method: method as HttpMethod, path }
}

/** Mutating requests carry `X-Vesper: 1` (07 B15): cross-origin pages can't add it without a preflight. */
export function isMutating(method: HttpMethod): boolean {
  return method !== 'GET'
}

/** Substitute `:name` segments. Every value is URI-encoded; a missing param is a programming error. */
export function fillPath(pattern: string, params: Record<string, string | number> | undefined): string {
  return pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = params?.[name]
    if (v === undefined || v === null || v === '') throw new Error(`missing path param "${name}" for ${pattern}`)
    return encodeURIComponent(String(v))
  })
}

/** `?a=1&b=x` from a flat object; undefined/null are skipped, arrays repeat the key, booleans become true/false. */
export function buildQuery(query: object | undefined): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    const values: unknown[] = Array.isArray(v) ? v : [v]
    for (const item of values) {
      if (item === undefined || item === null) continue
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`)
    }
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export function buildUrl(pattern: string, params?: Record<string, string | number>, query?: object): string {
  return fillPath(pattern, params) + buildQuery(query)
}

/** Auth endpoints answer 401 for a wrong password; that must not be treated as "the session expired". */
export function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/api/auth/')
}
