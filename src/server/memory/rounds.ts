/**
 * Turning ranked message ids into what the model reads (research 02 §5.3 steps 7–9):
 *   expand each hit to its round (the user message + the adjacent AI reply on the active path), merge overlapping
 *   rounds, drop what is already in the model's context (this session's current epoch) and what was injected in the
 *   last 10 turns (auto-recall), drop exact duplicates, stop at the round / token budget, then order chronologically.
 */
import type { MemoryHit } from '@shared/types/domain'
import type { MessageRow, SessionRow } from '../db/repos'
import { id as bindId } from '../db/sqlite'
import type { ServerContext } from '../services'
import { estimateTokens } from '../providers/voyage/catalogue'
import type { SearchItem } from './engine/protocol'
import { attachmentLine } from './engine/text'

export interface RoundOptions {
  minScore: number
  maxRounds: number
  maxTokens: number
  /** Messages the model already has (same session, current epoch) or was recently given. */
  exclude: Set<bigint>
  /** The asking session and the first seq of its current epoch: those messages are in context already. */
  contextSessionId: bigint | null
  contextFromSeq: number | null
}

export function toHit(m: MessageRow, s: SessionRow, score: number): MemoryHit {
  return {
    messageUid: m.uid,
    sessionUid: s.uid,
    shortId: s.shortId,
    sessionTitle: s.title,
    tag: m.tag,
    body: m.body,
    tsUtc: m.tsUtc,
    tzOffsetMin: m.tzOffsetMin,
    tzName: m.tzName,
    score
  }
}

const usable = (m: MessageRow | null | undefined): m is MessageRow => !!m && m.onPath && !m.hidden && !m.deleted && m.body.trim() !== ''

export function expandRounds(ctx: ServerContext, items: SearchItem[], o: RoundOptions): MemoryHit[] {
  const sessions = new Map<bigint, SessionRow | null>()
  const sessionOf = (sid: bigint) => {
    if (!sessions.has(sid)) sessions.set(sid, ctx.repos.sessions.byId(sid))
    return sessions.get(sid) ?? null
  }
  const inContext = (m: MessageRow) =>
    o.exclude.has(m.id) || (o.contextSessionId !== null && m.sessionId === o.contextSessionId && o.contextFromSeq !== null && m.seq >= o.contextFromSeq)
  const taken = new Set<bigint>()
  const bodies = new Set<string>()
  const out: MemoryHit[] = []
  let rounds = 0
  let tokens = 0
  for (const it of items) {
    if (it.score < o.minScore) continue
    if (rounds >= o.maxRounds) break
    const row = ctx.repos.messages.byId(BigInt(it.id))
    // Found by words inside its file (F72): the record carries those words, so the model sees what matched (a
    // message may be only a file, with no text of its own).
    const m = row && it.attachment ? { ...row, body: `${row.body.trim()}${row.body.trim() ? '\n' : ''}${attachmentLine(it.attachment)}` } : row
    if (!usable(m) || inContext(m) || taken.has(m.id)) continue
    const s = sessionOf(m.sessionId)
    if (!s) continue
    // The round: a user message with the reply after it, or a reply with the user message before it.
    const partner = m.role === 'user' ? ctx.repos.messages.range(m.sessionId, m.seq + 1, 1)[0] : ctx.repos.messages.previousOnPath(m.sessionId, m.seq)
    const round = [m]
    if (usable(partner) && partner.role !== m.role && !inContext(partner) && !taken.has(partner.id)) round.push(partner)
    const fresh = round.filter((x) => !bodies.has(x.body.trim()))
    if (!fresh.length) continue
    const cost = fresh.reduce((sum, x) => sum + estimateTokens(x.body.slice(0, 1200)) + 12, 0)
    if (rounds > 0 && tokens + cost > o.maxTokens) break
    for (const x of fresh) {
      taken.add(x.id)
      bodies.add(x.body.trim())
      out.push(toHit(x, s, it.score))
    }
    tokens += cost
    rounds++
  }
  return out.sort((a, b) => a.tsUtc - b.tsUtc || a.messageUid.localeCompare(b.messageUid))
}

/** Messages injected into this session's last `turns` AI replies (auto-recall must not repeat them). */
export function recentlyInjected(ctx: ServerContext, sessionId: bigint, turns = 10): Set<bigint> {
  const rows = ctx.db
    .prepare(
      `SELECT message_id FROM memory_injections WHERE session_id = ? AND turn_message_id IN (
         SELECT id FROM messages WHERE session_id = ? AND on_path = 1 AND role = 'assistant' ORDER BY seq DESC LIMIT ?)`
    )
    .all(bindId(sessionId), bindId(sessionId), BigInt(turns)) as { message_id: number | bigint }[]
  return new Set(rows.map((r) => BigInt(r.message_id)))
}

/** First seq of the session's current epoch (its messages are in the model's context already). */
export function epochStartSeq(ctx: ServerContext, s: SessionRow): number | null {
  const e = ctx.repos.epochs.current(s.id)
  if (!e) return null
  if (e.startMessageId === 0n) return 1
  return ctx.repos.messages.byId(e.startMessageId)?.seq ?? 1
}
