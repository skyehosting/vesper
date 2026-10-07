/**
 * Streaming ZIP in and out (fflate, no buffering of whole archives).
 *   ZipWriter — entries are written one after another; output goes to a file with backpressure.
 *   readZip   — walks an archive file chunk by chunk and hands each wanted entry's bytes to a sink, enforcing
 *               per-entry and total caps on the INFLATED size (zip-bomb safe even when the headers lie). The archive
 *               is pushed in ZIP_PUSH_SLICE pieces so the memory used before a cap fires stays bounded too (F02).
 */
import fs from 'node:fs'
import { once } from 'node:events'
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, type UnzipFile } from 'fflate'
import { VesperError } from '@shared/errors'

export class ZipWriter {
  private readonly out: fs.WriteStream
  private readonly zip: Zip
  private pending: Uint8Array[] = []
  private error: Error | null = null
  private finished = false
  bytes = 0

  constructor(readonly file: string) {
    this.out = fs.createWriteStream(file, { flags: 'wx' })
    this.out.on('error', (e) => (this.error ??= e))
    this.zip = new Zip((err, chunk, final) => {
      if (err) this.error ??= err
      else this.pending.push(chunk)
      if (final) this.finished = true
    })
  }

  private async flush(): Promise<void> {
    if (this.error) throw this.error
    const chunks = this.pending
    this.pending = []
    for (const c of chunks) {
      this.bytes += c.length
      if (!this.out.write(c)) await once(this.out, 'drain')
      if (this.error) throw this.error
    }
  }

  /** Start an entry; push its data with `write`, end it with `close`. `store` skips compression (images, zips). */
  async entry(name: string, o: { store?: boolean } = {}): Promise<{ write(data: Uint8Array | string): Promise<void>; close(): Promise<void> }> {
    const f = o.store ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 })
    this.zip.add(f)
    const enc = new TextEncoder()
    return {
      write: async (data) => {
        f.push(typeof data === 'string' ? enc.encode(data) : data, false)
        await this.flush()
      },
      close: async () => {
        f.push(new Uint8Array(0), true)
        await this.flush()
      }
    }
  }

  /** Copy a file from disk into the archive as one entry. */
  async addFile(name: string, src: string, o: { store?: boolean } = {}): Promise<void> {
    const e = await this.entry(name, o)
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 256 * 1024 })) await e.write(chunk as Buffer)
    await e.close()
  }

  async finish(): Promise<number> {
    this.zip.end()
    await this.flush()
    if (!this.finished) throw new Error('zip did not finish')
    this.out.end()
    await once(this.out, 'close')
    if (this.error) throw this.error
    return this.bytes
  }

  /** Abandon a half-written archive (the caller deletes the file). */
  async abort(): Promise<void> {
    this.zip.terminate()
    this.out.destroy()
    await once(this.out, 'close').catch(() => undefined)
  }
}

export interface ZipEntrySink {
  /** Called with inflated data; return false to stop reading this entry. */
  data(chunk: Uint8Array): void
  end(): void
}

export interface ReadZipOptions {
  /** Decide per entry name: a sink to receive its bytes, or null to skip it. */
  open(name: string): ZipEntrySink | null
  /** Maximum inflated bytes of one entry / of all wanted entries together. */
  maxEntryBytes: (name: string) => number
  maxTotalBytes: number
}

/**
 * Archive bytes handed to fflate per push (F02). fflate inflates ALL of a pushed chunk in one call before `ondata`
 * (and so the caps) can run; deflate expands at most ~1032:1, so one push of 16 KiB produces at most ~16.5 MiB.
 */
export const ZIP_PUSH_SLICE = 16 * 1024

/** Read the wanted entries of a ZIP file. Throws VesperError('payload_too_large') when an inflated cap is exceeded. */
export async function readZip(file: string, o: ReadZipOptions): Promise<void> {
  let total = 0
  let failure: Error | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (f: UnzipFile) => {
    if (failure || f.name.endsWith('/')) return
    const sink = o.open(f.name)
    if (!sink) return
    const cap = o.maxEntryBytes(f.name)
    let size = 0
    f.ondata = (err, chunk, final) => {
      if (failure) return
      if (err) {
        failure = new VesperError('validation', { message: 'The archive is damaged.' })
        return
      }
      size += chunk.length
      total += chunk.length
      if (size > cap || total > o.maxTotalBytes) {
        failure = new VesperError('payload_too_large', { message: 'The archive unpacks to more than Vesper accepts.' })
        f.terminate()
        return
      }
      if (chunk.length) sink.data(chunk)
      if (final) sink.end()
    }
    try {
      f.start()
    } catch {
      // Unsupported compression method (e.g. LZMA): treated like a damaged archive.
      failure = new VesperError('validation', { message: 'The archive uses an unsupported compression method.' })
    }
  }
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const buf = chunk as Buffer
    for (let i = 0; i < buf.length; i += ZIP_PUSH_SLICE) {
      unzip.push(buf.subarray(i, i + ZIP_PUSH_SLICE), false)
      if (failure) throw failure
    }
  }
  unzip.push(new Uint8Array(0), true)
  if (failure) throw failure
}
