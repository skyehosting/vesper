/**
 * System routes (07 D2, platform-int): resource use for Settings → Performance/About, "Unload voice models now", and
 * opening one of a FIXED set of local folders in Explorer (desktop only — the path is never taken from the client), and
 * the updater (H-v12-updates): every device may read its state; checking, downloading and restarting are desktop-only.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { systemOf } from '../system'
import { updateStatus } from '../system/updates'
import { parse, route } from './route'

const openBody = z.object({ which: z.enum(['roaming', 'local', 'backups', 'exports', 'data', 'logs', 'models']) }).strict()

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const system = () => {
    const s = systemOf(ctx)
    if (!s) throw new VesperError('not_implemented')
    return s
  }

  route(app, 'GET /api/system/resources', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return system().resources()
  })

  route(app, 'POST /api/system/unload-voice', () => system().unloadVoice({ onlyIdle: false }))

  const updater = () => {
    const u = ctx.platform.updater
    if (!u) throw new VesperError('not_implemented', { message: 'Updates come to the installed Vesper app on your PC.' })
    return u
  }

  route(app, 'GET /api/system/update', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return updateStatus(ctx)
  })

  // Without an updater, Check now just answers 'unsupported' (nothing to check with).
  route(app, 'POST /api/system/update/check', async () => (ctx.platform.updater ? ctx.platform.updater.check() : updateStatus(ctx)))

  route(app, 'POST /api/system/update/download', () => updater().download())

  route(app, 'POST /api/system/update/restart', async () => {
    if (!updater().restart()) throw new VesperError('conflict', { message: 'No update is ready to install yet.' })
  })

  route(app, 'POST /api/system/open-folder', async (req) => {
    // Without a desktop shell (standalone server) there is nothing to open: say so before validating.
    if (!ctx.platform.openPath) throw new VesperError('not_implemented', { message: 'Opening folders needs the Vesper app on your PC.' })
    const { which } = parse(openBody, req.body)
    await system().openFolder(which)
  })
}
