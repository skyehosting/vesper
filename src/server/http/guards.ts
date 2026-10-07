/**
 * Request guards (07 B2/B3/B15, research 06 §5.3), installed on every listener before any route:
 * 1. Host allow-list per listener (DNS rebinding) → 421; a *.ts.net Host on Listener A → 421 (07 B3).
 * 2. Mutating requests: exact Origin match, Sec-Fetch-Site same-origin/none, header `x-vesper: 1` → else 403.
 *    API reads refuse cross-site Fetch Metadata too. No CORS headers are ever sent.
 * 3. Authorization: ONE hook reads the route's `config.auth`; registering a route without it throws (onRoute).
 *    Pending devices (07 B16) get nothing but the public routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { apiError, type ApiError } from '@shared/errors'
import { CSRF_HEADER, type AuthLevel } from '@shared/api'
import type { Listener } from '@shared/types/domain'
import type { AuthCore } from '../auth/core'

const LEVELS: readonly AuthLevel[] = ['public', 'device', 'sudo', 'desktop']
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** What the guards know about a listener; hosts/origins are filled once the port is bound. */
export interface ListenerGuardState {
  name: Listener
  hosts: Set<string>
  origins: Set<string>
}

export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')
}

function deny(reply: FastifyReply, status: number, error: ApiError): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ error })
}

/** Host header check shared with the WebSocket upgrade. Returns an HTTP status to refuse with, or null. */
export function hostProblem(l: ListenerGuardState, hostHeader: string | undefined): number | null {
  const host = (hostHeader ?? '').toLowerCase()
  if (!host) return 421
  if (l.name === 'loopback' && /\.ts\.net(:\d+)?$/.test(host)) return 421
  return l.hosts.has(host) ? null : 421
}

/** Origin check shared with the WebSocket upgrade: present and exactly one of this listener's origins. */
export function originOk(l: ListenerGuardState, origin: string | undefined): boolean {
  return !!origin && l.origins.has(origin.toLowerCase())
}

/**
 * Is this request an API call (07 B15: API reads refuse cross-site Fetch Metadata)? Decided from what the router
 * matched and from the DECODED path, never from the raw URL alone: find-my-way decodes `/%61pi/sessions` to
 * `/api/sessions` before matching (F05). A path that cannot be decoded counts as API (refused rather than guessed).
 */
export function isApiRequest(rawUrl: string, routeUrl: string | undefined): boolean {
  const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/')
  if (routeUrl !== undefined && isApiPath(routeUrl)) return true
  const raw = rawUrl.split('?')[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return true
  }
  return isApiPath(raw) || isApiPath(decoded.toLowerCase())
}

export function installGuards(app: FastifyInstance, l: ListenerGuardState, auth: AuthCore): void {
  app.decorateRequest('vesper', null)

  app.addHook('onRoute', (opts) => {
    const level = opts.config?.auth
    if (!level || !LEVELS.includes(level)) throw new Error(`Route ${String(opts.method)} ${opts.url} must declare config.auth (07 B2)`)
  })

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (hostProblem(l, req.headers.host) !== null) return deny(reply, 421, apiError('forbidden', { message: 'Misdirected request.' }))

    const config = req.routeOptions.config ?? {}
    // A safe-method read of anything that needs a session is treated like an API read too (defence in depth, F05).
    const isApi = isApiRequest(req.url, req.routeOptions.url) || (config.auth !== undefined && config.auth !== 'public')
    const sfs = req.headers['sec-fetch-site']

    if (config.guard === 'test') {
      // /api/test/* exists only in test builds with VESPER_TEST=1; reachable from this machine only.
      if (l.name !== 'loopback' || !isLoopbackAddress(req.socket.remoteAddress)) return deny(reply, 403, apiError('forbidden'))
    } else if (!SAFE_METHODS.has(req.method)) {
      if (!originOk(l, req.headers.origin)) return deny(reply, 403, apiError('forbidden', { message: 'Cross-origin request refused.' }))
      if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return deny(reply, 403, apiError('forbidden', { message: 'Cross-site request refused.' }))
      if (req.headers[CSRF_HEADER] !== '1') return deny(reply, 403, apiError('forbidden', { message: 'Missing request header.' }))
    } else if (isApi && sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') {
      return deny(reply, 403, apiError('forbidden', { message: 'Cross-site request refused.' }))
    }

    req.vesper = auth.resolve(req.headers.cookie, l.name, req.socket.remoteAddress ?? null)
    const level: AuthLevel = config.auth ?? 'public'
    if (level === 'public') return
    const who = req.vesper
    if (!who) return deny(reply, 401, apiError('unauthorized'))
    if (who.pending) return deny(reply, 403, apiError('forbidden', { message: 'This device is waiting for approval on your PC.' }))
    if (level === 'desktop' && !who.isDesktop) return deny(reply, 403, apiError('desktop_only'))
    if (level === 'sudo' && !who.sudo) return deny(reply, 403, apiError('sudo_required'))
  })
}
