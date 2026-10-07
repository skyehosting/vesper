/**
 * Chat stores (07 B9): where a session's rows live. Every normal session lives in vesper.db (the main store); a
 * temporary chat lives in a private in-memory SQLite connection of its own (`:memory:`, temp_store=MEMORY) with the
 * same schema, so the same repositories, branching and epoch code serve it — and nothing of it ever reaches
 * vesper.db, its WAL, FTS, the memory worker, exports or backups. Closing that connection drops everything; a restart
 * forgets every temporary chat (it was never on disk).
 *
 * Ids in a temporary store start at 1 like the main DB's, so internal ids must never cross stores: code that hands a
 * bigint id to a service that reads vesper.db (memory notifications, `memory_injections`) checks `store.temporary`
 * first. Uids are UUIDs and safe everywhere.
 *
 * A temporary chat ends on explicit close (DELETE /api/sessions/:uid), after `noSubscriberMs` (10 min) with no
 * subscribed client, after 24 h without activity, or at shutdown: the running turn is stopped and awaited, the
 * connection closed, its attachments dropped from content-server's temp store (`forgetTemporary`), and
 * `session.ended` broadcast.
 *
 * Phase 4: files uploaded for a temporary chat (`POST /api/attachments?temporary=1`) but never sent are tracked here
 * too (`noteUpload`): they go when no live temporary chat of the uploading device is left (at once when its chat
 * ends, after a short grace otherwise) or after `UPLOAD_IDLE_MS` regardless, so the temp dir holds no leftovers
 * until quit. The hub's event ring for the uid is dropped when the chat ends.
 */
import { VesperError } from '@shared/errors'
import type { SessionSummary } from '@shared/types/domain'
import { coreOf } from '../core'
import { MIGRATIONS } from '../db/migrations'
import type { MessageRow, SessionRow } from '../db/repos'
import { createRepos, type ReposImpl } from '../db/repos/index'
import { migrate, openDb, type Db } from '../db/sqlite'
import { toSummary } from '../http/convert'
import type { ServerContext } from '../services'
import { testEnv } from '../testMode'

/** Where a session's rows live: vesper.db, or one temporary chat's in-memory connection. */
export interface ChatStore {
  readonly temporary: boolean
  /** A context whose `repos`/`db` are this store's (the real ctx for the main store). */
  readonly ctx: ServerContext
  readonly repos: ReposImpl
  readonly db: Db
}

export interface TempChat extends ChatStore {
  readonly temporary: true
  readonly uid: string
  readonly sessionId: bigint
  /** Devices that see it in their session list (the creator, then every device that subscribed). */
  readonly devices: Set<string>
  /** Attachments its messages used (dropped from the temp store when it ends, 07 B9). */
  readonly attachments: Set<string>
  lastActivity: number
  /** When the last subscriber left (null while someone is subscribed). */
  idleSince: number | null
  ending: boolean
}

export type EndReason = 'closed' | 'idle' | 'no-subscriber' | 'shutdown'

export interface TemporaryOptions {
  /** End after this long with no subscribed client (07 B9: 10 min). */
  noSubscriberMs?: number
  /** End after this long without activity (07 B9: 24 h). */
  maxIdleMs?: number
  /** How often subscriptions are checked. */
  sweepMs?: number
}

export const NO_SUBSCRIBER_MS = 10 * 60_000
export const MAX_IDLE_MS = 24 * 3600_000
const SWEEP_MS = 30_000
/** A sanity cap: each chat holds an SQLite connection (≈ 0.5 MB empty). */
const MAX_CHATS = 50
/** An unsent temporary upload is dropped after this long, live chat or not (re-uploading the file refreshes it). */
export const UPLOAD_IDLE_MS = 60 * 60_000
/** …and after this long when its device has no live temporary chat (an upload may race the chat's creation). */
export const UPLOAD_ORPHAN_GRACE_MS = 60_000

interface PendingUpload {
  devices: Set<string>
  at: number
}

/** Test builds only (07 B10): shorter timings so ending is testable. */
function envMs(name: `VESPER_${string}`): number | undefined {
  if (!__VESPER_TEST__) return undefined
  const v = Number(testEnv(name))
  return Number.isFinite(v) && v > 0 ? v : undefined
}

export class TemporaryChats {
  private readonly chats = new Map<string, TempChat>()
  private readonly noSubscriberMs: number
  private readonly maxIdleMs: number
  private readonly sweepMs: number
  /** Runs only while a temporary chat exists (nothing ticks at idle). */
  private timer: NodeJS.Timeout | null = null
  private readonly ending = new Set<Promise<void>>()
  /** Temporary uploads not (yet) used by a message of a live chat, by sha. */
  private readonly uploads = new Map<string, PendingUpload>()
  /** Set by the chat engine: stop a session's turn and resolve when it has settled. */
  private stopTurn: (uid: string) => Promise<void> = async () => undefined
  private closed = false

  constructor(
    private readonly ctx: ServerContext,
    o: TemporaryOptions = {}
  ) {
    this.noSubscriberMs = o.noSubscriberMs ?? envMs('VESPER_TEMP_NO_SUBSCRIBER_MS') ?? NO_SUBSCRIBER_MS
    this.maxIdleMs = o.maxIdleMs ?? MAX_IDLE_MS
    this.sweepMs = o.sweepMs ?? envMs('VESPER_TEMP_SWEEP_MS') ?? SWEEP_MS
  }

  setTurnStopper(fn: (uid: string) => Promise<void>): void {
    this.stopTurn = fn
  }

  /** A new temporary chat (POST /api/sessions {temporary:true}). */
  create(o: { title?: string; systemPrompt?: string; promptId?: number | null; deviceId: string | null; now: number }): { chat: TempChat; session: SessionRow } {
    if (this.closed) throw new VesperError('internal', { message: 'Vesper is shutting down.' })
    if (this.chats.size >= MAX_CHATS) throw new VesperError('conflict', { message: 'Too many temporary chats are open; close one first.' })
    const db = openDb(':memory:')
    let repos: ReposImpl
    let session: SessionRow
    try {
      // Sorting and temp B-trees stay in RAM too (never a temp file on disk).
      db.exec('PRAGMA temp_store = MEMORY')
      migrate(db, MIGRATIONS)
      repos = createRepos(db)
      session = repos.sessions.create({ title: o.title, systemPrompt: o.systemPrompt, promptId: o.promptId ?? null, now: o.now })
    } catch (e) {
      db.close()
      throw e
    }
    const main = coreOf(this.ctx).repos
    // Shared tables (prompts, facts, kv, attachments, devices) stay in vesper.db; only the chat's own rows are here.
    const mixed: ReposImpl = { ...main, sessions: repos.sessions, messages: repos.messages, branches: repos.branches, transcript: repos.transcript, epochs: repos.epochs }
    const scoped = Object.create(this.ctx, { repos: { value: mixed, enumerable: true }, db: { value: db, enumerable: true } }) as ServerContext
    roots.set(scoped, this.ctx)
    const chat: TempChat = {
      temporary: true,
      uid: session.uid,
      sessionId: session.id,
      ctx: scoped,
      repos: mixed,
      db,
      devices: new Set(o.deviceId ? [o.deviceId] : []),
      attachments: new Set(),
      lastActivity: o.now,
      idleSince: o.now,
      ending: false
    }
    this.chats.set(chat.uid, chat)
    this.ensureTimer()
    return { chat, session }
  }

  /** The sweep timer runs while a temporary chat or a pending temporary upload exists (nothing ticks at idle). */
  private ensureTimer(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.sweep(), this.sweepMs)
    this.timer.unref()
  }

  private stopTimerIfIdle(): void {
    if (!this.chats.size && !this.uploads.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** A file was uploaded with `?temporary=1` by this device (POST /api/attachments). */
  noteUpload(sha: string, deviceId: string | null, now = this.ctx.clock.now()): void {
    if (this.closed) return
    const u = this.uploads.get(sha)
    if (u) {
      u.at = now
      if (deviceId) u.devices.add(deviceId)
    } else this.uploads.set(sha, { devices: new Set(deviceId ? [deviceId] : []), at: now })
    this.ensureTimer()
  }

  /** Shas a live chat's messages use (they are dropped when that chat ends). */
  private usedByChats(): Set<string> {
    const used = new Set<string>()
    for (const c of this.chats.values()) if (!c.ending) for (const sha of c.attachments) used.add(sha)
    return used
  }

  /**
   * Drop unsent temporary uploads: those of devices with no live temporary chat (at once for `endedDevices`, after
   * the orphan grace otherwise) and any older than UPLOAD_IDLE_MS. Uploads a live chat now uses belong to that chat.
   */
  private sweepUploads(now: number, endedDevices?: ReadonlySet<string>): void {
    if (!this.uploads.size) return
    const used = this.usedByChats()
    const liveDevices = new Set<string>()
    for (const c of this.chats.values()) if (!c.ending) for (const d of c.devices) liveDevices.add(d)
    const drop: string[] = []
    for (const [sha, u] of this.uploads) {
      if (used.has(sha)) {
        this.uploads.delete(sha)
        continue
      }
      const devices = [...u.devices]
      const orphan = !devices.some((d) => liveDevices.has(d))
      const justEnded = orphan && (!devices.length || devices.some((d) => endedDevices?.has(d)))
      if (justEnded || (orphan && now - u.at >= UPLOAD_ORPHAN_GRACE_MS) || now - u.at >= UPLOAD_IDLE_MS) {
        this.uploads.delete(sha)
        drop.push(sha)
      }
    }
    this.forget(drop)
  }

  private forget(shas: string[]): void {
    if (!shas.length) return
    try {
      this.ctx.services.content?.forgetTemporary(shas)
    } catch (e) {
      this.ctx.log.warn('forgetting temporary attachments failed', { error: e })
    }
  }

  get(uid: string): TempChat | null {
    const c = this.chats.get(uid)
    return c && !c.ending ? c : null
  }

  has(uid: string): boolean {
    return this.get(uid) !== null
  }

  /** The chat and row of a message uid (REST and "speak again" look messages up by uid; ≤ 50 indexed lookups). */
  message(uid: string): { chat: TempChat; message: MessageRow } | null {
    for (const chat of this.chats.values()) {
      if (chat.ending) continue
      const message = chat.repos.messages.byUid(uid)
      if (message) return { chat, message }
    }
    return null
  }

  touch(chat: TempChat, now: number): void {
    chat.lastActivity = now
  }

  /** Chats this device sees in its list: ones it created or opened. */
  forDevice(deviceId: string): TempChat[] {
    this.noteSubscribers()
    return [...this.chats.values()].filter((c) => !c.ending && c.devices.has(deviceId))
  }

  summary(chat: TempChat): SessionSummary | null {
    const s = chat.repos.sessions.byId(chat.sessionId)
    return s ? { ...toSummary(chat.db, s), temporary: true } : null
  }

  /**
   * End a chat: refuse new work, stop and await its turn, close the connection, drop its attachments, tell clients.
   * Resolves when everything is released; false when there was no such chat.
   */
  end(uid: string, reason: EndReason): Promise<boolean> {
    const chat = this.chats.get(uid)
    if (!chat || chat.ending) return Promise.resolve(false)
    chat.ending = true
    const p = (async () => {
      try {
        await this.stopTurn(uid)
      } catch (e) {
        this.ctx.log.warn('stopping a temporary chat failed', { error: e })
      }
      this.chats.delete(uid)
      try {
        chat.db.close()
      } catch {
        /* already closed */
      }
      // Files still used by another live temporary chat stay (identical uploads share one temp file), and so do
      // files another device uploaded for a chat of its own that is still open.
      const stillUsed = new Set<string>()
      for (const other of this.chats.values()) for (const sha of other.attachments) stillUsed.add(sha)
      for (const [sha, u] of this.uploads) if ([...u.devices].some((d) => !chat.devices.has(d))) stillUsed.add(sha)
      const drop = [...chat.attachments].filter((sha) => !stillUsed.has(sha))
      for (const sha of drop) this.uploads.delete(sha)
      chat.attachments.clear()
      this.forget(drop)
      // Unsent uploads of this chat's devices go now when those devices have no other live temporary chat.
      this.sweepUploads(this.ctx.clock.now(), chat.devices)
      this.stopTimerIfIdle()
      if (reason !== 'shutdown') {
        this.ctx.hub.broadcast({ t: 'session.ended', sessionUid: uid })
        for (const d of chat.devices) this.ctx.hub.broadcast({ t: 'sessions.changed' }, { deviceId: d })
      }
      // The uid is gone for good: its event ring and every subscription to it go too (Phase 4 leak fix).
      this.ctx.hub.dropSession?.(uid)
      this.ctx.log.info('temporary chat ended', { reason })
    })()
    const owned = p.finally(() => this.ending.delete(owned))
    this.ending.add(owned)
    return p.then(() => true)
  }

  /** Subscribed clients keep a chat alive and make it visible to their device. */
  private noteSubscribers(): Set<string> {
    const watched = new Set<string>()
    for (const c of this.ctx.hub.clients()) {
      for (const uid of c.subscriptions) {
        const chat = this.chats.get(uid)
        if (!chat) continue
        watched.add(uid)
        chat.devices.add(c.device.id)
      }
    }
    return watched
  }

  sweep(now = this.ctx.clock.now()): void {
    if (this.closed) return
    const watched = this.noteSubscribers()
    for (const chat of [...this.chats.values()]) {
      if (chat.ending) continue
      if (watched.has(chat.uid)) chat.idleSince = null
      else chat.idleSince ??= now
      if (now - chat.lastActivity >= this.maxIdleMs) void this.end(chat.uid, 'idle')
      else if (chat.idleSince !== null && now - chat.idleSince >= this.noSubscriberMs) void this.end(chat.uid, 'no-subscriber')
    }
    this.sweepUploads(now)
    this.stopTimerIfIdle()
  }

  stats(): { chats: number; ending: number; timer: boolean; uploads: number } {
    return { chats: this.chats.size, ending: this.ending.size, timer: this.timer !== null, uploads: this.uploads.size }
  }

  /** Shutdown: every chat ends (restart = gone, 07 B9). Call after the engine stopped its turns. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.allSettled([...this.chats.keys()].map((uid) => this.end(uid, 'shutdown')))
    await Promise.allSettled([...this.ending])
    const pending = [...this.uploads.keys()]
    this.uploads.clear()
    this.forget(pending)
  }
}

const registry = new WeakMap<ServerContext, TemporaryChats>()
/** A temporary chat's scoped context → the server's own (services bound per context, e.g. memoryOf, use the root). */
const roots = new WeakMap<ServerContext, ServerContext>()

/** The server context behind `ctx` (itself unless it is a temporary chat's scoped context). */
export function rootOf(ctx: ServerContext): ServerContext {
  return roots.get(ctx) ?? ctx
}

/** The temporary chats of a server (created on first use; the chat engine closes them at shutdown). */
export function temporaryChatsOf(ctx: ServerContext, o?: TemporaryOptions): TemporaryChats {
  let t = registry.get(ctx)
  if (!t) {
    t = new TemporaryChats(ctx, o)
    registry.set(ctx, t)
  }
  return t
}

/** Is `uid` a live temporary chat? (WS subscribe check; no chats object is created for the question.) */
export function isTemporarySession(ctx: ServerContext, uid: string): boolean {
  return registry.get(ctx)?.has(uid) ?? false
}

/** Is this store a temporary chat? */
export function isTempChat(st: ChatStore): st is TempChat {
  return st.temporary
}

/** The main store of a server (vesper.db). */
export function mainStore(ctx: ServerContext): ChatStore {
  return { temporary: false, ctx, repos: coreOf(ctx).repos, db: ctx.db }
}

/** The store that holds session `uid` (a live temporary chat, else vesper.db). */
export function storeOf(ctx: ServerContext, uid: string): ChatStore {
  return registry.get(ctx)?.get(uid) ?? mainStore(ctx)
}

/** A message by uid in any store. */
export function findMessage(ctx: ServerContext, uid: string): { store: ChatStore; message: MessageRow } | null {
  const t = registry.get(ctx)?.message(uid)
  if (t) return { store: t.chat, message: t.message }
  const m = coreOf(ctx).repos.messages.byUid(uid)
  return m ? { store: mainStore(ctx), message: m } : null
}
