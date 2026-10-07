/**
 * "That was in another chat" (P19, 07 §H fix5-client-P19). With the default memory scope a chat searches only itself
 * and the chats linked to it (R8, 07 D11), so a fresh chat asking "what did I say about the telescope last week?"
 * found nothing and the model could only say it doesn't remember. When memory_search finds nothing and the chat's
 * own ceiling stops short of every chat, the keyword index is asked which chats OUTSIDE that reach mention the query,
 * and the model is told their IDs so it can point the owner at `/link #ID` (or the chat's memory scope).
 *
 * Privacy: only chats the 'all' scope could ever recall are named — never private, memory-off, deleted or temporary
 * chats — and only their short IDs: no text, title or summary of them reaches the model. Private and temporary asking
 * chats get no hint (links can't widen them).
 */
import type { ServerContext } from '../services'
import { ftsOrQuery } from '../memory/engine/text'
import { resolveScope } from '../memory/scope'

/** At most this many chats are named. */
export const HINT_MAX_CHATS = 3
/** Keyword candidates read from the index (best first) before grouping them by chat. */
const CANDIDATES = 200

/** Short IDs of chats outside `sessionUid`'s memory reach whose messages match `query` (best first), or []. */
export function chatsOutOfReach(ctx: ServerContext, sessionUid: string, query: string): { shortIds: string[]; scope: 'this' | 'linked' } | null {
  const self = ctx.repos.sessions.byUid(sessionUid)
  if (!self || self.deletedUtc !== null || self.private || self.memory === 'off') return null
  // The chat's own ceiling (not the scope the model asked for: a narrower request is the model's to widen).
  const reach = resolveScope(ctx, { sessionUid }, { hasKey: false })
  if (reach.refused || reach.scope === 'all') return null
  const match = ftsOrQuery(query)
  if (!match) return null
  const reachable = new Set(reach.sessionIds)
  const rows = ctx.db
    .prepare(
      `SELECT m.session_id AS sid FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.deleted = 0 AND m.hidden = 0 AND m.on_path = 1
       ORDER BY f.rank LIMIT ?`
    )
    .all(match, CANDIDATES) as Array<{ sid: number | bigint }>
  const out: string[] = []
  const seen = new Set<number>()
  for (const r of rows) {
    const sid = Number(r.sid)
    if (seen.has(sid) || reachable.has(sid)) continue
    seen.add(sid)
    const s = ctx.repos.sessions.byId(BigInt(sid))
    // Exactly the chats an 'all' scope may recall (07 B9): never private, memory-off or deleted ones.
    if (!s || s.deletedUtc !== null || s.private || s.memory === 'off') continue
    out.push(s.shortId)
    if (out.length >= HINT_MAX_CHATS) break
  }
  return out.length ? { shortIds: out, scope: reach.scope } : null
}

/** What the model reads after an empty memory_search when other chats match. */
export function outOfReachText(h: { shortIds: string[]; scope: 'this' | 'linked' }): string {
  const ids = h.shortIds.map((s) => `#${s}`).join(', ')
  const how =
    h.scope === 'this'
      ? "This conversation's memory is limited to itself: the user can widen it in this chat's memory settings and ask again."
      : `The user can link one to this conversation with /link ${`#${h.shortIds[0]}`} (or set its memory to every chat) and ask again.`
  return `Nothing was found in the conversations this one can search, but the same words appear in other conversations: ${ids}. Tell the user it may be there. ${how}`
}
