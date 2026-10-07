/**
 * Auth routes (03 §3, 07 B2/B15/B16). Session core: src/server/auth/core.ts; password, lockout, sudo, pairing and
 * devices: src/server/auth/service.ts through `accessOf(ctx)` (this module is registered once per listener).
 * Responses never contain codes' hashes, tokens or the password hash; failures use the shared error catalogue.
 */
import { isIP } from 'node:net'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthState } from '@shared/api'
import { VesperError } from '@shared/errors'
import type { Listener } from '@shared/types/domain'
import { absoluteLimit, clearedCookie, sessionCookie } from '../auth/core'
import type { Caller } from '../auth/service'
import { coreOf } from '../core'
import { qrSvg } from '../net/addresses'
import { accessOf } from '../net'
import type { ServerContext } from '../services'
import { parse, route, who } from './route'

/** Which listener a request arrived on: each listener is its own Fastify instance with its own node server. */
export function listenerOf(ctx: ServerContext, req: FastifyRequest): Listener {
  const srv = req.server.server
  const l = coreOf(ctx).listeners.all().find((x) => x.server === srv)
  if (!l) throw new VesperError('forbidden')
  return l.name
}

/**
 * The client address for per-IP lockout buckets and the audit log (07 B15). X-Forwarded-For is trusted ONLY on
 * Listener C, which binds 127.0.0.1 and is reached only through `tailscale serve` (07 B3), and only from a loopback
 * peer: the proxy APPENDS the real tailnet address, so the LAST entry is the one it vouches for (anything before it
 * came from the client and may be forged). Elsewhere the header is ignored. Added by platform-int (access gap).
 */
export function clientIp(listener: Listener, remote: string | null, xff: string | string[] | undefined): string | null {
  if (listener !== 'tailnet' || !remote || !isLoopback(remote) || xff === undefined) return remote
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  const last = raw.split(',').map((x) => x.trim()).filter(Boolean).pop()
  if (!last || last.length > 64) return remote
  // "[v6]:port" / "v4:port" forms are not sent by Serve, but strip them defensively.
  const host = last.startsWith('[') ? last.slice(1, last.indexOf(']')) : /^\d+\.\d+\.\d+\.\d+:\d+$/.test(last) ? last.slice(0, last.lastIndexOf(':')) : last
  return isIP(host) ? host : remote
}

function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, '')
  return v === '::1' || /^127\./.test(v)
}

export function callerOf(ctx: ServerContext, req: FastifyRequest): Caller {
  const listener = listenerOf(ctx, req)
  const ua = req.headers['user-agent']
  const tsUser = req.headers['tailscale-user-login']
  return {
    listener,
    ip: clientIp(listener, req.socket.remoteAddress ?? null, req.headers['x-forwarded-for']),
    userAgent: typeof ua === 'string' ? ua : null,
    // Tailscale Serve adds this; any local process could forge it, so it is display/audit data only (research 06 §3.3).
    proxyUser: listener === 'tailnet' && typeof tsUser === 'string' ? tsUser : null
  }
}

const loginBody = z.object({ password: z.string().max(4096), deviceName: z.string().max(200).optional().default('') })
const sudoBody = z.object({ password: z.string().max(4096) })
const passwordBody = z.object({ current: z.string().max(4096).optional(), next: z.string().max(8192) })
const pairBody = z.object({ target: z.enum(['local', 'lan', 'tailnet']).optional() })
const redeemBody = z.object({ code: z.string().max(128), deviceName: z.string().max(200).optional().default('') })
const idParams = z.object({ id: z.string().min(1).max(64) })
const approveBody = z.object({ allow: z.boolean() })
const logQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const core = coreOf(ctx)
  const access = () => accessOf(ctx)

  route(app, 'GET /api/auth/state', (req, reply): AuthState => {
    reply.header('cache-control', 'no-store')
    // Pending devices nobody approved expire here too, so a waiting phone learns it was not let in.
    access().auth.sweepPending()
    const me = req.vesper && ctx.repos.devices.byId(req.vesper.deviceId)?.revokedUtc === null ? req.vesper : null
    return { ...core.auth.state(), signedIn: !!me && !me.pending, pendingApproval: !!me?.pending }
  })

  route(app, 'POST /api/auth/login', async (req, reply) => {
    const b = parse(loginBody, req.body)
    const w = callerOf(ctx, req)
    const r = await access().auth.login(b.password, b.deviceName, w, req.vesper)
    reply.header('set-cookie', sessionCookie(r.token, true, absoluteLimit(w))).header('cache-control', 'no-store')
    return { deviceId: r.deviceId }
  })

  route(app, 'POST /api/auth/logout', (req, reply) => {
    const me = who(req)
    core.auth.revoke(me.deviceId)
    ctx.repos.authLog.add({ now: ctx.clock.now(), event: 'logout', ip: callerOf(ctx, req).ip, detail: me.deviceId })
    ctx.hub.broadcast({ t: 'devices.changed' })
    reply.header('set-cookie', clearedCookie())
  })

  route(app, 'POST /api/auth/sudo', async (req) => {
    const b = parse(sudoBody, req.body)
    return { untilUtc: await access().auth.sudo(who(req), b.password, callerOf(ctx, req)) }
  })

  route(app, 'POST /api/auth/password', async (req) => {
    const b = parse(passwordBody, req.body)
    await access().auth.setPassword(who(req), b, callerOf(ctx, req))
  })

  route(app, 'GET /api/auth/devices', (req, reply) => {
    reply.header('cache-control', 'no-store')
    return access().auth.devices(who(req))
  })

  route(app, 'DELETE /api/auth/devices/:id', (req) => {
    const { id } = parse(idParams, req.params)
    access().auth.revokeDevice(id, who(req), callerOf(ctx, req))
  })

  route(app, 'POST /api/auth/devices/:id/approve', (req) => {
    const { id } = parse(idParams, req.params)
    access().auth.approve(id, parse(approveBody, req.body).allow)
  })

  route(app, 'GET /api/auth/log', (req, reply) => {
    reply.header('cache-control', 'no-store')
    return access().auth.log(parse(logQuery, req.query).limit ?? 100)
  })

  route(app, 'POST /api/auth/pair', async (req, reply) => {
    const b = parse(pairBody, req.body ?? {})
    const { net, auth } = access()
    const target = b.target ?? net.defaultPairTarget()
    // Check the way in first: a code for a listener that isn't running would be useless.
    const base = net.pairBase(target)
    const { code, expiresUtc } = auth.createPairing(target)
    const url = `${base}${code}`
    reply.header('cache-control', 'no-store')
    return { code, url, qrSvg: await qrSvg(url), expiresUtc, target }
  })

  route(app, 'POST /api/auth/pair/redeem', (req, reply) => {
    const b = parse(redeemBody, req.body)
    const w = callerOf(ctx, req)
    // F12: the caller's current session (a browser clicking "Open in browser" again) is replaced, not piled up.
    const r = access().auth.redeemPairing(b.code, b.deviceName, w, req.vesper)
    reply.header('set-cookie', sessionCookie(r.token, true, absoluteLimit(w))).header('cache-control', 'no-store')
    return { deviceId: r.deviceId, pending: r.pending }
  })
}
