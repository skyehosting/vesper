/**
 * Chat-engine test harness: a real startServer on a temp data dir (restartable on the same dir), the mock provider
 * server, a signed-in WebSocket client and the fakes of the services the engine calls (memory, speech).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CSRF_HEADER } from '@shared/api'
import type { LlmProfile } from '@shared/settings'
import type { ServerMsg } from '@shared/ws'
import { startServer } from '@server/app'
import type { RunningServer, ServerContext } from '@server/services'
import type { ChatEngine } from '@server/chat/engine'
import { fakePlatform, type FakePlatform } from '../../fakes/platform'
import { WsProbe } from '../server/helpers'
import { startMockServer, type MockServer } from '../../mocks/server'

process.env.VESPER_TEST = '1'

export type ProfileInput = Partial<LlmProfile> & Pick<LlmProfile, 'id' | 'preset' | 'adapter' | 'baseUrl' | 'model'>

export interface Turn {
  replyId: string
  userUid: string | undefined
  done: Extract<ServerMsg, { t: 'reply.done' }>
  events: ServerMsg[]
}

export class ChatHarness {
  server!: RunningServer
  cookie = ''
  host = ''
  origin = ''
  private probes: WsProbe[] = []

  private constructor(
    readonly mock: MockServer,
    readonly dir: string,
    readonly platform: FakePlatform,
    private ownsMock: boolean
  ) {}

  static async start(o: { mock?: MockServer; now?: number } = {}): Promise<ChatHarness> {
    const mock = o.mock ?? (await startMockServer())
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-chat-'))
    const platform = fakePlatform(path.join(dir, 'data'), { now: o.now, isDesktop: true })
    const h = new ChatHarness(mock, dir, platform, !o.mock)
    await h.boot()
    return h
  }

  get ctx(): ServerContext {
    return this.server.ctx
  }

  get engine(): ChatEngine {
    return this.ctx.services.chat as ChatEngine
  }

  private async boot(): Promise<void> {
    this.server = await startServer(this.platform, { port: 0, webDir: path.join(this.dir, 'web'), workersDir: this.dir, devRendererUrl: null })
    this.host = `127.0.0.1:${this.server.port}`
    this.origin = `http://${this.host}`
    const r = await this.inject('POST', '/api/test/login-as', { kind: 'desktop' })
    const body = r.json() as { cookie: { name: string; value: string } }
    this.cookie = `${body.cookie.name}=${body.cookie.value}`
  }

  /** Close and start again on the same data dir (secrets survive in the fake platform). */
  async restart(): Promise<void> {
    for (const p of this.probes) p.close()
    this.probes = []
    await this.server.close()
    await this.boot()
  }

  async inject(method: string, url: string, payload?: unknown): Promise<{ statusCode: number; json(): unknown; body: string }> {
    const headers: Record<string, string> = { host: this.host }
    if (method !== 'GET') {
      headers.origin = this.origin
      headers[CSRF_HEADER] = '1'
    }
    if (this.cookie) headers.cookie = this.cookie
    return this.server.ctx.app!.inject({ method: method as 'GET', url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
  }

  async setProfile(p: ProfileInput, key?: string): Promise<void> {
    await this.ctx.settings.patch({ llm: { profiles: [p as LlmProfile], defaultProfile: p.id } })
    if (key) await this.ctx.secrets.set(`llm:${p.id}`, key, p.baseUrl)
  }

  openaiProfile(model = 'mock-echo', extra: Partial<LlmProfile> = {}): ProfileInput {
    return { id: 'mock', label: 'Mock', preset: 'custom', adapter: 'openai', baseUrl: `${this.mock.url}/v1`, model, ...extra }
  }

  anthropicProfile(model = 'claude-opus-5-5', extra: Partial<LlmProfile> = {}): ProfileInput {
    return { id: 'claude', label: 'Claude', preset: 'anthropic', adapter: 'anthropic', baseUrl: `${this.mock.url}/anthropic`, model, ...extra }
  }

  async session(body: Record<string, unknown> = {}): Promise<{ uid: string; shortId: string }> {
    const r = await this.inject('POST', '/api/sessions', body)
    if (r.statusCode !== 200) throw new Error(`create session → ${r.statusCode} ${r.body}`)
    return r.json() as { uid: string; shortId: string }
  }

  async patchSession(uid: string, body: Record<string, unknown>): Promise<void> {
    const r = await this.inject('PATCH', `/api/sessions/${uid}`, body)
    if (r.statusCode !== 200) throw new Error(`patch session → ${r.statusCode} ${r.body}`)
  }

  async client(uid?: string): Promise<WsProbe> {
    const p = new WsProbe(`ws://${this.host}/ws`, { origin: this.origin, cookie: this.cookie })
    this.probes.push(p)
    await p.hello()
    if (uid) {
      p.send({ t: 'subscribe', sessionUid: uid })
      await p.next('subscribed', (m) => m.sessionUid === uid)
    }
    return p
  }

  /** Send a message and wait for its reply.done; returns every event of the turn (the probe's buffer is drained). */
  async send(p: WsProbe, uid: string, text: string, extra: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Turn> {
    const id = `m${Math.random().toString(36).slice(2)}`
    p.send({ t: 'chat.send', id, sessionUid: uid, text, attachments: [], client: { ts: Date.now(), tzOffset: 120, tzName: 'Europe/Berlin' }, speak: false, ...extra })
    return this.awaitTurn(p, id, timeoutMs)
  }

  async awaitTurn(p: WsProbe, id: string, timeoutMs = 10_000): Promise<Turn> {
    const answer = await waitMsg(p, (m) => (m.t === 'ack' || m.t === 'error') && m.id === id, timeoutMs)
    if (answer.t === 'error') throw new Error(`request failed: ${JSON.stringify(answer.error)}`)
    const first = answer as Extract<ServerMsg, { t: 'ack' }>
    // Take the events up to this reply's reply.done; later ones (titles, other turns) stay for the test.
    const until = Date.now() + timeoutMs
    let i = -1
    while ((i = p.msgs.findIndex((m) => m.t === 'reply.done' && m.replyId === first.replyId)) < 0) {
      if (Date.now() > until) throw new Error(`timeout waiting for reply.done; saw ${p.msgs.map((m) => m.t).join(', ')}`)
      await new Promise((r) => setTimeout(r, 5))
    }
    const events = p.msgs.splice(0, i + 1)
    const done = events[events.length - 1] as Extract<ServerMsg, { t: 'reply.done' }>
    return { replyId: first.replyId as string, userUid: first.messageUid, done, events }
  }

  async close(): Promise<void> {
    for (const p of this.probes) p.close()
    await this.server.close()
    if (this.ownsMock) await this.mock.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Wait for (and remove from the probe's buffer) the first message matching `pred`, polling. */
export async function waitMsg(p: WsProbe, pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const i = p.msgs.findIndex(pred)
    if (i >= 0) return p.msgs.splice(i, 1)[0]
    if (Date.now() > until) throw new Error(`timeout; saw ${p.msgs.map((m) => m.t).join(', ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Requests the LLM mock answered (chat only). */
export function chatRequests(mock: MockServer): Array<{ path: string; json: Record<string, unknown>; headers: Record<string, string> }> {
  return mock.recorder
    .all()
    .filter((r) => r.method === 'POST' && (/\/chat\/completions$/.test(r.path) || /\/v1\/messages$/.test(r.path)))
    .map((r) => ({ path: r.path, json: r.json as Record<string, unknown>, headers: r.headers }))
}
