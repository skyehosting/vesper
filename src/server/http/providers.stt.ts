/**
 * POST /api/providers/stt/test (desktop; wizard step 5 and Settings → Voice in). `{provider, key?, model?}` → a
 * ProviderTestResult; a key given here is used for this one test and never stored. 10 s limit (07 D11).
 * Owned by voice-in-server.
 */
import type { FastifyInstance } from 'fastify'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { route } from './route'

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'POST /api/providers/stt/test', async (req) => {
    const tester = ctx.services.testers.stt
    if (!tester) throw new VesperError('stt_unavailable', { status: 503 })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      return await tester.test((req.body ?? {}) as Record<string, unknown>, ctrl.signal)
    } finally {
      clearTimeout(timer)
    }
  })
}
