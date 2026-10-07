/**
 * Prompt library (03 §3, R11): named system prompts used by the session panel and `/prompt use|save <name>`. Every
 * change is announced with `prompts.changed` so other devices' panels refresh. Deleting a prompt leaves the sessions
 * that used it with their own copy of the text (only the link to the library entry is cleared).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { parse, route } from './route'

export const PROMPT_LIMITS = { name: 80, body: 100_000 } as const

const name = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim())
  .pipe(z.string().min(1, 'A prompt needs a name').max(PROMPT_LIMITS.name))
const body = z.string().max(PROMPT_LIMITS.body)
const idParams = z.object({ id: z.coerce.number().int().positive() })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const repos = ctx.repos
  const changed = () => ctx.hub.broadcast({ t: 'prompts.changed' })

  route(app, 'GET /api/prompts', (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return repos.prompts.list()
  })

  route(app, 'POST /api/prompts', (req) => {
    const b = parse(z.object({ name, body }).strict(), req.body)
    const p = repos.prompts.create(b.name, b.body, ctx.clock.now())
    changed()
    return p
  })

  route(app, 'PATCH /api/prompts/:id', (req) => {
    const { id } = parse(idParams, req.params)
    const b = parse(z.object({ name: name.optional(), body: body.optional() }).strict(), req.body)
    const p = repos.prompts.update(id, b, ctx.clock.now())
    changed()
    return p
  })

  route(app, 'DELETE /api/prompts/:id', (req) => {
    const { id } = parse(idParams, req.params)
    if (!repos.prompts.list().some((p) => p.id === id)) throw new VesperError('not_found')
    repos.prompts.delete(id)
    const cleared = ctx.db.prepare('UPDATE sessions SET prompt_id = NULL WHERE prompt_id = ?').run(BigInt(id))
    changed()
    if (Number(cleared.changes) > 0) ctx.hub.broadcast({ t: 'sessions.changed' })
  })
}
