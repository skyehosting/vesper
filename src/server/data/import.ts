/**
 * Import (03 §3 POST /api/import, 07 A4/B6): a Vesper export (JSON or ZIP with attachments), a ChatGPT data export
 * (`conversations.json` or the ZIP containing it) or a Claude.ai export. Every conversation becomes a NEW session
 * (new uid and short id) with the original timestamps, `device: 'import'` on every message and
 * `meta.imported = {source, key, utc}` on the session; a conversation imported before is skipped. Messages are written
 * in transactions of ≤ 500 rows with yields (07 C9). Imported text is stored, never rendered or executed; it is not
 * queued for embedding — the backfill consent flow (07 C12) offers that.
 * Attachments come only from archive CONTENT (`attachments/<sha>`, re-hashed), never from paths in the file.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { VesperError } from '@shared/errors'
import type { ImportResult } from '@shared/api'
import { ianaZone, isValidZoneName } from '@shared/time'
import type { AttachmentRef } from '@shared/types/domain'
import { tx, type Db } from '../db/sqlite'
import type { Repos } from '../db/repos'
import type { Log } from '../services'
import { exportDocSchema, VESPER_EXPORT_JSON, type ImportConversation } from './format'
import type { ImportInput, JobIO } from './jobs'
import { detectSource, readChatGpt, readClaude, readVesper, type ImportSource } from './sources'
import { readZip } from './zipio'

export const IMPORT_LIMITS = {
  /** Upload cap (07 B6). */
  maxUploadBytes: 200 * 1024 * 1024,
  /** Inflated JSON document inside an archive. */
  maxJsonBytes: 400 * 1024 * 1024,
  /** Everything inflated from one archive. */
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  rowsPerTx: 500
} as const

export interface ImportDeps {
  db: Db
  repos: Repos
  now(): number
  log: Log
  /** IANA zone used for messages that carry none (ChatGPT/Claude): the PC's zone at each message's instant. */
  zone: string
  /** Max bytes of one imported attachment (Settings → chat.attachments.maxFileMb). */
  maxAttachmentBytes: number
  /** A temp file path in the attachment store's tmp dir. */
  tempPath(): string
  /** Store a file as an attachment (sniffed, deduplicated, text extracted); null when refused. */
  ingestFile(file: { path: string; sha: string; size: number; name: string }): Promise<AttachmentRef | null>
}

interface Loaded {
  doc: unknown
  /** sha → temp file, for Vesper archives. */
  files: Map<string, { path: string; size: number }>
}

const isConversationsJson = (name: string) => /(^|\/)conversations\.json$/i.test(name) && name.split('/').length <= 2

async function load(deps: ImportDeps, file: string): Promise<Loaded> {
  const fh = await fsp.open(file, 'r')
  const head = Buffer.alloc(4)
  try {
    await fh.read(head, 0, 4, 0)
  } finally {
    await fh.close()
  }
  const files = new Map<string, { path: string; size: number }>()
  let jsonChunks: Buffer[] = []
  if (head.readUInt32LE(0) === 0x04034b50) {
    const state = { found: null as string | null }
    /** Entries being written (fd → temp path): closed and removed if the archive turns out bad. */
    const openFds = new Map<number, string>()
    const discard = () => {
      for (const [fd, p] of openFds) {
        fs.closeSync(fd)
        fs.rmSync(p, { force: true })
      }
      openFds.clear()
      for (const f of files.values()) fs.rmSync(f.path, { force: true })
      files.clear()
    }
    try {
      await readZip(file, {
        maxTotalBytes: IMPORT_LIMITS.maxTotalBytes,
        maxEntryBytes: (name) => (name.startsWith('attachments/') ? deps.maxAttachmentBytes : IMPORT_LIMITS.maxJsonBytes),
        open(name) {
          if (name === VESPER_EXPORT_JSON || (isConversationsJson(name) && state.found !== VESPER_EXPORT_JSON)) {
            state.found = name
            jsonChunks = []
            return { data: (c) => void jsonChunks.push(Buffer.from(c)), end: () => undefined }
          }
          const m = /^attachments\/([0-9a-f]{64})$/.exec(name)
          if (!m) return null
          const p = deps.tempPath()
          const fd = fs.openSync(p, 'wx')
          openFds.set(fd, p)
          const hash = createHash('sha256')
          let size = 0
          return {
            data(c) {
              hash.update(c)
              size += c.length
              fs.writeSync(fd, c)
            },
            end() {
              openFds.delete(fd)
              fs.closeSync(fd)
              // Only content whose hash matches its name is accepted (a tampered archive can't alias files).
              if (hash.digest('hex') === m[1]) files.set(m[1], { path: p, size })
              else fs.rmSync(p, { force: true })
            }
          }
        }
      })
    } catch (e) {
      discard()
      throw e
    }
    if (!state.found) {
      discard()
      throw new VesperError('unsupported_type', { message: 'That archive has no conversations.json or vesper-export.json.' })
    }
  } else {
    jsonChunks = [await fsp.readFile(file)]
  }
  let doc: unknown
  try {
    doc = JSON.parse(Buffer.concat(jsonChunks).toString('utf8').replace(/^﻿/, ''))
  } catch {
    for (const f of files.values()) fs.rmSync(f.path, { force: true })
    throw new VesperError('unsupported_type', { message: "That file isn't valid JSON." })
  }
  return { doc, files }
}

/** Remove a partially written session (an import interrupted by shutdown). */
function dropSession(db: Db, sid: bigint): void {
  tx(db, () => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
    db.prepare('DELETE FROM branch_choices WHERE session_id = ?').run(sid)
    db.prepare('DELETE FROM branches WHERE session_id = ?').run(sid)
    db.prepare('DELETE FROM session_links WHERE from_session = ? OR to_session = ?').run(sid, sid)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
  })
}

function importedKeys(db: Db): Set<string> {
  const rows = db.prepare(`SELECT json_extract(meta, '$.imported.key') AS k FROM sessions WHERE deleted_utc IS NULL AND meta LIKE '%"imported"%'`).all() as { k: string | null }[]
  return new Set(rows.map((r) => r.k).filter((k): k is string => typeof k === 'string'))
}

export async function runImport(deps: ImportDeps, input: ImportInput, io: JobIO): Promise<ImportResult> {
  const { db, repos } = deps
  const loaded = await load(deps, input.file)
  const result: ImportResult = { sessions: 0, messages: 0, attachments: 0, skipped: 0, source: 'chatgpt' }
  try {
    const source: ImportSource | null = detectSource(loaded.doc)
    if (!source) throw new VesperError('unsupported_type', { message: "That file isn't a ChatGPT, Claude or Vesper export." })
    result.source = source

    let conversations: Iterable<ImportConversation>
    let total: number
    let library: { prompts: { name: string; body: string }[]; facts: { text: string }[] } | null = null
    if (source === 'vesper') {
      const d = exportDocSchema.safeParse(loaded.doc)
      if (!d.success) throw new VesperError('validation', { message: "That Vesper export can't be read (unknown version or damaged)." })
      conversations = readVesper(d.data.sessions, result)
      total = d.data.sessions.length
      library = { prompts: d.data.prompts, facts: d.data.facts }
    } else {
      const arr = loaded.doc as unknown[]
      conversations = source === 'chatgpt' ? readChatGpt(arr, result) : readClaude(arr, result)
      total = arr.length
    }

    // Attachments of a Vesper archive: stored by content first, so message refs can point at them.
    const available = new Map<string, AttachmentRef>()
    for (const [sha, f] of loaded.files) {
      const ref = await deps.ingestFile({ path: f.path, sha, size: f.size, name: sha })
      loaded.files.delete(sha)
      if (ref) {
        available.set(sha, ref)
        result.attachments++
      }
      await io.yield()
    }

    const zone = isValidZoneName(deps.zone) ? ianaZone(deps.zone) : ianaZone('UTC')
    const seen = importedKeys(db)
    const now = deps.now()
    const shortIdMap = new Map<string, bigint>()
    const pendingLinks: { from: bigint; to: string[] }[] = []
    let done = 0
    for (const conv of conversations) {
      done++
      io.progress('import', done, total)
      if (seen.has(conv.key) || !conv.messages.length) {
        result.skipped++
        continue
      }
      // Importing Vesper's own export back into the same Vesper: the original session is still here.
      if (source === 'vesper' && conv.key.startsWith('vesper:') && repos.sessions.byUid(conv.key.slice(7))) {
        result.skipped++
        continue
      }
      const s = repos.sessions.create({
        title: conv.title,
        systemPrompt: conv.systemPrompt ?? '',
        private: conv.private ?? false,
        meta: { imported: { source, key: conv.key, utc: now } },
        now: conv.createdUtc > 0 ? conv.createdUtc : now
      })
      try {
        for (let i = 0; i < conv.messages.length; ) {
          const end = Math.min(conv.messages.length, i + IMPORT_LIMITS.rowsPerTx)
          const batch = conv.messages.slice(i, end)
          // Files to ingest are prepared outside the transaction (ingestion is async and may run the extractor).
          const refs: AttachmentRef[][] = []
          for (const m of batch) {
            const list: AttachmentRef[] = []
            for (const a of m.attachments ?? []) {
              const have = available.get(a.sha) ?? repos.attachments.get(a.sha)
              if (have) list.push({ ...have, name: a.name || have.name })
            }
            for (const f of m.textFiles ?? []) {
              const ref = await ingestText(deps, f.name, f.text)
              if (ref) {
                list.push(ref)
                result.attachments++
              }
            }
            refs.push(list)
          }
          tx(db, () => {
            batch.forEach((m, k) => {
              const ts = Number.isFinite(m.tsUtc) && m.tsUtc > 0 ? m.tsUtc : conv.createdUtc || now
              const tz = m.tz ?? { offsetMin: zone.partsAt(ts).offsetMin, name: zone.name }
              repos.messages.append({
                sessionId: s.id,
                role: m.role,
                body: m.body,
                tsUtc: ts,
                tzOffsetMin: tz.offsetMin,
                tzName: tz.name,
                device: 'import',
                status: 'complete',
                provider: m.provider ?? null,
                model: m.model ?? null,
                attachments: refs[k]
              })
            })
          })
          result.messages += batch.length
          i = end
          await io.yield()
        }
        repos.sessions.update(s.id, {
          pinned: conv.pinned ?? false,
          archived: conv.archived ?? false,
          memory: conv.memory ?? 'inherit',
          memoryScope: conv.memoryScope ?? 'inherit',
          ...(conv.summary ? { summary: conv.summary } : {})
        })
      } catch (e) {
        dropSession(db, s.id)
        throw e
      }
      seen.add(conv.key)
      result.sessions++
      if (conv.oldShortId) shortIdMap.set(conv.oldShortId, s.id)
      if (conv.links?.length) pendingLinks.push({ from: s.id, to: conv.links })
    }

    io.progress('import', total, total)

    // Links between imported sessions, remapped to their new ids (links to sessions not in the file are dropped).
    for (const l of pendingLinks) {
      for (const old of l.to) {
        const to = shortIdMap.get(old)
        if (to !== undefined && to !== l.from) repos.sessions.addLink(l.from, to, now)
      }
    }
    if (library) importLibrary(deps, library, now)
    return result
  } finally {
    for (const f of loaded.files.values()) fs.rmSync(f.path, { force: true })
  }
}

async function ingestText(deps: ImportDeps, name: string, text: string): Promise<AttachmentRef | null> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0 || bytes.length > deps.maxAttachmentBytes) return null
  const p = deps.tempPath()
  await fsp.writeFile(p, bytes, { flag: 'wx' })
  const sha = createHash('sha256').update(bytes).digest('hex')
  return deps.ingestFile({ path: p, sha, size: bytes.length, name: /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.txt` })
}

/** Prompts (a name that exists already gets " (imported)") and pinned facts (exact duplicates skipped). */
function importLibrary(deps: ImportDeps, lib: { prompts: { name: string; body: string }[]; facts: { text: string }[] }, now: number): void {
  const { repos } = deps
  const names = new Set(repos.prompts.list().map((p) => p.name.toLowerCase()))
  for (const p of lib.prompts) {
    let name = p.name.trim().slice(0, 80)
    if (!name) continue
    if (names.has(name.toLowerCase())) {
      const existing = repos.prompts.list().find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (existing?.body === p.body) continue
      name = `${name.slice(0, 68)} (imported)`
      if (names.has(name.toLowerCase())) continue
    }
    repos.prompts.create(name, p.body, now)
    names.add(name.toLowerCase())
  }
  const facts = new Set(repos.facts.list().map((f) => f.text))
  for (const f of lib.facts) {
    if (facts.has(f.text)) continue
    repos.facts.create(f.text, now)
    facts.add(f.text)
  }
}
