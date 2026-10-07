/**
 * Small HTTP helpers shared by the mock modules (plain node:http, no framework, so the mock stays independent of the
 * server under test). Everything here is test-only.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export interface MockRequest {
  method: string
  /** Path after any module prefix was stripped (e.g. `/openai/v1/models` → `/v1/models`). */
  path: string
  /** The path as received. */
  rawPath: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Buffer
  /** Module forced by a path prefix (`/openai`, `/anthropic`, …), if any. */
  forced: string | null
  /** Parsed JSON body (undefined when the body is empty or not JSON). */
  json: unknown
  raw: IncomingMessage
  /** Absolute base URL of the mock server (http://127.0.0.1:port), for links such as preview_url. */
  base: string
}

export function header(req: MockRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

/** Bearer token or a provider-specific key header. */
export function bearer(req: MockRequest): string | null {
  const auth = header(req, 'authorization')
  if (!auth) return null
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m ? m[1].trim() : null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

export function sendBytes(res: ServerResponse, status: number, bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': contentType, 'content-length': bytes.byteLength, ...headers })
  res.end(bytes)
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  sendBytes(res, status, Buffer.from(text, 'utf8'), contentType)
}

/**
 * Server-sent events writer with optional per-event delay and a hard abort after N events (the socket is destroyed
 * without a terminating chunk, as a dropped connection would look to the client).
 */
export class SseWriter {
  private sent = 0
  private closed = false

  constructor(
    private readonly res: ServerResponse,
    private readonly o: { delayMs?: number; abortAfterEvents?: number; firstByteDelayMs?: number } = {}
  ) {
    res.on('close', () => {
      this.closed = true
    })
  }

  get aborted(): boolean {
    return this.closed
  }

  async open(): Promise<void> {
    if (this.o.firstByteDelayMs) await sleep(this.o.firstByteDelayMs)
    if (this.closed) return
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    this.res.flushHeaders()
  }

  /** Write one event. Returns false once the stream is closed (client abort or scripted abort). */
  async event(data: unknown, event?: string): Promise<boolean> {
    if (this.closed) return false
    if (this.o.abortAfterEvents !== undefined && this.sent >= this.o.abortAfterEvents) {
      this.closed = true
      this.res.socket?.destroy()
      return false
    }
    if (this.sent > 0 && this.o.delayMs) await sleep(this.o.delayMs)
    if (this.closed) return false
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    this.res.write(`${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`)
    this.sent++
    return true
  }

  end(): void {
    if (!this.closed) this.res.end()
    this.closed = true
  }
}

export async function readBody(req: IncomingMessage, limit = 150 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = chunk as Buffer
    size += b.length
    if (size > limit) throw new Error(`mock: request body over ${limit} bytes`)
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

export function tryJson(body: Buffer, contentType: string | undefined): unknown {
  if (!body.length) return undefined
  if (contentType && !/json/i.test(contentType) && !/^\s*[[{]/.test(body.subarray(0, 64).toString('utf8'))) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Rough token estimate used for usage numbers and rate limits (~4 chars per token, at least 1). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** FNV-1a 32-bit, used to derive deterministic ids, signatures and vectors. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
