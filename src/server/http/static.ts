/**
 * The web client: built files from `webDir` (immutable caching for hashed assets, no-cache for index.html) with an
 * SPA fallback to index.html for HTML navigations outside /api and /ws. In dev (devRendererUrl) the same routes are
 * forwarded to Vite instead. Everything here is `auth: 'public'` (the client itself shows the login screen).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { apiError } from '@shared/errors'
import type { DevProxy } from './devProxy'

/** Vite's hashed output (`assets/index-AbC123xy.js`) never changes for a given name. */
const HASHED = /(^|\/)assets\/.+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i

function notFound(reply: FastifyReply) {
  return reply.code(404).header('cache-control', 'no-store').send({ error: apiError('not_found') })
}

function isReserved(p: string): boolean {
  return p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/')
}

export async function registerWebClient(app: FastifyInstance, o: { webDir: string; dev: DevProxy | null }): Promise<void> {
  if (o.dev) {
    const dev = o.dev
    app.route({
      method: 'GET',
      url: '/*',
      config: { auth: 'public' },
      handler: (req, reply) => {
        if (isReserved(req.url.split('?')[0])) return notFound(reply)
        dev.http(req, reply)
        return reply
      }
    })
    return
  }

  const root = path.resolve(o.webDir)
  await app.register(fastifyStatic, { root, serve: false, decorateReply: true })
  const indexFile = path.join(root, 'index.html')

  const sendIndex = (reply: FastifyReply) => {
    if (!fs.existsSync(indexFile)) return reply.code(404).type('text/plain').send('The Vesper web client is not built (out/web).')
    reply.header('cache-control', 'no-cache')
    return reply.sendFile('index.html', root, { cacheControl: false })
  }

  app.route({
    method: 'GET',
    url: '/*',
    config: { auth: 'public' },
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      const urlPath = req.url.split('?')[0]
      if (isReserved(urlPath)) return notFound(reply)
      let rel: string
      try {
        rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
      } catch {
        return notFound(reply)
      }
      const abs = path.resolve(root, rel)
      const inside = abs === root || abs.startsWith(root + path.sep)
      if (inside && rel && !rel.split(/[\\/]/).some((s) => s.startsWith('.'))) {
        let st: fs.Stats | null = null
        try {
          st = fs.statSync(abs)
        } catch {
          st = null
        }
        if (st?.isFile()) {
          const relPosix = path.relative(root, abs).split(path.sep).join('/')
          if (relPosix === 'index.html') return sendIndex(reply)
          reply.header('cache-control', HASHED.test(relPosix) ? 'public, max-age=31536000, immutable' : 'no-cache')
          return reply.sendFile(relPosix, root, { cacheControl: false })
        }
      }
      const accept = String(req.headers.accept ?? '')
      if (accept.includes('text/html')) return sendIndex(reply)
      return notFound(reply)
    }
  })
}
