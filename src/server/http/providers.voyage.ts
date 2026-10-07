/**
 * POST /api/providers/voyage/test (desktop only, 07 B2): the wizard / Settings "Test" — a real 1-input embed at 256
 * dims (research 02 §5.8), 10 s timeout, mapped outcome. Uses the typed key, else the saved one.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { baseUrlProblem } from '@shared/settings'
import type { ServerContext } from '../services'
import { parse, route } from './route'

const body = z.object({
  key: z.string().max(400).optional(),
  baseUrl: z.string().max(200).optional(),
  model: z.string().max(80).optional()
})

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'POST /api/providers/voyage/test', async (req, reply) => {
    const b = parse(body, req.body)
    if (b.baseUrl) {
      const problem = baseUrlProblem(b.baseUrl)
      if (problem) throw new VesperError('validation', { fields: { baseUrl: problem } })
    }
    const tester = ctx.services.testers.voyage
    if (!tester) throw new VesperError('not_implemented')
    // The client went away before we answered: stop the upstream call too.
    const ctl = new AbortController()
    const onClose = () => {
      if (!reply.raw.writableFinished) ctl.abort()
    }
    reply.raw.once('close', onClose)
    try {
      return await tester.test(b, ctl.signal)
    } finally {
      reply.raw.off('close', onClose)
    }
  })
}
