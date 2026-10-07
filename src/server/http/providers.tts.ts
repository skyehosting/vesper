/** POST /api/providers/tts/test (desktop, wizard "Test"): voices + models (+ quota) for a key that may be unsaved. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { parse, route } from './route'
import { abortOnClose } from './tts'

const body = z.object({ provider: z.string().min(1).max(40), key: z.string().max(8192).optional(), baseUrl: z.string().max(500).optional() })
/** 07 D11: every wizard Test has a 10 s timeout. */
const TEST_TIMEOUT_MS = 10_000

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'POST /api/providers/tts/test', async (req, reply) => {
    const b = parse(body, req.body)
    const tester = ctx.services.testers.tts
    if (!tester) throw new VesperError('not_implemented')
    const a = abortOnClose(reply)
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    a.signal.addEventListener('abort', onAbort, { once: true })
    const t = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS)
    try {
      return await tester.test(b, ac.signal)
    } finally {
      clearTimeout(t)
      a.signal.removeEventListener('abort', onAbort)
      a.done()
    }
  })
}
