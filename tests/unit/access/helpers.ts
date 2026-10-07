/** Shared harness for the access-server integration tests: a real server with injected access fakes. */
import https from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import WebSocket from 'ws'
import type { ServerMsg } from '@shared/ws'
import { WS_PROTOCOL } from '@shared/ws'
import { accessOf, setAccessTestDeps, type AccessTestDeps } from '@server/net'
import type { RunningListener } from '@server/http/listeners'
import { coreOf, startTestServer, type TestServer } from '../server/helpers'

export const PASSWORD = 'violin harbor 1987 tide'
export const FAST_SCRYPT = { N: 2 ** 12, r: 8, p: 1 }

export interface AccessServer extends TestServer {
  desktop: string
  /** Shift the server clock (limiter windows, sudo expiry, timers). */
  advance(ms: number): void
  setPassword(pw?: string): Promise<void>
  /** Password login on Listener A from `ip`; returns the cookie header. */
  loginPw(o?: { password?: string; ip?: string; name?: string }): Promise<{ res: LightMyRequestResponse; cookie: string | null }>
  access(): ReturnType<typeof accessOf>
  notes: { title: string; body: string }[]
}

/** `desktopApp`: the platform is the Electron app's (`isDesktop`), not the standalone server's. */
export async function startAccessServer(deps: AccessTestDeps = {}, o: { desktopApp?: boolean } = {}): Promise<AccessServer> {
  setAccessTestDeps({ scrypt: FAST_SCRYPT, ...deps })
  const notes: { title: string; body: string }[] = []
  let t: TestServer
  try {
    t = await startTestServer({ platform: (p) => ({ ...p, isDesktop: o.desktopApp ?? p.isDesktop, notify: (title, body) => void notes.push({ title, body }) }) })
  } finally {
    setAccessTestDeps(null)
  }
  await accessOf(t.server.ctx).net.ready
  const desktop = await t.login('desktop')
  const s: AccessServer = {
    ...t,
    desktop,
    notes,
    advance(ms) {
      coreOf(t.server.ctx).clockOffsetMs += ms
    },
    async setPassword(pw = PASSWORD) {
      const r = await t.inject({ method: 'POST', url: '/api/auth/password', cookie: desktop, payload: { next: pw } })
      if (r.statusCode !== 204) throw new Error(`set password → ${r.statusCode} ${r.body}`)
    },
    async loginPw(o = {}) {
      const res = await t.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: o.password ?? PASSWORD, deviceName: o.name ?? 'Phone' },
        remoteAddress: o.ip ?? '127.0.0.1'
      } as InjectOptions)
      return { res, cookie: cookieOf(res) }
    },
    access: () => accessOf(t.server.ctx)
  }
  return s
}

export function cookieOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : raw
  if (typeof first !== 'string') return null
  const pair = first.split(';')[0]
  return pair.endsWith('=') ? null : pair
}

/** Inject into another listener's app with a matching Host (and Origin for writes) for that listener. */
export function injectOn(l: RunningListener, o: InjectOptions & { host?: string; origin?: string; cookie?: string }): Promise<LightMyRequestResponse> {
  const method = (o.method ?? 'GET').toUpperCase()
  const host = o.host ?? new URL(l.url).host
  const headers: Record<string, string> = { host, ...((o.headers ?? {}) as Record<string, string>) }
  if (method !== 'GET' && method !== 'HEAD') {
    headers.origin = o.origin ?? `https://${host}`
    headers['x-vesper'] = '1'
  }
  if (o.cookie) headers.cookie = o.cookie
  const { host: _h, origin: _o, cookie: _c, headers: _hh, ...rest } = o
  return l.app.inject({ ...rest, headers })
}

export interface HttpsResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json: unknown
  cert: ReturnType<TLSSocket['getPeerCertificate']> | null
}

/** A real HTTPS request (self-signed: verification off, the test checks the certificate itself). */
export function httpsRequest(url: string, o: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<HttpsResult> {
  const u = new URL(o.path, url)
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body)
    const req = https.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: o.method ?? 'GET',
        rejectUnauthorized: false,
        agent: false,
        headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) }
      },
      (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate?.(false) ?? null
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = body ? JSON.parse(body) : undefined
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json, cert })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** A WebSocket over wss/ws with exact headers, recording JSON messages. */
export class Socket {
  readonly ws: WebSocket
  readonly msgs: ServerMsg[] = []
  readonly opened: Promise<void>
  readonly closed: Promise<{ code: number; reason: string }>
  rejected: number | null = null

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers, rejectUnauthorized: false })
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.on('unexpected-response', (_q, res) => {
        this.rejected = res.statusCode ?? 0
        reject(new Error(`rejected ${res.statusCode}`))
      })
      this.ws.once('error', reject)
    })
    this.opened.catch(() => undefined)
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    this.ws.on('message', (d, bin) => {
      if (!bin) this.msgs.push(JSON.parse(d.toString()) as ServerMsg)
    })
  }

  async hello(): Promise<void> {
    await this.opened
    this.ws.send(JSON.stringify({ t: 'hello', protocol: WS_PROTOCOL, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: true, audioUnlocked: false } }))
    await this.wait((m) => m.t === 'ready')
  }

  async wait(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const t0 = Date.now()
    for (;;) {
      const hit = this.msgs.find(pred)
      if (hit) {
        this.msgs.splice(this.msgs.indexOf(hit), 1)
        return hit
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for a WS message')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  close(): void {
    this.ws.close()
  }
}
