/** POST /api/stt/unload — "Unload voice models now" (07 D2, Settings → About → Resource use). Owned by voice-in-server. */
import type { FastifyInstance } from 'fastify'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { route } from './route'

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'POST /api/stt/unload', async () => {
    const svc = ctx.services.stt
    if (!svc) throw new VesperError('stt_unavailable', { status: 503 })
    await svc.unload()
  })
}
