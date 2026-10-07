/**
 * Export (03 §3 GET /api/export, 07 C20 "Export everything"): Markdown per session or Vesper JSON.
 *   one session  → `<title> #ID.md` or `.json`
 *   everything   → a ZIP: Markdown = one file per session; JSON = `vesper-export.json` + `attachments/<sha>`.
 * Streams to a file in `exports/` page by page (500 messages) with yields (07 C9). The transcript is never exported
 * (07 A3); neither are deleted messages, off-path variants, hidden turns, trash or temporary chats.
 */
import fs from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { VesperError } from '@shared/errors'
import { formatStamp, zoneOf, type Clock as TimeClock } from '@shared/time'
import { formatShortId } from '@shared/ids'
import type { Db } from '../db/sqlite'
import type { MessageRow, Repos, SessionRow } from '../db/repos'
import { VESPER_EXPORT_FORMAT, VESPER_EXPORT_JSON, VESPER_EXPORT_VERSION, type VesperExportHeader, type VesperExportMessage, type VesperExportSession } from './format'
import type { ExportInput, ExportOutput, JobIO } from './jobs'
import { ZipWriter } from './zipio'

export interface ExportDeps {
  db: Db
  repos: Repos
  now(): number
  appVersion: string
  names: { user: string; assistant: string; clock: TimeClock }
  /** Path of a stored attachment's bytes, or null when missing. */
  attachmentPath(sha: string): string | null
}

const PAGE = 500

/** A file-system-safe name: no reserved characters, no trailing dots/spaces, bounded. */
export function safeFileName(s: string, fallback = 'Untitled'): string {
  const cleaned = s
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) || !cleaned ? fallback : cleaned
}

function stamp(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** On-path, visible messages of a session, oldest first, one page at a time. */
async function* sessionMessages(repos: Repos, s: SessionRow, io: JobIO): AsyncGenerator<MessageRow> {
  let from = 1
  for (;;) {
    const page = repos.messages.range(s.id, from, PAGE)
    if (!page.length) return
    for (const m of page) if (!m.deleted && !m.hidden) yield m
    from = page[page.length - 1].seq + 1
    await io.yield()
  }
}

function sessionsToExport(db: Db, repos: Repos, uid: string | undefined): SessionRow[] {
  if (uid !== undefined) {
    const s = repos.sessions.byUid(uid)
    if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
    return [s]
  }
  const ids = db.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL ORDER BY created_utc, id').all() as { id: number | bigint }[]
  return ids.map((r) => repos.sessions.byId(BigInt(r.id))).filter((s): s is SessionRow => s !== null)
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Markdown of one session, written through `out` piece by piece. */
async function writeMarkdown(deps: ExportDeps, s: SessionRow, out: (text: string) => Promise<void>, io: JobIO): Promise<number> {
  const { names } = deps
  const created = formatStamp(s.createdUtc, zoneOf(null, -new Date(s.createdUtc).getTimezoneOffset()), names.clock)
  await out(`# ${s.title || 'Untitled'}\n\n${formatShortId(s.shortId)} · started ${created} · ${s.messageCount} messages\n\n`)
  if (s.systemPrompt.trim()) await out(`${quote(`**System prompt:**\n${s.systemPrompt.trim()}`)}\n\n`)
  await out('---\n')
  let count = 0
  for await (const m of sessionMessages(deps.repos, s, io)) {
    const who = m.role === 'user' ? names.user : names.assistant
    const when = formatStamp(m.tsUtc, zoneOf(m.tzName, m.tzOffsetMin), names.clock)
    let block = `\n### ${who} · ${when}\n\n${m.body}\n`
    if (m.attachments.length) block += `\n${m.attachments.map((a) => `- Attachment: ${a.name} (${a.mime}, ${sizeLabel(a.size)})`).join('\n')}\n`
    await out(block)
    count++
  }
  return count
}

function exportMessage(m: MessageRow): VesperExportMessage {
  return {
    uid: m.uid,
    seq: m.seq,
    role: m.role,
    body: m.body,
    tsUtc: m.tsUtc,
    tzOffsetMin: m.tzOffsetMin,
    tzName: m.tzName,
    device: m.device,
    status: m.status,
    provider: m.provider,
    model: m.model,
    usage: m.usage,
    attachments: m.attachments.map(({ textState: _t, ...a }) => a)
  }
}

/** JSON of one session as a stream of pieces; collects the attachment SHAs it references. */
async function writeSessionJson(deps: ExportDeps, s: SessionRow, out: (text: string) => Promise<void>, shas: Set<string>, io: JobIO): Promise<number> {
  const head: Omit<VesperExportSession, 'messages'> = {
    uid: s.uid,
    shortId: s.shortId,
    title: s.title,
    createdUtc: s.createdUtc,
    updatedUtc: s.updatedUtc,
    pinned: s.pinned,
    archived: s.archived,
    private: s.private,
    memory: s.memory,
    memoryScope: s.memoryScope,
    systemPrompt: s.systemPrompt,
    summary: s.summary,
    links: deps.repos.sessions.links(s.id).map((l) => l.shortId)
  }
  const headJson = JSON.stringify(head)
  await out(`${headJson.slice(0, -1)},"messages":[`)
  let count = 0
  for await (const m of sessionMessages(deps.repos, s, io)) {
    for (const a of m.attachments) shas.add(a.sha)
    await out(`${count ? ',' : ''}${JSON.stringify(exportMessage(m))}`)
    count++
  }
  await out(']}')
  return count
}

function header(deps: ExportDeps): VesperExportHeader {
  return { format: VESPER_EXPORT_FORMAT, version: VESPER_EXPORT_VERSION, app: deps.appVersion, exportedUtc: deps.now() }
}

/** Prompt library and pinned facts, appended after the sessions. */
function libraryJson(repos: Repos): string {
  const prompts = repos.prompts.list().map((p) => ({ name: p.name, body: p.body, createdUtc: p.createdUtc, updatedUtc: p.updatedUtc }))
  const facts = repos.facts.list().map((f) => ({ text: f.text, createdUtc: f.createdUtc, updatedUtc: f.updatedUtc }))
  return `"prompts":${JSON.stringify(prompts)},"facts":${JSON.stringify(facts)}`
}

/** A plain file writer with backpressure: writes `<file>.part`, renamed to `file` when complete. */
async function withFile<T>(file: string, fn: (write: (s: string) => Promise<void>) => Promise<T>): Promise<{ result: T; bytes: number }> {
  const part = `${file}.part`
  const out = fs.createWriteStream(part, { flags: 'wx', encoding: 'utf8' })
  let failed: Error | null = null
  out.on('error', (e) => (failed ??= e))
  try {
    const result = await fn(async (s) => {
      if (failed) throw failed
      if (!out.write(s)) await once(out, 'drain')
    })
    out.end()
    await once(out, 'close')
    if (failed) throw failed
    fs.renameSync(part, file)
    return { result, bytes: fs.statSync(file).size }
  } catch (e) {
    out.destroy()
    // Closed before the caller removes the .part (on Windows an open file lingers in the folder listing).
    if (!out.closed) await once(out, 'close').catch(() => undefined)
    throw e
  }
}

/**
 * A free path for `name` in `dir`: "name.ext", else "name (2).ext", … — two exports of the same thing within one
 * second must not collide (the download name is unaffected).
 */
function freePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const p = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`)
    if (!fs.existsSync(p) && !fs.existsSync(`${p}.part`)) return p
  }
}

/**
 * Exports are written to `<file>.part` and renamed into place when complete (Phase 4): a job whose worker died
 * mid-write leaves only a `.part`, which the next export removes (bulk jobs run one at a time, JobLock).
 */
function removeStaleParts(dir: string): void {
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) fs.rmSync(path.join(dir, f), { force: true })
}

export async function runExport(deps: ExportDeps, input: ExportInput, io: JobIO): Promise<ExportOutput> {
  fs.mkdirSync(input.dir, { recursive: true })
  removeStaleParts(input.dir)
  const sessions = sessionsToExport(deps.db, deps.repos, input.sessionUid)
  const when = stamp(deps.now())
  let file = ''
  try {
    if (input.sessionUid !== undefined) {
      const s = sessions[0]
      const ext = input.format === 'md' ? 'md' : 'json'
      const fileName = `${safeFileName(s.title)} ${s.shortId}.${ext}`
      file = freePath(input.dir, `${when}-${fileName}`)
      const { result: messages, bytes } = await withFile(file, async (w) => {
        if (input.format === 'md') return writeMarkdown(deps, s, w, io)
        const h = JSON.stringify(header(deps))
        await w(`${h.slice(0, -1)},"sessions":[`)
        const n = await writeSessionJson(deps, s, w, new Set(), io)
        await w(`],"prompts":[],"facts":[]}`)
        return n
      })
      return { file, fileName, mime: input.format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json', bytes, sessions: 1, messages }
    }

    const fileName = `vesper-export-${when}${input.format === 'md' ? '-markdown' : ''}.zip`
    file = freePath(input.dir, fileName)
    const zip = new ZipWriter(`${file}.part`)
    let messages = 0
    try {
      if (input.format === 'md') {
        const used = new Set<string>()
        for (const [i, s] of sessions.entries()) {
          let name = `${safeFileName(s.title)} ${s.shortId}.md`
          if (used.has(name.toLowerCase())) name = `${i + 1} ${name}`
          used.add(name.toLowerCase())
          const e = await zip.entry(name)
          messages += await writeMarkdown(deps, s, (t) => e.write(t), io)
          await e.close()
          io.progress('export', i + 1, sessions.length)
        }
      } else {
        const shas = new Set<string>()
        const e = await zip.entry(VESPER_EXPORT_JSON)
        const h = JSON.stringify(header(deps))
        await e.write(`${h.slice(0, -1)},"sessions":[`)
        for (const [i, s] of sessions.entries()) {
          if (i) await e.write(',')
          messages += await writeSessionJson(deps, s, (t) => e.write(t), shas, io)
          io.progress('export', i + 1, sessions.length)
        }
        await e.write(`],${libraryJson(deps.repos)}}`)
        await e.close()
        for (const sha of shas) {
          const p = deps.attachmentPath(sha)
          if (p) await zip.addFile(`attachments/${sha}`, p)
          await io.yield()
        }
      }
      const bytes = await zip.finish()
      fs.renameSync(`${file}.part`, file)
      return { file, fileName, mime: 'application/zip', bytes, sessions: sessions.length, messages }
    } catch (e) {
      await zip.abort()
      throw e
    }
  } catch (e) {
    if (file) {
      fs.rmSync(`${file}.part`, { force: true })
      fs.rmSync(file, { force: true })
    }
    throw e
  }
}
