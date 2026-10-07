/**
 * Context assembly (07 C1/C4/C5): the effective epoch's frozen system + tools, then its transcript replayed verbatim.
 * Nothing older than the epoch is sent and nothing inside it is ever re-rendered; state changes arrive as appended
 * system_note rows (state snapshots below), never as edits to `system`.
 */
import { createHash } from 'node:crypto'
import { djson } from '@shared/djson'
import { MEMORY_FUNCTIONS, TOOLS_VERSION, functionJsonSchema } from '@shared/memoryFunctions'
import type { Settings } from '@shared/settings'
import type { ToolMode } from '@shared/types/domain'
import type { WireBlock } from '@shared/types/wire'
import { effectiveToneMode, isToneKey, toneKey, type ToneKey } from '@shared/voiceTone'
import type { EpochRow, MessageRow, SessionRow, TranscriptRow } from '../db/repos'
import type { AttachmentSource, CanonTurn, LlmRequest, ResolvedProfile, ToolDef } from '../providers/llm/types'
import { memoryOf } from '../memory/service'
import { resolveScope } from '../memory/scope'
import type { FactsApi } from '../memory/facts'
import type { ServerContext } from '../services'
import { frozenToneKey, readProtocols, renderProtocols, toneChangeNote } from './protocols'
import { rootOf } from './temporary'

/** The protocols text new epochs freeze: content-server's single source (07 C1), or the file/default without it. */
export function currentProtocols(ctx: ServerContext): { text: string; hash: string } {
  const content = ctx.services.content
  if (content) {
    try {
      const p = content.protocols()
      return { text: p.text, hash: p.hash }
    } catch {
      /* fall back to reading the file ourselves */
    }
  }
  return readProtocols(ctx.paths.roaming)
}

const FACTS_HEADER = 'About the user (facts the user pinned; newer statements in the conversation may supersede them):'

/** Pinned facts through memory's facts API (one implementation, 07 A4); the facts table directly without memory. */
function factsOf(ctx: ServerContext): Pick<FactsApi, 'list' | 'note'> {
  try {
    return memoryOf(rootOf(ctx)).facts
  } catch {
    return {
      list: () => ctx.repos.facts.list(),
      note: () => {
        const facts = ctx.repos.facts.list()
        return facts.length ? `${FACTS_HEADER}\n${facts.map((f) => `- ${f.text}`).join('\n')}` : null
      }
    }
  }
}

export function toolDefs(): ToolDef[] {
  return MEMORY_FUNCTIONS.map((f) => ({ name: f.name, description: f.description, input_schema: functionJsonSchema(f) }))
}

export function desiredToolMode(p: ResolvedProfile): ToolMode {
  return p.caps.tools ? 'native' : 'text'
}

/** The session prompt as it enters `system` at epoch start (R11). */
export function sessionPrompt(ctx: ServerContext, s: SessionRow): string {
  if (s.systemPrompt.trim()) return s.systemPrompt.trim()
  if (s.promptId !== null) return ctx.repos.prompts.list().find((p) => p.id === s.promptId)?.body.trim() ?? ''
  return ''
}

/**
 * The tone instruction in force for this chat (H-v11-tone): Settings' mode, 'off' when voice replies are off or the
 * chat's voice can't use a tone (effectiveToneMode), with the tag's placement.
 */
export function toneKeyOf(settings: Settings, s: Pick<SessionRow, 'voice'>): ToneKey {
  return toneKey(effectiveToneMode(settings.voice.tts, s.voice), settings.voice.tts.tonePlacement)
}

/** Create an epoch whose system/tools are rendered NOW and frozen for its whole life (07 C1). */
export function createEpoch(ctx: ServerContext, s: SessionRow, p: ResolvedProfile, startMessageId: bigint, recap: string | null): EpochRow {
  const settings = ctx.settings.get()
  const toolMode = desiredToolMode(p)
  const protocols = currentProtocols(ctx)
  const system: { text: string }[] = [
    {
      text: renderProtocols(protocols.text, {
        assistantName: settings.profile.assistantName,
        userName: settings.profile.userName,
        sessionShortId: s.shortId,
        toolMode,
        toneMode: effectiveToneMode(settings.voice.tts, s.voice),
        tonePlacement: settings.voice.tts.tonePlacement
      })
    }
  ]
  const prompt = sessionPrompt(ctx, s)
  if (prompt) system.push({ text: `Instructions for this conversation:\n${prompt}` })
  const tools = toolMode === 'native' ? toolDefs() : []
  const e = ctx.repos.epochs.create({
    sessionId: s.id,
    branchId: s.activeBranch ?? 0n,
    startMessageId,
    systemJson: djson(system),
    toolsJson: djson(tools),
    protocolsHash: protocols.hash,
    toolsVersion: TOOLS_VERSION,
    toolMode,
    recap,
    thinkingStripBefore: null,
    now: ctx.clock.now()
  })
  if (s.toolMode !== toolMode) ctx.repos.sessions.update(s.id, { toolMode })
  return e
}

export function epochStartSeq(ctx: ServerContext, e: EpochRow): number {
  if (e.startMessageId === 0n) return 1
  return ctx.repos.messages.byId(e.startMessageId)?.seq ?? 1
}

export function toCanon(rows: TranscriptRow[]): CanonTurn[] {
  return rows.map((r) => ({ id: Number(r.id), role: r.role, blocks: r.blocks }))
}

export function buildRequest(p: ResolvedProfile, e: EpochRow, rows: TranscriptRow[]): LlmRequest {
  return {
    model: p.model,
    system: JSON.parse(e.systemJson) as { text: string }[],
    tools: JSON.parse(e.toolsJson) as ToolDef[],
    toolMode: e.toolMode,
    turns: toCanon(rows),
    maxTokens: p.options.maxTokens,
    effort: p.options.effort,
    temperature: p.options.temperature,
    reasoningDisplay: p.options.reasoningDisplay,
    stripThinkingBefore: e.thinkingStripBefore === null ? null : Number(e.thinkingStripBefore)
  }
}

// ── Budget (07 C4) ────────────────────────────────────────────────────────────────────────────
const IMAGE_TOKENS = 1600

/** Conservative token estimate of canonical blocks (~3.5 chars per token; images flat). */
export function estimateBlocks(blocks: WireBlock[], att: AttachmentSource): number {
  let chars = 0
  let tokens = 0
  for (const b of blocks) {
    switch (b.t) {
      case 'text':
      case 'memory_result':
      case 'system_note':
      case 'tool_result':
        chars += b.text.length
        break
      case 'tool_call':
        chars += djson(b.input).length + 20
        break
      case 'reasoning':
        chars += djson(b.payload ?? null).length
        break
      case 'image':
        tokens += IMAGE_TOKENS
        break
      case 'document':
        tokens += 1500
        break
      case 'file_text':
        chars += att.text(b.sha)?.length ?? 100
        break
    }
  }
  return tokens + Math.ceil(chars / 3.5)
}

export function estimateRequest(e: EpochRow, rows: TranscriptRow[], att: AttachmentSource): number {
  let t = Math.ceil((e.systemJson.length + e.toolsJson.length) / 3.5)
  for (const r of rows) t += estimateBlocks(r.blocks, att) + 4
  return t
}

// ── State snapshots → system notes (07 C1, A4, C13, C15) ──────────────────────────────────────
export interface CtxSnapshot {
  /** memory on/off (effective) */
  m: 'on' | 'off'
  /** voice: replies are spoken */
  v: boolean
  /** hash of the session prompt */
  p: string
  /** hash of the outgoing links */
  l: string
  /** hash of the pinned facts */
  f: string
  /**
   * hash of what the memory functions may reach (F29): the effective scope and, below 'all', the accessible chats —
   * a scope change, a new Settings default, or a linked chat turning private / memory-off. Absent in snapshots written
   * before Phase 4c (then no change is assumed).
   */
  a?: string
  /**
   * The tone instruction in force (H-v11-tone, toneKeyOf): a change — the owner's tone mode or placement, voice replies
   * turned on/off, or a voice that can/can't use a tone — reaches the AI as a note. Absent before v1.1 (then the
   * epoch's frozen system is the baseline, frozenToneKey).
   */
  t?: ToneKey
}

const h = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)

/**
 * Is AI memory (the memory functions, the manifest, auto-recall) on for this chat? One definition everywhere (F27):
 * on unless the chat's own memory switch is off. `settings.memory.enabled` is the Voyage switch ("Remember with Voyage
 * AI"): without it memory works by keywords on this PC (research 02 §5.7, F37) — it never turns the functions off.
 * MemoryService's scope clamp (memory/scope.ts) follows the same rule.
 */
export function memoryOn(_settings: Settings, s: SessionRow): boolean {
  return s.memory !== 'off'
}

export function snapshotOf(ctx: ServerContext, s: SessionRow, speak: boolean): CtxSnapshot {
  const settings = ctx.settings.get()
  const links = ctx.repos.sessions
    .links(s.id)
    .map((x) => x.shortId)
    .sort()
    .join(',')
  const facts = factsOf(ctx)
    .list()
    .map((f) => f.text)
    .join('\n')
  return { m: memoryOn(settings, s) ? 'on' : 'off', v: speak, p: h(sessionPrompt(ctx, s)), l: h(links), f: h(facts), a: h(accessOf(ctx, s)), t: toneKeyOf(settings, s) }
}

/**
 * What the memory functions may reach from `s`, as MemoryService resolves it (memory/scope.ts, on the main store: a
 * temporary chat is unknown there). 'all' lists no ids: it changes with every new chat, the manifest note doesn't.
 */
function accessOf(ctx: ServerContext, s: SessionRow): string {
  try {
    const r = resolveScope(rootOf(ctx), { sessionUid: s.uid }, { hasKey: false })
    if (r.refused) return 'refused'
    return r.scope === 'all' ? 'all' : `${r.scope}:${[...r.sessionIds].sort((x, y) => x - y).join(',')}`
  } catch {
    return ''
  }
}

export function readSnapshot(m: MessageRow): CtxSnapshot | null {
  const c = m.meta.ctx
  if (!c || typeof c !== 'object') return null
  const x = c as Record<string, unknown>
  if ((x.m !== 'on' && x.m !== 'off') || typeof x.v !== 'boolean' || typeof x.p !== 'string' || typeof x.l !== 'string' || typeof x.f !== 'string') return null
  return { m: x.m, v: x.v, p: x.p, l: x.l, f: x.f, ...(typeof x.a === 'string' ? { a: x.a } : {}), ...(isToneKey(x.t) ? { t: x.t } : {}) }
}

/** The latest snapshot on the active path inside the epoch (before `beforeSeq`), or null at an epoch's first turn. */
export function baselineSnapshot(ctx: ServerContext, s: SessionRow, startSeq: number, beforeSeq: number): CtxSnapshot | null {
  let seq = beforeSeq
  for (let guard = 0; guard < 400 && seq > startSeq; guard++) {
    const page = ctx.repos.messages.tail(s.id, 50, { beforeSeq: seq })
    if (!page.length) return null
    for (let i = page.length - 1; i >= 0; i--) {
      const m = page[i]
      if (m.seq < startSeq) return null
      const snap = readSnapshot(m)
      if (snap) return snap
    }
    seq = page[0].seq
  }
  return null
}

export interface NoteInput {
  ctx: ServerContext
  session: SessionRow
  snapshot: CtxSnapshot
  baseline: CtxSnapshot | null
  /** The previous assistant reply was interrupted by voice (07 C15). */
  interruptedAfter: string | null
  /** The epoch the turn runs in: its frozen system says which tone instruction the AI started with (H-v11-tone). */
  epoch?: Pick<EpochRow, 'systemJson'>
}

/**
 * The tone note for a turn, if the instruction in force differs from what the AI was last told: the baseline
 * snapshot's, else (an epoch's first turn, or a chat from before v1.1) the epoch's frozen system. A system without a
 * `{{tone_instruction}}` (an edited protocols file) is left alone until a snapshot records one.
 */
function toneNote(n: NoteInput, user: string): string | null {
  const now = n.snapshot.t
  if (!now) return null
  const was = n.baseline?.t ?? (n.epoch ? frozenToneKey(n.epoch.systemJson) : null)
  if (!was || was === now) return null
  const tts = n.ctx.settings.get().voice.tts
  return toneChangeNote(now, user, now !== 'off' || tts.toneMode === 'off' ? 'setting' : tts.enabled ? 'voice' : 'voice-off')
}

/** The system notes for a turn: the epoch's opening state, or what changed since the baseline. */
export async function notesFor(n: NoteInput): Promise<string[]> {
  const { ctx, session: s, snapshot: now, baseline: was } = n
  const settings = ctx.settings.get()
  const user = settings.profile.userName || 'the user'
  const notes: string[] = []
  const memory = ctx.services.memory
  // The note text is memory's (one implementation, 07 A4); only "cleared" is the engine's own.
  const factsNote = (): string | null => factsOf(ctx).note() ?? (was ? `${user} cleared the things they asked you to always remember.` : null)
  const manifest = async (): Promise<string | null> => {
    if (now.m !== 'on' || !memory) return null
    try {
      const r = await memory.sessions(undefined, { sessionUid: s.uid })
      // A refusal is not a list of conversations (F27).
      if (r.refused) return null
      return r.text.trim() ? `Conversations you can access with the memory functions:\n${r.text.trim()}` : null
    } catch {
      return null
    }
  }

  if (!was) {
    // Without a memory service the functions answer "memory is disabled" too (tools.ts).
    if (now.m === 'off' || !memory) notes.push(`Memory is off in this conversation; the memory functions answer "memory is disabled".`)
    else {
      const m = await manifest()
      if (m) notes.push(m)
    }
    if (now.v) notes.push('Voice is on: your replies are spoken aloud.')
    const f = factsNote()
    if (f) notes.push(f)
  } else {
    if (now.m !== was.m) {
      if (now.m === 'off') notes.push(`${user} turned memory off; the memory functions now answer "memory is disabled".`)
      else {
        notes.push(`${user} turned memory on; you can use the memory functions again.`)
        const m = await manifest()
        if (m) notes.push(m)
      }
    } else if (now.m === 'on' && (now.l !== was.l || (now.a !== undefined && was.a !== undefined && now.a !== was.a))) {
      // Links, the memory scope or a reachable chat's privacy changed: the list the AI works from is re-sent (F29).
      const m = await manifest()
      notes.push(m ?? (now.l !== was.l ? 'The linked conversations changed.' : 'The conversations you can access with the memory functions changed.'))
    }
    if (now.v !== was.v) notes.push(now.v ? 'Voice is on now: your replies are spoken aloud.' : 'Voice is off now: your replies are read, not heard.')
    if (now.p !== was.p) {
      const prompt = sessionPrompt(ctx, s)
      notes.push(prompt ? `${user} changed the instructions for this conversation. From now on:\n${prompt}` : `${user} removed the instructions for this conversation.`)
    }
    if (now.f !== was.f) {
      const f = factsNote()
      if (f) notes.push(f)
    }
  }
  const tone = toneNote(n, user)
  if (tone) notes.push(tone)
  if (n.interruptedAfter !== null) notes.push(`(${user} interrupted your previous reply after: '${n.interruptedAfter}'.)`)
  return notes
}
