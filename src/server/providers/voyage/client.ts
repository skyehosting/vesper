/**
 * Thin Voyage AI client over global fetch (research 02 §5.9: no SDK — it doesn't route `al-` keys and pulls in
 * node-fetch). Runs in db.worker (07 C11: the VoyageScheduler owns every Voyage call) and, for one-off key tests, in
 * the main process. 07 B1: `redirect: 'manual'`, a timeout per request, a response size cap, and errors that carry
 * only a kind + status — never the upstream body (it is not even read on failure beyond a small cap).
 */

/** Wire format captured from the official SDK (research 02 §5.9, §7.1). */
export interface EmbedRequest {
  input: string[]
  model: string
  inputType: 'query' | 'document'
  dim: number
  /** int8 for stored document vectors, float for queries (research 02 §5.2/§5.3). */
  dtype: 'int8' | 'float'
}

export interface EmbedResult<V extends Int8Array | Float32Array = Int8Array | Float32Array> {
  vectors: V[]
  tokens: number
}

export interface RerankRequest {
  query: string
  documents: string[]
  model: string
  topK: number
}

export interface RerankResult {
  /** Sorted by descending score (as Voyage returns them). */
  results: { index: number; score: number }[]
  tokens: number
}

export type VoyageErrorKind = 'auth' | 'forbidden' | 'rate' | 'server' | 'bad_request' | 'not_found' | 'gone' | 'network' | 'timeout' | 'aborted'

export class VoyageError extends Error {
  constructor(
    readonly kind: VoyageErrorKind,
    readonly status?: number,
    /** From a Retry-After header (429/503), when present. */
    readonly retryAfterMs?: number
  ) {
    super(`voyage ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'VoyageError'
  }

  /** Worth retrying later with backoff (rate limits, server errors, network trouble). */
  get transient(): boolean {
    return this.kind === 'rate' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout'
  }
}

export interface VoyageClientOptions {
  /** e.g. https://api.voyageai.com/v1 (no trailing slash needed). */
  baseUrl: string
  key: string
  timeoutMs?: number
  /** Response size cap in bytes (1,000 × 2048-d float vectors in base64 ≈ 11 MB). */
  maxResponseBytes?: number
  fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export interface VoyageClient {
  embed(r: EmbedRequest & { dtype: 'int8' }, signal?: AbortSignal): Promise<EmbedResult<Int8Array>>
  embed(r: EmbedRequest & { dtype: 'float' }, signal?: AbortSignal): Promise<EmbedResult<Float32Array>>
  rerank(r: RerankRequest, signal?: AbortSignal): Promise<RerankResult>
}

export function createVoyageClient(o: VoyageClientOptions): VoyageClient {
  const base = o.baseUrl.replace(/\/+$/, '')
  const doFetch = o.fetch ?? fetch
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = o.maxResponseBytes ?? DEFAULT_MAX_BYTES

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new VoyageError('aborted')
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, timeoutMs)
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let res: Response
      try {
        res = await doFetch(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: ctl.signal
        })
      } catch {
        throw new VoyageError(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network')
      }
      if (res.status !== 200) {
        // Drain a little so the connection can be reused; never surface the body (07 B1).
        await res.body?.cancel().catch(() => undefined)
        throw errorFor(res)
      }
      const bytes = await readCapped(res, maxBytes).catch(() => {
        throw new VoyageError(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network')
      })
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown
      } catch {
        throw new VoyageError('server', res.status)
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function embed(r: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
    const json = (await post(
      '/embeddings',
      {
        input: r.input,
        model: r.model,
        input_type: r.inputType,
        output_dimension: r.dim,
        output_dtype: r.dtype,
        encoding_format: 'base64',
        truncation: true
      },
      signal
    )) as { data?: { embedding?: unknown; index?: number }[]; usage?: { total_tokens?: number } }
    const data = Array.isArray(json.data) ? json.data : null
    if (!data || data.length !== r.input.length) throw new VoyageError('server', 200)
    const vectors: (Int8Array | Float32Array)[] = new Array(r.input.length)
    for (const d of data) {
      const i = typeof d.index === 'number' ? d.index : -1
      if (i < 0 || i >= vectors.length || typeof d.embedding !== 'string') throw new VoyageError('server', 200)
      vectors[i] = decode(d.embedding, r.dtype, r.dim)
    }
    return { vectors, tokens: Number(json.usage?.total_tokens ?? 0) }
  }

  return {
    embed: embed as VoyageClient['embed'],
    async rerank(r, signal) {
      const json = (await post('/rerank', { query: r.query, documents: r.documents, model: r.model, top_k: r.topK, return_documents: false, truncation: true }, signal)) as {
        data?: { index?: number; relevance_score?: number }[]
        usage?: { total_tokens?: number }
      }
      if (!Array.isArray(json.data)) throw new VoyageError('server', 200)
      const results = json.data
        .filter((d) => typeof d.index === 'number' && d.index >= 0 && d.index < r.documents.length && typeof d.relevance_score === 'number')
        .map((d) => ({ index: d.index as number, score: d.relevance_score as number }))
        .sort((a, b) => b.score - a.score)
      return { results, tokens: Number(json.usage?.total_tokens ?? 0) }
    }
  }
}

function errorFor(res: Response): VoyageError {
  const s = res.status
  const ra = retryAfterMs(res.headers.get('retry-after'))
  if (s === 401) return new VoyageError('auth', s)
  if (s === 403) return new VoyageError('forbidden', s)
  if (s === 404) return new VoyageError('not_found', s)
  if (s === 410) return new VoyageError('gone', s)
  if (s === 429) return new VoyageError('rate', s, ra)
  if (s >= 500) return new VoyageError('server', s, ra)
  if (s >= 300 && s < 400) return new VoyageError('network', s)
  return new VoyageError('bad_request', s)
}

function retryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec)) return Math.max(0, Math.min(300, sec)) * 1000
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, Math.min(300_000, at - Date.now())) : undefined
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error('response too large')
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('response too large')
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

/** base64 numpy array → typed array (int8 for int8; float32 for float), copied to an aligned buffer. */
function decode(b64: string, dtype: 'int8' | 'float', dim: number): Int8Array | Float32Array {
  const buf = Buffer.from(b64, 'base64')
  if (dtype === 'int8') {
    if (buf.length !== dim) throw new VoyageError('server', 200)
    const out = new Int8Array(dim)
    out.set(new Int8Array(buf.buffer, buf.byteOffset, buf.length))
    return out
  }
  if (buf.length !== dim * 4) throw new VoyageError('server', 200)
  const out = new Float32Array(dim)
  new Uint8Array(out.buffer).set(buf)
  return out
}
