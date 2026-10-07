/** Pinned facts, "About you" (07 A4): CRUD for the memory viewer and `/remember`. Delivery to the AI is the engine's. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { memoryOf } from '../memory'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const body = z.object({ text: z.string().max(2000) })
const idParams = z.object({ id: z.coerce.number().int().positive() })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const facts = () => memoryOf(ctx).facts
  route(app, 'GET /api/facts', () => facts().list())
  route(app, 'POST /api/facts', (req) => facts().create(parse(body, req.body).text))
  route(app, 'PATCH /api/facts/:id', (req) => facts().update(parse(idParams, req.params).id, parse(body, req.body).text))
  route(app, 'DELETE /api/facts/:id', (req) => {
    facts().delete(parse(idParams, req.params).id)
  })
}
