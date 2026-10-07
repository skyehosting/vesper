/**
 * Multipart receiving (07 B6): parts are streamed to temp files while hashing (never buffered), with a per-file cap
 * from Settings, at most 2 files (the file + its client-made thumbnail), 5 fields of 64 KB, 110 MB per request
 * (more only when the caller's file cap needs it: imports, see requestCapFor).
 * Paste-from-clipboard needs nothing special: the client uploads the Blob like any file.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Transform, type Readable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyRequest } from 'fastify'
import { VesperError } from '@shared/errors'

/** Attachment uploads: request ≤ 110 MB (07 B6). */
export const MAX_REQUEST_BYTES = 110 * 1024 * 1024
/** Room for multipart boundaries, part headers and the small fields around the file(s). */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024
export const FIELD_LIMITS = { fields: 5, fieldSize: 64 * 1024 } as const

export interface TempFile {
  path: string
  sha: string
  size: number
}

export interface ReceivedUpload {
  /** Field "file" (also accepted as the first unnamed file part). */
  file: TempFile & { filename: string; declaredMime: string }
  /** Field "thumb": the client-made thumbnail (07 B6). */
  thumb: TempFile | null
  /** Field "meta": JSON {name?, width?, height?} — advisory; the server's own sniffing wins. */
  meta: { name?: string; width?: number; height?: number }
}

/** Counts and hashes bytes on their way to disk; fails the pipeline once `cap` is exceeded. */
class HashCap extends Transform {
  readonly hash = createHash('sha256')
  size = 0
  constructor(private readonly cap: number) {
    super()
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.size += chunk.length
    if (this.size > this.cap) return cb(new VesperError('payload_too_large'))
    this.hash.update(chunk)
    cb(null, chunk)
  }
}

async function toTempFile(stream: Readable & { truncated?: boolean }, dest: string, cap: number): Promise<TempFile> {
  // A body that ends before the closing boundary destroys the part before we read it ("Part terminated early"), and
  // a pipeline on an already-destroyed stream would wait forever.
  if (stream.destroyed && !stream.readableEnded) throw new VesperError('validation', { message: 'The upload was cut off. Try again.' })
  const hc = new HashCap(cap)
  await pipeline(stream, hc, fs.createWriteStream(dest, { flags: 'wx' }))
  if (stream.truncated) throw new VesperError('payload_too_large')
  return { path: dest, sha: hc.hash.digest('hex'), size: hc.size }
}

function parseMeta(raw: string): ReceivedUpload['meta'] {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new VesperError('validation', { fields: { meta: 'Not valid JSON' } })
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new VesperError('validation', { fields: { meta: 'Expected an object' } })
  const o = v as Record<string, unknown>
  const out: ReceivedUpload['meta'] = {}
  if (typeof o.name === 'string') out.name = o.name.slice(0, 500)
  if (typeof o.width === 'number' && Number.isFinite(o.width)) out.width = o.width
  if (typeof o.height === 'number' && Number.isFinite(o.height)) out.height = o.height
  return out
}

/**
 * The request cap for an upload with these file caps: 110 MB (07 B6) unless the caller's own file caps need more —
 * the import route's 200 MB file (07 B6 'Import: 200 MB cap') must not be refused by the attachment request cap (F03).
 */
export function requestCapFor(o: { maxFileBytes: number; maxThumbBytes: number }): number {
  return Math.max(MAX_REQUEST_BYTES, o.maxFileBytes + o.maxThumbBytes + MULTIPART_OVERHEAD_BYTES)
}

/**
 * Receive one attachment upload. Temp files are created with `tempPath()`; on any failure every temp file written so
 * far is removed before the error propagates.
 */
export async function receiveUpload(req: FastifyRequest, o: { tempPath(): string; maxFileBytes: number; maxThumbBytes: number }): Promise<ReceivedUpload> {
  if (!req.isMultipart()) throw new VesperError('validation', { message: 'Expected a multipart/form-data upload.' })
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > requestCapFor(o)) throw new VesperError('payload_too_large')

  const written: string[] = []
  let file: ReceivedUpload['file'] | null = null
  let thumb: TempFile | null = null
  let meta: ReceivedUpload['meta'] = {}
  try {
    const parts = req.parts({
      limits: { fileSize: Math.max(o.maxFileBytes, o.maxThumbBytes), files: 2, fields: FIELD_LIMITS.fields, fieldSize: FIELD_LIMITS.fieldSize, parts: 8, headerPairs: 50 }
    })
    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.valueTruncated) throw new VesperError('payload_too_large', { message: 'A form field is too large.' })
        if (part.fieldname === 'meta' && typeof part.value === 'string') meta = parseMeta(part.value)
        continue
      }
      const isThumb = part.fieldname === 'thumb'
      if ((isThumb && thumb) || (!isThumb && file)) {
        part.file.resume()
        throw new VesperError('validation', { message: 'Upload one file at a time.' })
      }
      const dest = o.tempPath()
      written.push(dest)
      const t = await toTempFile(part.file, dest, isThumb ? o.maxThumbBytes : o.maxFileBytes)
      if (isThumb) thumb = t
      else file = { ...t, filename: part.filename ?? '', declaredMime: part.mimetype ?? '' }
    }
    if (!file) throw new VesperError('validation', { fields: { file: 'No file in the upload' } })
    return { file, thumb, meta }
  } catch (e) {
    await Promise.all(written.map((p) => fsp.rm(p, { force: true })))
    throw clientError(e)
  }
}

/** A connection dropped mid-upload or a malformed body is the client's problem (400), not an internal error. */
function clientError(e: unknown): unknown {
  if (e instanceof VesperError) return e
  const err = e as { code?: unknown; message?: unknown; statusCode?: unknown }
  if (typeof err.statusCode === 'number') return e
  if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || (typeof err.message === 'string' && /multipart|terminated early|boundary|end of form/i.test(err.message))) {
    return new VesperError('validation', { message: 'The upload was cut off. Try again.' })
  }
  return e
}
