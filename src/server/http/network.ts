/**
 * Network & access routes (03 §3, 07 B2/B3/B14, E8): status for every device, changes on the desktop only. The work
 * happens in src/server/net/manager.ts through `accessOf(ctx)` (this module is registered once per listener).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { accessOf } from '../net'
import type { ServerContext } from '../services'
import { parse, route, who } from './route'

const port = z.number().int().min(1024).max(65535)
const putBody = z
  .object({
    mode: z.enum(['local', 'lan', 'tailscale']).optional(),
    port: port.optional(),
    lanAddress: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'An IPv4 address')
      .nullable()
      .optional(),
    lanPort: port.optional(),
    tailnetPort: port.optional(),
    funnel: z.boolean().optional(),
    funnelAutoOffHours: z.number().int().min(0).max(168).optional(),
    keepRemoteWhileClosed: z.boolean().optional(),
    paused: z.boolean().optional(),
    resumeRemoteLogin: z.boolean().optional()
  })
  .strict()
const firewallBody = z.object({ publicToo: z.boolean().optional() })
const serveBody = z.object({ on: z.boolean(), funnel: z.boolean().optional() })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const net = () => accessOf(ctx).net

  route(app, 'GET /api/network', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return net().refresh(false)
  })

  route(app, 'PUT /api/network', async (req) => net().update(parse(putBody, req.body), who(req).deviceId))

  route(app, 'POST /api/network/firewall/allow', async (req) => net().allowFirewall(!!parse(firewallBody, req.body ?? {}).publicToo))

  route(app, 'POST /api/network/tailscale/serve', async (req) => {
    const b = parse(serveBody, req.body)
    return net().setTailscale(b.on, !!b.funnel, who(req).deviceId)
  })
}
