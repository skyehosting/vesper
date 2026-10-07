/**
 * LLM provider endpoints (owned by llm-engine, 07 E1/D11): presets for the wizard, the model list of a saved profile,
 * and "Test connection" (desktop only). Errors are mapped to the catalogue; upstream bodies never reach the client.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { PRESETS } from '@shared/presets'
import { PRESET_IDS } from '@shared/settings'
import { adapterFor, resolveProfile } from '../providers/llm/client'
import { mapProviderError } from '../providers/llm/errors'
import type { ServerContext } from '../services'
import { parse, route } from './route'

/** Every provider test answers within 10 s (07 D11). */
export const TEST_TIMEOUT_MS = 10_000

const testBody = z.object({
  profileId: z.string().max(64).optional(),
  preset: z.enum(PRESET_IDS),
  baseUrl: z.string().max(500),
  model: z.string().max(200).optional(),
  key: z.string().max(8192).optional()
})

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fn(ctl.signal)
  } finally {
    clearTimeout(timer)
  }
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/providers/presets', () => PRESETS.map((p) => ({ ...p, auth: { ...p.auth }, defaults: { ...p.defaults } })))

  route(app, 'GET /api/providers/llm/models', async (req) => {
    const { profile: id } = parse(z.object({ profile: z.string().min(1).max(64) }), req.query)
    const profile = ctx.settings.get().llm.profiles.find((p) => p.id === id)
    if (!profile) throw new VesperError('not_found', { message: 'No such AI provider profile.' })
    try {
      const p = await resolveProfile(ctx, profile, { modelOptional: true })
      return await withTimeout(TEST_TIMEOUT_MS, (signal) => adapterFor(p).listModels(signal))
    } catch (e) {
      throw mapProviderError(e)
    }
  })

  route(app, 'POST /api/providers/llm/test', async (req) => {
    const body = parse(testBody, req.body)
    const tester = ctx.services.testers.llm
    if (!tester) throw new VesperError('not_implemented')
    return withTimeout(TEST_TIMEOUT_MS, (signal) => tester.test(body, signal))
  })
}
