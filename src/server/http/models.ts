/**
 * Local speech-model management (07 B12; 03 §3): list with state/progress/disk use (device), download and delete
 * (desktop only). A download runs in the background and reports through `stt.model.progress` events; DELETE also
 * cancels a running download. Owned by voice-in-server.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const params = z.object({ id: z.string().min(1).max(80) })

function svcOf(ctx: ServerContext) {
  const svc = ctx.services.stt
  if (!svc) throw new VesperError('stt_unavailable', { status: 503 })
  return svc
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/stt/models', () => svcOf(ctx).models())

  route(app, 'POST /api/stt/models/:id/download', async (req) => {
    const { id } = parse(params, req.params)
    const svc = svcOf(ctx)
    if (!(await svc.models()).some((m) => m.id === id)) throw new VesperError('not_found')
    void svc.download(id).catch(() => undefined) // progress and failures arrive as stt.model.progress
  })

  route(app, 'DELETE /api/stt/models/:id', async (req) => {
    const { id } = parse(params, req.params)
    await svcOf(ctx).remove(id)
  })
}
