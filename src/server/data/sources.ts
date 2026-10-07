/**
 * Readers for the import sources (07 A4): ChatGPT `conversations.json`, the Claude.ai export `conversations.json`, and
 * Vesper's own export. Each turns one conversation into an ImportConversation (original timestamps, the conversation's
 * current branch only, consecutive turns of one role merged). Content is only ever TEXT here — nothing is rendered,
 * fetched or executed; tool calls, code-interpreter runs, browsing results, hidden context and reasoning are dropped.
 * A malformed conversation is skipped (and counted), never fatal.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Role } from '@shared/types/domain'
import { exportSessionSchema, parseExportMessage, type ImportConversation, type ImportMessage } from './format'

export type ImportSource = 'vesper' | 'chatgpt' | 'claude'

const MAX_PATH = 200_000

/** Which format a parsed document is, or null. */
export function detectSource(doc: unknown): ImportSource | null {
  if (typeof doc === 'object' && doc !== null && !Array.isArray(doc) && (doc as { format?: unknown }).format === 'vesper-export') return 'vesper'
  if (!Array.isArray(doc)) return null
  const first = doc.find((x) => typeof x === 'object' && x !== null) as Record<string, unknown> | undefined
  if (!first) return doc.length === 0 ? 'chatgpt' : null
  if ('mapping' in first) return 'chatgpt'
  if ('chat_messages' in first) return 'claude'
  return null
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24)
}

/** Join consecutive turns of the same role (assistant text split around a tool call, multi-part user turns). */
export function mergeRuns(msgs: ImportMessage[]): ImportMessage[] {
  const out: ImportMessage[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      prev.body = `${prev.body}\n\n${m.body}`.trim()
      if (m.attachments?.length) prev.attachments = [...(prev.attachments ?? []), ...m.attachments]
      if (m.textFiles?.length) prev.textFiles = [...(prev.textFiles ?? []), ...m.textFiles]
    } else out.push({ ...m })
  }
  return out
}

/** Seconds (ChatGPT) → ms; null for missing/invalid values. */
function secToMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null
}

function isoToMs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// ── ChatGPT ─────────────────────────────────────────────────────────────────────────────────────
const gptNode = z.looseObject({
  id: z.string().optional(),
  parent: z.string().nullable().optional(),
  children: z.array(z.string()).optional().catch([]),
  message: z
    .looseObject({
      author: z.looseObject({ role: z.string() }),
      create_time: z.number().nullable().optional().catch(null),
      content: z.looseObject({ content_type: z.string().optional().catch(''), parts: z.array(z.unknown()).optional().catch([]), text: z.string().optional().catch(undefined) }).optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
      recipient: z.string().nullable().optional().catch(null)
    })
    .nullable()
    .optional()
    .catch(null)
})

const gptConversation = z.looseObject({
  title: z.string().nullable().optional().catch(null),
  create_time: z.number().nullable().optional().catch(null),
  mapping: z.record(z.string(), z.unknown()),
  current_node: z.string().nullable().optional().catch(null),
  conversation_id: z.string().nullable().optional().catch(null),
  id: z.string().nullable().optional().catch(null)
})

type GptNode = z.infer<typeof gptNode>

function gptText(msg: NonNullable<GptNode['message']>): string | null {
  const c = msg.content
  if (!c) return null
  const type = c.content_type ?? ''
  if (type === 'text' || type === 'multimodal_text') {
    const pieces: string[] = []
    for (const p of c.parts ?? []) {
      if (typeof p === 'string') pieces.push(p)
      else if (typeof p === 'object' && p !== null) {
        const ct = (p as { content_type?: unknown }).content_type
        if (ct === 'image_asset_pointer') pieces.push('[image]')
        else if (ct === 'audio_transcription' && typeof (p as { text?: unknown }).text === 'string') pieces.push((p as { text: string }).text)
      }
    }
    return pieces.join('\n')
  }
  return null
}

export function* readChatGpt(doc: unknown[], stats: { skipped: number }): Generator<ImportConversation> {
  for (const raw of doc) {
    const conv = gptConversation.safeParse(raw)
    if (!conv.success) {
      stats.skipped++
      continue
    }
    const c = conv.data
    const nodes = new Map<string, GptNode>()
    for (const [k, v] of Object.entries(c.mapping)) {
      const n = gptNode.safeParse(v)
      if (n.success) nodes.set(n.data.id ?? k, n.data)
    }
    // The visible branch: from current_node up to the root (cycle- and depth-safe); else follow last children down.
    let path: GptNode[] = []
    const seen = new Set<string>()
    let cur = c.current_node ?? null
    while (cur && nodes.has(cur) && !seen.has(cur) && seen.size < MAX_PATH) {
      seen.add(cur)
      const n = nodes.get(cur) as GptNode
      path.push(n)
      cur = n.parent ?? null
    }
    path.reverse()
    if (!path.length) {
      let node = [...nodes.values()].find((n) => !n.parent) ?? null
      while (node && path.length < MAX_PATH) {
        path.push(node)
        const next: string | undefined = node.children?.[node.children.length - 1]
        node = next ? (nodes.get(next) ?? null) : null
      }
    }
    const created = secToMs(c.create_time) ?? 0
    let lastTs = created
    const msgs: ImportMessage[] = []
    for (const n of path) {
      const m = n.message
      if (!m) continue
      const role = m.author.role
      if (role !== 'user' && role !== 'assistant') continue
      if (m.recipient && m.recipient !== 'all') continue
      const meta = m.metadata ?? {}
      if (meta.is_visually_hidden_from_conversation === true || meta.is_user_system_message === true) continue
      const text = gptText(m)
      if (text === null || !text.trim()) continue
      const ts = secToMs(m.create_time) ?? lastTs
      lastTs = ts
      msgs.push({ role: role as Role, body: text.trim(), tsUtc: ts, model: role === 'assistant' && typeof meta.model_slug === 'string' ? meta.model_slug.slice(0, 200) : null })
    }
    const original = c.conversation_id ?? c.id ?? shortHash(`${c.title ?? ''}|${c.create_time ?? ''}|${msgs[0]?.body ?? ''}`)
    yield {
      key: `chatgpt:${original}`,
      title: (c.title ?? '').trim().slice(0, 200) || 'Imported ChatGPT chat',
      createdUtc: created || msgs[0]?.tsUtc || 0,
      messages: mergeRuns(msgs)
    }
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────────────────────────
const claudeMessage = z.looseObject({
  uuid: z.string().optional(),
  text: z.string().optional().catch(''),
  sender: z.string(),
  created_at: z.string().optional(),
  parent_message_uuid: z.string().nullable().optional().catch(null),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional().catch(undefined) })).optional().catch(undefined),
  attachments: z.array(z.looseObject({ file_name: z.string().optional().catch('file'), extracted_content: z.string().optional().catch(undefined) })).optional().catch([]),
  files: z.array(z.looseObject({ file_name: z.string().optional() })).optional().catch([])
})

const claudeConversation = z.looseObject({
  uuid: z.string().optional(),
  name: z.string().nullable().optional().catch(''),
  created_at: z.string().optional(),
  chat_messages: z.array(z.unknown())
})

type ClaudeMessage = z.infer<typeof claudeMessage>

/** Claude.ai's root parent id for the first message of a conversation. */
const CLAUDE_ROOT = '00000000-0000-4000-8000-000000000000'

function claudeText(m: ClaudeMessage): string {
  if (m.content?.length) {
    const parts = m.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
    if (parts.length) return parts.join('\n\n')
  }
  return m.text ?? ''
}

export function* readClaude(doc: unknown[], stats: { skipped: number }): Generator<ImportConversation> {
  for (const raw of doc) {
    const conv = claudeConversation.safeParse(raw)
    if (!conv.success) {
      stats.skipped++
      continue
    }
    const c = conv.data
    const all: ClaudeMessage[] = []
    for (const m of c.chat_messages) {
      const r = claudeMessage.safeParse(m)
      if (r.success) all.push(r.data)
    }
    // Newer exports carry the branch tree: walk from the newest message back through parents; else keep file order.
    let path = all
    if (all.length && all.every((m) => m.uuid) && all.some((m) => m.parent_message_uuid)) {
      const byId = new Map(all.map((m) => [m.uuid as string, m]))
      const chain: ClaudeMessage[] = []
      const seen = new Set<string>()
      let cur: ClaudeMessage | undefined = all[all.length - 1]
      while (cur && !seen.has(cur.uuid as string)) {
        seen.add(cur.uuid as string)
        chain.push(cur)
        const p: string | null | undefined = cur.parent_message_uuid
        cur = p && p !== CLAUDE_ROOT ? byId.get(p) : undefined
      }
      path = chain.reverse()
    }
    const created = isoToMs(c.created_at) ?? 0
    let lastTs = created
    const msgs: ImportMessage[] = []
    for (const m of path) {
      const role: Role | null = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
      if (!role) continue
      const text = claudeText(m).trim()
      const textFiles = (m.attachments ?? [])
        .filter((a) => typeof a.extracted_content === 'string' && a.extracted_content.trim() !== '')
        .map((a) => ({ name: (a.file_name ?? 'file').slice(0, 200) || 'file', text: a.extracted_content as string }))
      const otherFiles = (m.files ?? []).map((f) => f.file_name).filter((n): n is string => typeof n === 'string' && n !== '')
      const body = [text, ...otherFiles.map((n) => `[Attached file: ${n}]`)].filter(Boolean).join('\n\n')
      if (!body && !textFiles.length) continue
      const ts = isoToMs(m.created_at) ?? lastTs
      lastTs = ts
      msgs.push({ role, body: body || textFiles.map((f) => `[Attached file: ${f.name}]`).join('\n'), tsUtc: ts, textFiles: textFiles.length ? textFiles : undefined })
    }
    const original = c.uuid ?? shortHash(`${c.name ?? ''}|${c.created_at ?? ''}|${msgs[0]?.body ?? ''}`)
    yield {
      key: `claude:${original}`,
      title: (c.name ?? '').trim().slice(0, 200) || 'Imported Claude chat',
      createdUtc: created || msgs[0]?.tsUtc || 0,
      messages: mergeRuns(msgs)
    }
  }
}

// ── Vesper ──────────────────────────────────────────────────────────────────────────────────────
export function* readVesper(sessions: unknown[], stats: { skipped: number }): Generator<ImportConversation> {
  for (const raw of sessions) {
    const s = exportSessionSchema.safeParse(raw)
    if (!s.success) {
      stats.skipped++
      continue
    }
    const v = s.data
    const msgs: ImportMessage[] = []
    for (const m of v.messages) {
      const p = parseExportMessage(m)
      if (!p) continue
      msgs.push({ role: p.role, body: p.body, tsUtc: p.tsUtc, tz: { offsetMin: p.tzOffsetMin, name: p.tzName }, model: p.model ?? null, provider: p.provider ?? null, attachments: p.attachments })
    }
    yield {
      key: `vesper:${v.uid ?? shortHash(`${v.title}|${v.createdUtc}`)}`,
      title: v.title.slice(0, 200),
      createdUtc: v.createdUtc,
      messages: msgs,
      systemPrompt: v.systemPrompt,
      pinned: v.pinned,
      archived: v.archived,
      private: v.private,
      memory: v.memory,
      memoryScope: v.memoryScope,
      summary: v.summary,
      oldShortId: v.shortId,
      links: v.links
    }
  }
}
