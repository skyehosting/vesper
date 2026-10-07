/** GET /api/bootstrap: everything the client needs on start (03 §3, 07 B2/C19). Never contains secret material. */
import type { FastifyInstance } from 'fastify'
import type { Bootstrap } from '@shared/api'
import type { MemoryStatus } from '@shared/types/domain'
import { coreOf } from '../core'
import type { ServerContext } from '../services'
import { systemOf } from '../system'
import { testEnv } from '../testMode'
import { route, who } from './route'

export const MEMORY_DISABLED: MemoryStatus = {
  state: 'disabled',
  model: null,
  dim: null,
  indexed: 0,
  queued: 0,
  errors: 0,
  tier: 'unknown',
  queueEtaSec: null
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  const core = coreOf(ctx)
  route(app, 'GET /api/bootstrap', async (req, reply): Promise<Bootstrap> => {
    const me = who(req)
    reply.header('cache-control', 'no-store')
    let memory = MEMORY_DISABLED
    try {
      memory = ctx.services.memory?.status() ?? MEMORY_DISABLED
    } catch (e) {
      ctx.log.warn('memory status failed', { error: e })
    }
    return {
      version: core.version,
      desktop: me.isDesktop,
      device: { id: me.deviceId, kind: me.kind, name: me.name, listener: me.listener, sudo: me.sudo },
      settings: ctx.settings.get(),
      secretsSet: await ctx.secrets.list(),
      secretsInvalid: await ctx.secrets.invalid(),
      network: core.networkStatus(),
      memory,
      portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
      isTest: core.testMode,
      // Test runs are muted by default (07 E10); VESPER_MUTE=0 makes the client audible. Always false in release.
      mute: __VESPER_TEST__ && core.testMode && testEnv('VESPER_MUTE') !== '0',
      gameMode: { ...(systemOf(ctx)?.gameMode.state ?? { active: false, reason: 'off' as const }) },
      // Local paths are shown only on the PC itself (Settings → Data).
      dataPaths: me.isDesktop ? { roaming: ctx.paths.roaming, local: ctx.paths.local } : null,
      // Settings recovered, low disk, a failed backup (fix-platform F59/F66).
      ...(systemOf(ctx) ? { health: systemOf(ctx)!.health.state() } : {})
    }
  })
}
