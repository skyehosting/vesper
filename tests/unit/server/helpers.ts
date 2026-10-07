/** Test harness for the server: a real startServer on a random loopback port with a temp data dir. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import WebSocket from 'ws'
import { CSRF_HEADER } from '@shared/api'
import { WS_PROTOCOL, type ServerMsg } from '@shared/ws'
import { startServer, type StartOptionsExtra } from '@server/app'
import { coreOf } from '@server/core'
import { createNodePlatform } from '@server/nodePlatform'
import type { Platform } from '@server/platform'
import type { RunningServer } from '@server/services'

process.env.VESPER_TEST = '1'

export interface TestServer {
  server: RunningServer
  dir: string
  origin: string
  host: string
  /** fastify.inject with a valid Host (and, for mutating requests, Origin + x-vesper) unless overridden. */
  inject(o: InjectOptions & { cookie?: string }): Promise<LightMyRequestResponse>
  /** A session cookie for a new device ('browser' or 'desktop'). */
  login(kind: 'browser' | 'desktop'): Promise<string>
  close(): Promise<void>
}

export async function startTestServer(o: { opts?: Partial<StartOptionsExtra>; platform?: (p: Platform) => Platform } = {}): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-test-'))
  let platform = createNodePlatform({ appDir: dir, version: '0.0.0-test', dataDir: path.join(dir, 'data') })
  if (o.platform) platform = o.platform(platform)
  const server = await startServer(platform, { port: 0, webDir: path.join(dir, 'web'), workersDir: dir, devRendererUrl: null, ...o.opts })
  const host = `127.0.0.1:${server.port}`
  const origin = `http://${host}`
  const app = server.ctx.app!
  const t: TestServer = {
    server,
    dir,
    origin,
    host,
    inject(io) {
      const method = (io.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = { host }
      if (method !== 'GET' && method !== 'HEAD') {
        headers.origin = origin
        headers[CSRF_HEADER] = '1'
      }
      if (io.cookie) headers.cookie = io.cookie
      // An override of `undefined` removes a default header (to test its absence).
      for (const [k, v] of Object.entries((io.headers ?? {}) as Record<string, string | undefined>)) {
        if (v === undefined) delete headers[k]
        else headers[k] = v
      }
      const { cookie: _c, headers: _h, ...rest } = io
      return app.inject({ ...rest, headers })
    },
    async login(kind) {
      const r = await t.inject({ method: 'POST', url: '/api/test/login-as', payload: { kind } })
      const body = r.json() as { cookie: { name: string; value: string } }
      return `${body.cookie.name}=${body.cookie.value}`
    },
    async close() {
      await server.close()
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(`${path.join(dir, 'data')}-local`, { recursive: true, force: true })
    }
  }
  return t
}

export { coreOf }

/** A WebSocket client that records every JSON message and can wait for one. */
export class WsProbe {
  readonly msgs: ServerMsg[] = []
  readonly ws: WebSocket
  closed: { code: number; reason: string } | null = null
  rejected: number | null = null
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
  readonly opened: Promise<void>
  readonly closedP: Promise<{ code: number; reason: string }>

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.on('unexpected-response', (_req, res) => {
        this.rejected = res.statusCode ?? 0
        reject(new Error(`rejected ${res.statusCode}`))
      })
      this.ws.once('error', (e) => reject(e))
    })
    this.opened.catch(() => undefined)
    this.closedP = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() }
        resolve(this.closed)
      })
    })
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const m = JSON.parse(data.toString()) as ServerMsg
      this.msgs.push(m)
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    })
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m))
  }

  next<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, timeoutMs = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const seen = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>))
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1)
      return Promise.resolve(seen as Extract<ServerMsg, { t: T }>)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs)
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>),
        resolve: (m) => {
          clearTimeout(timer)
          const i = this.msgs.indexOf(m)
          if (i >= 0) this.msgs.splice(i, 1)
          resolve(m as Extract<ServerMsg, { t: T }>)
        }
      })
    })
  }

  async hello(): Promise<Extract<ServerMsg, { t: 'ready' }>> {
    await this.opened
    this.send({ t: 'hello', protocol: WS_PROTOCOL, tz: 'Europe/Berlin', tzOffset: 120, client: { visible: true, focused: true, audioUnlocked: false } })
    return this.next('ready')
  }

  close(): void {
    this.ws.close()
  }
}

export function wsUrl(t: TestServer): string {
  return `ws://${t.host}/ws`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
