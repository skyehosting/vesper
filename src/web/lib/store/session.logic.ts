/**
 * Pure helpers of the session slice (unit-tested, DOM-free): summary extraction and how one `SessionSummary` update
 * changes the list rows and the open chat's detail.
 */
import type { Session, SessionSummary } from '@shared/types/domain'

/** The summary fields of a full session (what list rows hold). */
export function summaryOf(s: Session | SessionSummary): SessionSummary {
  return {
    uid: s.uid,
    shortId: s.shortId,
    title: s.title,
    createdUtc: s.createdUtc,
    updatedUtc: s.updatedUtc,
    lastMessageUtc: s.lastMessageUtc,
    lastSeq: s.lastSeq,
    messageCount: s.messageCount,
    pinned: s.pinned,
    archived: s.archived,
    private: s.private,
    temporary: s.temporary,
    hasPrompt: s.hasPrompt,
    linkCount: s.linkCount,
    memory: s.memory,
    deletedUtc: s.deletedUtc ?? null,
    summary: s.summary ?? null,
    // Imported chats keep their badge through live updates (only summaries carry it).
    ...('imported' in s && s.imported ? { imported: s.imported } : {})
  }
}

/**
 * Apply one session's new summary: archived/deleted rows leave the list, others are replaced in place or added at the
 * top; the open chat's detail takes the summary fields (title, pin, counts) and keeps its own (prompt, links, voice).
 * Returns the same arrays/objects when nothing changed.
 */
export function applySummary(
  items: readonly SessionSummary[],
  active: Session | null,
  session: SessionSummary
): { items: readonly SessionSummary[]; active: Session | null } {
  const nextActive = active && active.uid === session.uid ? { ...active, ...summaryOf(session) } : active
  const i = items.findIndex((x) => x.uid === session.uid)
  if (session.deletedUtc || session.archived) {
    return { items: i < 0 ? items : items.filter((x) => x.uid !== session.uid), active: nextActive }
  }
  const row = summaryOf(session)
  return { items: i < 0 ? [row, ...items] : items.map((x, j) => (j === i ? row : x)), active: nextActive }
}
