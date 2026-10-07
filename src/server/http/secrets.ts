/**
 * PUT/DELETE /api/secrets/:name (desktop only, write-only — values are never readable, 07 B1/B2). A key is bound to
 * the origin it is for: `forUrl` from the client, else the configured base URL of that provider.
 * Owners validate keys and react to saves through settings/secretHooks.ts (07 C22), never by editing this route.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { baseUrlProblem, type Settings } from '@shared/settings'
import type { ServerContext } from '../services'
import { secretHooks } from '../settings/secretHooks'
import { SECRET_NAME } from '../settings/secrets'
import { parse, route } from './route'

const FIXED_ORIGINS: Record<string, string> = {
  'tts:elevenlabs': 'https://api.elevenlabs.io',
  'tts:openai': 'https://api.openai.com',
  'stt:openai': 'https://api.openai.com',
  'stt:groq': 'https://api.groq.com',
  'stt:deepgram': 'https://api.deepgram.com',
  'stt:elevenlabs': 'https://api.elevenlabs.io'
}

/** Where a key is used when the client did not say (null = must be given). */
export function defaultUrlFor(name: string, s: Settings): string | null {
  if (FIXED_ORIGINS[name]) return FIXED_ORIGINS[name]
  if (name === 'voyage') return s.memory.voyage.baseUrl
  if (name === 'tts:openai-compatible') return s.voice.tts.baseUrl || null
  const m = /^llm(?:-header)?:(.+)$/.exec(name)
  if (m) return s.llm.profiles.find((p) => p.id === m[1])?.baseUrl || null
  return null
}

const params = z.object({ name: z.string().regex(SECRET_NAME, 'Unknown secret name') })
const body = z.object({ value: z.string().min(1).max(8192), forUrl: z.string().max(500).optional(), check: z.boolean().optional() })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'PUT /api/secrets/:name', async (req) => {
    const { name } = parse(params, req.params)
    const b = parse(body, req.body)
    const url = b.forUrl ?? defaultUrlFor(name, ctx.settings.get())
    if (!url) throw new VesperError('validation', { fields: { forUrl: 'Which address is this key for?' } })
    const problem = baseUrlProblem(url)
    if (problem) throw new VesperError('validation', { fields: { forUrl: problem } })
    const value = b.value.trim()
    const hooks = secretHooks(ctx, name)
    // `check: false`: the caller tests the key itself right away (SecretPut.check), so the save does not.
    if (b.check !== false) for (const h of hooks) await h.validate?.(name, value, url, ctx)
    await ctx.secrets.set(name, value, url)
    for (const h of hooks) await (async () => h.saved?.(name, ctx))().catch((e: unknown) => ctx.log.warn('secret hook failed', { name, error: String(e) }))
    return { ok: true as const }
  })

  route(app, 'DELETE /api/secrets/:name', async (req) => {
    const { name } = parse(params, req.params)
    await ctx.secrets.delete(name)
    for (const h of secretHooks(ctx, name)) await (async () => h.deleted?.(name, ctx))().catch((e: unknown) => ctx.log.warn('secret hook failed', { name, error: String(e) }))
  })
}
