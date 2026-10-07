/**
 * Voice setup endpoints (voice-out-server, 07 C22): the voices dropdown, a same-origin preview proxy (the client never
 * sees provider URLs or keys), and a short sample for the settings page / wizard. Audio is sent as bytes with its real
 * type; a request the client abandons aborts the provider call.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import { TTS_PROVIDERS } from '@shared/settings'
import type { ServerContext } from '../services'
import { speechOf } from '../speech'
import { parse, route } from './route'

const voicesQuery = z.object({ provider: z.enum(TTS_PROVIDERS).optional(), refresh: z.enum(['1', '0', 'true', 'false']).optional() })
const previewParams = z.object({ provider: z.enum(TTS_PROVIDERS), voiceId: z.string().min(1).max(200) })
const sampleBody = z.object({
  provider: z.enum(TTS_PROVIDERS).optional(),
  voiceId: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(1000)
})

/** An AbortSignal that fires when the client goes away before the answer is sent. */
export function abortOnClose(reply: FastifyReply): { signal: AbortSignal; done(): void } {
  const ac = new AbortController()
  const onClose = () => {
    if (!reply.raw.writableFinished) ac.abort()
  }
  reply.raw.on('close', onClose)
  return { signal: ac.signal, done: () => void reply.raw.off('close', onClose) }
}

function service(ctx: ServerContext) {
  const s = speechOf(ctx)
  if (!s) throw new VesperError('not_implemented')
  return s
}

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/tts/voices', async (req) => {
    const q = parse(voicesQuery, req.query)
    const provider = q.provider ?? ctx.settings.get().voice.tts.provider
    return service(ctx).voices(provider, q.refresh === '1' || q.refresh === 'true')
  })

  route(app, 'GET /api/tts/preview/:provider/:voiceId', async (req, reply) => {
    const p = parse(previewParams, req.params)
    const a = abortOnClose(reply)
    try {
      const out = await service(ctx).preview(p.provider, p.voiceId, a.signal)
      reply
        .header('content-type', out.mime)
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(out.audio.buffer, out.audio.byteOffset, out.audio.byteLength))
    } finally {
      a.done()
    }
  })

  route(app, 'POST /api/tts/sample', async (req, reply) => {
    const b = parse(sampleBody, req.body)
    const a = abortOnClose(reply)
    try {
      const out = await service(ctx).sample(b, a.signal)
      reply
        .header('content-type', out.mime)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(out.audio.buffer, out.audio.byteOffset, out.audio.byteLength))
    } finally {
      a.done()
    }
  })
}
