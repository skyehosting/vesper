/**
 * Data (03 §3, 07 B2/B6/C9/C20): export, import, backups. Export/import/backup run as bulk jobs on db.worker
 * (../data/jobs.ts), one at a time; progress goes to the requesting device as `job.progress`.
 *   GET  /api/export?format=md|json[&session=<uid>]  sudo — a download (.md/.json for one session, .zip for all);
 *                                                     the file in exports/ is deleted once sent.
 *   POST /api/import  (multipart "file", ≤ 200 MB)   sudo — Vesper JSON/ZIP, ChatGPT or Claude export.
 *   POST /api/backup · GET /api/backups               sudo
 *   POST /api/backups/restore {file}                  desktop — staged; applied when Vesper restarts.
 *   GET  /api/data/usage                              device — disk use per data folder (memory-ui, Phase 3).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { contentOf } from '../attachments'
import { createJobIO } from '../data/jobs'
import { IMPORT_LIMITS } from '../data/import'
import { createUsageReader } from '../data/usage'
import { receiveUpload } from '../attachments/upload'
import type { ServerContext } from '../services'
import { contentDisposition, streamRoute } from './attachments'
import { parse, route, who } from './route'

const exportQuery = z.object({ format: z.enum(['md', 'json']), session: z.string().min(1).max(64).optional() }).strict()
const restoreBody = z.object({ file: z.string().min(1).max(200) }).strict()

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  await app.register(multipart, { throwFileSizeLimit: true, limits: { files: 1, fields: 5, fieldSize: 64 * 1024, parts: 8 } })
  const content = contentOf(ctx)

  const ioFor = (deviceId: string, job: 'export' | 'import' | 'backup') =>
    createJobIO({
      signal: content.shutdown.signal,
      onProgress: (phase, done, total) => ctx.hub.broadcast({ t: 'job.progress', job, phase, done, total }, { deviceId })
    })

  streamRoute(app, 'GET /api/export', async (req, reply) => {
    const q = parse(exportQuery, req.query)
    const me = who(req)
    const out = await content.lock.run('an export', () => content.jobs.export({ format: q.format, sessionUid: q.session, dir: ctx.paths.exports }, ioFor(me.deviceId, 'export')))
    const stream = fs.createReadStream(out.file)
    // Exports hold every conversation: never leave them lying in exports/ after the download.
    const remove = () => fs.rm(out.file, { force: true }, () => undefined)
    stream.once('close', remove)
    reply
      .header('content-type', out.mime)
      .header('content-disposition', contentDisposition('attachment', out.fileName))
      .header('content-length', String(out.bytes))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
    return reply.send(stream)
  })

  route(app, 'POST /api/import', async (req) => {
    const me = who(req)
    const up = await receiveUpload(req, { tempPath: () => content.store.tempPath(), maxFileBytes: IMPORT_LIMITS.maxUploadBytes, maxThumbBytes: 0 })
    if (up.thumb) fs.rmSync(up.thumb.path, { force: true })
    try {
      const r = await content.lock.run('an import', () => content.jobs.import({ file: up.file.path }, ioFor(me.deviceId, 'import')))
      ctx.log.info('import finished', { ...r })
      if (r.sessions) ctx.hub.broadcast({ t: 'sessions.changed' })
      if (r.source === 'vesper') ctx.hub.broadcast({ t: 'prompts.changed' })
      return r
    } finally {
      fs.rmSync(up.file.path, { force: true })
    }
  })

  route(app, 'POST /api/backup', async () => {
    const b = await content.backup('manual')
    return { file: b.file, bytes: b.bytes }
  })

  route(app, 'GET /api/backups', (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return content.backups.list().map((b) => ({ file: b.file, bytes: b.bytes, createdUtc: b.createdUtc }))
  })

  const usage = createUsageReader(ctx.paths, path.join(ctx.paths.roaming, 'vesper.db'))
  route(app, 'GET /api/data/usage', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return usage()
  })

  route(app, 'POST /api/backups/restore', async (req) => {
    const { file } = parse(restoreBody, req.body)
    await content.lock.run('a restore', () => content.backups.stageRestore(file))
    const restart = ctx.platform.restart
    if (restart) {
      ctx.hub.broadcast({ t: 'toast', tone: 'info', text: 'Restoring the backup — Vesper is restarting.' })
      // After this response has gone out.
      setTimeout(() => restart.call(ctx.platform), 500).unref()
    } else {
      ctx.hub.broadcast({ t: 'toast', tone: 'warning', text: 'The backup will be restored the next time Vesper starts. Restart Vesper now to finish.' })
    }
  })
}
