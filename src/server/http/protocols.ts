/**
 * Protocols file (R9, 07 C1/B2): everyone may read it (the panel shows it), only the desktop may change it. Saving
 * never breaks running sessions: their epochs froze the old text; new epochs pick up the new one (Settings offers
 * "Apply to this session now" → POST /api/sessions/:uid/epoch). Warnings never block a save.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { contentOf } from '../attachments'
import { MAX_PROTOCOLS_CHARS, validateProtocols } from '../protocols/protocols'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const putBody = z
  .object({ text: z.string().max(MAX_PROTOCOLS_CHARS).refine((t) => t.trim() !== '', 'The protocols text is empty; use Reset to go back to the default.') })
  .strict()

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const protocols = contentOf(ctx).protocolsStore

  route(app, 'GET /api/protocols', (_req, reply) => {
    reply.header('cache-control', 'no-store')
    const p = protocols.get()
    return { text: p.text, isDefault: p.isDefault, hash: p.hash, warnings: validateProtocols(p.text) }
  })

  route(app, 'PUT /api/protocols', (req) => {
    const { text } = parse(putBody, req.body)
    const p = protocols.put(text)
    ctx.log.info('protocols saved', { hash: p.hash.slice(0, 12), isDefault: p.isDefault })
    return { hash: p.hash, warnings: validateProtocols(p.text) }
  })

  route(app, 'POST /api/protocols/reset', () => {
    const p = protocols.reset()
    ctx.log.info('protocols reset to the default')
    return { hash: p.hash }
  })
}
