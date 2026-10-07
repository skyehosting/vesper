/**
 * Listeners (02 §5, 07 B3): A = http://127.0.0.1:<port> (always), B = LAN HTTPS and C = tailnet loopback (added by
 * access-server). Every listener is its own Fastify instance built by the same `createApp`, so routes, guards, CSP and
 * the WebSocket endpoint are identical; only the Host/Origin allow-lists and the listener name (which classifies the
 * device) differ.
 */
import type http from 'node:http'
import type https from 'node:https'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { apiError } from '@shared/errors'
import type { Listener } from '@shared/types/domain'
import type { ServerContext } from '../services'
import type { AuthCore } from '../auth/core'
import type { HubImpl } from '../ws/hub'
import { createUpgradeHandler } from '../ws/upgrade'
import { WebSocketServer } from '../ws/wsLib'
import { createDevProxy, type DevProxy } from './devProxy'
import { statusOf, toApiError } from './errors'
import { installGuards, type ListenerGuardState } from './guards'
import { registerRoutes } from './index'
import { registerWebClient } from './static'

export interface ListenerSpec {
  name: Listener
  /** Address to bind (127.0.0.1 for A and C, the chosen LAN address for B). */
  bindHost: string
  /** 0 = random. */
  port: number
  /** On EADDRINUSE/EACCES try port+1 … port+n (07 C19). */
  portRetries?: number
  https?: { key: string | Buffer; cert: string | Buffer }
  /** Accepted Host header values (lower-case host:port) once the port is known. */
  hosts(port: number): string[]
  /** Exact origins accepted for mutating requests and the WebSocket upgrade. */
  origins(port: number): string[]
}

export interface RunningListener {
  name: Listener
  app: FastifyInstance
  server: http.Server | https.Server
  port: number
  url: string
  guard: ListenerGuardState
  close(): Promise<void>
}

export interface ListenerRegistry {
  start(spec: ListenerSpec): Promise<RunningListener>
  stop(name: Listener): Promise<void>
  get(name: Listener): RunningListener | undefined
  all(): RunningListener[]
  closeAll(): Promise<void>
}

export interface AppDeps {
  ctx: ServerContext
  auth: AuthCore
  hub: HubImpl
  webDir: string
  devRendererUrl: string | null
}

/** Listener A's allow-lists (07 B4: vesper.localhost for local browsers). */
export function loopbackSpec(port: number, retries: number): ListenerSpec {
  const names = (p: number) => [`127.0.0.1:${p}`, `localhost:${p}`, `vesper.localhost:${p}`]
  return {
    name: 'loopback',
    bindHost: '127.0.0.1',
    port,
    portRetries: retries,
    hosts: names,
    origins: (p) => names(p).map((h) => `http://${h}`)
  }
}

const PROD_CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
  workerSrc: ["'self'", 'blob:'],
  connectSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  mediaSrc: ["'self'", 'blob:'],
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"]
}

/** Dev (07 E3): React Fast Refresh needs an inline preamble, and Vite's HMR socket is a ws: connection. */
function devCsp(devUrl: string) {
  const u = new URL(devUrl)
  return {
    ...PROD_CSP,
    scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", u.origin],
    connectSrc: ["'self'", 'ws:', u.origin, `ws://${u.host}`]
  }
}

export async function createApp(deps: AppDeps, guard: ListenerGuardState, httpsOpts?: ListenerSpec['https']): Promise<FastifyInstance> {
  const log = deps.ctx.log.child(`http.${guard.name}`)
  const app = (httpsOpts
    ? Fastify({ logger: false, https: { key: httpsOpts.key, cert: httpsOpts.cert }, bodyLimit: 1024 * 1024, return503OnClosing: true })
    : Fastify({ logger: false, bodyLimit: 1024 * 1024, return503OnClosing: true })) as unknown as FastifyInstance

  // Security headers first, so even refusals from the guards carry them.
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: deps.devRendererUrl ? devCsp(deps.devRendererUrl) : PROD_CSP },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // Never HSTS on IPs, loopback or the self-signed LAN origin (research 06 §5.8).
    strictTransportSecurity: false,
    xFrameOptions: { action: 'deny' }
  })
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('permissions-policy', 'microphone=(self), camera=(), geolocation=()')
  })
  await app.register(cookie)
  // For access-server's per-route login/pairing limits (`config.rateLimit`); nothing is limited globally.
  await app.register(rateLimit, { global: false })
  installGuards(app, guard, deps.auth)

  app.setErrorHandler((err, req, reply) => {
    const e = toApiError(err)
    const status = statusOf(err, e)
    if (status >= 500) log.error('request failed', { method: req.method, path: req.url.split('?')[0], error: err })
    reply.code(status).header('cache-control', 'no-store').send({ error: e })
  })
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).header('cache-control', 'no-store').send({ error: apiError('not_found') })
  })

  await app.register(async (scope) => registerRoutes(scope, deps.ctx))
  const dev: DevProxy | null = deps.devRendererUrl ? createDevProxy(deps.devRendererUrl) : null
  await registerWebClient(app, { webDir: deps.webDir, dev })
  await app.ready()
  return app
}

/**
 * Ports Chromium (and so Electron and the e2e browsers) refuses to load (net::ERR_UNSAFE_PORT), above 1023. Only
 * matters for port 0 (VESPER_PORT=0 in tests): Windows may hand out e.g. 1720 or 1723 from its dynamic range.
 */
const BROWSER_UNSAFE_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

function listenOnce(server: http.Server | https.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off('listening', onListening)
      reject(e)
    }
    const onListening = () => {
      server.off('error', onError)
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port, exclusive: true })
  })
}

export function createListenerRegistry(deps: AppDeps): ListenerRegistry {
  const running = new Map<Listener, RunningListener>()
  // One WebSocket server for every listener: it only performs handshakes (noServer).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false, clientTracking: false })

  const registry: ListenerRegistry = {
    async start(spec) {
      if (running.has(spec.name)) await registry.stop(spec.name)
      const guard: ListenerGuardState = { name: spec.name, hosts: new Set(), origins: new Set() }
      const app = await createApp(deps, guard, spec.https)
      const server = app.server
      let port = spec.port
      const retries = spec.port === 0 ? 0 : Math.max(0, spec.portRetries ?? 0)
      for (let i = 0; ; i++) {
        try {
          port = await listenOnce(server, spec.bindHost, spec.port === 0 ? 0 : spec.port + i)
          // A port the OS chose may be one browsers refuse to open: take another.
          for (let tries = 0; spec.port === 0 && BROWSER_UNSAFE_PORTS.has(port) && tries < 10; tries++) {
            await new Promise<void>((r) => server.close(() => r()))
            port = await listenOnce(server, spec.bindHost, 0)
          }
          break
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          // Windows reserves port ranges (excluded port ranges answer EACCES), so treat it like "in use".
          if ((code === 'EADDRINUSE' || code === 'EACCES') && i < retries) continue
          await app.close().catch(() => undefined)
          throw e
        }
      }
      for (const h of spec.hosts(port)) guard.hosts.add(h.toLowerCase())
      for (const o of spec.origins(port)) guard.origins.add(o.toLowerCase())
      const dev = deps.devRendererUrl ? createDevProxy(deps.devRendererUrl) : null
      server.on('upgrade', createUpgradeHandler({ guard, auth: deps.auth, hub: deps.hub, wss, dev }))
      const scheme = spec.https ? 'https' : 'http'
      const hostForUrl = spec.bindHost.includes(':') ? `[${spec.bindHost}]` : spec.bindHost
      const l: RunningListener = {
        name: spec.name,
        app,
        server,
        port,
        url: `${scheme}://${hostForUrl}:${port}`,
        guard,
        async close() {
          running.delete(spec.name)
          for (const c of deps.hub.clients()) if (c.listener === spec.name) c.close(1001, 'listener closed')
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000)
            t.unref()
            server.close(() => {
              clearTimeout(t)
              resolve()
            })
            server.closeAllConnections()
          })
          await app.close().catch(() => undefined)
        }
      }
      running.set(spec.name, l)
      return l
    },
    async stop(name) {
      await running.get(name)?.close()
    },
    get: (name) => running.get(name),
    all: () => [...running.values()],
    async closeAll() {
      for (const l of [...running.values()].reverse()) await l.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }
  return registry
}

