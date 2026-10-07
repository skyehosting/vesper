/**
 * Route registration helpers. Every route declares `config.auth` (07 B2); `route()` takes it from ENDPOINT_AUTH so a
 * module cannot get it wrong, and the guard's onRoute hook rejects any route registered without one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { AuthLevel, EndpointKey, EndpointRes } from '@shared/api'
import type { RequestAuth } from '../auth/core'
import type { ServerContext } from '../services'
import { ENDPOINT_AUTH } from './endpoints'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Minimum authorization (07 B2). Mandatory on every route. */
    auth?: AuthLevel
    /** 'test': /api/test/* — loopback peers only, no Origin/CSRF checks (test builds + VESPER_TEST=1 only). */
    guard?: 'test'
  }
  interface FastifyRequest {
    /** The device behind the session cookie, when there is a valid one. */
    vesper: RequestAuth | null
  }
}

/** A route module (07 E1): `server/http/index.ts` imports a fixed list of these. */
export interface RouteModule {
  register(app: FastifyInstance, ctx: ServerContext): void | Promise<void>
}

type Handler<K extends EndpointKey> = (req: FastifyRequest, reply: FastifyReply) => Promise<EndpointRes<K>> | EndpointRes<K>

/** Register the handler of a contract endpoint (`'GET /api/sessions'`). `void` results answer 204. */
export function route<K extends EndpointKey>(app: FastifyInstance, key: K, handler: Handler<K>, extra: { bodyLimit?: number } = {}): void {
  const [method, url] = key.split(' ') as [string, string]
  app.route({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url,
    config: { auth: ENDPOINT_AUTH[key] },
    ...(extra.bodyLimit ? { bodyLimit: extra.bodyLimit } : {}),
    handler: async (req, reply) => {
      const res = await handler(req, reply)
      if (reply.sent) return reply
      if (res === undefined) return reply.code(204).send()
      return res
    }
  })
}

/** Endpoints owned by a later agent: answer 501 with the right auth level until they are implemented. */
export function stubs(app: FastifyInstance, keys: readonly EndpointKey[]): void {
  for (const key of keys)
    route(app, key, () => {
      throw new VesperError('not_implemented')
    })
}

/** Parse a body/query/params with a zod schema; failures become `validation` with field messages. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {})
  if (r.success) return r.data
  const fields: Record<string, string> = {}
  for (const i of r.error.issues) fields[i.path.map(String).join('.') || '(root)'] = i.message
  throw new VesperError('validation', { fields })
}

/** The authenticated device (routes above 'public' always have one; the guard ran first). */
export function who(req: FastifyRequest): RequestAuth {
  if (!req.vesper) throw new VesperError('unauthorized')
  return req.vesper
}
