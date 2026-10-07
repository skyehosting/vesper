/**
 * Resumable HTTPS download of one pinned model file (07 B12): redirects are followed by hand and only to known
 * release/CDN hosts, a `.part` file resumes with `Range`, the byte count may never exceed the pinned size, and a
 * stalled connection is aborted. Hashing happens afterwards over the complete file (a resumed file has two halves).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { VesperError } from '@shared/errors'

export interface DownloadOptions {
  url: string
  /** The `.part` file (kept across attempts and restarts for resume). */
  part: string
  size: number
  signal: AbortSignal
  /** Hosts redirects and the URL itself may use. */
  allowedHosts: readonly string[]
  /** Test builds: plain http to loopback origins (the mock GitHub server). */
  allowedOrigins?: readonly string[]
  onProgress(bytes: number): void
  stallMs?: number
  fetchImpl?: typeof fetch
}

const MAX_REDIRECTS = 5

function checkUrl(raw: string, o: DownloadOptions): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new VesperError('model_unsafe', { status: 422 })
  }
  if (o.allowedOrigins?.includes(u.origin)) return u
  if (u.protocol !== 'https:' || u.username || u.password) throw new VesperError('model_unsafe', { status: 422 })
  if (!o.allowedHosts.includes(u.hostname)) throw new VesperError('model_unsafe', { status: 422 })
  return u
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Download `url` into `part` (resuming what is there). Resolves when the file has exactly `size` bytes. */
export async function downloadResumable(o: DownloadOptions): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch
  let have = sizeOf(o.part)
  if (have > o.size) {
    fs.rmSync(o.part, { force: true })
    have = 0
  }
  if (have === o.size) return o.onProgress(have)
  let url = checkUrl(o.url, o).toString()
  let redirects = 0
  let retried416 = false
  for (;;) {
    if (o.signal.aborted) throw o.signal.reason
    let res: Response
    try {
      res = await fetchImpl(url, { redirect: 'manual', headers: have > 0 ? { range: `bytes=${have}-` } : {}, signal: o.signal })
    } catch {
      if (o.signal.aborted) throw o.signal.reason
      throw new VesperError('network', { status: 502 })
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      const loc = res.headers.get('location')
      if (!loc || ++redirects > MAX_REDIRECTS) throw new VesperError('model_unsafe', { status: 422 })
      url = checkUrl(new URL(loc, url).toString(), o).toString()
      continue
    }
    if (res.status === 416 && have > 0 && !retried416) {
      // The server cannot continue from here (file changed?): start over once.
      await res.body?.cancel().catch(() => undefined)
      fs.rmSync(o.part, { force: true })
      have = 0
      retried416 = true
      continue
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined)
      throw new VesperError(res.status === 404 ? 'not_found' : 'network', { status: 502, upstreamStatus: res.status })
    }
    if (res.status === 200 && have > 0) {
      // No range support: the whole file comes again.
      fs.rmSync(o.part, { force: true })
      have = 0
    } else if (res.status === 206) {
      const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')
      if (!m || Number(m[1]) !== have) {
        await res.body.cancel().catch(() => undefined)
        fs.rmSync(o.part, { force: true })
        throw new VesperError('model_checksum', { status: 502 })
      }
    }
    await streamTo(res.body, o, have)
    const got = sizeOf(o.part)
    if (got !== o.size) throw new VesperError(got > o.size ? 'model_checksum' : 'network', { status: 502 })
    return
  }
}

async function streamTo(body: ReadableStream<Uint8Array>, o: DownloadOptions, start: number): Promise<void> {
  const fd = fs.openSync(o.part, start > 0 ? 'a' : 'w')
  const reader = body.getReader()
  let bytes = start
  let stalled = false
  let stall: NodeJS.Timeout | null = null
  // A connection that stops sending is cancelled (the pending read then resolves done/rejects).
  const arm = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => {
      stalled = true
      void reader.cancel().catch(() => undefined)
    }, o.stallMs ?? 30_000)
  }
  try {
    arm()
    for (;;) {
      const { done, value } = await reader.read()
      if (done || stalled) break
      arm()
      bytes += value.byteLength
      if (bytes > o.size) throw new VesperError('model_checksum', { status: 502 })
      fs.writeSync(fd, value)
      o.onProgress(bytes)
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    if (o.signal.aborted) throw o.signal.reason
    if (e instanceof VesperError) throw e
    throw new VesperError('network', { status: 502 })
  } finally {
    if (stall) clearTimeout(stall)
    fs.closeSync(fd)
  }
  if (o.signal.aborted) throw o.signal.reason
  if (stalled) throw new VesperError('network', { status: 502 })
}

/**
 * SHA-256 of a file, streamed. Settles only after the file handle is CLOSED ('close', not 'end'): on Windows a file
 * deleted while a handle is still open stays in its folder listing ("delete pending") until that handle closes, so
 * a caller that removes the file right after hashing (a tampered download) must not race the stream's auto-close.
 */
export function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
    let failure: Error | null = null
    let digest: string | null = null
    const onAbort = () => s.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    s.on('data', (c) => h.update(c))
    s.on('error', (e) => {
      failure = e
    })
    s.on('end', () => {
      digest = h.digest('hex')
    })
    s.on('close', () => {
      signal?.removeEventListener('abort', onAbort)
      if (digest !== null && !failure) resolve(digest)
      else reject(failure ?? (signal?.aborted ? signal.reason : new Error('read stream closed early')))
    })
  })
}
