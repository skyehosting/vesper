/**
 * /api/memory/* (03 §3, 07 C10–C13, B2 auth levels from ENDPOINT_AUTH): status, manual recall, re-index (sudo),
 * backfill consent + estimate (07 C12), the sessions manifest (R7), forgetting one message (07 B9), and deleting the
 * whole memory index (sudo; messages stay). The memory viewer's timeline (R7) is memory/timeline.ts.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { memoryOf } from '../memory'
import { memoryTimeline, TIMELINE_LIMITS } from '../memory/timeline'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const recallBody = z.object({ query: z.string().trim().min(1).max(2000), sessionUid: z.string().min(1).max(64) })
const reindexBody = z.object({ scope: z.enum(['all', 'missing']).default('missing') })
const backfillBody = z.object({ choice: z.enum(['all', 'new', 'sessions']), sessionUids: z.array(z.string().min(1).max(64)).max(10_000).optional() })
const uidParams = z.object({ uid: z.string().min(1).max(64) })
const timelineQuery = z.object({
  session: z.string().min(1).max(64).optional(),
  role: z.enum(['user', 'assistant']).optional(),
  fromUtc: z.coerce.number().int().optional(),
  toUtc: z.coerce.number().int().optional(),
  cursor: z.string().max(48).optional(),
  limit: z.coerce.number().int().min(1).max(TIMELINE_LIMITS.max).optional()
})

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const mem = () => memoryOf(ctx)

  route(app, 'GET /api/memory/status', () => mem().status())

  route(app, 'POST /api/memory/recall', async (req) => {
    const b = parse(recallBody, req.body)
    return mem().manualRecall(b.query, b.sessionUid)
  })

  route(app, 'POST /api/memory/reindex', async (req) => {
    const b = parse(reindexBody, req.body)
    if (!ctx.settings.get().memory.enabled) throw new VesperError('validation', { message: 'Turn memory on first.' })
    return mem().reindex(b.scope)
  })

  route(app, 'GET /api/memory/backfill/estimate', async () => mem().backfillEstimate())

  route(app, 'POST /api/memory/backfill', async (req) => {
    const b = parse(backfillBody, req.body)
    if (!ctx.settings.get().memory.enabled) throw new VesperError('validation', { message: 'Turn memory on first.' })
    return mem().backfill(b.choice, b.sessionUids)
  })

  route(app, 'GET /api/memory/manifest', () => mem().manifest())

  route(app, 'DELETE /api/memory/messages/:uid', (req) => {
    mem().forget(parse(uidParams, req.params).uid)
  })

  // The memory viewer's timeline (memory-ui, Phase 3): keyset pages over the visible on-path messages.
  route(app, 'GET /api/memory/timeline', (req, reply) => {
    reply.header('cache-control', 'no-store')
    return memoryTimeline(ctx.db, ctx.repos, parse(timelineQuery, req.query))
  })

  route(app, 'DELETE /api/memory/index', async () => {
    await mem().deleteIndex()
  })
}
