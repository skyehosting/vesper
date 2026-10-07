/**
 * Raw HTTP for guard tests: node:http lets a test send exactly the headers it wants (a forged Host or Origin, a
 * missing cookie), which fetch and Playwright's request context normalise away.
 */
import http from 'node:http'

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  /** Parsed body, or undefined when it is not JSON. */
  json: unknown
}

export interface RawRequest {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
}

export function rawRequest(baseUrl: string, r: RawRequest): Promise<RawResponse> {
  const u = new URL(r.path, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: r.method ?? 'GET', headers: r.headers ?? {}, timeout: r.timeoutMs ?? 15_000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = text ? (JSON.parse(text) as unknown) : undefined
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`rawRequest timed out: ${r.method ?? 'GET'} ${r.path}`)))
    req.on('error', reject)
    if (r.body !== undefined) req.write(r.body)
    req.end()
  })
}
