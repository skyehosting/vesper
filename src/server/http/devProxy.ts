/**
 * Dev topology (07 E3, BLD-3): the window always loads the loopback server, so cookie/Origin/CSRF behave as in
 * production; in dev every non-/api, non-/ws request and the Vite HMR socket are forwarded to the Vite dev server.
 * A deliberately small proxy on node:http / node:net (no new dependency).
 */
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization'])

export interface DevProxy {
  http(req: FastifyRequest, reply: FastifyReply): void
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void
}

export function createDevProxy(target: string): DevProxy {
  const t = new URL(target)
  const port = Number(t.port || (t.protocol === 'https:' ? 443 : 80))
  const host = t.hostname.replace(/^\[|\]$/g, '')

  return {
    http(req, reply) {
      reply.hijack()
      const headers: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(req.raw.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v
      headers.host = t.host
      const up = http.request({ host, port, method: req.raw.method, path: req.raw.url, headers }, (res) => {
        const out: http.OutgoingHttpHeaders = {}
        for (const [k, v] of Object.entries(res.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v
        // Helmet set the security headers (dev CSP) in onRequest; a hijacked reply would drop them, so copy them over.
        for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined && !(k in out)) out[k] = v as string
        reply.raw.writeHead(res.statusCode ?? 502, out)
        res.pipe(reply.raw)
      })
      up.on('error', () => {
        if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/plain' })
        reply.raw.end('Vite dev server is not reachable')
      })
      up.end() // GET/HEAD only: the body (if any) was already consumed by Fastify
    },
    upgrade(req, socket, head) {
      const up = net.connect(port, host, () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]
          lines.push(k.toLowerCase() === 'host' ? `Host: ${t.host}` : `${k}: ${req.rawHeaders[i + 1]}`)
        }
        up.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) up.write(head)
        socket.pipe(up)
        up.pipe(socket)
      })
      const end = () => {
        socket.destroy()
        up.destroy()
      }
      up.on('error', end)
      socket.on('error', end)
      socket.on('close', () => up.destroy())
      up.on('close', () => socket.destroy())
    }
  }
}
