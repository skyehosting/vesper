/**
 * The mock provider server (07 E1, 05 §2): one node:http server on 127.0.0.1 mounting one module per provider family.
 * Nothing here talks to the Internet; tests point the app at `url` (VESPER_MOCK_BASE) and script the responses.
 *
 *   const mock = await startMockServer()
 *   mock.llm.script({ text: 'Hi!', reasoning: 'thinking…' })
 *   … drive the app …
 *   mock.recorder.assertPrefixInvariant()
 *   await mock.close()
 *
 * Routing: a request may name its module with a path prefix — /openai, /anthropic, /voyage, /elevenlabs, /stt, /groq,
 * /gh — which is stripped (so a base URL of `${url}/anthropic` works for any SDK). Without a prefix the path and the
 * provider's auth header decide: `xi-api-key` → ElevenLabs, `anthropic-version`/`x-api-key` → Anthropic.
 * Generic `script()` entries are matched first, then the modules in order; anything else is a 404 recorded as
 * 'unhandled' (assert with `recorder.assertNoUnhandled()`).
 */
import http, { type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { readBody, sendBytes, sendJson, sleep, tryJson, type MockRequest } from './http'
import { Recorder } from './recorder'
import { createLlmMock, type LlmMock } from './llm'
import { createVoyageMock, type VoyageMock } from './voyage'
import { createTtsMock, type TtsMock } from './tts'
import { createSttMock, type SttMock } from './stt'
import { createGithubModelsMock, type GithubModelsMock } from './github-models'
import type { MockModule } from './module'

export interface ScriptEntry {
  method?: string
  /** Exact path (after prefix stripping) or a pattern. */
  path: string | RegExp
  /** How many requests this entry answers (default 1; Infinity = until reset). */
  times?: number
  status?: number
  json?: unknown
  body?: string | Uint8Array
  contentType?: string
  headers?: Record<string, string>
  delayMs?: number
  /** Never answer. */
  hang?: boolean
  /** Destroy the socket without a response. */
  destroy?: boolean
  /** Full control. */
  handler?: (req: MockRequest, res: ServerResponse) => void | Promise<void>
}

export interface MockServer {
  /** http://127.0.0.1:<port> — use as VESPER_MOCK_BASE. */
  url: string
  port: number
  recorder: Recorder
  llm: LlmMock
  voyage: VoyageMock
  tts: TtsMock
  stt: SttMock
  models: GithubModelsMock
  /** Queue raw responses that take precedence over the modules. */
  script(...entries: ScriptEntry[]): void
  /** Clear scripts, module modes and the recorder (between tests that share one server). */
  reset(): void
  close(): Promise<void>
}

export interface MockServerOptions {
  /** 0 (default) = a free port. */
  port?: number
}

/** https://fetch.spec.whatwg.org/#port-blocking — ports fetch() refuses to connect to. */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
])

export const MODULE_PREFIXES = ['openai', 'anthropic', 'voyage', 'elevenlabs', 'stt', 'groq', 'gh'] as const

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const recorder = new Recorder()
  const llm = createLlmMock()
  const voyage = createVoyageMock()
  const tts = createTtsMock()
  const stt = createSttMock()
  const models = createGithubModelsMock()
  // Order matters only for ambiguous paths: TTS claims GET /v1/models when `xi-api-key` is present, before the LLM.
  const modules: MockModule[] = [tts, llm, voyage, stt, models]
  let scripts: Array<ScriptEntry & { left: number }> = []
  let seq = 0
  let base = ''
  const sockets = new Set<Socket>()

  async function dispatch(req: MockRequest, res: ServerResponse): Promise<string> {
    const si = scripts.findIndex((s) => (!s.method || s.method.toUpperCase() === req.method) && (typeof s.path === 'string' ? s.path === req.path || s.path === req.rawPath : s.path.test(req.path)))
    if (si >= 0) {
      const s = scripts[si]
      if (--s.left <= 0) scripts.splice(si, 1)
      if (s.delayMs) await sleep(s.delayMs)
      if (s.hang) return 'script'
      if (s.destroy) {
        res.socket?.destroy()
        return 'script'
      }
      if (s.handler) await s.handler(req, res)
      else if (s.json !== undefined) sendJson(res, s.status ?? 200, s.json, s.headers)
      else sendBytes(res, s.status ?? 200, typeof s.body === 'string' ? Buffer.from(s.body) : (s.body ?? new Uint8Array()), s.contentType ?? 'text/plain', s.headers)
      return 'script'
    }
    for (const m of modules) {
      if (req.forced && !m.prefixes.includes(req.forced)) continue
      if (await m.handle(req, res)) return m.name
    }
    if (req.method === 'GET' && req.path === '/__mock/health') {
      sendJson(res, 200, { ok: true, modules: modules.map((m) => m.name) })
      return 'script'
    }
    sendJson(res, 404, { error: `mock: no handler for ${req.method} ${req.rawPath}` })
    return 'unhandled'
  }

  const server = http.createServer((raw, res) => {
    void (async () => {
      const u = new URL(raw.url ?? '/', 'http://mock.invalid')
      const first = u.pathname.split('/')[1] ?? ''
      const forced = (MODULE_PREFIXES as readonly string[]).includes(first) ? first : null
      let body: Buffer
      try {
        body = await readBody(raw)
      } catch (e) {
        sendJson(res, 413, { error: String(e) })
        return
      }
      const req: MockRequest = {
        method: (raw.method ?? 'GET').toUpperCase(),
        path: forced ? u.pathname.slice(forced.length + 1) || '/' : u.pathname,
        rawPath: u.pathname,
        query: u.searchParams,
        headers: raw.headers,
        body,
        forced,
        json: tryJson(body, raw.headers['content-type']),
        raw,
        base
      }
      const n = ++seq
      // Recorded before answering so a test can see a request whose response hangs or streams.
      const record = {
        seq: n,
        ts: Date.now(),
        module: 'pending',
        method: req.method,
        path: req.path,
        rawPath: req.rawPath,
        query: Object.fromEntries(u.searchParams),
        headers: Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
        body: body.toString('utf8'),
        bytes: body,
        json: req.json
      }
      recorder.push(record)
      try {
        record.module = await dispatch(req, res)
      } catch (e) {
        record.module = 'error'
        if (!res.headersSent) sendJson(res, 500, { error: `mock crashed: ${e instanceof Error ? e.message : String(e)}` })
        else res.destroy()
      }
    })()
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const listen = (p: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  await listen(opts.port ?? 0)
  // fetch() refuses the WHATWG "bad ports" (6000, 6665–6669, 10080, …): a random port that lands on one made every
  // fetch to the mock fail with "bad port" (a flake). Take another.
  for (let i = 0; i < 20 && opts.port === undefined && FETCH_BAD_PORTS.has((server.address() as AddressInfo).port); i++) {
    await new Promise<void>((r) => server.close(() => r()))
    await listen(0)
  }
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  models.attach(base)

  return {
    url: base,
    port,
    recorder,
    llm,
    voyage,
    tts,
    stt,
    models,
    script(...entries) {
      for (const e of entries) scripts.push({ ...e, left: e.times ?? 1 })
    },
    reset() {
      scripts = []
      for (const m of modules) m.reset()
      recorder.clear()
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
