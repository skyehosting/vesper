/**
 * Pure chat-view reducer: REST pages plus live WS events → the windowed timeline the MessageWindow renders (R5,
 * 07 D1, research 03 §4.4). A view holds a *contiguous* run of on-path messages `loSeq..hiSeq` (at most 3N, the
 * component trims it), the in-flight replies, and the live messages that arrived while the window was not at the
 * live edge or while a page request was in flight (`pending`, merged when the window reaches the edge again).
 *
 * Event semantics follow 07 C16/C21: `message.created` appends only when the window shows the live edge
 * (`hasAfter === false`); otherwise it just moves `lastSeq` (the "Jump to latest" pill counts it).
 */
import type { ApiError } from '@shared/errors'
import type { InflightReply, Message, MessagePage, ReplyState } from '@shared/types/domain'
import type { ServerMsg } from '@shared/ws'

export interface ToolActivity {
  kind: 'search' | 'recall' | 'sessions' | 'auto'
  query: string
  count: number
  sessions: string[]
}

export interface InflightView {
  replyId: string
  /** The assistant placeholder message, once known. */
  messageUid: string | null
  state: ReplyState
  text: string
  error: ApiError | null
  /** Reasoning text (only sent when "show reasoning" is on). */
  reasoning: string
  /** Memory tool calls of this reply ("remembering …"), in order. */
  tools: ToolActivity[]
  detail: string | null
}

export interface ChatView {
  status: 'loading' | 'ready' | 'error'
  error: ApiError | null
  /** On-path messages loSeq..hiSeq in seq order, hidden turns included (rows skip them). */
  messages: Message[]
  loSeq: number
  hiSeq: number
  lastSeq: number
  hasBefore: boolean
  /** The window does not reach the live edge (newer messages exist on the server). */
  hasAfter: boolean
  inflight: Record<string, InflightView>
  /** Last session-level error (e.g. `session_busy` with no reply id). */
  notice: ApiError | null
  /** Live messages not in the window yet (window away from the edge, or a page in flight). Bounded. */
  pending: Message[]
  /** Assistant message uid → reply id, for replies finished in this view (synced reveal outlives reply.done). */
  replyOf: Record<string, string>
  /** Assistant message uid → its reasoning text, for replies finished in this view (not stored on the server). */
  reasoningOf: Record<string, string>
  /** Bumped whenever the window is replaced (open, reload, jump): the list re-positions. */
  gen: number
}

/** Live messages kept while away from the edge; beyond this the next `after` page fetches them. */
export const PENDING_MAX = 64
const REPLY_OF_MAX = 24

export function emptyChat(): ChatView {
  return {
    status: 'loading',
    error: null,
    messages: [],
    loSeq: 0,
    hiSeq: 0,
    lastSeq: 0,
    hasBefore: false,
    hasAfter: false,
    inflight: {},
    notice: null,
    pending: [],
    replyOf: {},
    reasoningOf: {},
    gen: 0
  }
}

/** A refetch is starting (resync, path change, jump): keep showing what we have, collect live messages meanwhile. */
export function startReload(view: ChatView): ChatView {
  return { ...view, status: 'loading', pending: [] }
}

/** Insert or replace by uid, keeping seq order (a different uid at the same seq is another variant: it replaces). */
/** Events carry the message row only: keep the page-derived extras (variant counts, recall count) they lack. */
export function withExtras(next: Message, prev: Message | undefined): Message {
  if (!prev || (next.variant !== undefined || prev.variant === undefined) && (next.recalled !== undefined || prev.recalled === undefined)) return next
  return { ...next, variant: next.variant ?? prev.variant, recalled: next.recalled ?? prev.recalled }
}

export function upsertMessage(list: readonly Message[], msg0: Message): Message[] {
  const out = list.slice()
  const at = out.findIndex((m) => m.uid === msg0.uid)
  const msg = withExtras(msg0, at >= 0 ? out[at] : undefined)
  if (at >= 0) out.splice(at, 1)
  let i = out.length
  while (i > 0 && out[i - 1].seq > msg.seq) i--
  if (i > 0 && out[i - 1].seq === msg.seq) {
    out[i - 1] = msg
    return out
  }
  out.splice(i, 0, msg)
  return out
}

function maxSeq(list: readonly Message[], floor: number): number {
  let m = floor
  for (const x of list) if (x.seq > m) m = x.seq
  return m
}

/**
 * Merge pending live messages newer than `hiSeq` into a window that reaches the live edge. If they don't continue
 * the window without a gap, the window is marked `hasAfter` instead (the next `after` page brings them).
 */
function mergePending(view: ChatView): ChatView {
  if (view.pending.length === 0) return view
  // Live versions of messages the page already holds (a reply finished while the page was in flight) win: events
  // are newer than the snapshot the page was read from.
  const byUid = new Map(view.pending.map((m) => [m.uid, m]))
  let updated = false
  const messages0 = view.messages.map((m) => {
    const live = byUid.get(m.uid)
    if (!live) return m
    updated = true
    byUid.delete(m.uid)
    return withExtras(live, m)
  })
  if (updated) view = { ...view, messages: messages0, pending: view.pending.filter((m) => byUid.has(m.uid)) }
  if (view.hasAfter || view.pending.length === 0) return { ...view, pending: view.hasAfter ? view.pending : [] }
  const newer = view.pending.filter((m) => m.seq > view.hiSeq).sort((a, b) => a.seq - b.seq)
  if (newer.length === 0) return { ...view, pending: [] }
  if (newer[0].seq > view.hiSeq + 1 && view.messages.length > 0) {
    return { ...view, hasAfter: true, lastSeq: maxSeq(newer, view.lastSeq) }
  }
  let messages = view.messages
  for (const m of newer) messages = upsertMessage(messages, m)
  const hi = maxSeq(newer, view.hiSeq)
  return { ...view, messages, hiSeq: hi, loSeq: view.messages.length ? view.loSeq : newer[0].seq, lastSeq: Math.max(view.lastSeq, hi), pending: [] }
}

/** Replace the window with a fetched page (open, reload, jump). */
export function applyPage(view: ChatView, page: MessagePage): ChatView {
  const next: ChatView = {
    ...view,
    status: 'ready',
    error: null,
    messages: page.items.slice(),
    loSeq: page.items.length ? page.loSeq : 0,
    hiSeq: page.items.length ? page.hiSeq : 0,
    lastSeq: Math.max(page.lastSeq, page.items.length ? page.hiSeq : 0),
    hasBefore: page.hasBefore,
    hasAfter: page.hasAfter,
    gen: view.gen + 1
  }
  return mergePending(next)
}

/** Older rows (`mode=before&seq=loSeq`) above the window. */
export function prependPage(view: ChatView, page: MessagePage): ChatView {
  const older = page.items.filter((m) => view.messages.length === 0 || m.seq < view.loSeq)
  if (older.length === 0) return { ...view, hasBefore: false }
  return { ...view, messages: [...older, ...view.messages], loSeq: older[0].seq, hasBefore: page.hasBefore, lastSeq: Math.max(view.lastSeq, page.lastSeq) }
}

/** Newer rows (`mode=after&seq=hiSeq`) below the window. */
export function appendPage(view: ChatView, page: MessagePage): ChatView {
  const newer = page.items.filter((m) => view.messages.length === 0 || m.seq > view.hiSeq)
  let messages = view.messages
  for (const m of newer) messages = upsertMessage(messages, m)
  const next: ChatView = {
    ...view,
    messages,
    hiSeq: maxSeq(newer, view.hiSeq),
    loSeq: view.messages.length ? view.loSeq : (newer[0]?.seq ?? 0),
    hasAfter: page.hasAfter,
    lastSeq: Math.max(view.lastSeq, page.lastSeq)
  }
  return mergePending(next)
}

/** Unload `count` rows from one end (the component decides what is safe to drop, 07 D1). */
export function trimWindow(view: ChatView, side: 'top' | 'bottom', count: number): ChatView {
  const n = Math.min(count, view.messages.length - 1)
  if (n <= 0) return view
  if (side === 'top') {
    const messages = view.messages.slice(n)
    return { ...view, messages, loSeq: messages[0].seq, hasBefore: true }
  }
  const messages = view.messages.slice(0, view.messages.length - n)
  return { ...view, messages, hiSeq: messages[messages.length - 1].seq, hasAfter: true }
}

/** Is `seq` inside the loaded window? */
export function inWindow(view: ChatView, seq: number): boolean {
  return view.messages.length > 0 && seq >= view.loSeq && seq <= view.hiSeq
}

function addPending(view: ChatView, m: Message): Message[] {
  const out = upsertMessage(view.pending, m)
  return out.length > PENDING_MAX ? out.slice(out.length - PENDING_MAX) : out
}

/** A live message: into the window when it shows the live edge (or the message is inside it), else pending. */
function placeMessage(view: ChatView, m: Message): ChatView {
  const lastSeq = Math.max(view.lastSeq, m.seq)
  const inside = view.messages.some((x) => x.uid === m.uid) || (view.messages.length > 0 && m.seq >= view.loSeq && m.seq <= view.hiSeq)
  if (view.status === 'ready' && (inside || !view.hasAfter)) {
    const messages = upsertMessage(view.messages, m)
    return { ...view, messages, lastSeq, hiSeq: Math.max(view.hiSeq, m.seq), loSeq: view.messages.length ? view.loSeq : m.seq }
  }
  return { ...view, lastSeq, pending: addPending(view, m) }
}

function patchMessage(view: ChatView, uid: string, patch: (m: Message) => Message): ChatView {
  let hit = false
  const map = (list: Message[]): Message[] =>
    list.map((m) => {
      if (m.uid !== uid) return m
      hit = true
      return patch(m)
    })
  const messages = map(view.messages)
  const pending = map(view.pending)
  return hit ? { ...view, messages, pending } : view
}

function newInflight(replyId: string): InflightView {
  return { replyId, messageUid: null, state: 'writing', text: '', error: null, reasoning: '', tools: [], detail: null }
}

function fromInflight(r: InflightReply): InflightView {
  return { ...newInflight(r.replyId), messageUid: r.messageUid, state: r.state, text: r.text }
}

function withInflight(view: ChatView, replyId: string, patch: (cur: InflightView) => InflightView): ChatView {
  const cur = view.inflight[replyId] ?? newInflight(replyId)
  return { ...view, inflight: { ...view.inflight, [replyId]: patch(cur) } }
}

function withoutInflight(view: ChatView, replyId: string): ChatView {
  if (!(replyId in view.inflight)) return view
  const inflight = { ...view.inflight }
  delete inflight[replyId]
  return { ...view, inflight }
}

function rememberReply(view: ChatView, messageUid: string | null | undefined, replyId: string): ChatView {
  if (!messageUid || view.replyOf[messageUid] === replyId) return view
  const entries = Object.entries(view.replyOf).filter(([k]) => k !== messageUid)
  entries.push([messageUid, replyId])
  return { ...view, replyOf: Object.fromEntries(entries.slice(-REPLY_OF_MAX)) }
}

/** Apply one server event addressed to this view's session. Irrelevant events return the same object. */
export function applyChatEvent(view: ChatView, msg: ServerMsg): ChatView {
  switch (msg.t) {
    case 'subscribed': {
      const inflight: Record<string, InflightView> = {}
      for (const r of msg.inflight) inflight[r.replyId] = { ...(view.inflight[r.replyId] ?? newInflight(r.replyId)), ...fromInflight(r), tools: view.inflight[r.replyId]?.tools ?? [] }
      let next: ChatView = { ...view, inflight }
      for (const r of msg.inflight) next = rememberReply(next, r.messageUid, r.replyId)
      return next
    }
    case 'message.created': {
      const next = placeMessage(view, msg.message)
      return { ...next, lastSeq: Math.max(next.lastSeq, msg.lastSeq) }
    }
    case 'message.updated':
      return placeMessage(view, msg.message)
    case 'message.deleted':
      return patchMessage(view, msg.messageUid, (m) => ({ ...m, deleted: true, body: '' }))
    case 'reply.status': {
      const next = withInflight(view, msg.replyId, (cur) => ({ ...cur, messageUid: msg.messageUid, state: msg.state, detail: msg.detail ?? null }))
      return rememberReply(next, msg.messageUid, msg.replyId)
    }
    case 'reply.delta':
      return withInflight(view, msg.replyId, (cur) => ({ ...cur, text: cur.text + msg.text }))
    case 'reply.reasoning':
      return withInflight(view, msg.replyId, (cur) => ({ ...cur, reasoning: cur.reasoning + msg.text }))
    case 'reply.tool':
      return withInflight(view, msg.replyId, (cur) => ({
        ...cur,
        tools: [...cur.tools, { kind: msg.kind, query: msg.query, count: msg.count, sessions: msg.sessions }].slice(-8)
      }))
    case 'reply.snapshot': {
      const next = withInflight(view, msg.reply.replyId, (cur) => ({ ...cur, ...fromInflight(msg.reply), tools: cur.tools, reasoning: cur.reasoning }))
      return rememberReply(next, msg.reply.messageUid, msg.reply.replyId)
    }
    case 'reply.done': {
      // Auto-recall is recorded after the reply; its reply.tool count stands in until the next page load (07 A4).
      const recalled = (view.inflight[msg.replyId]?.tools ?? []).reduce((n, t) => n + t.count, 0)
      const message = recalled > 0 && !msg.message.recalled ? { ...msg.message, recalled } : msg.message
      const reasoning = view.inflight[msg.replyId]?.reasoning ?? ''
      let next = rememberReply(withoutInflight(view, msg.replyId), msg.message.uid, msg.replyId)
      if (reasoning) next = { ...next, reasoningOf: Object.fromEntries([...Object.entries(next.reasoningOf), [msg.message.uid, reasoning]].slice(-REPLY_OF_MAX)) }
      return placeMessage(next, message)
    }
    case 'reply.error':
      if (msg.replyId === null) return { ...view, notice: msg.error }
      return withInflight(view, msg.replyId, (cur) => ({ ...cur, state: 'error', error: msg.error }))
    default:
      return view
  }
}

/** One rendered row: a message (with the live text of its in-flight reply), or a reply with no message yet. */
export interface ChatRow {
  key: string
  message: Message | null
  reply: InflightView | null
  /** The previous visible message (day separators, time-gap markers). */
  prev: Message | null
  /** This is the newest assistant row in the window (its avatar mirrors the Star's state). */
  newestAi?: boolean
}

export function chatRows(view: ChatView): ChatRow[] {
  const byMessage = new Map<string, InflightView>()
  const orphans: InflightView[] = []
  for (const r of Object.values(view.inflight)) {
    if (r.messageUid) byMessage.set(r.messageUid, r)
    else orphans.push(r)
  }
  const rows: ChatRow[] = []
  let prev: Message | null = null
  const shown = new Set<string>()
  for (const m of view.messages) {
    if (m.hidden) continue
    shown.add(m.uid)
    rows.push({ key: m.uid, message: m, reply: byMessage.get(m.uid) ?? null, prev })
    prev = m
  }
  // Replies whose message isn't in the window belong at the live edge: only shown when the window is there.
  if (!view.hasAfter) {
    for (const r of byMessage.values()) if (r.messageUid && !shown.has(r.messageUid) && !view.pending.some((p) => p.uid === r.messageUid)) orphans.push(r)
    for (const r of orphans) rows.push({ key: `reply:${r.replyId}`, message: null, reply: r, prev })
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = rows[i].message?.role ?? 'assistant'
    if (role === 'assistant') {
      rows[i] = { ...rows[i], newestAi: true }
      break
    }
  }
  return rows
}

/** "The AI is still working on this reply." */
export function isActiveReply(r: InflightView): boolean {
  return r.state !== 'done' && r.state !== 'stopped' && r.state !== 'error'
}

/** The newest assistant / user message in the window (commands: /retry, /copy, /edit-last). */
export function lastMessageOf(view: ChatView, role: Message['role']): Message | null {
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i]
    if (m.role === role && !m.hidden && !m.deleted) return m
  }
  return null
}
