/**
 * Mock Voyage AI (owner: memory; foundation version by test-infra): POST /v1/embeddings and POST /v1/rerank.
 *
 * Embeddings are deterministic: each word token (lower-cased, a few stop words dropped) seeds its own pseudo-random
 * direction and a text's vector is the normalised sum, plus a small per-text component. Texts that share words are
 * therefore similar, unrelated texts are near-orthogonal, and identical texts give identical vectors — similarity is
 * controllable from the test text alone. Dimension k is a prefix of the 2048-d vector (Matryoshka, re-normalised).
 * Rerank scores are the share of query tokens found in the document.
 * Memory-agent extensions: latency injection (`setDelay`, `hangNext`), per-lane request counts (`counts()`: query
 * embeddings vs document embeddings vs reranks — the scheduler's foreground and background lanes) and a request log.
 *
 * As the real API: the body is validated before the key (research 02 §2.7), errors are `{detail}`, ≤ 1,000 inputs.
 * `mode('free-trial')` enforces 3 RPM / 10K TPM (research 02 §2.6) with 429s.
 */
import type { ServerResponse } from 'node:http'
import { bearer, fnv1a, isRecord, sendJson, sleep, type MockRequest } from './http'
import type { MockModule } from './module'

export type VoyageDtype = 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary'
export type VoyageMode = 'ok' | 'unauthorized' | 'rate-limited' | 'server-error' | 'free-trial'

export interface VoyageMock {
  mode(m: VoyageMode): void
  /** Accept only these keys (null = any non-empty key, the default). */
  setKeys(keys: string[] | null): void
  /** Fail the next `count` requests with `status` (then behave normally): backoff and retry tests. */
  failNext(status: 429 | 500 | 502 | 503 | 400 | 401, count?: number): void
  /** Every text sent to /v1/embeddings (in order) — e.g. assert private sessions never reach Voyage. */
  embeddedTexts(): string[]
  /** Rerank queries received. */
  rerankQueries(): string[]
  /** Delay every answer by `ms` (latency injection; 0 = none). */
  setDelay(ms: number): void
  /** Never answer the next `count` requests (the client's timeout / abort must handle it). */
  hangNext(count?: number): void
  /** Served requests per lane: query embeddings (foreground), document embeddings (background), reranks. */
  counts(): { query: number; document: number; rerank: number; rejected: number }
  /** Every request that reached a handler, in order (served or rejected). */
  log(): VoyageLogEntry[]
  /** Back to defaults: mode ok, any key, no delay, counters and logs cleared. */
  reset(): void
}

export interface VoyageLogEntry {
  kind: 'embed' | 'rerank'
  inputType: 'query' | 'document' | null
  inputs: number
  tokens: number
  dim: number | null
  status: number
  at: number
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it', 'at', 'for', 'with', 'be', 'was', 'are', 'i', 'you', 'we', 'my', 'me'])
const MAX_DIM = 2048
const DIMS = [256, 512, 1024, 2048]
const DTYPES: VoyageDtype[] = ['float', 'int8', 'uint8', 'binary', 'ubinary']
/** Tokens per request by model family (research 02 §2.2). */
const TOKEN_CAP: Array<[RegExp, number]> = [
  [/lite/, 1_000_000],
  [/large|code|context|finance|law/, 120_000],
  [/./, 320_000]
]

export const FREE_TRIAL = { rpm: 3, tpm: 10_000 } as const

/** Word tokens used for vectors and overlap scores. */
export function voyageWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w))
}

/** Billing-style token estimate (~5 chars per token, research 02 §2.2), at least 1 per input. */
export function voyageTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 5))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dirCache = new Map<string, Float64Array>()
function direction(token: string): Float64Array {
  let v = dirCache.get(token)
  if (!v) {
    const rnd = mulberry32(fnv1a(token))
    v = new Float64Array(MAX_DIM)
    for (let i = 0; i < MAX_DIM; i++) v[i] = rnd() + rnd() - 1
    if (dirCache.size > 50_000) dirCache.clear()
    dirCache.set(token, v)
  }
  return v
}

/** Unit-length embedding of `text` with `dim` dimensions (the same prefix for every dim, re-normalised). */
export function mockEmbedding(text: string, dim = 1024): Float64Array {
  const out = new Float64Array(dim)
  for (const w of voyageWords(text)) {
    const d = direction(`w:${w}`)
    for (let i = 0; i < dim; i++) out[i] += d[i]
  }
  // A small per-text component: identical texts stay identical, texts with the same words differ slightly, and an
  // empty or all-stop-word text still gets a valid unit vector.
  const own = direction(`t:${text.trim().toLowerCase()}`)
  for (let i = 0; i < dim; i++) out[i] += 0.15 * own[i]
  let n = 0
  for (let i = 0; i < dim; i++) n += out[i] * out[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < dim; i++) out[i] /= n
  return out
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/** Quantise a unit vector as Voyage's `output_dtype` (int8 scaled to the vector's largest component). */
export function quantize(v: Float64Array, dtype: VoyageDtype): number[] {
  if (dtype === 'float') return Array.from(v, (x) => Math.fround(x))
  if (dtype === 'int8' || dtype === 'uint8') {
    let max = 0
    for (const x of v) max = Math.max(max, Math.abs(x))
    const s = max ? 127 / max : 0
    return Array.from(v, (x) => Math.max(-128, Math.min(127, Math.round(x * s))) + (dtype === 'uint8' ? 128 : 0))
  }
  // binary / ubinary: one bit per dimension (1 = positive), MSB first; binary is offset by −128 (research 02 §2.2).
  const out: number[] = []
  for (let i = 0; i < v.length; i += 8) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (v[i + b] > 0 ? 1 : 0)
    out.push(dtype === 'binary' ? byte - 128 : byte)
  }
  return out
}

/** base64 of the numbers as Voyage encodes them: float32 for float, int8 for int8/binary, uint8 otherwise. */
export function encodeBase64(values: number[], dtype: VoyageDtype): string {
  if (dtype === 'float') return Buffer.from(new Float32Array(values).buffer).toString('base64')
  if (dtype === 'int8' || dtype === 'binary') return Buffer.from(new Int8Array(values).buffer).toString('base64')
  return Buffer.from(new Uint8Array(values).buffer).toString('base64')
}

/**
 * Share of the query's distinct words that occur in the document, with a small Jaccard tie-break; 0..1. Like rerank-3
 * following an instruction, a leading instruction ending in "Query:" only frames the query and is not scored.
 */
export function rerankScore(query: string, doc: string): number {
  const at = query.lastIndexOf('Query:')
  const q = new Set(voyageWords(at >= 0 ? query.slice(at + 6) : query))
  const d = new Set(voyageWords(doc))
  if (!q.size) return 0
  let hit = 0
  for (const w of q) if (d.has(w)) hit++
  const union = new Set([...q, ...d]).size
  return Math.min(1, 0.95 * (hit / q.size) + 0.05 * (union ? hit / union : 0))
}

function detail(res: ServerResponse, status: number, text: string): void {
  sendJson(res, status, { detail: text })
}

function reject(res: ServerResponse, status: number, text: string): true {
  detail(res, status, text)
  return true
}

export function createVoyageMock(): VoyageMock & MockModule {
  let mode: VoyageMode = 'ok'
  let keys: string[] | null = null
  let failures: Array<{ status: number }> = []
  let embedded: string[] = []
  let queries: string[] = []
  let window: Array<{ ts: number; tokens: number }> = []
  let delayMs = 0
  let hangs = 0
  let entries: VoyageLogEntry[] = []
  const counts = { query: 0, document: 0, rerank: 0, rejected: 0 }

  /** Sends the error and returns true when the request must not be served (auth, scripted failures, rate limits). */
  function gate(req: MockRequest, res: ServerResponse, tokens: number): boolean {
    const key = bearer(req)
    if (!key) return reject(res, 401, 'Unauthorized')
    if (mode === 'unauthorized' || (keys && !keys.includes(key))) return reject(res, 401, 'Provided API key is invalid.')
    const fail = failures.shift()
    if (fail) return reject(res, fail.status, fail.status === 429 ? 'Rate limit exceeded.' : `Mock failure ${fail.status}.`)
    if (mode === 'rate-limited') return reject(res, 429, 'Rate limit exceeded.')
    if (mode === 'server-error') return reject(res, 500, 'Internal server error.')
    if (mode === 'free-trial') {
      const now = Date.now()
      window = window.filter((w) => now - w.ts < 60_000)
      const used = window.reduce((s, w) => s + w.tokens, 0)
      if (window.length >= FREE_TRIAL.rpm || used + tokens > FREE_TRIAL.tpm)
        return reject(res, 429, 'You have not yet added your payment method in the billing page and will have reduced rate limits of 3 RPM and 10K TPM.')
      window.push({ ts: now, tokens })
    }
    return false
  }

  function embeddings(req: MockRequest, res: ServerResponse): void {
    const b = req.json
    if (!isRecord(b)) return detail(res, 400, 'Request body must be JSON.')
    const inputs = typeof b.input === 'string' ? [b.input] : Array.isArray(b.input) && b.input.every((x) => typeof x === 'string') ? (b.input as string[]) : null
    if (!inputs || !inputs.length) return detail(res, 400, "Value error, 'input' must be a non-empty string or list of strings.")
    if (inputs.length > 1000) return detail(res, 400, 'The batch size limit is 1000. Please reduce the number of inputs.')
    const model = typeof b.model === 'string' ? b.model : ''
    if (!/^voyage-/.test(model)) return detail(res, 400, `Model ${model || '(missing)'} is not supported.`)
    const dim = b.output_dimension === undefined || b.output_dimension === null ? 1024 : Number(b.output_dimension)
    if (!DIMS.includes(dim)) return detail(res, 400, `output_dimension must be one of ${DIMS.join(', ')}.`)
    const dtype = (b.output_dtype ?? 'float') as VoyageDtype
    if (!DTYPES.includes(dtype)) return detail(res, 400, `output_dtype must be one of ${DTYPES.join(', ')}.`)
    if (b.input_type !== undefined && b.input_type !== null && b.input_type !== 'query' && b.input_type !== 'document') return detail(res, 400, "input_type must be 'query', 'document' or null.")
    const enc = b.encoding_format ?? null
    if (enc !== null && enc !== 'base64') return detail(res, 400, "encoding_format must be null or 'base64'.")
    const tokens = inputs.reduce((s, t) => s + voyageTokens(t), 0)
    const cap = TOKEN_CAP.find(([re]) => re.test(model))?.[1] ?? 320_000
    if (tokens > cap) return detail(res, 400, `Request to model '${model}' failed. The max allowed tokens per submitted batch is ${cap}. Your batch has ${tokens} tokens.`)
    const inputType = b.input_type === 'query' || b.input_type === 'document' ? b.input_type : null
    const entry: VoyageLogEntry = { kind: 'embed', inputType, inputs: inputs.length, tokens, dim, status: 200, at: Date.now() }
    entries.push(entry)
    if (gate(req, res, tokens)) {
      entry.status = res.statusCode
      counts.rejected++
      return
    }
    if (inputType === 'query') counts.query++
    else counts.document++
    embedded.push(...inputs)
    const data = inputs.map((text, index) => {
      const q = quantize(mockEmbedding(text, dim), dtype)
      return { object: 'embedding', embedding: enc === 'base64' ? encodeBase64(q, dtype) : q, index }
    })
    sendJson(res, 200, { object: 'list', data, model, usage: { total_tokens: tokens } })
  }

  function rerank(req: MockRequest, res: ServerResponse): void {
    const b = req.json
    if (!isRecord(b)) return detail(res, 400, 'Request body must be JSON.')
    if (typeof b.query !== 'string' || !b.query) return detail(res, 400, "'query' is required.")
    const docs = Array.isArray(b.documents) && b.documents.every((x) => typeof x === 'string') ? (b.documents as string[]) : null
    if (!docs || !docs.length) return detail(res, 400, "'documents' must be a non-empty list of strings.")
    if (docs.length > 1000) return detail(res, 400, 'The number of documents must be at most 1000.')
    const model = typeof b.model === 'string' ? b.model : ''
    if (!/^rerank-/.test(model)) return detail(res, 400, `Model ${model || '(missing)'} is not supported.`)
    const topK = b.top_k === undefined || b.top_k === null ? docs.length : Number(b.top_k)
    if (!Number.isInteger(topK) || topK < 1) return detail(res, 400, 'top_k must be a positive integer.')
    const tokens = voyageTokens(b.query) * docs.length + docs.reduce((s, d) => s + voyageTokens(d), 0)
    const entry: VoyageLogEntry = { kind: 'rerank', inputType: null, inputs: docs.length, tokens, dim: null, status: 200, at: Date.now() }
    entries.push(entry)
    if (gate(req, res, tokens)) {
      entry.status = res.statusCode
      counts.rejected++
      return
    }
    counts.rerank++
    queries.push(b.query)
    const query = b.query
    const scored = docs.map((d, index) => ({ index, relevance_score: Number(rerankScore(query, d).toFixed(6)), ...(b.return_documents ? { document: d } : {}) }))
    scored.sort((x, y) => y.relevance_score - x.relevance_score || x.index - y.index)
    sendJson(res, 200, { object: 'list', data: scored.slice(0, topK), model, usage: { total_tokens: tokens } })
  }

  return {
    name: 'voyage',
    prefixes: ['voyage'],
    mode(m) {
      mode = m
      window = []
    },
    setKeys(k) {
      keys = k
    },
    failNext(status, count = 1) {
      for (let i = 0; i < count; i++) failures.push({ status })
    },
    embeddedTexts() {
      return [...embedded]
    },
    rerankQueries() {
      return [...queries]
    },
    setDelay(ms) {
      delayMs = Math.max(0, ms)
    },
    hangNext(count = 1) {
      hangs += count
    },
    counts() {
      return { ...counts }
    },
    log() {
      return entries.map((e) => ({ ...e }))
    },
    reset() {
      mode = 'ok'
      keys = null
      failures = []
      embedded = []
      queries = []
      window = []
      delayMs = 0
      hangs = 0
      entries = []
      counts.query = counts.document = counts.rerank = counts.rejected = 0
    },
    async handle(req, res) {
      if (req.forced && req.forced !== 'voyage') return false
      if (req.method !== 'POST') return false
      const isEmbed = req.path === '/v1/embeddings' || req.path === '/embeddings'
      const isRerank = req.path === '/v1/rerank' || req.path === '/rerank'
      if (!isEmbed && !isRerank) return false
      if (hangs > 0) {
        hangs--
        // Leave the request open until the client gives up (its abort closes the socket).
        await new Promise<void>((resolve) => res.once('close', () => resolve()))
        return true
      }
      if (delayMs) await sleep(delayMs)
      if (res.destroyed) return true
      if (isEmbed) embeddings(req, res)
      else rerank(req, res)
      return true
    }
  }
}
