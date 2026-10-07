/**
 * stt.* client messages, binary kind 2 (mic PCM) and ctx.services.stt (07 E1, C17). Owned by voice-in-server.
 * Everything a mic session sends back is targeted at the one client (client.send), never a session event.
 */
import { VesperError } from '@shared/errors'
import { BIN_KIND } from '@shared/ws'
import { createStt } from '../../providers/stt'
import type { ServerContext } from '../../services'

export function register(ctx: ServerContext): void {
  const svc = createStt(ctx)
  ctx.hub.on('stt.', async (client, msg) => {
    switch (msg.t) {
      case 'stt.start':
        try {
          await svc.start(client, msg)
        } catch (e) {
          client.send({ t: 'stt.state', state: 'error', error: ctx.toApiError(e) })
          throw e // the hub answers {t:'error', id} for the request
        }
        ctx.hub.ack(client, msg)
        return
      case 'stt.tts-active':
        return svc.ttsActive(client, msg.active)
      case 'stt.stop':
        return svc.stop(client, msg.reason)
      case 'stt.cancel':
        return svc.cancel(client)
      case 'stt.prewarm':
        // Best effort: a missing model or key surfaces at stt.start, where the client shows it.
        return void svc.prewarm().catch((e: unknown) => ctx.log.child('stt').debug('prewarm skipped', { code: ctx.toApiError(e).code }))
      default:
        throw new VesperError('not_implemented')
    }
  })
  ctx.hub.onBinary(BIN_KIND.micPcm, (client, _header, payload) => svc.frame(client, payload))
  ctx.hub.onDisconnect((client) => svc.disconnect(client))
}
