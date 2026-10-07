/** GET/PATCH /api/settings (07 B1/B2): see ../settings/rules.ts for who may change what. */
import type { FastifyInstance } from 'fastify'
import { VesperError } from '@shared/errors'
import { migrateSettingsInput, settingsSchema, type DeepPartial, type Settings } from '@shared/settings'
import type { ServerContext } from '../services'
import { assertPatchAllowed, assertUrls, rebindKeys } from '../settings/rules'
import { deepMerge, zodFields } from '../settings/store'
import { route, who } from './route'

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/settings', (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return ctx.settings.get()
  })

  route(app, 'PATCH /api/settings', async (req) => {
    const me = who(req)
    // An older client's `voice.tts.tone` boolean is read as toneMode (H-v11-tone).
    const body = migrateSettingsInput(req.body)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new VesperError('validation', { message: 'Expected a settings object.' })
    const prev = ctx.settings.get()
    assertPatchAllowed(body, { isDesktop: me.isDesktop, settings: prev })
    const candidate = settingsSchema.safeParse(deepMerge(prev, body))
    if (!candidate.success) throw new VesperError('validation', { fields: zodFields(candidate.error.issues) })
    assertUrls(body, candidate.data)
    const next = await ctx.settings.patch(body as DeepPartial<Settings>, { by: me.deviceId })
    const cleared = await rebindKeys(prev, next, ctx.secrets)
    if (cleared.length) ctx.log.info('keys cleared after a base URL change', { names: cleared })
    return next
  })
}
