/**
 * GET /api/search (03 §3): the UI's search box. Keyword (FTS5, newest first with a cursor, or bm25 relevance) works
 * whether or not memory is on; `mode=semantic` adds the vector leg when Voyage is configured. Off-path hits are
 * included and marked (`onPath: false` → "earlier version", 07 C3); deleted and hidden messages never appear.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { memoryOf } from '../memory'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const query = z.object({
  q: z.string().trim().min(1).max(500),
  scope: z.enum(['all', 'session']).default('all'),
  session: z.string().min(1).max(64).optional(),
  mode: z.enum(['keyword', 'semantic']).default('keyword'),
  order: z.enum(['relevance', 'recent']).default('recent'),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Phase 4 (additive): role and time-window filters, applied on the server before paging.
  role: z.enum(['user', 'assistant']).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional()
})

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/search', (req) => memoryOf(ctx).uiSearch(parse(query, req.query)))
}
