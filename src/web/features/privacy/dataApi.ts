/**
 * Data-page requests that the typed JSON client can't make: the multipart import upload (XHR for upload progress)
 * and the export download (a same-origin link, so a 2 GB export streams to disk instead of into memory). Both are
 * sudo routes (07 B2): a cheap sudo GET first lets the app's password prompt run before the real request.
 */
import { CSRF_HEADER, type ImportResult } from '@shared/api'
import { api } from '../../lib/api'
import { ApiErrorException, networkError, parseErrorBody } from '../../lib/errors.logic'
import { downloadUrl } from '../memory/download'

/** Ask for the password now if this device needs it (desktop: never). Throws when the user cancels. */
export async function ensureSudo(): Promise<void> {
  await api('GET /api/backups')
}

export function exportUrl(o: { format: 'md' | 'json'; session?: string }): string {
  const q = new URLSearchParams({ format: o.format })
  if (o.session) q.set('session', o.session)
  return `/api/export?${q.toString()}`
}

export async function startExport(o: { format: 'md' | 'json'; session?: string }): Promise<void> {
  await ensureSudo()
  downloadUrl(exportUrl(o))
}

export function uploadImport(file: File, o: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {}): Promise<ImportResult> {
  return new Promise<ImportResult>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/import')
    xhr.withCredentials = true
    xhr.setRequestHeader(CSRF_HEADER, '1')
    xhr.setRequestHeader('accept', 'application/json')
    const onAbort = (): void => xhr.abort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => o.signal?.removeEventListener('abort', onAbort)
    if (o.onProgress) xhr.upload.onprogress = (e) => o.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
    xhr.onerror = () => {
      done()
      reject(networkError())
    }
    xhr.onabort = () => {
      done()
      reject(new DOMException('Import cancelled', 'AbortError'))
    }
    xhr.onload = () => {
      done()
      let body: unknown = null
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as ImportResult)
      else reject(new ApiErrorException(parseErrorBody(xhr.status || 500, body, xhr.getResponseHeader('retry-after')), xhr.status))
    }
    xhr.send(form)
  })
}
