/**
 * Bounded random access to an uploaded file. Sniffing, image header probing and the ZIP central-directory check read
 * only a few small windows of the file, never the whole thing (07 B6: no decoding in the server process).
 */
import fs from 'node:fs/promises'

export interface ByteSource {
  readonly size: number
  /** Up to `len` bytes starting at `pos` (fewer at the end of the file). */
  read(pos: number, len: number): Promise<Buffer>
}

export function bufferSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    read: async (pos, len) => buf.subarray(Math.max(0, pos), Math.min(buf.length, Math.max(0, pos) + Math.max(0, len)))
  }
}

/** Open `file` for bounded reads; always `close()` it (the handle is the only resource). */
export async function openFileSource(file: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await fs.open(file, 'r')
  try {
    const { size } = await fh.stat()
    return {
      size,
      async read(pos, len) {
        const start = Math.max(0, pos)
        const n = Math.max(0, Math.min(len, size - start))
        if (n === 0) return Buffer.alloc(0)
        const buf = Buffer.alloc(n)
        const { bytesRead } = await fh.read(buf, 0, n, start)
        return buf.subarray(0, bytesRead)
      },
      close: () => fh.close()
    }
  } catch (e) {
    await fh.close()
    throw e
  }
}
