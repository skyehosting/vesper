/** DB rows → API shapes (shared/types/domain.ts). */
import type { Message, MessagePage, Session, SessionLink, SessionSummary } from '@shared/types/domain'
import type { Db } from '../db/sqlite'
import type { MessageRow, Page, SessionRow } from '../db/repos'
import type { ReposImpl } from '../db/repos/index'

export function toLink(r: SessionRow): SessionLink {
  return { uid: r.uid, shortId: r.shortId, title: r.title, createdUtc: r.createdUtc }
}

export function toSummary(db: Db, r: SessionRow): SessionSummary {
  const linkCount = Number((db.prepare('SELECT count(*) AS c FROM session_links WHERE from_session = ?').get(r.id) as { c: number }).c)
  return {
    uid: r.uid,
    shortId: r.shortId,
    title: r.title,
    createdUtc: r.createdUtc,
    updatedUtc: r.updatedUtc,
    lastMessageUtc: r.lastMessageUtc,
    lastSeq: r.lastSeq,
    messageCount: r.messageCount,
    pinned: r.pinned,
    archived: r.archived,
    private: r.private,
    temporary: false,
    hasPrompt: r.systemPrompt.trim() !== '' || r.promptId !== null,
    linkCount,
    memory: r.memory,
    deletedUtc: r.deletedUtc,
    summary: r.summary,
    ...importedSource(r.meta)
  }
}

/** `meta.imported.source` written by the importer (07 A4), so lists can mark imported chats. */
function importedSource(meta: Record<string, unknown>): Pick<SessionSummary, 'imported'> {
  const imp = meta.imported
  if (typeof imp !== 'object' || imp === null) return {}
  const src = (imp as { source?: unknown }).source
  return src === 'vesper' || src === 'chatgpt' || src === 'claude' ? { imported: src } : {}
}

const tokenStmts = new WeakMap<Db, ReturnType<Db['prepare']>>()

/**
 * Token totals of a session's AI replies (migration 9 keeps them on the row): null when nothing was reported (no
 * replies yet, or a provider that sends no usage) — the panel then shows "—".
 */
export function sessionTokens(db: Db, sessionId: bigint): Session['tokens'] {
  let st = tokenStmts.get(db)
  if (!st) {
    st = db.prepare('SELECT tokens_in AS i, tokens_out AS o, tokens_cache_read AS c FROM sessions WHERE id = ?')
    tokenStmts.set(db, st)
  }
  const t = st.get(sessionId) as { i: number | bigint; o: number | bigint; c: number | bigint } | undefined
  if (!t) return null
  const [i, o, c] = [Number(t.i), Number(t.o), Number(t.c)]
  if (!i && !o && !c) return null
  return c ? { in: i, out: o, cacheRead: c } : { in: i, out: o }
}

export function toSession(db: Db, repos: ReposImpl, r: SessionRow): Session {
  const epoch = repos.epochs.current(r.id)
  let epochInfo: Session['epoch'] = null
  if (epoch) {
    const start = epoch.startMessageId === 0n ? null : repos.messages.byId(epoch.startMessageId)
    epochInfo = { id: Number(epoch.id), startSeq: start?.seq ?? 1, hasRecap: !!epoch.recap }
  }
  const meta: Session['meta'] = {}
  if (typeof r.meta.continuedIn === 'string') meta.continuedIn = r.meta.continuedIn
  if (typeof r.meta.continuedFrom === 'string') meta.continuedFrom = r.meta.continuedFrom
  if (r.meta.backfill === 'all' || r.meta.backfill === 'new' || r.meta.backfill === 'none') meta.backfill = r.meta.backfill
  return {
    ...toSummary(db, r),
    systemPrompt: r.systemPrompt,
    promptId: r.promptId,
    memoryScope: r.memoryScope,
    llmProfile: r.llmProfile,
    model: r.model,
    voice: r.voice,
    toolMode: r.toolMode,
    links: repos.sessions.links(r.id).map(toLink),
    linkedFrom: repos.sessions.linkedFrom(r.id).map(toLink),
    meta,
    epoch: epochInfo,
    tokens: sessionTokens(db, r.id)
  }
}

export function toMessage(m: MessageRow, sessionUid: string, extra: { variant?: { index: number; count: number }; recalled?: number } = {}): Message {
  const out: Message = {
    uid: m.uid,
    sessionUid,
    seq: m.seq,
    role: m.role,
    tag: m.tag,
    // Tombstones keep their place in the timeline but never their text (07 C3).
    body: m.deleted ? '' : m.body,
    tsUtc: m.tsUtc,
    tzOffsetMin: m.tzOffsetMin,
    tzName: m.tzName,
    device: m.device,
    status: m.status,
    attachments: m.deleted ? [] : m.attachments
  }
  if (m.error) out.error = m.error
  if (m.provider) out.provider = m.provider
  if (m.model) out.model = m.model
  if (m.usage) out.usage = m.usage
  if (m.hidden) out.hidden = true
  if (m.deleted) out.deleted = true
  if (m.spokenChars !== null) out.spokenChars = m.spokenChars
  if (m.interrupted) out.interrupted = true
  if (m.meta.truncated === true) out.truncated = true
  if (extra.variant) out.variant = extra.variant
  if (extra.recalled) out.recalled = extra.recalled
  return out
}

/** A page with the ‹ n/m › variant info and the "Remembered" counts filled in. */
export function toMessagePage(db: Db, repos: ReposImpl, s: SessionRow, page: Page<MessageRow>): MessagePage {
  const variants = new Map<number, { index: number; count: number }>()
  if (page.items.length) {
    for (const seq of repos.branches.forkSeqsInRange(s.id, page.loSeq, page.hiSeq)) {
      const v = repos.branches.variants(s.id, seq)
      const active = v.find((x) => x.active)
      if (v.length > 1 && active) variants.set(seq, { index: active.index, count: v.length })
    }
  }
  const recalled = new Map<bigint, number>()
  const assistantIds = page.items.filter((m) => m.role === 'assistant').map((m) => m.id)
  if (assistantIds.length) {
    const rows = db
      .prepare(`SELECT turn_message_id AS id, count(*) AS c FROM memory_injections WHERE turn_message_id IN (${assistantIds.map(() => '?').join(',')}) GROUP BY turn_message_id`)
      .all(...assistantIds) as { id: number | bigint; c: number }[]
    for (const r of rows) recalled.set(BigInt(r.id), Number(r.c))
  }
  return {
    items: page.items.map((m) => toMessage(m, s.uid, { variant: variants.get(m.seq), recalled: recalled.get(m.id) })),
    loSeq: page.loSeq,
    hiSeq: page.hiSeq,
    lastSeq: page.lastSeq,
    hasBefore: page.hasBefore,
    hasAfter: page.hasAfter
  }
}
