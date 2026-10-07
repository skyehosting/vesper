/**
 * Server service interfaces (07 E2). Each Phase 2 agent implements one service in its own folder and registers it in
 * `ctx.services` from its `index.ts`; the others call it only through these interfaces. Fakes live in tests/fakes/.
 * Changing a signature here is an orchestrator change (note it in 07).
 */
import type { FastifyInstance } from 'fastify'
import type { Db } from './db/sqlite'
import type { Platform } from './platform'
import type { DeepPartial, Settings } from '@shared/settings'
import type { ApiError } from '@shared/errors'
import type { ClientMsg, ServerMsg, ClientState, SpeechChunkHeader } from '@shared/ws'
import type { AttachmentRef, DeviceInfo, Listener, Message, MemoryHit, MemoryScope, MemoryStatus, ModelInfo, ProviderTestResult, Voice } from '@shared/types/domain'
import type { SttModelInfo } from '@shared/models'
import type { Repos } from './db/repos'

// ── Logging ───────────────────────────────────────────────────────────────────────────────────
export interface Log {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(scope: string): Log
}

// ── Settings & secrets ────────────────────────────────────────────────────────────────────────
export type SettingsPath = 'profile' | 'llm' | 'chat' | 'memory' | 'voice' | 'voice.tts' | 'voice.stt' | 'appearance' | 'performance' | 'access' | 'desktop' | 'data' | 'privacy' | 'wizard' | 'updates'

export interface SettingsStore {
  get(): Settings
  /** Validates, writes atomically, broadcasts `settings.changed`. `by` = device id (for audit / remote rules). */
  patch(partial: DeepPartial<Settings>, opts?: { by?: string }): Promise<Settings>
  /** Called after a change that touched `path` (prev, next). Returns an unsubscribe. */
  subscribe(path: SettingsPath, cb: (next: Settings, prev: Settings) => void): () => void
}

export interface SecretsService {
  /** Names that are set and readable. */
  list(): Promise<string[]>
  /** Names that exist but cannot be decrypted (DPAPI loss). */
  invalid(): Promise<string[]>
  /**
   * The key for `name` IF it is bound to `requestUrl`'s origin (07 B1); throws VesperError('key_origin_mismatch') when
   * bound elsewhere and returns null when not set.
   */
  getFor(name: string, requestUrl: string): Promise<string | null>
  set(name: string, value: string, boundUrl: string | null): Promise<void>
  delete(name: string): Promise<void>
  /** Drop a provider key whose bound origin no longer matches its configured base URL. */
  rebind(name: string, newUrl: string): Promise<'kept' | 'cleared' | 'absent'>
}

// ── WebSocket hub ─────────────────────────────────────────────────────────────────────────────
export interface WsClient {
  readonly id: string
  readonly device: Pick<DeviceInfo, 'id' | 'kind' | 'name' | 'listener'>
  readonly listener: Listener
  readonly isDesktop: boolean
  state: ClientState
  tz: string | null
  tzOffset: number
  subscriptions: ReadonlySet<string>
  send(msg: ServerMsg): void
  /** Binary audio frame; returns false (and does not send) when the socket is over the backpressure limit. */
  sendSpeech(header: SpeechChunkHeader, audio: Uint8Array): boolean
  readonly bufferedAmount: number
  close(code: number, reason: string): void
}

/** Distributes `Omit<event, 'evSeq'>` with a fresh per-session evSeq to every subscriber and keeps the resume ring. */
export interface Hub {
  clients(): Iterable<WsClient>
  client(id: string): WsClient | undefined
  /**
   * Session event: stamped with evSeq, stored in the ring, sent to subscribers (optionally except one client or a set
   * of clients — every synced-reveal speaker, Phase 4 — or only one). Targeted events are unsequenced (07 G1).
   */
  emit(sessionUid: string, msg: DistributiveOmit<Extract<ServerMsg, { sessionUid: string; evSeq: number }>, 'evSeq'>, opts?: { except?: string | ReadonlySet<string>; only?: string }): void
  /** Non-session event to everyone (or one device / one client). */
  broadcast(msg: Exclude<ServerMsg, { evSeq: number }>, opts?: { deviceId?: string; clientId?: string; desktopOnly?: boolean }): void
  /** Register a handler for client messages whose `t` starts with `prefix` (e.g. 'chat.'). */
  on(prefix: string, handler: (client: WsClient, msg: ClientMsg) => void | Promise<void>): void
  /** Register a handler for binary frames of a kind. */
  onBinary(kind: number, handler: (client: WsClient, header: unknown, payload: Uint8Array) => void): void
  /** Called when a client disconnects (cleanup per client). */
  onDisconnect(handler: (client: WsClient) => void): void
  /** Close every socket of a device (revocation). */
  closeDevice(deviceId: string, code: number, reason: string): void
  /** Provides `subscribed.inflight` (the chat engine sets it). */
  setInflightProvider(fn: (sessionUid: string) => import('@shared/types/domain').InflightReply[]): void
  /** Answer a client request that carried an `id`. */
  ack(client: WsClient, msg: { id?: string }, extra?: { replyId?: string; messageUid?: string }): void
  /** Fail a client request that carried an `id` with `{t:"error", id, error}`. */
  fail(client: WsClient, msg: { id?: string }, error: ApiError): void
  /**
   * The session is gone for good (a temporary chat ended, a session was purged from the trash) — Phase 4, additive:
   * its event ring is dropped and every socket's subscription to it is removed. A later ring for the same uid would
   * start above every dropped evSeq, so a stale `sinceEvSeq` reads as a gap and the client refetches. Optional so
   * older fakes still type-check.
   */
  dropSession?(sessionUid: string): void
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// ── Chat (llm-engine) ─────────────────────────────────────────────────────────────────────────
export interface ChatService {
  /** Handles chat.send / chat.regenerate / chat.edit / chat.stop from WS (registered by the engine itself). */
  stop(sessionUid: string): void
  /** Is a reply in flight for this session? */
  busy(sessionUid: string): boolean
  /**
   * Replies that could not be saved (07 C19, F28) and wait in memory for their retry: messageUid → the message
   * reply.done showed (full text, status 'error', "not saved"). Served instead of the stale row. Optional (additive).
   */
  unsavedReplies?(sessionUid: string): ReadonlyMap<string, Message>
  /**
   * Start the /continue opening turn for a freshly created session (07 C18). `opts.speak` (additive, P22): speak it on
   * the requesting device (`deviceId`), through its tab showing the source chat.
   */
  startContinuation(sessionUid: string, sourceUid: string, client: WsClient | null, opts?: { speak?: boolean; deviceId?: string; speakClientId?: string }): Promise<void>
  /** Generate (or reuse) the recap of a session (utility model). */
  recap(sessionUid: string): Promise<string>
  /** Force a new epoch (protocols apply-now, delete-and-refresh). */
  newEpoch(sessionUid: string, reason: 'apply-protocols' | 'refresh-context' | 'model-switch' | 'overflow'): Promise<number>
  close(): Promise<void>
}

// ── Memory (memory agent) ─────────────────────────────────────────────────────────────────────
export interface ScopeCtx {
  sessionUid: string
  /** The scope asked for by the tool call / UI; clamped in code to what the session may access (07 B7). */
  requested?: MemoryScope
}

export interface MemoryQuery {
  query: string
  after?: string
  before?: string
  limit?: number
}

export interface RecallQuery {
  shortId: string
  query?: string
  around?: string
  last?: number
}

export interface MemoryService {
  /** `refused` (additive, Phase 4c F27): memory can't be used from this session; the fixed refusal text. */
  search(q: MemoryQuery, scope: ScopeCtx, budgetMs: number): Promise<{ hits: MemoryHit[]; mode: 'hybrid' | 'keyword'; refused?: string }>
  recall(r: RecallQuery, scope: ScopeCtx): Promise<{ hits: MemoryHit[]; refused?: string }>
  /** `refused` (additive, Phase 4c F27): set when `text` is a refusal, not a list of conversations. */
  sessions(query: string | undefined, scope: ScopeCtx): Promise<{ text: string; refused?: string }>
  autoRecall(text: string, scope: ScopeCtx, budgetMs: number): Promise<MemoryHit[]>
  /** The `untrusted()` rendering of hits for the model (07 B7), times relative to `nowUtc` in `zone`. */
  formatResult(hits: MemoryHit[], o: { query: string; nowUtc: number; tzName: string | null; tzOffsetMin: number }): string
  onMessagePersisted(messageId: bigint): void
  onSessionFlagsChanged(sessionId: bigint): void
  onPathChanged(sessionId: bigint): void
  onMessagesDeleted(ids: bigint[]): void
  status(): MemoryStatus
  reindex(scope: 'all' | 'missing'): Promise<{ queued: number }>
  close(): Promise<void>
}

// ── Speech out (voice-out-server) ─────────────────────────────────────────────────────────────
export interface SpeechTarget {
  replyId: string
  sessionUid: string
  /** Clients that should play audio (fixed at reply start, 07 C16). */
  clientIds: string[]
  /**
   * The assistant message being spoken (optional, additive): when given, a barge-in also persists
   * `messages.spoken_chars` + `interrupted` itself (07 C15), so it is recorded even if the caller ignores `done`.
   */
  messageUid?: string
  /**
   * When the turn was received (the chat engine's `reply.timing` origin, additive): the speech job's own marks
   * (`speechOpen`, `firstAudioSent`) are then ms since the same moment, like the engine's (07 D6).
   */
  receivedAt?: number
}

export interface SpeechSink {
  /** Visible (tag-free) markdown text as it streams. */
  push(text: string): void
  /** A tone tag appeared at visible offset `at`. */
  tone(value: string, at: number): void
  /** The reply's text is complete (final clean body). */
  end(finalBody: string): void
  abort(reason: 'barge-in' | 'stopped' | 'error'): void
  /** Resolves when all chunks were sent (or the sink was aborted). */
  readonly done: Promise<{ chunks: number; spokenChars: number; interrupted: boolean; failed: boolean }>
}

/**
 * What the opener of a sink learns while it speaks (additive, Phase 3 engine-int; 07 C16 synced reveal):
 * the first audio reached the speakers (reply.status 'speaking'); a speaking client stopped getting audio
 * (backpressure, or it left) and must get text instead; synthesis failed (speech.error).
 */
export type SpeechSinkEvent =
  | { kind: 'first-audio' }
  | { kind: 'degraded'; clientId: string; reason: 'backpressure' | 'speaker-left' | 'text-first' }
  | { kind: 'failed'; index: number }

export interface SpeechService {
  open(
    target: SpeechTarget,
    o: { voiceOverride?: { provider: string; voiceId: string; model?: string } | null; talkMode: boolean; onEvent?: (e: SpeechSinkEvent) => void }
  ): SpeechSink
  replay(messageUid: string, client: WsClient): Promise<void>
  /**
   * Barge-in from any device (07 C15/C16); `byClientId` (additive) is the client that interrupted. `beforeAudio`
   * (additive, F31): that client had not started playing the reply — when nobody else may have heard it, speech stops
   * but the reply carries on as text (not a barge-in).
   */
  cancel(replyId: string, spokenChars?: number, byClientId?: string, o?: { beforeAudio?: boolean }): void
  voices(provider: string, refresh?: boolean): Promise<{ voices: Voice[]; models: ModelInfo[]; quota?: { used: number; limit: number } }>
  close(): Promise<void>
}

// ── Speech in (voice-in-server) ───────────────────────────────────────────────────────────────
export interface SttService {
  models(): Promise<SttModelInfo[]>
  download(id: string): Promise<void>
  remove(id: string): Promise<void>
  unload(): Promise<void>
  close(): Promise<void>
}

// ── Content (content-server) ──────────────────────────────────────────────────────────────────
export interface ContentService {
  /** Attachment metadata (stored, or held in memory for a temporary chat, 07 B9); null when unknown. */
  attachment(sha: string): AttachmentRef | null
  /** The stored bytes (image/document blocks for providers, 07 C8). Throws VesperError('not_found'). */
  readAttachment(sha: string): Promise<Buffer>
  /** Extracted text written once at ingestion (07 C8); null for images and failed extractions. */
  attachmentText(sha: string): { text: string; chars: number; truncated: boolean } | null
  /** Forget a temporary chat's attachments (bytes in the temp dir, metadata and text in memory) when it ends. */
  forgetTemporary(shas: readonly string[]): void
  /** The protocols text new epochs freeze (07 C1): the user's protocols.md or the shipped default. */
  protocols(): { text: string; hash: string; isDefault: boolean }
  /** Back up the database now (07 C20). */
  backup(reason: 'manual' | 'daily'): Promise<{ file: string; bytes: number }>
  close(): Promise<void>
}

// ── Provider tests (wizard) ───────────────────────────────────────────────────────────────────
export type ProviderKind = 'llm' | 'voyage' | 'tts' | 'stt'
export interface ProviderTester {
  test(input: Record<string, unknown>, signal: AbortSignal): Promise<ProviderTestResult>
}

// ── Context ───────────────────────────────────────────────────────────────────────────────────
export interface Services {
  chat?: ChatService
  memory?: MemoryService
  speech?: SpeechService
  stt?: SttService
  content?: ContentService
  testers: Partial<Record<ProviderKind, ProviderTester>>
}

export interface Clock {
  now(): number
}

export interface ServerContext {
  platform: Platform
  db: Db
  repos: Repos
  settings: SettingsStore
  secrets: SecretsService
  hub: Hub
  log: Log
  clock: Clock
  services: Services
  /** Paths: roaming (settings, DB, attachments, backups) and local (models, logs). */
  paths: { roaming: string; local: string; attachments: string; models: string; logs: string; backups: string; exports: string; temp: string }
  /** Register a cleanup run at shutdown (reverse order). */
  onClose(fn: () => void | Promise<void>): void
  /** Fastify instance of Listener A (routes are shared by all listeners). */
  app?: FastifyInstance
  /** Map an unknown thrown value to the client error shape (never upstream bodies). */
  toApiError(e: unknown): ApiError
}

// ── Server startup (used by src/main and src/server/node-entry.ts) ────────────────────────────
export interface StartOptions {
  /** Loopback port (0 = random, tests). */
  port?: number
  /** Dev: forward non-API requests to this Vite dev server URL. */
  devRendererUrl?: string | null
  /** Directory with the built web client (out/web). */
  webDir: string
  /** Directory with built worker scripts (out/main). */
  workersDir: string
}

export interface RunningServer {
  ctx: ServerContext
  port: number
  /** http://127.0.0.1:<port> */
  loopbackUrl: string
  /**
   * Create a fresh desktop device session (07 §5.3 / B11): revokes earlier desktop devices and returns the cookie the
   * main process sets in the window's own session before loading `loopbackUrl`.
   */
  createDesktopSession(): Promise<{ name: string; value: string; url: string }>
  close(): Promise<void>
}
