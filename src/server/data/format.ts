/**
 * The Vesper export format (JSON, version 1) and the normalized shape every importer produces.
 *
 * Exported: sessions that are not in the trash, the messages of each session's ACTIVE path (no off-path variants,
 * no deleted tombstones, no hidden system-made turns), the prompt library and pinned facts. Never exported: the wire
 * transcript (07 A3), epochs/recaps, vectors, devices, settings and secrets. Temporary chats never reach the DB.
 */
import { z } from 'zod'
import type { AttachmentRef, MemoryMode, Role, Usage } from '@shared/types/domain'

export const VESPER_EXPORT_FORMAT = 'vesper-export'
export const VESPER_EXPORT_VERSION = 1
/** Name of the JSON document inside an export archive. */
export const VESPER_EXPORT_JSON = 'vesper-export.json'

export interface VesperExportMessage {
  uid: string
  seq: number
  role: Role
  body: string
  tsUtc: number
  tzOffsetMin: number
  tzName: string | null
  device: string | null
  status: string
  provider: string | null
  model: string | null
  usage: Usage | null
  attachments: AttachmentRef[]
}

export interface VesperExportSession {
  uid: string
  shortId: string
  title: string
  createdUtc: number
  updatedUtc: number
  pinned: boolean
  archived: boolean
  private: boolean
  memory: MemoryMode
  memoryScope: string
  systemPrompt: string
  summary: string | null
  /** Short ids of the sessions this one may recall. */
  links: string[]
  messages: VesperExportMessage[]
}

export interface VesperExportHeader {
  format: typeof VESPER_EXPORT_FORMAT
  version: typeof VESPER_EXPORT_VERSION
  app: string
  exportedUtc: number
}

// ── Validation of incoming Vesper exports (07 B6: zod-validated, new ids) ─────────────────────────
const attachmentRef = z.looseObject({
  sha: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().max(500),
  mime: z.string().max(200),
  size: z.number().int().nonnegative(),
  kind: z.enum(['image', 'pdf', 'docx', 'text', 'other'])
})

const exportMessage = z.looseObject({
  role: z.enum(['user', 'assistant']),
  body: z.string().max(5_000_000),
  tsUtc: z.number().finite(),
  tzOffsetMin: z.number().int().min(-900).max(900).catch(0),
  tzName: z.string().max(64).nullable().catch(null),
  provider: z.string().max(100).nullable().optional().catch(null),
  model: z.string().max(200).nullable().optional().catch(null),
  attachments: z.array(attachmentRef).max(50).catch([])
})

export const exportSessionSchema = z.looseObject({
  uid: z.string().max(64).optional(),
  shortId: z.string().max(20).optional(),
  title: z.string().max(500).catch(''),
  createdUtc: z.number().finite(),
  pinned: z.boolean().catch(false),
  archived: z.boolean().catch(false),
  private: z.boolean().catch(false),
  memory: z.enum(['inherit', 'on', 'off']).catch('inherit'),
  memoryScope: z.enum(['inherit', 'this', 'linked', 'all']).catch('inherit'),
  systemPrompt: z.string().max(100_000).catch(''),
  summary: z.string().max(10_000).nullable().catch(null),
  links: z.array(z.string().max(20)).max(1000).catch([]),
  messages: z.array(z.unknown()).max(5_000_000)
})

export const exportDocSchema = z.looseObject({
  format: z.literal(VESPER_EXPORT_FORMAT),
  version: z.number().int().min(1).max(VESPER_EXPORT_VERSION),
  sessions: z.array(z.unknown()).max(1_000_000),
  prompts: z.array(z.looseObject({ name: z.string().min(1).max(80), body: z.string().max(100_000) })).max(10_000).catch([]),
  facts: z.array(z.looseObject({ text: z.string().min(1).max(10_000) })).max(10_000).catch([])
})

export function parseExportMessage(v: unknown): z.infer<typeof exportMessage> | null {
  const r = exportMessage.safeParse(v)
  return r.success ? r.data : null
}

// ── Normalized import shape ─────────────────────────────────────────────────────────────────────
export interface ImportMessage {
  role: Role
  body: string
  tsUtc: number
  /** Known zone of the sender (Vesper exports); null = use the PC's zone at that instant. */
  tz?: { offsetMin: number; name: string | null }
  model?: string | null
  provider?: string | null
  attachments?: AttachmentRef[]
  /** Text files to ingest as attachments of this message (Claude's extracted file contents). */
  textFiles?: { name: string; text: string }[]
}

export interface ImportConversation {
  /** Dedupe key: `<source>:<original id>` — a conversation imported before is skipped. */
  key: string
  title: string
  createdUtc: number
  messages: ImportMessage[]
  systemPrompt?: string
  pinned?: boolean
  archived?: boolean
  private?: boolean
  memory?: MemoryMode
  memoryScope?: 'inherit' | 'this' | 'linked' | 'all'
  summary?: string | null
  /** Vesper exports: the original short id and outgoing links (remapped to the new ids). */
  oldShortId?: string
  links?: string[]
}
