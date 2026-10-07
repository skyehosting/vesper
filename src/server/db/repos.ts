/**
 * Repository interfaces over the main DB connection (07 C9: every call O(page), p99 < 5 ms). Implemented by the
 * foundation in ./repos/*.ts; Phase 2 agents use them and request new methods via docs/requests/<agent>.md.
 * Internal ids are bigint (node:sqlite BigInt binding, research 03 §1); external ids are uids / short ids.
 */
import type { AttachmentRef, Fact, MessageStatus, Prompt, Role, RoleTag, TimelineSample, Usage, Variant, MemoryMode, MemoryScope, ToolMode, SessionVoice } from '@shared/types/domain'
import type { WireBlock, WireRole } from '@shared/types/wire'

export interface SessionRow {
  id: bigint
  uid: string
  shortId: string
  title: string
  titleAuto: boolean
  createdUtc: number
  updatedUtc: number
  lastMessageUtc: number | null
  pinned: boolean
  archived: boolean
  deletedUtc: number | null
  private: boolean
  memory: MemoryMode
  memoryScope: MemoryScope | 'inherit'
  systemPrompt: string
  promptId: number | null
  llmProfile: string | null
  model: string | null
  voice: SessionVoice | null
  toolMode: ToolMode | null
  activeBranch: bigint | null
  messageCount: number
  lastSeq: number
  summary: string | null
  summaryUtc: number | null
  meta: Record<string, unknown>
}

export interface MessageRow {
  id: bigint
  uid: string
  sessionId: bigint
  branchId: bigint
  seq: number
  role: Role
  tag: RoleTag
  body: string
  tsUtc: number
  tzOffsetMin: number
  tzName: string | null
  device: string | null
  status: MessageStatus
  error: { code: string; message: string } | null
  provider: string | null
  model: string | null
  usage: Usage | null
  attachments: AttachmentRef[]
  onPath: boolean
  hidden: boolean
  deleted: boolean
  spokenChars: number | null
  interrupted: boolean
  meta: Record<string, unknown>
}

export interface NewMessage {
  sessionId: bigint
  role: Role
  body: string
  tsUtc: number
  tzOffsetMin: number
  tzName: string | null
  device: string | null
  status?: MessageStatus
  provider?: string | null
  model?: string | null
  attachments?: AttachmentRef[]
  hidden?: boolean
  meta?: Record<string, unknown>
}

export interface TranscriptRow {
  id: bigint
  sessionId: bigint
  messageId: bigint
  part: number
  role: WireRole
  blocks: WireBlock[]
  /** Exact stored JSON (djson) — adapters must use the parsed blocks, but byte size is tracked for request limits. */
  bytes: number
  provider: string | null
  model: string | null
  createdUtc: number
}

export interface EpochRow {
  id: bigint
  sessionId: bigint
  branchId: bigint
  startMessageId: bigint
  systemJson: string
  toolsJson: string
  protocolsHash: string
  toolsVersion: number
  toolMode: ToolMode
  recap: string | null
  recapDraft: string | null
  thinkingStripBefore: bigint | null
  createdUtc: number
}

export interface Page<T> {
  items: T[]
  loSeq: number
  hiSeq: number
  lastSeq: number
  hasBefore: boolean
  hasAfter: boolean
}

export interface Repos {
  sessions: {
    create(o: { title?: string; systemPrompt?: string; promptId?: number | null; private?: boolean; meta?: Record<string, unknown>; now: number }): SessionRow
    byUid(uid: string): SessionRow | null
    byShortId(shortId: string): SessionRow | null
    byId(id: bigint): SessionRow | null
    list(o: { q?: string; filter?: 'all' | 'pinned' | 'archived' | 'trash'; cursor?: string; limit: number }): { items: SessionRow[]; next: string | null }
    update(id: bigint, patch: Partial<Omit<SessionRow, 'id' | 'uid' | 'shortId' | 'createdUtc'>>): SessionRow
    softDelete(id: bigint, now: number): void
    restore(id: bigint): void
    /** Directional links: from may recall to. */
    links(id: bigint): SessionRow[]
    linkedFrom(id: bigint): SessionRow[]
    addLink(from: bigint, to: bigint, now: number): void
    removeLink(from: bigint, to: bigint): void
    /** Ids this session may search (07 B9: private/temporary/deleted excluded; scope clamped). */
    accessibleIds(id: bigint, scope: MemoryScope): bigint[]
  }
  messages: {
    /** Appends on the active path: next seq on the session's active branch. */
    append(m: NewMessage): MessageRow
    byUid(uid: string): MessageRow | null
    byId(id: bigint): MessageRow | null
    update(id: bigint, patch: Partial<Pick<MessageRow, 'body' | 'status' | 'error' | 'usage' | 'provider' | 'model' | 'tsUtc' | 'spokenChars' | 'interrupted' | 'meta' | 'attachments'>>): MessageRow
    /** Keyset page on the active path (partial index; tombstones included). */
    page(sessionId: bigint, o: { mode: 'latest' | 'before' | 'after' | 'around'; seq?: number; limit: number }): Page<MessageRow>
    timeline(sessionId: bigint, samples: number): TimelineSample[]
    /** Last `n` on-path messages, oldest first (context assembly, recaps). */
    tail(sessionId: bigint, n: number, opts?: { beforeSeq?: number }): MessageRow[]
    /** On-path messages from seq (inclusive) onward, oldest first, paged. */
    range(sessionId: bigint, fromSeq: number, limit: number): MessageRow[]
    /** `now` (additive, Phase 4c) stamps `meta.deletedUtc`: the 07 B9 daily purge clears the message 30 days later. */
    softDelete(id: bigint, now?: number): void
    restore(id: bigint): void
    previousOnPath(sessionId: bigint, beforeSeq: number): MessageRow | null
    /**
     * Startup (07 C6): replies left `streaming` by a crash or quit become `stopped` (some text) or `error` (none).
     * Returns how many rows changed. (Additive, Phase 3 engine-int.)
     */
    recoverStreaming(): number
  }
  branches: {
    /** Create a branch forking at `seq` (07 C3 parent rule) and make it active; returns its id. */
    fork(sessionId: bigint, forkSeq: number, reason: 'edit' | 'regenerate', now: number): bigint
    variants(sessionId: bigint, seq: number): Variant[]
    /** Select a variant at a fork; flips on_path in one transaction; returns the new lastSeq. */
    select(sessionId: bigint, seq: number, branchId: bigint): { lastSeq: number; changed: bigint[] }
    locate(messageId: bigint): { seq: number; onPath: boolean; branchPath: { forkSeq: number; branchId: number }[] }
    /** Seqs in [lo, hi] that are fork points on the active path (fills Message.variant). */
    forkSeqsInRange(sessionId: bigint, lo: number, hi: number): number[]
  }
  transcript: {
    append(row: Omit<TranscriptRow, 'id' | 'bytes'>): TranscriptRow
    /** Turns of the active path for an epoch: from the epoch's start message onward, in order. */
    forEpoch(epoch: EpochRow): TranscriptRow[]
    forMessage(messageId: bigint): TranscriptRow[]
    deleteForMessage(messageId: bigint): void
  }
  epochs: {
    create(e: Omit<EpochRow, 'id' | 'createdUtc' | 'recapDraft'> & { now: number }): EpochRow
    /** Effective epoch for the session's active path (07 C4). */
    current(sessionId: bigint): EpochRow | null
    /** Every epoch whose start is on the active path, oldest first (additive, F24: recap chain rebuilds). */
    onPath(sessionId: bigint): EpochRow[]
    update(id: bigint, patch: Partial<Pick<EpochRow, 'recap' | 'recapDraft' | 'thinkingStripBefore'>>): EpochRow
  }
  prompts: {
    list(): Prompt[]
    create(name: string, body: string, now: number): Prompt
    update(id: number, patch: { name?: string; body?: string }, now: number): Prompt
    delete(id: number): void
  }
  facts: {
    list(): Fact[]
    create(text: string, now: number): Fact
    update(id: number, text: string, now: number): Fact
    delete(id: number): void
  }
  attachments: {
    upsert(a: AttachmentRef & { createdUtc: number }): void
    get(sha: string): (AttachmentRef & { createdUtc: number }) | null
    setText(sha: string, extractor: string, text: string): void
    text(sha: string): { text: string; chars: number; extractor: string } | null
  }
  devices: {
    create(d: { id: string; name: string; kind: 'desktop' | 'browser' | 'paired'; listener: 'loopback' | 'lan' | 'tailnet'; tokenHash: string; pending: boolean; now: number; ip: string | null; userAgent: string | null }): void
    byId(id: string): { id: string; name: string; kind: 'desktop' | 'browser' | 'paired'; listener: 'loopback' | 'lan' | 'tailnet'; pending: boolean; revokedUtc: number | null } | null
    byTokenHash(hash: string): { id: string; name: string; kind: 'desktop' | 'browser' | 'paired'; listener: 'loopback' | 'lan' | 'tailnet'; pending: boolean; revokedUtc: number | null; createdUtc: number; lastSeenUtc: number | null; sudoUntilUtc: number | null } | null
    list(): Array<{ id: string; name: string; kind: 'desktop' | 'browser' | 'paired'; listener: 'loopback' | 'lan' | 'tailnet'; createdUtc: number; lastSeenUtc: number | null; lastIp: string | null; userAgent: string | null; pending: boolean; revokedUtc: number | null }>
    touch(id: string, now: number, ip: string | null): void
    setSudo(id: string, untilUtc: number | null): void
    approve(id: string): void
    revoke(id: string, now: number): void
    revokeKind(kind: 'desktop', now: number): void
    revokeAllExcept(id: string, now: number): void
  }
  authLog: {
    add(e: { now: number; event: string; ip: string | null; detail: string | null }): void
    list(limit: number): { tsUtc: number; event: string; ip: string | null; detail: string | null }[]
    /** Keep only the newest `keep` rows (access-server bounds the audit log); returns the rows removed. */
    prune(keep: number): number
  }
  kv: {
    get<T = unknown>(k: string): T | null
    set(k: string, v: unknown): void
    delete(k: string): void
  }
  /** The rows behind `Message.recalled` (the "Remembered" chip, 07 A4); written via memoryOf(ctx).recordInjections. (Additive, Phase 3 engine-int.) */
  memoryInjections: {
    add(sessionId: bigint, messageId: bigint, turnMessageId: bigint): void
  }
  embedQueue: {
    /** Insert a message for embedding (skips private/temporary/memory-off sessions — the caller checks, the memory worker re-checks). */
    enqueue(messageId: bigint): void
  }
}
