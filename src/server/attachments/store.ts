/**
 * Content-addressed attachment store (03 §2, 07 B5/B6/B9/C8): bytes at `attachments/<sha[0..2]>/<sha>` (thumbnail
 * next to it as `<sha>.thumb`), one `attachments` row per SHA-256, extracted text written ONCE at ingestion into
 * `attachment_text` (+ `attachment_fts` via triggers). Identical bytes are stored once. Temporary chats (07 B9) keep
 * their files under the temp dir and their metadata/text in memory only — never in SQLite.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { VesperError } from '@shared/errors'
import type { AttachmentRef } from '@shared/types/domain'
import type { Db } from '../db/sqlite'
import type { Repos } from '../db/repos'
import type { Clock, Log } from '../services'
import { openFileSource } from './bytes'
import type { ExtractFailure, ExtractorPool } from './extractor'
import { imageSize, imageType, isInlineType, sniff } from './sniff'

export const SHA_RE = /^[0-9a-f]{64}$/

/** Thumbnails are made by the client (07 B6); the server only checks they are small raster images. */
export const THUMB_LIMITS = { maxBytes: 512 * 1024, maxEdge: 640 } as const
const PDF_MAX_PAGES = 500

export interface IngestInput {
  /** A temp file in the store's tmp dir; ingest moves or deletes it. */
  file: string
  sha: string
  size: number
  name: string
  thumb?: { file: string; size: number } | null
  temporary?: boolean
}

export interface ServeInfo {
  path: string
  /** Content-Type to send when inline; downloads always go out as application/octet-stream. */
  mime: string
  size: number
  name: string
  inline: boolean
}

interface TempEntry {
  ref: AttachmentRef
  text: { text: string; chars: number; truncated: boolean } | null
}

interface Row {
  sha: string
  name: string
  mime: string
  size: number | bigint
  kind: AttachmentRef['kind']
  width: number | bigint | null
  height: number | bigint | null
  text_chars: number | bigint | null
  text_state: string | null
}

export interface StoreDeps {
  db: Db
  repos: Repos
  /** ctx.paths.attachments */
  root: string
  /** ctx.paths.temp (temporary chats) */
  tempRoot: string
  clock: Clock
  log: Log
  extractor: ExtractorPool
  /** Current text cap (Settings → chat.attachments.maxTextChars). */
  maxTextChars(): number
}

/** "report.pdf" from whatever the client sent: no directories, no control characters, bounded length. */
export function cleanName(raw: string | undefined | null, fallback = 'file'): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 200)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

const num = (v: number | bigint | null): number | null => (v === null ? null : Number(v))

export class AttachmentStore {
  readonly tmpDir: string
  private readonly temp = new Map<string, TempEntry>()
  private readonly extracting = new Map<string, Promise<void>>()
  private readonly getRow
  private readonly setState

  constructor(private readonly d: StoreDeps) {
    this.tmpDir = path.join(d.root, '.tmp')
    fs.mkdirSync(this.tmpDir, { recursive: true })
    this.getRow = d.db.prepare('SELECT sha, name, mime, size, kind, width, height, text_chars, text_state FROM attachments WHERE sha = ?')
    this.setState = d.db.prepare('UPDATE attachments SET text_state = ?, text_error = ? WHERE sha = ?')
    // Leftovers of uploads interrupted by a crash or a kill.
    for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { force: true })
  }

  /**
   * A fresh temp file path for an upload in progress: next to the store (same volume, so the final rename is atomic),
   * or inside the temp dir for a temporary chat, whose bytes must never touch the roaming profile (07 B9).
   */
  tempPath(temporary = false): string {
    const dir = temporary ? path.join(this.d.tempRoot, 'attachments', '.tmp') : this.tmpDir
    if (temporary) fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`)
  }

  filePath(sha: string, temporary = false): string {
    return temporary ? path.join(this.d.tempRoot, 'attachments', sha) : path.join(this.d.root, sha.slice(0, 2), sha)
  }

  thumbPath(sha: string, temporary = false): string {
    return `${this.filePath(sha, temporary)}.thumb`
  }

  /** Metadata of a stored or temporary attachment. */
  get(sha: string): AttachmentRef | null {
    if (!SHA_RE.test(sha)) return null
    const t = this.temp.get(sha)
    if (t) return { ...t.ref }
    const r = this.getRow.get(sha) as Row | undefined
    return r ? this.fromRow(r) : null
  }

  private fromRow(r: Row): AttachmentRef {
    const out: AttachmentRef = { sha: r.sha, name: r.name, mime: r.mime, size: Number(r.size), kind: r.kind }
    const w = num(r.width)
    const h = num(r.height)
    const tc = num(r.text_chars)
    if (w !== null) out.width = w
    if (h !== null) out.height = h
    if (tc !== null) out.textChars = tc
    if (r.text_state === 'ok' || r.text_state === 'truncated' || r.text_state === 'failed') out.textState = r.text_state
    return out
  }

  text(sha: string): { text: string; chars: number; truncated: boolean } | null {
    if (!SHA_RE.test(sha)) return null
    const t = this.temp.get(sha)
    if (t) return t.text
    const row = this.getRow.get(sha) as Row | undefined
    if (!row || row.text_state === 'failed') return null
    const x = this.d.repos.attachments.text(sha)
    return x ? { text: x.text, chars: x.chars, truncated: row.text_state === 'truncated' } : null
  }

  async read(sha: string): Promise<Buffer> {
    const ref = this.get(sha)
    if (!ref) throw new VesperError('not_found')
    try {
      return await fsp.readFile(this.filePath(sha, this.temp.has(sha)))
    } catch {
      throw new VesperError('not_found')
    }
  }

  /**
   * Store an uploaded file: sniff its real type (07 B5), validate images by header, move it into place (or drop it
   * when the bytes are already stored) and extract its text once. Returns the ref with THIS upload's name.
   */
  async ingest(input: IngestInput): Promise<AttachmentRef> {
    const cleanup = async () => {
      await fsp.rm(input.file, { force: true })
      if (input.thumb) await fsp.rm(input.thumb.file, { force: true })
    }
    try {
      if (!SHA_RE.test(input.sha)) throw new VesperError('validation')
      if (input.size === 0) throw new VesperError('validation', { message: 'The file is empty.' })
      const name = cleanName(input.name)
      const src = await openFileSource(input.file)
      let sniffed: Awaited<ReturnType<typeof sniff>>
      try {
        sniffed = await sniff(src, name)
      } finally {
        await src.close()
      }
      if (!sniffed.ok) {
        if (sniffed.reason === 'too-many-pixels') throw new VesperError('payload_too_large', { message: 'That image has too many pixels (more than 50 megapixels).' })
        if (sniffed.reason === 'damaged-image') throw new VesperError('unsupported_type', { message: "That image looks damaged and can't be used." })
        throw new VesperError('unsupported_type')
      }
      const s = sniffed.value
      const thumbOk = input.thumb && s.kind === 'image' ? await this.validThumb(input.thumb.file, input.thumb.size) : false

      const temporary = !!input.temporary
      const dest = this.filePath(input.sha, temporary)
      await moveInto(input.file, dest)
      if (input.thumb) {
        if (thumbOk && !fs.existsSync(this.thumbPath(input.sha, temporary))) await moveInto(input.thumb.file, this.thumbPath(input.sha, temporary))
        else await fsp.rm(input.thumb.file, { force: true })
      }

      const fresh: AttachmentRef = { sha: input.sha, name, mime: s.mime, size: input.size, kind: s.kind }
      if (s.width !== undefined) fresh.width = s.width
      if (s.height !== undefined) fresh.height = s.height

      if (temporary) {
        const existing = this.temp.get(input.sha)
        if (!existing) this.temp.set(input.sha, { ref: fresh, text: null })
        if (s.kind !== 'image' && !existing?.text) await this.extractTemp(input.sha, s.kind)
        return { ...(this.temp.get(input.sha) as TempEntry).ref, name }
      }

      if (!this.getRow.get(input.sha)) this.d.repos.attachments.upsert({ ...fresh, createdUtc: this.d.clock.now() })
      if (s.kind !== 'image') await this.extractOnce(input.sha, s.kind)
      return { ...(this.get(input.sha) as AttachmentRef), name }
    } catch (e) {
      await cleanup()
      throw e
    }
  }

  private async validThumb(file: string, size: number): Promise<boolean> {
    if (size > THUMB_LIMITS.maxBytes) throw new VesperError('validation', { message: 'The thumbnail is too large.' })
    const src = await openFileSource(file)
    try {
      const t = imageType(await src.read(0, 64))
      const d = t ? await imageSize(src, t) : null
      if (!t || !d || d.width > THUMB_LIMITS.maxEdge || d.height > THUMB_LIMITS.maxEdge) {
        throw new VesperError('validation', { message: 'The thumbnail must be a small PNG, JPEG or WebP image.' })
      }
      return true
    } finally {
      await src.close()
    }
  }

  private limits() {
    return { maxChars: this.d.maxTextChars(), maxPages: PDF_MAX_PAGES }
  }

  /** Text is extracted once per SHA (07 C8); a failed extraction is retried when the same bytes are uploaded again. */
  private extractOnce(sha: string, kind: AttachmentRef['kind']): Promise<void> {
    if (kind === 'image' || kind === 'other') return Promise.resolve()
    const running = this.extracting.get(sha)
    if (running) return running
    const row = this.getRow.get(sha) as Row | undefined
    if (row && (row.text_state === 'ok' || row.text_state === 'truncated')) return Promise.resolve()
    const p = (async () => {
      const r = await this.d.extractor.extract(this.filePath(sha), kind, this.limits())
      if (r.ok) {
        this.d.repos.attachments.setText(sha, r.extractor, r.text)
        this.setState.run(r.truncated ? 'truncated' : 'ok', null, sha)
      } else {
        this.markFailed(sha, r.code)
      }
    })().finally(() => this.extracting.delete(sha))
    this.extracting.set(sha, p)
    return p
  }

  private markFailed(sha: string, code: ExtractFailure): void {
    this.d.log.warn('attachment text extraction failed', { code })
    this.setState.run('failed', code, sha)
  }

  private async extractTemp(sha: string, kind: AttachmentRef['kind']): Promise<void> {
    const entry = this.temp.get(sha)
    if (!entry || kind === 'image' || kind === 'other') return
    const r = await this.d.extractor.extract(this.filePath(sha, true), kind, this.limits())
    if (r.ok) {
      entry.text = { text: r.text, chars: r.text.length, truncated: r.truncated }
      entry.ref.textChars = r.text.length
      entry.ref.textState = r.truncated ? 'truncated' : 'ok'
    } else {
      entry.ref.textState = 'failed'
    }
  }

  /** How to serve `sha` (07 B5); null = unknown. `thumb` falls back to the original for inline images. */
  serveInfo(sha: string, o: { thumb: boolean }): ServeInfo | null {
    const ref = this.get(sha)
    if (!ref) return null
    const temporary = this.temp.has(sha)
    if (o.thumb) {
      const tp = this.thumbPath(sha, temporary)
      const st = statOrNull(tp)
      if (st) {
        const head = readHead(tp, 16)
        const t = imageType(head)
        if (t) return { path: tp, mime: t, size: st.size, name: ref.name, inline: true }
      }
      if (!isInlineType(ref.mime)) return null
    }
    const fp = this.filePath(sha, temporary)
    const st = statOrNull(fp)
    if (!st) return null
    return { path: fp, mime: ref.mime, size: st.size, name: ref.name, inline: isInlineType(ref.mime) }
  }

  forgetTemporary(shas: readonly string[]): void {
    for (const sha of shas) {
      if (!this.temp.delete(sha)) continue
      fs.rmSync(this.filePath(sha, true), { force: true })
      fs.rmSync(this.thumbPath(sha, true), { force: true })
    }
  }

  get temporaryCount(): number {
    return this.temp.size
  }

  /**
   * Delete attachments that no message references and that are older than `olderThanUtc` (a grace period for files
   * uploaded but not sent yet), plus stray files without a row. Scans messages in pages with yields (07 C9).
   */
  async collectGarbage(olderThanUtc: number): Promise<{ removed: number }> {
    const referenced = new Set<string>()
    const page = this.d.db.prepare("SELECT id, attachments FROM messages WHERE id > ? AND attachments <> '[]' ORDER BY id LIMIT 500")
    let last = 0n
    for (;;) {
      const rows = page.all(last) as { id: number | bigint; attachments: string }[]
      if (!rows.length) break
      for (const r of rows) {
        last = BigInt(r.id)
        try {
          for (const a of JSON.parse(r.attachments) as { sha?: unknown }[]) if (typeof a?.sha === 'string') referenced.add(a.sha)
        } catch {
          /* a corrupt JSON column references nothing */
        }
      }
      await yieldLoop()
    }
    const candidates = (this.d.db.prepare('SELECT sha FROM attachments WHERE created_utc < ?').all(olderThanUtc) as { sha: string }[]).map((r) => r.sha)
    const del = this.d.db.prepare('DELETE FROM attachments WHERE sha = ?')
    const delText = this.d.db.prepare('DELETE FROM attachment_text WHERE sha = ?')
    let removed = 0
    for (const sha of candidates) {
      if (referenced.has(sha) || this.temp.has(sha)) continue
      delText.run(sha)
      del.run(sha)
      fs.rmSync(this.filePath(sha), { force: true })
      fs.rmSync(this.thumbPath(sha), { force: true })
      removed++
    }
    // Files whose row never got written (a crash between rename and insert) and are past the grace period.
    for (const dir of safeReaddir(this.d.root)) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue
      for (const f of safeReaddir(path.join(this.d.root, dir))) {
        const sha = f.replace(/\.thumb$/, '')
        if (!SHA_RE.test(sha) || this.getRow.get(sha)) continue
        const st = statOrNull(path.join(this.d.root, dir, f))
        if (st && st.mtimeMs < olderThanUtc) fs.rmSync(path.join(this.d.root, dir, f), { force: true })
      }
    }
    return { removed }
  }
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

function readHead(p: string, n: number): Buffer {
  const fd = fs.openSync(p, 'r')
  try {
    const b = Buffer.alloc(n)
    const got = fs.readSync(fd, b, 0, n, 0)
    return b.subarray(0, got)
  } finally {
    fs.closeSync(fd)
  }
}

/** Move a temp file to `dest`, or drop it when `dest` already holds the same content (dedupe). */
async function moveInto(src: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    await fsp.rm(src, { force: true })
    return
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fsp.rename(src, dest)
  } catch (e) {
    // A concurrent upload of the same bytes won the race; ours is redundant.
    if (fs.existsSync(dest)) await fsp.rm(src, { force: true })
    else if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await fsp.copyFile(src, dest)
      await fsp.rm(src, { force: true })
    } else throw e
  }
}
