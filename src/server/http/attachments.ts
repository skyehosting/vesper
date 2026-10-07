/**
 * Attachments (03 §3, 07 B5/B6/C8). POST is multipart: field "file" (+ optional "thumb", "meta" JSON {name, width,
 * height}); `?temporary=1` keeps the file out of SQLite and the roaming profile (temporary chats, 07 B9).
 *
 * Serving untrusted bytes (07 B5): inline ONLY for png/jpeg/gif/webp/avif and client-made thumbnails, with their
 * sniffed type; everything else (svg, html, pdf, docx, text, …) is `application/octet-stream` +
 * `Content-Disposition: attachment`. Always nosniff, `CSP: default-src 'none'; sandbox`, CORP same-origin and
 * `Cache-Control: private, no-store`.
 */
import fs from 'node:fs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { EndpointKey } from '@shared/api'
import { contentOf } from '../attachments'
import { SHA_RE, THUMB_LIMITS, type ServeInfo } from '../attachments/store'
import { receiveUpload } from '../attachments/upload'
import { temporaryChatsOf } from '../chat/temporary'
import type { ServerContext } from '../services'
import { ENDPOINT_AUTH } from './endpoints'
import { parse, route, who } from './route'

const shaParams = z.object({ sha: z.string().regex(SHA_RE, 'Not an attachment id') })
const getQuery = z.object({ thumb: z.enum(['1']).optional(), download: z.enum(['1']).optional() })
const postQuery = z.object({ temporary: z.enum(['1']).optional() })

/** RFC 5987 file name: CR/LF/quotes stripped, then percent-encoded; plus an ASCII fallback for old clients. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const safe = name.replace(/[\r\n"\\]/g, '').trim() || 'file'
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * A contract route whose handler streams its own reply (files): `route()` answers 204 when a handler returns nothing,
 * which would race a stream that is still being written. The auth level still comes from ENDPOINT_AUTH (07 B2).
 */
export function streamRoute(app: FastifyInstance, key: EndpointKey, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> | FastifyReply): void {
  const [method, url] = key.split(' ') as ['GET' | 'POST', string]
  app.route({ method, url, config: { auth: ENDPOINT_AUTH[key] }, handler })
}

function serve(reply: FastifyReply, info: ServeInfo, forceDownload: boolean): FastifyReply {
  const inline = info.inline && !forceDownload
  reply
    .header('content-type', inline ? info.mime : 'application/octet-stream')
    .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', info.name))
    .header('content-length', String(info.size))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('cache-control', 'private, no-store')
  return reply.send(fs.createReadStream(info.path))
}

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  // Encapsulated in this module's scope (07 E1): limits are per request below.
  await app.register(multipart, { throwFileSizeLimit: true, limits: { files: 2, fields: 5, fieldSize: 64 * 1024, parts: 8 } })
  const content = contentOf(ctx)

  route(app, 'POST /api/attachments', async (req) => {
    const q = parse(postQuery, req.query)
    const temporary = q.temporary === '1'
    const maxFileBytes = ctx.settings.get().chat.attachments.maxFileMb * 1024 * 1024
    const up = await receiveUpload(req, { tempPath: () => content.store.tempPath(temporary), maxFileBytes, maxThumbBytes: THUMB_LIMITS.maxBytes })
    const ref = await content.store.ingest({
      file: up.file.path,
      sha: up.file.sha,
      size: up.file.size,
      name: up.meta.name ?? up.file.filename,
      thumb: up.thumb ? { file: up.thumb.path, size: up.thumb.size } : null,
      temporary
    })
    // Unsent temporary uploads are swept when their device's temporary chat ends or after an idle time (Phase 4).
    if (temporary) temporaryChatsOf(ctx).noteUpload(ref.sha, who(req).deviceId, ctx.clock.now())
    return ref
  })

  streamRoute(app, 'GET /api/attachments/:sha', (req, reply) => {
    const { sha } = parse(shaParams, req.params)
    const q = parse(getQuery, req.query)
    const info = content.store.serveInfo(sha, { thumb: q.thumb === '1' })
    if (!info) throw new VesperError('not_found')
    return serve(reply, info, q.download === '1')
  })

  route(app, 'GET /api/attachments/:sha/text', (req, reply) => {
    const { sha } = parse(shaParams, req.params)
    if (!content.store.get(sha)) throw new VesperError('not_found')
    const t = content.store.text(sha)
    if (!t) throw new VesperError('not_found', { message: 'This file has no extracted text.' })
    reply.header('cache-control', 'no-store')
    return { text: t.text, chars: t.chars, truncated: t.truncated }
  })
}
