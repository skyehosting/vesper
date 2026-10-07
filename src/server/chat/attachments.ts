/**
 * Attachment bytes/text for request rendering (07 C8). content-server is the single source (ctx.services.content:
 * stored files, and a temporary chat's files in the temp dir, 07 B9); the extracted text was written once at
 * ingestion. Bytes are frozen at ingestion, so a replay renders the same request bytes.
 *
 * Adapters render synchronously, so a round first `preload`s the images/documents its request references (async reads
 * through content-server) and then renders inside `rendering(pinned, …)`. A small LRU keeps recently sent files in
 * memory (a tool loop re-sends the same images several times); it is bounded by bytes and dropped on close. Files too
 * large for the LRU are pinned only for the duration of one synchronous render.
 * Without content-server (unit tests of other areas) the files are read from their content-addressed paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AttachmentSource } from '../providers/llm/types'
import type { ServerContext } from '../services'
import { derivedBoundary } from './untrusted'

const CACHE_BYTES = 48 * 1024 * 1024
const BOUNDARY_KEY = 'chat.boundaryKey'
const SHA_RE = /^[0-9a-f]{64}$/

export interface AttachmentCache extends AttachmentSource {
  /** Read these attachments' bytes (small ones join the LRU); resolves to every file found, for `rendering`. */
  preload(shas: Iterable<string>): Promise<Map<string, Buffer>>
  /** Run a synchronous render with `pinned` visible to `bytes()` (large files never enter the LRU). */
  rendering<T>(pinned: Map<string, Buffer>, fn: () => T): T
  clear(): void
  readonly cachedBytes: number
}

export function createAttachmentSource(ctx: ServerContext): AttachmentCache {
  const lru = new Map<string, Buffer>()
  let total = 0
  let overlay: Map<string, Buffer> | null = null
  let secret = ctx.repos.kv.get<string>(BOUNDARY_KEY)
  if (!secret) {
    secret = randomBytes(16).toString('hex')
    ctx.repos.kv.set(BOUNDARY_KEY, secret)
  }
  const key = secret

  /** Fallback without content-server: the stored file (not a thumbnail), else a temporary chat's file. */
  function find(sha: string): string | null {
    if (!SHA_RE.test(sha)) return null
    const dir = path.join(ctx.paths.attachments, sha.slice(0, 2))
    try {
      const name = fs.readdirSync(dir).find((f) => f === sha || (f.startsWith(`${sha}.`) && !f.startsWith(`${sha}.thumb`)))
      if (name) return path.join(dir, name)
    } catch {
      /* not stored */
    }
    const temp = path.join(ctx.paths.temp, 'attachments', sha)
    return fs.existsSync(temp) ? temp : null
  }

  function remember(sha: string, buf: Buffer): void {
    if (buf.length > CACHE_BYTES / 4 || lru.has(sha)) return
    lru.set(sha, buf)
    total += buf.length
    for (const [k, v] of lru) {
      if (total <= CACHE_BYTES) break
      lru.delete(k)
      total -= v.length
    }
  }

  function cached(sha: string): Buffer | null {
    const pinned = overlay?.get(sha)
    if (pinned) return pinned
    const hit = lru.get(sha)
    if (!hit) return null
    lru.delete(sha)
    lru.set(sha, hit)
    return hit
  }

  return {
    async preload(shas) {
      const out = new Map<string, Buffer>()
      const content = ctx.services.content
      for (const sha of new Set(shas)) {
        if (!SHA_RE.test(sha)) continue
        const hit = cached(sha)
        if (hit) {
          out.set(sha, hit)
          continue
        }
        let buf: Buffer | null = null
        try {
          buf = content ? await content.readAttachment(sha) : null
        } catch {
          buf = null // unknown/removed: the adapter renders its "[image: …]" stand-in
        }
        if (!buf) {
          const file = find(sha)
          try {
            buf = file ? await fs.promises.readFile(file) : null
          } catch {
            buf = null
          }
        }
        if (!buf) continue
        remember(sha, buf)
        out.set(sha, buf)
      }
      return out
    },
    rendering(pinned, fn) {
      const prev = overlay
      overlay = pinned
      try {
        return fn()
      } finally {
        overlay = prev
      }
    },
    bytes(sha) {
      const hit = cached(sha)
      if (hit) return hit
      // Not preloaded (e.g. a test rendering directly): read synchronously.
      const file = find(sha)
      if (!file) return null
      try {
        const buf = fs.readFileSync(file)
        remember(sha, buf)
        return buf
      } catch {
        return null
      }
    },
    text(sha) {
      const content = ctx.services.content
      if (content) {
        try {
          const t = content.attachmentText(sha)
          if (t) return t.text
        } catch {
          /* fall back to the table */
        }
      }
      return ctx.repos.attachments.text(sha)?.text ?? null
    },
    boundary(sha) {
      return derivedBoundary(key, `file:${sha}`)
    },
    clear() {
      lru.clear()
      overlay = null
      total = 0
    },
    get cachedBytes() {
      return total
    }
  }
}
