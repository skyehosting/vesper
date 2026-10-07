/**
 * Typed REST client over the frozen `Endpoints` map (shared/api.ts):
 *
 *   const page = await api('GET /api/sessions/:uid/messages', { params: { uid }, query: { mode: 'latest', limit: 100 } })
 *
 * Path params, query and body are checked against the contract at compile time. Same-origin cookies only; mutating
 * methods add `X-Vesper: 1`; failures throw `ApiErrorException` (errors.logic.ts). Two app-level hooks: a 401 outside
 * /api/auth/* means the session ended (→ login), and `sudo_required` can open a password prompt and retry once.
 */
import { CSRF_HEADER, type EndpointBody, type EndpointKey, type EndpointQuery, type EndpointRes } from '@shared/api'
import type { AttachmentRef } from '@shared/types/domain'
import { buildUrl, isAuthEndpoint, isMutating, splitEndpointKey } from './api.logic'
import { ApiErrorException, networkError, parseErrorBody } from './errors.logic'

// ── type plumbing ─────────────────────────────────────────────────────────────────────────────
type PathOf<K> = K extends `${string} ${infer P}` ? P : never
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never
type ParamsPart<K> = [ParamNames<PathOf<K>>] extends [never]
  ? { params?: undefined }
  : { params: Record<ParamNames<PathOf<K>>, string | number> }
type QueryPart<K extends EndpointKey> = [EndpointQuery<K>] extends [never]
  ? { query?: undefined }
  : object extends EndpointQuery<K>
    ? { query?: EndpointQuery<K> }
    : { query: EndpointQuery<K> }
type BodyPart<K extends EndpointKey> = [EndpointBody<K>] extends [never] ? { body?: undefined } : { body: EndpointBody<K> }

export interface CommonOptions {
  signal?: AbortSignal
  /** Don't open the sudo prompt on `sudo_required` (e.g. the prompt's own request). */
  noSudoRetry?: boolean
}
export type RequestOptions<K extends EndpointKey> = ParamsPart<K> & QueryPart<K> & BodyPart<K> & CommonOptions
type Args<K extends EndpointKey> = object extends RequestOptions<K> ? [opts?: RequestOptions<K>] : [opts: RequestOptions<K>]

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────
export interface ApiHooks {
  /** A device-level request got 401: the session expired or was revoked. */
  onUnauthorized?: (err: ApiErrorException) => void
  /**
   * The server wants a recent password (07 B2 sudo). Resolve true after the user re-authenticated (the request is
   * retried once), false to give up (the original error is thrown). access-ui installs the real prompt later.
   */
  onSudoRequired?: (err: ApiErrorException) => Promise<boolean>
}

const hooks: ApiHooks = {}

export function setApiHooks(next: ApiHooks): void {
  Object.assign(hooks, next)
}

// ── requests ──────────────────────────────────────────────────────────────────────────────────
let inflight = 0

/** Requests currently on the wire (test readiness waits for 0). */
export function apiInflight(): number {
  return inflight
}

/** Settings-like writes on the wire (settings, keys, the access mode), whichever feature started them. */
const writes = new Set<Promise<unknown>>()
const SETTLED_PATHS = ['/api/settings', '/api/secrets', '/api/network']

/**
 * Wait until every settings/secret/network write started so far has answered (success or not). The setup wizard's
 * Continue uses it, so a step's last change is on the server before the next step (or the summary) reads it, no
 * matter which helper the step saved with.
 */
export async function settleWrites(): Promise<void> {
  while (writes.size) await Promise.allSettled([...writes])
}

export async function api<K extends EndpointKey>(key: K, ...args: Args<K>): Promise<EndpointRes<K>> {
  const { method, path } = splitEndpointKey(key)
  if (!isMutating(method) || !SETTLED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return request(key, ...args)
  const p = request(key, ...args)
  writes.add(p)
  void p.then(
    () => writes.delete(p),
    () => writes.delete(p)
  )
  return p
}

async function request<K extends EndpointKey>(key: K, ...args: Args<K>): Promise<EndpointRes<K>> {
  const opts = (args[0] ?? {}) as {
    params?: Record<string, string | number>
    query?: object
    body?: unknown
  } & CommonOptions
  const { method, path } = splitEndpointKey(key)
  const url = buildUrl(path, opts.params, opts.query)

  const run = async (): Promise<EndpointRes<K>> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (isMutating(method)) headers[CSRF_HEADER] = '1'
    let body: string | undefined
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    let res: Response
    inflight++
    try {
      try {
        res = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal, cache: 'no-store' })
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e
        throw networkError()
      }
      if (res.ok) return (await readJson(res)) as EndpointRes<K>
      const err = new ApiErrorException(parseErrorBody(res.status, await readJson(res).catch(() => null), res.headers.get('retry-after')), res.status)
      throw err
    } finally {
      inflight--
    }
  }

  try {
    return await run()
  } catch (e) {
    if (!(e instanceof ApiErrorException)) throw e
    if (e.code === 'unauthorized' && !isAuthEndpoint(path)) hooks.onUnauthorized?.(e)
    if (e.code === 'sudo_required' && !opts.noSudoRetry && hooks.onSudoRequired) {
      if (await hooks.onSudoRequired(e)) return run()
    }
    throw e
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    if (res.ok) throw new ApiErrorException(parseErrorBody(500, null), res.status)
    return null
  }
}

// ── uploads ───────────────────────────────────────────────────────────────────────────────────
export interface UploadOptions {
  /** Original file name (the Blob may be a re-encoded image). */
  name: string
  /** Client-made 320 px thumbnail for images (07 B6). */
  thumb?: Blob
  meta?: { width?: number; height?: number }
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  /** A temporary chat's file: kept in memory/temp only (`?temporary=1`, 07 B9). */
  temporary?: boolean
}

/**
 * Multipart upload to `POST /api/attachments` (fields: file, thumb?, meta JSON). Uses XHR rather than fetch because
 * fetch has no upload progress.
 */
export function uploadAttachment(file: Blob, opts: UploadOptions): Promise<AttachmentRef> {
  return new Promise<AttachmentRef>((resolve, reject) => {
    const form = new FormData()
    form.append('meta', JSON.stringify({ name: opts.name, ...opts.meta }))
    form.append('file', file, opts.name)
    if (opts.thumb) form.append('thumb', opts.thumb, 'thumb.jpg')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', opts.temporary ? '/api/attachments?temporary=1' : '/api/attachments')
    xhr.withCredentials = true
    xhr.setRequestHeader(CSRF_HEADER, '1')
    xhr.setRequestHeader('accept', 'application/json')
    xhr.responseType = 'text'
    const onAbort = (): void => xhr.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => opts.signal?.removeEventListener('abort', onAbort)
    if (opts.onProgress) xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
    xhr.onerror = () => {
      done()
      reject(networkError())
    }
    xhr.onabort = () => {
      done()
      reject(new DOMException('Upload aborted', 'AbortError'))
    }
    xhr.onload = () => {
      done()
      let parsed: unknown = null
      try {
        parsed = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null
      } catch {
        parsed = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed) resolve(parsed as AttachmentRef)
      else {
        const err = new ApiErrorException(parseErrorBody(xhr.status || 500, parsed, xhr.getResponseHeader('retry-after')), xhr.status)
        if (err.code === 'unauthorized') hooks.onUnauthorized?.(err)
        reject(err)
      }
    }
    xhr.send(form)
  })
}
