/**
 * The chat engine (ChatService, 03 §4 + 07 C1–C8, C15, C16, C18, C19). One turn per session at a time (busy →
 * `session_busy` unless `interrupt:true`); every turn runs as an owned task with its own AbortController, released in
 * `finally`, and `close()` aborts and awaits them all together with the background utility work.
 *
 * Turn: user message (+ header written once, 07 C2) → optional auto-recall → epoch choice (frozen system/tools, recap
 * rollover, 07 C1/C4) → state notes → rounds of provider streaming through the visible-text pipeline (tags stripped,
 * tone → speech) with the memory tool loop (≤ chat.maxToolCalls) → finalization that persists only complete blocks
 * (07 C6) → title / summary / draft-recap scheduling.
 *
 * Phase 3 (engine-int): every session lives in a ChatStore — vesper.db, or a temporary chat's in-memory store (07 B9,
 * ./temporary.ts) — and the turn reads/writes only through its store. Reply text is tidied as it streams (./tidy.ts),
 * so deltas, speech chunk texts and the stored body are one string. Synced reveal (R14, 07 C14/C16): every speaking
 * client gets no deltas (Phase 4: all of them, not only a lone speaker); when its speech degrades, fails or is
 * interrupted it gets one targeted `reply.snapshot` and then deltas. Talk mode (07 D6): fast voice model, a 300 ms auto-recall cap.
 */
import { createHash, randomBytes } from 'node:crypto'
import { apiError, VesperError, type ApiError } from '@shared/errors'
import { formatNow, isValidZoneName, ianaZone, turnHeader, zoneOf, type Zone } from '@shared/time'
import { tidyAfterTags, type ControlTag } from '@shared/tags'
import type { AttachmentRef, InflightReply, Message, ReplyState, Usage } from '@shared/types/domain'
import type { WireBlock } from '@shared/types/wire'
import type { SessionSummary } from '@shared/types/domain'
import type { ClientMsg } from '@shared/ws'
import { speakingToneMode } from '@shared/voiceTone'
import { coreOf } from '../core'
import type { EpochRow, MessageRow, Repos, SessionRow } from '../db/repos'
import { retryBusy, tx } from '../db/sqlite'
import { toMessage, toSummary } from '../http/convert'
import { toApiError } from '../http/errors'
import { memoryOf } from '../memory/service'
import { adapterFor, profileById, resolveProfile } from '../providers/llm/client'
import { isAbortError, mapProviderError } from '../providers/llm/errors'
import type { LlmAdapter, LlmRequest, ResolvedProfile } from '../providers/llm/types'
import type { ChatService, ServerContext, SpeechSink, SpeechSinkEvent, WsClient } from '../services'
import { createAttachmentSource } from './attachments'
import {
  baselineSnapshot,
  buildRequest,
  createEpoch,
  desiredToolMode,
  epochStartSeq,
  estimateBlocks,
  estimateRequest,
  memoryOn,
  notesFor,
  snapshotOf,
  type CtxSnapshot
} from './context'
import { finalizeRound } from './finalize'
import { LIMIT_REACHED, runMemoryFunction, type ToolRun } from './tools'
import { chatsOutOfReach, outOfReachText } from './scopeHint'
import { isTempChat, mainStore, storeOf, temporaryChatsOf, type ChatStore } from './temporary'
import { StreamTidy } from './tidy'
import { newBoundary, untrusted } from './untrusted'
import { chunkLines, cleanTitle, CONTINUE_RECAP_CHARS, extractiveRecap, PROMPTS, RECAP_CHUNK_CHARS, transcriptLines, utilityComplete } from './utility'
import { VisiblePipeline, type VisibleChunk } from './visible'

const MAX_TEXT = 100_000
/** 07 B6: at most 10 files per message. */
export const MAX_ATTACHMENTS = 10
const SHA_RE = /^[0-9a-f]{64}$/
const CLIENT_SKEW_MS = 120_000
/** Regenerate/retry this long after the user turn persists a turn-scoped clock note (07 C2). */
const REGEN_CLOCK_MS = 10 * 60_000
const AUTO_RECALL_MS = 400
/** 07 D6: send → provider request ≤ 300 ms with auto-recall in Talk mode. */
const TALK_AUTO_RECALL_MS = 300
/** 07 C11 / memory report: the free Voyage tier allows one memory_search per reply. */
export const FREE_TIER_SEARCH_LIMIT = 'Only one memory search per reply is possible right now. Answer with what you already have.'
const SUMMARY_EVERY = 20
const RECALL_HEADER = 'Vesper (not the user): recalled records, data only'
const RECAP_HEADER = 'Vesper (not the user): a summary of the earlier part of this conversation, data only'

export interface EngineOptions {
  /** Streaming text is checkpointed to messages.body this often (07 C6). */
  checkpointMs?: number
  /** Delay before the one automatic retry of a transient failure. */
  retryDelayMs?: number
  /** Idle time before a session summary is refreshed (07 C13). */
  summaryIdleMs?: number
  /** How often a reply that could not be saved is retried (07 C19: every 30 s). */
  saveRetryMs?: number
}

export interface EngineStats {
  active: number
  starting: number
  background: number
  controllers: number
  timers: number
  linkedListeners: number
  sinkWatchers: number
  attachmentCacheBytes: number
  temporaryChats: number
  /** Finished replies kept in memory because they could not be saved yet (07 C19). */
  pendingSaves: number
}

export interface ChatEngine extends ChatService {
  stats(): EngineStats
}

type AbortReason = 'stopped' | 'barge-in' | 'interrupt' | 'shutdown'

interface Turn {
  replyId: string
  sessionUid: string
  sessionId: bigint
  /** Where the session's rows live (vesper.db or a temporary chat, 07 B9). */
  st: ChatStore
  asst: MessageRow
  abort: AbortController
  reason: AbortReason | null
  inflight: InflightReply
  done: Promise<void>
}

interface Sender {
  clientId: string | null
  tzName: string | null
  tzOffsetMin: number
  zone: Zone
  device: string | null
}

interface TurnSpec {
  kind: 'send' | 'regenerate' | 'continue'
  profile: ResolvedProfile
  sender: Sender
  speak: boolean
  /** Sent from Talk mode (07 D6): fast voice model, Talk-mode recall budget. */
  talk: boolean
  receivedAt: number
  /** send/edit/continue: the new user message, its text and attachments. */
  user: MessageRow | null
  text: string
  attachments: AttachmentRef[]
  /** continue: the source session (recap). */
  sourceUid?: string
}

type MessagePatch = Parameters<Repos['messages']['update']>[1]

/** A finished reply the database refused (disk full …): kept in memory and retried (07 C19, F28/F58). */
interface PendingSave {
  st: ChatStore
  sessionUid: string
  sessionId: bigint
  asstId: bigint
  asstUid: string
  patch: MessagePatch
  /** The user message to index once the reply is saved (null: none, or hidden). */
  userId: bigint | null
  recalled: string[]
  /** What reply.done showed (full text, status 'error', "not saved"): served instead of the row until it lands (F28). */
  shown: Message
}

const NOT_SAVED_DISK = "Your disk is full, so this reply isn't saved yet. Free up some space; Vesper tries again every 30 seconds."
/** Messages before a new epoch's first turn quoted after its recap ("The last messages before this point"). */
const ROLLOVER_TAIL = 4

/**
 * A waiting recap draft (07 C4) with what it covered (F24), stored as JSON in `epochs.recap_draft`: the last message seq
 * and a hash of the message ids it summarised, so it is used only while the path still holds exactly those messages.
 * `force`: a new epoch was asked for (delete and refresh, apply protocols) and starts at the next turn regardless;
 * `text` null = not computed (yet). A plain-text draft from before this format is unverifiable and never used.
 * `purge`: a delete and refresh asked for it — the recap is rebuilt without deleted messages, also those an earlier
 * epoch's recap already summarised (F24). `ask`: the id of the newEpoch request that set `force`, so a rollover that
 * was already condensing when the refresh came can tell it did not see it and carries it over.
 */
interface Draft {
  text: string | null
  through: number
  hash: string
  force: boolean
  purge?: boolean
  ask?: string
}

function encodeDraft(d: Draft): string {
  return JSON.stringify({ v: 1, text: d.text, through: d.through, hash: d.hash, force: d.force, ...(d.purge ? { purge: true } : {}), ...(d.ask ? { ask: d.ask } : {}) })
}

function decodeDraft(raw: string | null): Draft | null {
  if (raw === null) return null
  try {
    const j = JSON.parse(raw) as Record<string, unknown> | null
    if (j && j.v === 1) {
      const d: Draft = { text: typeof j.text === 'string' ? j.text : null, through: Number(j.through) || 0, hash: typeof j.hash === 'string' ? j.hash : '', force: j.force === true }
      if (j.purge === true) d.purge = true
      if (typeof j.ask === 'string' && j.ask) d.ask = j.ask
      return d
    }
  } catch {
    /* a plain-text draft (older format) */
  }
  return { text: null, through: 0, hash: '', force: false }
}

const EMPTY_AT_LIMIT ="The model used its whole output limit before writing an answer (often on thinking). Raise the output limit or lower the reasoning effort in Settings."
const NOT_SAVED_DB = "Vesper couldn't save this reply yet. It tries again every 30 seconds."

type ChatSend = Extract<ClientMsg, { t: 'chat.send' }>
/** What a `chat.send` was acked with (a resend with the same clientMsgId gets it again, F62). */
type SendAck = { replyId?: string; messageUid: string }
/** How long, and how many, recent sends are remembered in memory for that (the user row's meta covers the rest). */
const RECENT_SEND_MS = 10 * 60_000
const RECENT_SEND_MAX = 500
type ChatRegen = Extract<ClientMsg, { t: 'chat.regenerate' }>
type ChatEdit = Extract<ClientMsg, { t: 'chat.edit' }>

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function createChatEngine(ctx: ServerContext, o: EngineOptions = {}): ChatEngine {
  const checkpointMs = o.checkpointMs ?? 2000
  const retryDelayMs = o.retryDelayMs ?? 1000
  const summaryIdleMs = o.summaryIdleMs ?? 60_000
  const saveRetryMs = o.saveRetryMs ?? 30_000
  const core = coreOf(ctx)
  const { hub, repos } = core
  const log = ctx.log.child('chat')
  const att = createAttachmentSource(ctx)
  const temps = temporaryChatsOf(ctx)

  const active = new Map<string, Turn>()
  const starting = new Set<string>()
  const background = new Set<Promise<unknown>>()
  /** Speech sinks being watched for barge-in; not awaited on close (the speech service aborts its own sinks). */
  const sinkWatchers = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  const summaryTimers = new Map<string, NodeJS.Timeout>()
  const draftJobs = new Set<string>()
  /** Sessions already told that the model cannot see images (07 C8 one-time toast); cleared on close. */
  const noVisionNoticed = new Set<string>()
  const pendingSaves = new Map<string, PendingSave>()
  /** `<sessionUid>:<clientMsgId>` → the send's ack (null: it failed), for resends after a lost ack (F62). */
  const recentSends = new Map<string, { at: number; result: Promise<SendAck | null> }>()
  let saveTimer: NodeJS.Timeout | null = null
  let linkedListeners = 0
  let closed = false

  // 07 C6: replies interrupted by a crash or quit are never left "streaming".
  repos.messages.recoverStreaming()

  // Ending a temporary chat stops its turn and waits for it before the store closes (07 B9).
  temps.setTurnStopper(async (uid) => {
    engine.stop(uid)
    await active.get(uid)?.done
  })

  hub.setInflightProvider((uid) => {
    const t = active.get(uid)
    return t ? [{ ...t.inflight }] : []
  })

  hub.on('chat.', async (client, msg) => {
    switch (msg.t) {
      case 'chat.send':
        return send(client, msg)
      case 'chat.stop':
        engine.stop(msg.sessionUid)
        return hub.ack(client, msg)
      case 'chat.regenerate':
        return regenerate(client, msg)
      case 'chat.edit':
        return edit(client, msg)
      default:
        throw new VesperError('validation', { message: 'Unknown chat request.' })
    }
  })

  /** Link a parent signal into a child controller; returns the unlink (listener ownership for the leak gate). */
  function link(parent: AbortSignal, child: AbortController): () => void {
    if (parent.aborted) {
      child.abort()
      return () => undefined
    }
    const fn = (): void => child.abort()
    parent.addEventListener('abort', fn, { once: true })
    linkedListeners++
    let done = false
    return () => {
      if (done) return
      done = true
      linkedListeners--
      parent.removeEventListener('abort', fn)
    }
  }

  /** Own a background promise until it settles. */
  function own<T>(p: Promise<T>): Promise<T> {
    background.add(p)
    void p.finally(() => background.delete(p)).catch(() => undefined)
    return p
  }

  /** An abortable controller that close() aborts. */
  function controller(): { ctl: AbortController; release(): void } {
    const ctl = new AbortController()
    controllers.add(ctl)
    return { ctl, release: () => void controllers.delete(ctl) }
  }

  // ── Admission ──────────────────────────────────────────────────────────────────────────────
  async function acquire(uid: string, interrupt: boolean | undefined): Promise<void> {
    if (closed) throw new VesperError('internal', { message: 'Vesper is shutting down.' })
    for (let i = 0; i < 3; i++) {
      const running = active.get(uid)
      if (!running && !starting.has(uid)) {
        starting.add(uid)
        return
      }
      if (!interrupt || !running) throw new VesperError('session_busy')
      running.reason = 'interrupt'
      running.abort.abort()
      await running.done
    }
    throw new VesperError('session_busy')
  }

  /** The session and the store it lives in (a temporary chat that is ending is gone). */
  function liveSession(uid: unknown): { s: SessionRow; st: ChatStore } {
    if (typeof uid !== 'string') throw new VesperError('validation')
    const st = storeOf(ctx, uid)
    const s = st.repos.sessions.byUid(uid)
    if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
    return { s, st }
  }

  /** SessionSummary for events (a temporary chat says so). */
  function summaryOf(st: ChatStore, s: SessionRow): SessionSummary {
    const sum = toSummary(st.db, s)
    return st.temporary ? { ...sum, temporary: true } : sum
  }

  /** "Refetch your list": a temporary chat only concerns the devices that have it (07 B9). */
  function sessionsChanged(st: ChatStore): void {
    if (!isTempChat(st)) return hub.broadcast({ t: 'sessions.changed' })
    for (const d of st.devices) hub.broadcast({ t: 'sessions.changed' }, { deviceId: d })
  }

  async function profileFor(s: SessionRow): Promise<ResolvedProfile> {
    const settings = ctx.settings.get()
    const prof = profileById(settings, s.llmProfile)
    if (!prof) throw new VesperError('provider_bad_request', { message: 'Choose an AI provider in Settings first.' })
    return resolveProfile(ctx, prof, { model: s.model })
  }

  function senderOf(client: WsClient | null, c: { ts: number; tzOffset: number; tzName: string | null } | undefined, now: number): Sender & { clientTs: number | null } {
    const override = ctx.settings.get().profile.timeZone
    let tzName: string | null = isValidZoneName(c?.tzName) ? c.tzName : isValidZoneName(client?.tz) ? client.tz : null
    let tzOffsetMin = Number.isFinite(c?.tzOffset) ? Math.max(-900, Math.min(900, Math.trunc(c?.tzOffset ?? 0))) : (client?.tzOffset ?? 0)
    if (isValidZoneName(override)) {
      tzName = override
      tzOffsetMin = ianaZone(override).partsAt(now).offsetMin
    }
    const clientTs = c && Number.isFinite(c.ts) && Math.abs(c.ts - now) > CLIENT_SKEW_MS ? c.ts : null
    return { clientId: client?.id ?? null, tzName, tzOffsetMin, zone: zoneOf(tzName, tzOffsetMin), device: client?.device.name ?? null, clientTs }
  }

  /**
   * The attachments of a message, through content-server (07 C8 single source). A stored session may only use
   * stored files; a temporary chat may also use files uploaded with ?temporary=1, which live in memory/temp only.
   */
  function attachmentRefs(st: ChatStore, shas: unknown): AttachmentRef[] {
    if (shas === undefined) return []
    if (!Array.isArray(shas) || shas.length > MAX_ATTACHMENTS) throw new VesperError('validation', { message: `At most ${MAX_ATTACHMENTS} attachments per message.` })
    const content = ctx.services.content
    const out: AttachmentRef[] = []
    for (const sha of shas) {
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new VesperError('validation')
      const row = st.repos.attachments.get(sha)
      let ref: AttachmentRef | null = null
      if (row || st.temporary) ref = content?.attachment(sha) ?? null
      if (!ref && row) {
        const { createdUtc: _c, ...plain } = row
        ref = plain
      }
      if (!ref) throw new VesperError('not_found', { message: 'An attachment was not uploaded.' })
      out.push(ref)
    }
    return out
  }

  /** A temporary chat remembers its files (dropped when it ends) and its last activity (24 h idle end). */
  function noteTemporary(st: ChatStore, attachments: AttachmentRef[], now: number): void {
    if (!isTempChat(st)) return
    temps.touch(st, now)
    for (const a of attachments) st.attachments.add(a.sha)
  }

  function newReplyId(): string {
    return `r_${randomBytes(8).toString('base64url')}`
  }

  /** The reply's row ('streaming'); `created` announces it once the turn's rows are committed. */
  function placeholderRow(st: ChatStore, s: SessionRow, sender: Sender, p: ResolvedProfile, now: number): MessageRow {
    return st.repos.messages.append({ sessionId: s.id, role: 'assistant', body: '', status: 'streaming', tsUtc: now, tzOffsetMin: sender.tzOffsetMin, tzName: sender.tzName, device: null, provider: p.preset.id, model: p.model })
  }

  function created(s: SessionRow, m: MessageRow): void {
    hub.emit(s.uid, { t: 'message.created', sessionUid: s.uid, message: toMessage(m, s.uid), lastSeq: m.seq })
  }

  /**
   * 07 C9 (Phase 4): a turn's first rows (fork, user message, reply placeholder) are written in ONE transaction and
   * retried asynchronously while db.worker holds the write lock — the main connection waits ≤ 250 ms per attempt
   * (MAIN_BUSY_TIMEOUT_MS) instead of blocking the event loop, and a busy attempt has written nothing.
   */
  function persist<T>(st: ChatStore, fn: () => T): Promise<T> {
    return retryBusy(() => tx(st.db, fn))
  }

  function startTurn(st: ChatStore, s: SessionRow, asst: MessageRow, spec: TurnSpec, replyId = newReplyId()): Turn {
    const t: Turn = {
      replyId,
      sessionUid: s.uid,
      sessionId: s.id,
      st,
      asst,
      abort: new AbortController(),
      reason: null,
      inflight: { replyId: '', messageUid: asst.uid, state: 'queued', text: '', speakingDeviceId: null },
      done: Promise.resolve()
    }
    t.inflight.replyId = t.replyId
    active.set(s.uid, t)
    starting.delete(s.uid)
    if (closed) {
      t.reason = 'shutdown'
      t.abort.abort()
    }
    t.done = own(
      runTurn(t, spec)
        .catch((e: unknown) => log.error('turn failed', { error: e }))
        .finally(() => {
          if (active.get(s.uid) === t) active.delete(s.uid)
        })
    )
    return t
  }

  // ── WS requests ────────────────────────────────────────────────────────────────────────────
  /**
   * F62 (07 C16): a resent `chat.send` (same clientMsgId — the client resends after a dropped socket, the ack may have
   * been lost) is answered with the original ack and never makes a second turn. In memory for sends in progress or
   * recent; after a restart the user row's `meta.clientMsgId` still answers it.
   */
  function storedSend(st: ChatStore, s: SessionRow, cmid: string): SendAck | null {
    const u = st.repos.messages
      .tail(s.id, 40)
      .reverse()
      .find((x) => x.role === 'user' && x.meta.clientMsgId === cmid)
    if (!u) return null
    const running = active.get(s.uid)
    return { messageUid: u.uid, ...(running && running.asst.seq === u.seq + 1 ? { replyId: running.replyId } : {}) }
  }

  function rememberSend(key: string): { done(a: SendAck | null): void } {
    const now = Date.now()
    for (const [k, v] of recentSends) if (now - v.at > RECENT_SEND_MS) recentSends.delete(k)
    if (recentSends.size >= RECENT_SEND_MAX) recentSends.delete(recentSends.keys().next().value as string)
    let settle!: (a: SendAck | null) => void
    const result = new Promise<SendAck | null>((r) => (settle = r))
    recentSends.set(key, { at: now, result })
    return {
      done(a) {
        settle(a)
        // A send that failed made nothing: a resend is a new attempt.
        if (!a && recentSends.get(key)?.result === result) recentSends.delete(key)
      }
    }
  }

  async function send(client: WsClient, m: ChatSend): Promise<void> {
    if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) throw new VesperError('validation', { message: 'The message is too long.' })
    if (m.clientMsgId !== undefined && (typeof m.clientMsgId !== 'string' || !m.clientMsgId || m.clientMsgId.length > 100)) throw new VesperError('validation')
    const { s: s0, st: st0 } = liveSession(m.sessionUid)
    const cmid = m.clientMsgId
    const key = cmid ? `${s0.uid}:${cmid}` : null
    if (key && cmid) {
      // Checked and registered in one synchronous stretch: a resend that arrives while this one is admitted waits for it.
      const inFlight = recentSends.get(key)
      const prior = inFlight ? await inFlight.result : storedSend(st0, s0, cmid)
      if (prior) return hub.ack(client, m, prior)
    }
    const attachments = attachmentRefs(st0, m.attachments)
    if (!m.text.trim() && !attachments.length) throw new VesperError('validation', { message: 'The message is empty.' })
    const remembered = key ? rememberSend(key) : null
    let acked: SendAck | null = null
    try {
      await acquire(s0.uid, m.interrupt)
    } catch (e) {
      remembered?.done(null)
      throw e
    }
    try {
      const { s, st } = liveSession(s0.uid)
      const p = await profileFor(s)
      const now = ctx.clock.now()
      const sender = senderOf(client, m.client, now)
      noteTemporary(st, attachments, now)
      const { user, asst } = await persist(st, () => ({
        user: st.repos.messages.append({
          sessionId: s.id,
          role: 'user',
          body: m.text,
          tsUtc: now,
          tzOffsetMin: sender.tzOffsetMin,
          tzName: sender.tzName,
          device: sender.device,
          attachments,
          meta: { ...(sender.clientTs !== null ? { clientTs: sender.clientTs } : {}), ...(cmid ? { clientMsgId: cmid } : {}) }
        }),
        asst: placeholderRow(st, s, sender, p, now)
      }))
      created(s, user)
      created(s, asst)
      const replyId = newReplyId()
      acked = { replyId, messageUid: user.uid }
      hub.ack(client, m, acked)
      startTurn(st, s, asst, { kind: 'send', profile: p, sender, speak: m.speak === true, talk: m.talk === true, receivedAt: now, user, text: m.text, attachments }, replyId)
    } catch (e) {
      starting.delete(s0.uid)
      throw e
    } finally {
      remembered?.done(acked)
    }
  }

  async function regenerate(client: WsClient, m: ChatRegen): Promise<void> {
    const { s: s0, st: st0 } = liveSession(m.sessionUid)
    const target = typeof m.messageUid === 'string' ? st0.repos.messages.byUid(m.messageUid) : null
    if (!target || target.sessionId !== s0.id || !target.onPath) throw new VesperError('not_found')
    if (target.role !== 'assistant') throw new VesperError('validation', { message: 'Only replies can be regenerated.' })
    await acquire(s0.uid, false)
    try {
      const { s, st } = liveSession(s0.uid)
      const p = await profileFor(s)
      const now = ctx.clock.now()
      const sender = senderOf(client, m.client, now)
      noteTemporary(st, [], now)
      const asst = await persist(st, () => {
        st.repos.branches.fork(s.id, target.seq, 'regenerate', now)
        return placeholderRow(st, s, sender, p, now)
      })
      forked(st, s, target.seq)
      created(s, asst)
      const replyId = newReplyId()
      hub.ack(client, m, { replyId, messageUid: asst.uid })
      startTurn(st, s, asst, { kind: 'regenerate', profile: p, sender, speak: m.speak === true, talk: false, receivedAt: now, user: null, text: '', attachments: [] }, replyId)
    } catch (e) {
      starting.delete(s0.uid)
      throw e
    }
  }

  async function edit(client: WsClient, m: ChatEdit): Promise<void> {
    if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) throw new VesperError('validation', { message: 'The message is too long.' })
    const { s: s0, st: st0 } = liveSession(m.sessionUid)
    const target = typeof m.messageUid === 'string' ? st0.repos.messages.byUid(m.messageUid) : null
    if (!target || target.sessionId !== s0.id || !target.onPath) throw new VesperError('not_found')
    if (target.role !== 'user') throw new VesperError('validation', { message: 'Only your own messages can be edited.' })
    const attachments = attachmentRefs(st0, m.attachments)
    if (!m.text.trim() && !attachments.length) throw new VesperError('validation', { message: 'The message is empty.' })
    await acquire(s0.uid, false)
    try {
      const { s, st } = liveSession(s0.uid)
      const p = await profileFor(s)
      const now = ctx.clock.now()
      const sender = senderOf(client, m.client, now)
      noteTemporary(st, attachments, now)
      const meta: Record<string, unknown> = { editOf: target.uid }
      if (sender.clientTs !== null) meta.clientTs = sender.clientTs
      const { user, asst } = await persist(st, () => {
        st.repos.branches.fork(s.id, target.seq, 'edit', now)
        const user = st.repos.messages.append({ sessionId: s.id, role: 'user', body: m.text, tsUtc: now, tzOffsetMin: sender.tzOffsetMin, tzName: sender.tzName, device: sender.device, attachments, meta })
        return { user, asst: placeholderRow(st, s, sender, p, now) }
      })
      forked(st, s, target.seq)
      created(s, user)
      created(s, asst)
      const replyId = newReplyId()
      hub.ack(client, m, { replyId, messageUid: user.uid })
      startTurn(st, s, asst, { kind: 'send', profile: p, sender, speak: m.speak === true, talk: false, receivedAt: now, user, text: m.text, attachments }, replyId)
    } catch (e) {
      starting.delete(s0.uid)
      throw e
    }
  }

  /** After a branch at `seq` (07 C3) was committed: tell memory and everyone that the path moved. */
  function forked(st: ChatStore, s: SessionRow, seq: number): void {
    // Ids of a temporary store mean nothing to memory (it reads vesper.db), and nothing of it is indexed anyway.
    if (!st.temporary) ctx.services.memory?.onPathChanged(s.id)
    hub.emit(s.uid, { t: 'session.path_changed', sessionUid: s.uid, forkSeq: seq, lastSeq: seq - 1 })
  }

  // ── The turn ───────────────────────────────────────────────────────────────────────────────
  async function runTurn(t: Turn, spec: TurnSpec): Promise<void> {
    const uid = t.sessionUid
    const st = t.st
    const R = st.repos
    const p = spec.profile
    const adapter: LlmAdapter = adapterFor(p)
    const settings = ctx.settings.get()
    const marks: Record<string, number> = {}
    const t0 = spec.receivedAt
    const mark = (k: string): void => {
      marks[k] ??= ctx.clock.now() - t0
    }
    /** The reply text so far, tidied as it streams: deltas, speech chunk texts and the stored body all equal it. */
    let body = ''
    const tidy = new StreamTidy()
    let lastCheckpoint = ''
    const usage: Usage = {}
    const recalled: string[] = []
    const searches = { count: 0 }
    let sink: SpeechSink | null = null
    /**
     * Synced reveal (07 C16): the speaking clients that get chunk texts with their audio instead of deltas — every
     * one of them (Phase 4: the hub's `except` takes a set), not only a lone speaker.
     */
    const revealing = new Set<string>()
    /** Speaking clients still receiving audio, and whether any audio has reached them yet. */
    const speaking = new Set<string>()
    let firstAudio = false
    let user = spec.user
    let userBlocks: WireBlock[] = []
    /** The user turn a context overflow rolls over at (07 C19): a send's new message, or the turn a regenerate answers. */
    let retryUser: MessageRow | null = null
    let retryBlocks: WireBlock[] = []
    let userWritten = spec.kind === 'regenerate'
    let part = 0
    let finished = false
    /** The answer stopped at the model's output limit (F63): kept, complete, marked "cut off". */
    let truncated = false

    const status = (state: ReplyState, detail?: string): void => {
      if (t.inflight.state === state && !detail) return
      t.inflight.state = state
      hub.emit(uid, { t: 'reply.status', sessionUid: uid, replyId: t.replyId, messageUid: t.asst.uid, state, ...(detail ? { detail } : {}) })
    }
    /** While text streams: 'preparing-voice' (speech open, no audio yet), 'speaking' (audio sent), else 'writing'. */
    const textState = (): ReplyState => (speaking.size ? (firstAudio ? 'speaking' : 'preparing-voice') : 'writing')
    const checkpoint = setInterval(() => {
      if (body === lastCheckpoint || finished) return
      lastCheckpoint = body
      try {
        R.messages.update(t.asst.id, { body })
      } catch (e) {
        log.warn('checkpoint failed', { error: e })
      }
    }, checkpointMs)
    checkpoint.unref()

    const emitText = (raw: string): void => {
      const text = tidy.push(raw)
      if (!text) return
      if (!body) mark('firstText')
      body += text
      t.inflight.text = body
      status(textState())
      hub.emit(uid, { t: 'reply.delta', sessionUid: uid, replyId: t.replyId, text }, revealing.size ? { except: revealing } : undefined)
      sink?.push(text)
    }

    /**
     * The speaking client stops getting audio-paced text (its speech degraded, failed or was interrupted): it gets the
     * text so far in ONE targeted `reply.snapshot`, then ordinary deltas (R14, 07 C14/C16).
     */
    const releaseSpeaker = (clientId: string): void => {
      if (!revealing.delete(clientId)) return
      if (hub.client(clientId)) hub.emit(uid, { t: 'reply.snapshot', sessionUid: uid, reply: { ...t.inflight } }, { only: clientId })
    }
    const speechGone = (): void => {
      t.inflight.speakingDeviceId = null
      if (!finished && (t.inflight.state === 'preparing-voice' || t.inflight.state === 'speaking')) status('writing')
    }
    const onSpeech = (e: SpeechSinkEvent): void => {
      if (finished) return
      if (e.kind === 'first-audio') {
        firstAudio = true
        if (t.inflight.state === 'preparing-voice') status('speaking')
      } else if (e.kind === 'degraded') {
        speaking.delete(e.clientId)
        if (!speaking.size) speechGone()
        releaseSpeaker(e.clientId)
      } else {
        // speech.error: the rest of the reply is text for everyone.
        speaking.clear()
        speechGone()
        for (const id of [...revealing]) releaseSpeaker(id)
      }
    }

    const addUsage = (u: Usage): void => {
      for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'reasoning'] as const) if (u[k]) usage[k] = (usage[k] ?? 0) + (u[k] ?? 0)
    }

    /** One transcript row of this reply; retried asynchronously while db.worker holds the lock (07 C9). */
    const writeRow = async (role: 'assistant' | 'tool' | 'system', blocks: WireBlock[]): Promise<void> => {
      await retryBusy(() => {
        R.transcript.append({ sessionId: t.sessionId, messageId: t.asst.id, part, role, blocks, provider: p.preset.id, model: p.model, createdUtc: ctx.clock.now() })
        part++
      })
    }

    const recordRecall = (run: ToolRun | { hits: { messageUid: string }[] }): void => {
      for (const h of run.hits) recalled.push(h.messageUid)
    }

    let epoch: EpochRow | null = null
    try {
      status('thinking')
      let s = R.sessions.byId(t.sessionId)
      if (!s) throw new VesperError('not_found')
      const zone = spec.sender.zone
      const clock = settings.profile.clock
      const memOn = memoryOn(settings, s)
      const toneOn = speakingToneMode(settings.voice.tts, s.voice) !== 'off'

      // Speech is fixed at reply start (07 C16); Talk mode uses the fast voice model (07 D6).
      const speech = ctx.services.speech
      if (spec.speak && speech) {
        const clientIds = speakers(uid, spec.sender.clientId, spec.kind === 'continue')
        if (clientIds.length) {
          for (const id of clientIds) speaking.add(id)
          if (settings.voice.tts.reveal === 'synced') for (const id of clientIds) revealing.add(id)
          const c = hub.client(clientIds[0])
          t.inflight.speakingDeviceId = c?.device.id ?? null
          sink = speech.open({ replyId: t.replyId, sessionUid: uid, clientIds, messageUid: t.asst.uid, receivedAt: t0 }, { voiceOverride: s.voice, talkMode: spec.talk, onEvent: onSpeech })
          watchSink(t, sink, () => {
            // Barge-in (07 C15): the speaker keeps its revealed text and can "show rest" from the snapshot.
            speaking.clear()
            t.inflight.speakingDeviceId = null
            for (const id of [...revealing]) releaseSpeaker(id)
          })
        }
      }

      if (spec.kind === 'send' || spec.kind === 'continue') {
        user = user as MessageRow
        const header = turnHeader(user.tsUtc, zone, R.messages.previousOnPath(s.id, user.seq)?.tsUtc ?? null, clock)
        const blocks: WireBlock[] = [{ t: 'text', text: spec.kind === 'continue' ? `${header}\n${continueText(s)}` : spec.text ? `${header}\n${spec.text}` : header }]
        blocks.push(...attachmentBlocks(spec.attachments))
        if (!p.caps.vision && spec.attachments.some((a) => a.kind === 'image') && !noVisionNoticed.has(uid)) {
          noVisionNoticed.add(uid)
          const toast = { t: 'toast' as const, tone: 'info' as const, text: "This model can't see images, so it gets each image's name and size instead." }
          if (spec.sender.clientId) hub.broadcast(toast, { clientId: spec.sender.clientId })
        }

        if (spec.kind === 'continue' && spec.sourceUid) {
          status('recapping')
          const recap = await engine.recap(spec.sourceUid)
          blocks.push({ t: 'memory_result', text: `${RECAP_HEADER}\n${untrusted('recap', newBoundary(), recap)}` })
        }

        // Auto-recall: data appended after the user's own words (07 B7/C2), within a tight budget (07 D6: Talk mode 300 ms).
        const memory = ctx.services.memory
        if (spec.kind === 'send' && memOn && memory && settings.memory.autoRecall && spec.text.trim().split(/\s+/).length >= 3) {
          status('recalling')
          const budget = spec.talk ? TALK_AUTO_RECALL_MS : AUTO_RECALL_MS
          const hits = await raceAbort(
            memory.autoRecall(spec.text, { sessionUid: uid }, budget).catch(() => []),
            t.abort.signal,
            [],
            budget + 50
          )
          if (hits.length) {
            const text = memory.formatResult(hits, { query: spec.text.slice(0, 200), nowUtc: ctx.clock.now(), tzName: spec.sender.tzName, tzOffsetMin: spec.sender.tzOffsetMin })
            blocks.push({ t: 'memory_result', text: `${RECALL_HEADER}\n${text}` })
            recordRecall({ hits })
            hub.emit(uid, { t: 'reply.tool', sessionUid: uid, replyId: t.replyId, kind: 'auto', query: spec.text.slice(0, 200), count: hits.length, sessions: [...new Set(hits.map((x) => x.shortId))] })
          }
          status('thinking')
        }

        userBlocks = blocks
        if (spec.kind === 'send') {
          retryUser = user
          retryBlocks = blocks
        }
        epoch = await chooseEpoch(t, s, p, user, blocks, status)
        s = R.sessions.byId(t.sessionId) as SessionRow
        await writeUserRows(st, s, epoch, user, blocks, spec.speak)
        userWritten = true
      } else {
        // Regenerate: the context is the path up to the user turn; notes go to part 0 of the new reply. The epoch is
        // chosen like a send's (F25/F26): imported history becomes a recap, a tool-mode switch or the hard window
        // rolls over at the user turn.
        const sc = st.ctx
        const prev = R.messages.previousOnPath(s.id, t.asst.seq)
        const chosen = await regenEpoch(t, s, p, prev, spec.speak, status)
        epoch = chosen.epoch
        retryUser = chosen.user
        retryBlocks = chosen.blocks
        s = R.sessions.byId(t.sessionId) as SessionRow
        const snap = snapshotOf(sc, s, spec.speak)
        const base = baselineSnapshot(sc, s, epochStartSeq(sc, epoch), t.asst.seq)
        const notes = base ? await notesFor({ ctx: sc, session: s, snapshot: snap, baseline: base, interruptedAfter: null, epoch }) : []
        const now = ctx.clock.now()
        if (prev && now - prev.tsUtc > REGEN_CLOCK_MS) notes.unshift(`[Now: ${formatNow(now, zone, clock)}]`)
        await retryBusy(() => R.messages.update(t.asst.id, { meta: { ...t.asst.meta, ctx: snap } }))
        if (notes.length) await writeRow('system', notes.map((text) => ({ t: 'system_note', text })))
      }

      // ── Rounds ───────────────────────────────────────────────────────────────────────────
      const maxCalls = settings.chat.maxToolCalls
      let calls = 0
      const retried = { history: false, context: false, transient: false }
      let refusal = false
      for (let round = 0; round <= maxCalls + 1; round++) {
        if (t.abort.signal.aborted) break
        const rows = R.transcript.forEpoch(epoch)
        const req = buildRequest(p, epoch, rows)
        // Adapters render synchronously: read the images/documents first, through content-server (07 C8).
        const pinned = await att.preload(mediaShas(req))
        if (t.abort.signal.aborted) break
        const roundCtl = new AbortController()
        const unlink = link(t.abort.signal, roundCtl)
        const pipe = new VisiblePipeline()
        /** Raw (pre-tidy) offset where this round's visible text starts, for tone positions. */
        let roundRaw = tidy.rawLength
        let raw = ''
        let cut: ControlTag | null = null
        let emitted = false
        let failure: unknown = null
        const stream = att.rendering(pinned, () => adapter.stream(req, att, roundCtl.signal))
        pinned.clear()
        mark('requestSent')

        const onVisible = (out: VisibleChunk): void => {
          if (out.reasoning) onReasoning(out.reasoning)
          const releasedBefore = pipe.length - out.text.length
          let text = out.text
          for (const tag of out.tags) {
            if (tag.name === 'tone') {
              // The paragraph break before a later round's first text counts too (2 raw chars, see below).
              const sepNext = !emitted && round > 0 && body ? 2 : 0
              // H-v11-tone: with tones off (or a voice that can't use them) a stray tag is stripped and goes nowhere.
              if (toneOn && tag.attrs.value) sink?.tone(tag.attrs.value.slice(0, 80), tidy.position(roundRaw + sepNext + tag.at))
            } else if (epoch?.toolMode === 'text' && !cut) {
              // Text mode: the model writes the call alone and stops; Vesper stops the stream right there (research 01 §2.5).
              cut = tag
              text = text.slice(0, Math.max(0, tag.at - releasedBefore))
              roundCtl.abort()
              break
            }
          }
          if (!text) return
          // Text from a later round (after a tool call) starts a new paragraph (the tidy collapses extra newlines).
          if (!emitted && round > 0 && body) emitText('\n\n')
          emitted = true
          emitText(text)
        }
        const onReasoning = (text: string): void => {
          mark('firstToken')
          if (!body) status('thinking')
          if (settings.chat.showReasoning) hub.emit(uid, { t: 'reply.reasoning', sessionUid: uid, replyId: t.replyId, text })
        }

        try {
          for await (const ev of stream.events) {
            if (ev.type === 'text') {
              mark('firstToken')
              raw += ev.text
              if (!cut) onVisible(pipe.push(ev.text))
            } else if (ev.type === 'reasoning') onReasoning(ev.text)
            else if (ev.type === 'tool_start') status('recalling')
            else if (ev.type === 'usage') {
              /* summed from the round result below */
            }
          }
          if (!cut && !roundCtl.signal.aborted) onVisible(pipe.end())
        } catch (e) {
          if (!(isAbortError(e) || roundCtl.signal.aborted)) failure = e
        } finally {
          unlink()
        }
        const res = stream.result()
        addUsage(res.usage)
        // F54: a stream that ends with finish_reason "error" (OpenRouter, vLLM: an upstream/internal failure during
        // generation) is the service's internal error, not "busy"; with no text yet it gets the one transient retry.
        if (!failure && !cut && !roundCtl.signal.aborted && res.stopReason === 'error') failure = new VesperError('provider_error')

        if (failure) {
          const ve = mapProviderError(failure)
          const code = ve.info.code
          if (!emitted && !t.abort.signal.aborted) {
            if (code === 'provider_history' && !retried.history) {
              // 07 C5: strip the epoch's earlier thinking (persisted), retry once.
              retried.history = true
              const first = R.transcript.forMessage(t.asst.id)[0]
              const watermark = first ? first.id : (rows.at(-1)?.id ?? 0n) + 1n
              epoch = R.epochs.update(epoch.id, { thinkingStripBefore: watermark })
              log.warn('thinking stripped after a history error', { epoch: Number(epoch.id) })
              round--
              continue
            }
            if (code === 'provider_context' && !retried.context && retryUser && round === 0) {
              // 07 C19: forced rollover + one retry (a regenerate too, F26: at the user turn it answers).
              retried.context = true
              status('summarizing')
              const s = R.sessions.byId(t.sessionId) as SessionRow
              // The user turn's row moves to the new epoch, where its first row carries the recap (07 C4).
              R.transcript.deleteForMessage(retryUser.id)
              epoch = await rollover(t, s, p, epoch, retryUser, null)
              await writeUserRows(st, R.sessions.byId(t.sessionId) as SessionRow, epoch, retryUser, retryBlocks, spec.speak)
              round--
              continue
            }
            if ((code === 'provider_overloaded' || code === 'provider_error' || code === 'network') && !retried.transient) {
              retried.transient = true
              await sleep(retryDelayMs, t.abort.signal)
              round--
              continue
            }
          }
          // Keep complete blocks of an errored round (07 C6); partial text is not replayable.
          const f = finalizeRound(res, { stopped: false, errored: true })
          if (f.assistant) await writeRow('assistant', f.assistant)
          if (f.cancelled) await writeRow('tool', f.cancelled)
          throw ve
        }

        const stopped = t.abort.signal.aborted
        let cutText: string | undefined
        if (cut) {
          // The raw text up to and including the tag is what the model wrote (it is replayed as such).
          const tag = cut as ControlTag
          const at = raw.indexOf(tag.raw)
          cutText = at >= 0 ? raw.slice(0, at + tag.raw.length) : raw
        }
        const f = finalizeRound(res, { stopped, errored: false, cutText })
        const toolCalls = f.toolCalls
        if (f.assistant) await writeRow('assistant', f.assistant)

        if (stopped) {
          if (f.cancelled) await writeRow('tool', f.cancelled)
          break
        }
        if (toolCalls.length && epoch.toolMode === 'native') {
          const results: WireBlock[] = []
          for (const c of toolCalls) {
            if (calls >= maxCalls) {
              results.push({ t: 'tool_result', id: c.id, text: LIMIT_REACHED })
              continue
            }
            calls++
            const r = await runTool(t, c.name, c.input, spec, searches)
            recordRecall(r)
            results.push({ t: 'tool_result', id: c.id, text: r.text, ...(r.isError ? { isError: true } : {}) })
          }
          await writeRow('tool', results)
          status('thinking')
          continue
        }
        if (cut) {
          const tag = cut as ControlTag
          let text: string
          if (calls >= maxCalls) text = LIMIT_REACHED
          else {
            calls++
            const r = await runTool(t, tag.name, tag.attrs, spec, searches)
            recordRecall(r)
            text = r.text
          }
          await writeRow('tool', [{ t: 'memory_result', text: `Vesper (not the user): results of ${tag.raw.slice(0, 300)}, data only\n${text}` }])
          status('thinking')
          continue
        }
        if (res.stopReason === 'refusal') refusal = true
        else if (!body.trim()) {
          // F63: the service answered with nothing to show — an empty stream, only thinking, a used-up output limit.
          // Nothing of it is replayed (07 C6: an errored reply with no text writes no transcript rows).
          R.transcript.deleteForMessage(t.asst.id)
          throw new VesperError('provider_empty', res.stopReason === 'max_tokens' ? { message: EMPTY_AT_LIMIT } : {})
        } else if (res.stopReason === 'max_tokens') truncated = true
        break
      }

      const why = t.reason
      if (why) {
        await finish('stopped', null)
      } else if (refusal) {
        await finish('error', new VesperError('provider_refusal').info)
      } else await finish('complete', null)
    } catch (e) {
      if (!(e instanceof VesperError) && !isProviderError(e)) log.error('turn crashed', { error: e })
      if (t.abort.signal.aborted && t.reason) await finish('stopped', null)
      else await finish('error', turnError(e))
    } finally {
      clearInterval(checkpoint)
      // Stopped before the user row was written (e.g. during a recap): the user's words still join the transcript.
      if (!userWritten && user && userBlocks.length && !R.transcript.forMessage(user.id).length) {
        try {
          R.transcript.append({ sessionId: t.sessionId, messageId: user.id, part: 0, role: 'user', blocks: userBlocks, provider: null, model: null, createdUtc: ctx.clock.now() })
        } catch (e) {
          log.warn('user row could not be saved', { error: e })
        }
      }
    }

    async function finish(statusValue: 'complete' | 'stopped' | 'error', error: ApiError | null): Promise<void> {
      if (finished) return
      finished = true
      tidy.end()
      // body is already tidied as it streamed; tidyAfterTags is idempotent and documents the invariant.
      const final = tidyAfterTags(body)
      const now = ctx.clock.now()
      mark('done')
      const patch: MessagePatch = {
        body: final,
        status: statusValue,
        error: error ? { code: error.code, message: error.message } : null,
        usage: Object.keys(usage).length ? usage : null,
        provider: p.preset.id,
        model: p.model,
        tsUtc: now,
        ...(t.reason === 'barge-in' ? { interrupted: true } : {}),
        ...(truncated ? { meta: { ...(R.messages.byId(t.asst.id)?.meta ?? t.asst.meta), truncated: true } } : {})
      }
      let done: MessageRow
      /** The reply could not be saved (07 C19): it is kept in memory, retried, and the turn still ends (F28/F58). */
      let notSaved: ApiError | null = null
      try {
        // 07 C9: retried asynchronously while db.worker holds the write lock (a finished reply is never dropped).
        done = await retryBusy(() => R.messages.update(t.asst.id, patch))
      } catch (e) {
        notSaved = notSavedError(e)
        log.warn('reply could not be saved; kept in memory and retried', { error: e, code: notSaved.code })
        // What clients get meanwhile: the full text, marked "not saved" (an error row until the retry lands).
        done = { ...t.asst, ...patch, status: 'error', error: { code: notSaved.code, message: notSaved.message } }
      }
      // The live "Remembered" count (07 A4) = distinct recalled messages, as memory_injections stores them (the count a
      // page load shows): auto-recall and a memory tool finding the same message count once.
      const recalledCount = new Set(recalled).size
      const doneMsg = toMessage(done, uid, recalledCount ? { recalled: recalledCount } : {})
      if (notSaved) {
        keepUnsaved({ st, sessionUid: uid, sessionId: t.sessionId, asstId: t.asst.id, asstUid: t.asst.uid, patch, userId: user && !user.hidden ? user.id : null, recalled: [...new Set(recalled)], shown: doneMsg })
      }
      if (sink) {
        if (statusValue === 'complete') sink.end(final)
        else if (t.reason !== 'barge-in') sink.abort(statusValue === 'error' ? 'error' : 'stopped')
      }
      const state: ReplyState = notSaved ? 'error' : statusValue === 'complete' ? 'done' : statusValue
      t.inflight.state = state
      hub.emit(uid, { t: 'reply.status', sessionUid: uid, replyId: t.replyId, messageUid: t.asst.uid, state })
      const shownError = notSaved ?? error
      if (shownError) hub.emit(uid, { t: 'reply.error', sessionUid: uid, replyId: t.replyId, error: shownError })
      hub.emit(uid, { t: 'reply.timing', sessionUid: uid, replyId: t.replyId, marks })
      const s = R.sessions.byId(t.sessionId)
      if (s) hub.emit(uid, { t: 'session.updated', sessionUid: uid, session: summaryOf(st, s) })
      // reply.done last: clients treat it as the end of the turn.
      hub.emit(uid, { t: 'reply.done', sessionUid: uid, replyId: t.replyId, message: doneMsg })
      sessionsChanged(st)
      // Memory hooks and the title/summary run when the reply is actually in the database.
      if (notSaved) return
      afterPersisted(st, uid, t.asst.uid, t.asst.id, user && !user.hidden ? user.id : null, final, [...new Set(recalled)])
      if (s && statusValue === 'complete') afterReply(s)
      // A save that worked is a good moment to retry the ones that did not (07 C19).
      if (pendingSaves.size) flushPendingSaves()
    }
  }

  /** Memory bookkeeping once a reply is in the database (never for a temporary chat, 07 B9). */
  function afterPersisted(st: ChatStore, uid: string, asstUid: string, asstId: bigint, userId: bigint | null, body: string, recalled: string[]): void {
    if (recalled.length) {
      // memory_injections only through memory's API (one writer; the "Remembered" chip reads them). A temporary
      // chat's go to its own in-memory store (F71: ids never cross stores), so this runs before the temporary return.
      try {
        memoryOf(ctx).recordInjections(uid, asstUid, recalled.map((messageUid) => ({ messageUid })))
      } catch (e) {
        log.debug('recalled rows not recorded', { error: e })
      }
    }
    // A temporary chat is never indexed, never recalled and has no rows in vesper.db for memory to point at (07 B9).
    if (st.temporary) return
    const memory = ctx.services.memory
    if (memory) {
      if (userId !== null) memory.onMessagePersisted(userId)
      if (body) memory.onMessagePersisted(asstId)
    }
  }

  /** The "not saved" error a reply shows while it waits for its retry: the disk, or the database. */
  function notSavedError(e: unknown): ApiError {
    const base = toApiError(e)
    if (base.code === 'disk_full') return apiError('disk_full', { message: NOT_SAVED_DISK })
    return apiError('db_error', { retryable: true, message: NOT_SAVED_DB })
  }

  function keepUnsaved(ps: PendingSave): void {
    pendingSaves.set(`${ps.sessionUid}:${ps.asstUid}`, ps)
    if (saveTimer || closed) return
    saveTimer = setInterval(flushPendingSaves, saveRetryMs)
    saveTimer.unref()
  }

  /** Retry the replies that could not be saved (07 C19: every 30 s, after the next successful save, and on close). */
  function flushPendingSaves(): void {
    for (const [key, ps] of [...pendingSaves]) {
      // A temporary chat that ended took its rows with it.
      if (isTempChat(ps.st) && !temps.has(ps.sessionUid)) {
        pendingSaves.delete(key)
        continue
      }
      // The message (or its whole chat) is gone — the trash was emptied — or the owner deleted it: nothing to save.
      if (unsavedTargetGone(ps)) {
        pendingSaves.delete(key)
        log.info('a reply that could not be saved is dropped: its message no longer exists')
        continue
      }
      let row: MessageRow
      try {
        row = ps.st.repos.messages.update(ps.asstId, ps.patch)
      } catch (e) {
        if (unsavedTargetGone(ps)) {
          pendingSaves.delete(key)
          log.info('a reply that could not be saved is dropped: its message no longer exists')
        } else log.debug('unsaved reply: still failing', { error: e })
        continue
      }
      pendingSaves.delete(key)
      log.info('a reply that could not be saved is saved now')
      hub.emit(ps.sessionUid, { t: 'message.updated', sessionUid: ps.sessionUid, message: toMessage(row, ps.sessionUid) })
      const s = ps.st.repos.sessions.byId(ps.sessionId)
      if (s) hub.emit(ps.sessionUid, { t: 'session.updated', sessionUid: ps.sessionUid, session: summaryOf(ps.st, s) })
      sessionsChanged(ps.st)
      // A chat in the trash is saved (it can be restored) but gets no memory indexing, title or summary.
      if (s && s.deletedUtc !== null) continue
      afterPersisted(ps.st, ps.sessionUid, ps.asstUid, ps.asstId, ps.userId, row.body, ps.recalled)
      if (s && row.status === 'complete' && !closed) afterReply(s)
    }
    if (!pendingSaves.size && saveTimer) {
      clearInterval(saveTimer)
      saveTimer = null
    }
  }

  /** Is the message a pending save targets deleted, or gone with its chat? (A read error says nothing: keep it.) */
  function unsavedTargetGone(ps: PendingSave): boolean {
    try {
      const m = ps.st.repos.messages.byId(ps.asstId)
      return !m || m.deleted || !ps.st.repos.sessions.byId(ps.sessionId)
    } catch {
      return false
    }
  }

  /** Images and documents a request renders (their bytes are read before the synchronous render). */
  function mediaShas(req: LlmRequest): string[] {
    const out: string[] = []
    for (const turn of req.turns) for (const b of turn.blocks) if (b.t === 'image' || b.t === 'document') out.push(b.sha)
    return out
  }

  function isProviderError(e: unknown): boolean {
    return !!e && typeof e === 'object' && ('status' in e || (e as { name?: string }).name?.startsWith('API') === true)
  }

  /**
   * The error a failed turn reports (F61). Provider failures are mapped where the adapter stream fails (the round's
   * `failure`), so what reaches the turn's catch otherwise is Vesper's own: a full disk, a busy or broken database, a
   * bug — never "The AI service rejected the request" (07 C19, H1: busy → retryable db_error).
   */
  function turnError(e: unknown): ApiError {
    if (e instanceof VesperError) return e.info
    if (isProviderError(e)) return mapProviderError(e).info
    return toApiError(e)
  }

  /**
   * The device's tab that asked for a continuation (P22): the tab that named itself (`speakClientId`, when it is a live
   * tab of that device), else one showing the source chat (focused first), else the device's focused, audio-unlocked
   * tab — `/continue #ID` is usually typed in another chat, and the sidebar continues chats that are not open.
   */
  function continuationSpeaker(deviceId: string, sourceUid: string, named: string | undefined): WsClient | null {
    const own = named ? hub.client(named) : undefined
    if (own && own.device.id === deviceId) return own
    let best: WsClient | null = null
    for (const c of hub.clients()) {
      if (c.device.id !== deviceId || !c.subscriptions.has(sourceUid)) continue
      if (!best || (c.state.focused && !best.state.focused)) best = c
    }
    if (best) return best
    for (const c of hub.clients()) if (c.device.id === deviceId && c.state.focused && c.state.audioUnlocked) return c
    return null
  }

  /**
   * Clients that play the reply's audio (07 C16 perDevice). A continuation's sender always speaks (P22): it chose the
   * opener's speech before it had moved on to (and subscribed to) the new chat.
   */
  function speakers(uid: string, senderId: string | null, continuation = false): string[] {
    const per = ctx.settings.get().voice.tts.perDevice
    if (per === 'sender') return senderId ? [senderId] : []
    const out: string[] = []
    if (continuation && senderId && hub.client(senderId)) out.push(senderId)
    for (const c of hub.clients()) if (!out.includes(c.id) && c.subscriptions.has(uid) && (c.id === senderId || c.state.audioUnlocked)) out.push(c.id)
    return out
  }

  /** Barge-in (07 C15): hand the speaker its text, stop the stream if still running, persist what was spoken. */
  function watchSink(t: Turn, sink: SpeechSink, onInterrupted: () => void): void {
    const w = sink.done
      .then((r) => {
        if (!r.interrupted) return
        if (active.get(t.sessionUid) === t && !t.abort.signal.aborted) {
          onInterrupted()
          t.reason = 'barge-in'
          t.abort.abort()
        }
        try {
          const m = t.st.repos.messages.update(t.asst.id, { interrupted: true, spokenChars: r.spokenChars })
          hub.emit(t.sessionUid, { t: 'message.updated', sessionUid: t.sessionUid, message: toMessage(m, t.sessionUid) })
        } catch (e) {
          log.warn('barge-in bookkeeping failed', { error: e })
        }
      })
      .catch((e: unknown) => log.warn('speech sink failed', { error: e }))
      .finally(() => sinkWatchers.delete(w))
    sinkWatchers.add(w)
  }

  /** Is Voyage on its free tier (07 C11: then at most one memory_search per reply)? */
  function freeTier(): boolean {
    try {
      return ctx.services.memory?.status().tier === 'free'
    } catch {
      return false
    }
  }

  async function runTool(t: Turn, name: string, input: Record<string, unknown>, spec: TurnSpec, searches: { count: number }): Promise<ToolRun> {
    const s = t.st.repos.sessions.byId(t.sessionId)
    const enabled = !!s && memoryOn(ctx.settings.get(), s)
    hub.emit(t.sessionUid, { t: 'reply.status', sessionUid: t.sessionUid, replyId: t.replyId, messageUid: t.asst.uid, state: 'recalling' })
    t.inflight.state = 'recalling'
    let r: ToolRun
    if (name === 'memory_search' && enabled && searches.count >= 1 && freeTier()) {
      r = { text: FREE_TIER_SEARCH_LIMIT, isError: false, kind: 'search', query: typeof input.query === 'string' ? input.query.slice(0, 200) : '', hits: [] }
    } else {
      if (name === 'memory_search' && enabled) searches.count++
      r = await raceAbort(
        runMemoryFunction(name, input, {
          memory: ctx.services.memory,
          enabled,
          sessionUid: t.sessionUid,
          nowUtc: ctx.clock.now(),
          tzName: spec.sender.tzName,
          tzOffsetMin: spec.sender.tzOffsetMin,
          outOfReach: (q) => {
            const h = chatsOutOfReach(ctx, t.sessionUid, q)
            return h ? outOfReachText(h) : null
          }
        }),
        t.abort.signal,
        { text: 'cancelled', isError: true, kind: 'search' as const, query: '', hits: [] }
      )
    }
    hub.emit(t.sessionUid, {
      t: 'reply.tool',
      sessionUid: t.sessionUid,
      replyId: t.replyId,
      kind: r.kind,
      query: r.query.slice(0, 200),
      count: r.hits.length,
      sessions: [...new Set(r.hits.map((h) => h.shortId))]
    })
    return r
  }

  /** `p`, or `fallback` on abort (or after `timeoutMs`, a cap on a service's own budget). */
  function raceAbort<T>(p: Promise<T>, signal: AbortSignal, fallback: T, timeoutMs?: number): Promise<T> {
    if (signal.aborted) return Promise.resolve(fallback)
    return new Promise<T>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      // Whichever comes first releases the listener and the timer (a hung service must not pin them).
      const finish = (v: T): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (timer) clearTimeout(timer)
        linkedListeners--
        resolve(v)
      }
      const onAbort = (): void => finish(fallback)
      signal.addEventListener('abort', onAbort, { once: true })
      linkedListeners++
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(fallback), timeoutMs)
      p.then(finish, () => finish(fallback))
    })
  }

  function continueText(s: SessionRow): string {
    const src = typeof s.meta.continuedFrom === 'string' ? repos.sessions.byUid(s.meta.continuedFrom) : null
    const name = ctx.settings.get().profile.userName || 'the user'
    return `Greet ${name} and pick up where you left off${src ? ` in conversation #${src.shortId}` : ''}.`
  }

  function attachmentBlocks(list: AttachmentRef[]): WireBlock[] {
    const out: WireBlock[] = []
    for (const a of list) {
      if (a.kind === 'image') out.push({ t: 'image', sha: a.sha, mime: a.mime, name: a.name, width: a.width ?? 0, height: a.height ?? 0 })
      else if (a.kind === 'pdf') {
        out.push({ t: 'document', sha: a.sha, mime: 'application/pdf', name: a.name })
        out.push({ t: 'file_text', sha: a.sha, name: a.name })
      } else if (a.kind === 'docx' || a.kind === 'text') out.push({ t: 'file_text', sha: a.sha, name: a.name })
      else out.push({ t: 'text', text: `[file: ${a.name}, ${a.mime}, ${a.size} bytes — no text could be extracted]` })
    }
    return out
  }

  function recapBlock(e: EpochRow): WireBlock {
    return { t: 'memory_result', text: `${RECAP_HEADER}\n${untrusted('recap', newBoundary(), e.recap ?? '')}` }
  }

  async function writeUserRows(st: ChatStore, s: SessionRow, epoch: EpochRow, user: MessageRow, blocks: WireBlock[], speak: boolean): Promise<void> {
    const sc = st.ctx
    const R = st.repos
    const startSeq = epochStartSeq(sc, epoch)
    const fresh = epoch.startMessageId === user.id || (epoch.startMessageId === 0n && user.seq === startSeq)
    const snap: CtxSnapshot = snapshotOf(sc, s, speak)
    const base = fresh ? null : baselineSnapshot(sc, s, startSeq, user.seq)
    const prev = R.messages.previousOnPath(s.id, user.seq)
    let interruptedAfter: string | null = null
    if (prev && prev.role === 'assistant' && prev.interrupted) {
      const spoken = prev.body.slice(0, prev.spokenChars ?? prev.body.length)
      interruptedAfter = spoken.slice(-80).replace(/'/g, '’')
    }
    const notes = await notesFor({ ctx: sc, session: s, snapshot: snap, baseline: base, interruptedAfter, epoch })
    // An epoch's first user turn carries the recap of what came before (07 C4).
    const finalBlocks = epoch.recap && epoch.startMessageId === user.id ? [...blocks, recapBlock(epoch)] : blocks
    // One transaction, retried while db.worker holds the write lock (07 C9).
    await persist(st, () => {
      R.messages.update(user.id, { meta: { ...user.meta, ctx: snap } })
      R.transcript.append({ sessionId: s.id, messageId: user.id, part: 0, role: 'user', blocks: finalBlocks, provider: null, model: null, createdUtc: ctx.clock.now() })
      if (notes.length) R.transcript.append({ sessionId: s.id, messageId: user.id, part: 1, role: 'system', blocks: notes.map((text) => ({ t: 'system_note', text })), provider: null, model: null, createdUtc: ctx.clock.now() })
    })
  }

  /** Pick the epoch for a new user turn, rolling over when needed (07 C4/C7). */
  async function chooseEpoch(t: Turn, s: SessionRow, p: ResolvedProfile, user: MessageRow, blocks: WireBlock[], status: (st: ReplyState) => void): Promise<EpochRow> {
    const R = t.st.repos
    const cur = R.epochs.current(s.id)
    if (!cur) return firstEpoch(t, s, p, user, status)
    const rows = R.transcript.forEpoch(cur)
    const hasRows = rows.some((r) => r.messageId !== user.id)
    if (!hasRows) return cur
    const need = rolloverNeed(t.st, s, p, cur, rows, blocks, user.seq)
    // F24: a stale draft is dropped (it can never describe a later turn's path either).
    if (need.stale) R.epochs.update(cur.id, { recapDraft: null })
    if (need.roll) {
      if (need.usable === null) status('summarizing')
      return rollover(t, s, p, cur, user, need.usable)
    }
    if (need.draftable) scheduleDraft(t.st, s, cur)
    return cur
  }

  /**
   * The first epoch of a session's path (none is effective). Earlier messages without a wire transcript (imported chats,
   * 07 C1/C4) reach the model as a recap, never re-rendered: the epoch then starts at `user` and carries it.
   */
  async function firstEpoch(t: Turn, s: SessionRow, p: ResolvedProfile, user: MessageRow, status: (st: ReplyState) => void): Promise<EpochRow> {
    if (user.seq <= 1) return createEpoch(t.st.ctx, s, p, 0n, null)
    const seed: EpochRow = { ...pseudoEpoch(s), startMessageId: 0n }
    status('summarizing')
    const { ctl, release } = controller()
    const unlink = link(t.abort.signal, ctl)
    try {
      const recap = await recapForEpoch(t.st, s, seed, ctl.signal, user.seq)
      const e = createEpoch(t.st.ctx, s, p, user.id, recap)
      hub.emit(s.uid, { t: 'epoch.created', sessionUid: s.uid, epochId: Number(e.id), startSeq: user.seq })
      return e
    } finally {
      unlink()
      release()
    }
  }

  type Rows = ReturnType<ChatStore['repos']['transcript']['forEpoch']>

  /**
   * Must the next request start a new epoch (07 C4/C7)? A tool-capability switch, a requested refresh, a waiting draft
   * that still describes the path (F24), or a request over the hard window. `draftable`: fill ≥ 0.75 × budget.
   */
  function rolloverNeed(st: ChatStore, s: SessionRow, p: ResolvedProfile, cur: EpochRow, rows: Rows, blocks: WireBlock[], userSeq: number): { roll: boolean; usable: string | null; stale: boolean; draftable: boolean } {
    const window = p.caps.contextWindow
    const budget = window * ctx.settings.get().chat.contextFill
    const hard = Math.max(window * 0.5, window - p.options.maxTokens)
    const est = estimateRequest(cur, rows, att) + estimateBlocks(blocks, att)
    const modeSwitch = cur.toolMode !== desiredToolMode(p)
    // F24: a waiting draft is used only while the path still holds exactly what it summarised (a forced one — delete
    // and refresh, apply protocols — rolls over anyway, with a fresh recap when it no longer holds).
    const draft = decodeDraft(cur.recapDraft)
    const usable = draft && draftHolds(st, s, cur, draft, userSeq) ? draft.text : null
    const forced = draft?.force === true
    return { roll: modeSwitch || forced || usable !== null || est > hard, usable, stale: !!draft && usable === null && !forced, draftable: est >= 0.75 * budget }
  }

  /**
   * The epoch a regenerate answers in (F25/F26): the path up to the user turn `prev`, chosen like a send's. With no
   * effective epoch (imported history) it starts at `prev` with a recap of what came before; a tool-mode switch, a
   * requested refresh, the hard window, or a user turn that never got a wire row (imported) roll over at `prev`.
   * Whenever the epoch starts at `prev`, `prev`'s rows are (re)written into it — its first row carries the recap (07 C4).
   * Returns the user turn and blocks the context-overflow retry may roll over at.
   */
  async function regenEpoch(t: Turn, s: SessionRow, p: ResolvedProfile, prev: MessageRow | null, speak: boolean, status: (st: ReplyState) => void): Promise<{ epoch: EpochRow; user: MessageRow | null; blocks: WireBlock[] }> {
    const R = t.st.repos
    const cur = R.epochs.current(s.id)
    if (!prev || prev.role !== 'user') return { epoch: cur ?? createEpoch(t.st.ctx, s, p, 0n, null), user: null, blocks: [] }
    const stored = R.transcript.forMessage(prev.id)
    const blocks = userBlocksOf(t.st, s, prev, stored)
    let epoch: EpochRow
    if (!cur) epoch = await firstEpoch(t, s, p, prev, status)
    else {
      const rows = R.transcript.forEpoch(cur).filter((r) => r.messageId !== prev.id && r.messageId !== t.asst.id)
      // A draft that covers `prev` itself is no recap *before* it, but may still serve the next send: left alone.
      const need = rolloverNeed(t.st, s, p, cur, rows, blocks, prev.seq)
      if (!need.roll && stored.length) return { epoch: cur, user: prev, blocks }
      if (need.usable === null) status('summarizing')
      epoch = await rollover(t, s, p, cur, prev, need.usable)
    }
    if (epoch.startMessageId === prev.id || !stored.length) {
      R.transcript.deleteForMessage(prev.id)
      await writeUserRows(t.st, R.sessions.byId(t.sessionId) as SessionRow, epoch, prev, blocks, speak)
    }
    return { epoch, user: prev, blocks }
  }

  /**
   * A user turn's blocks for writing it into a new epoch: its stored first row without the old recap, or — for a message
   * that never had one (imported) — its header, text and attachments, rendered now.
   */
  function userBlocksOf(st: ChatStore, s: SessionRow, m: MessageRow, stored: Rows): WireBlock[] {
    const first = stored.find((r) => r.part === 0 && r.role === 'user')
    if (first) return first.blocks.filter((b) => !(b.t === 'memory_result' && b.text.startsWith(RECAP_HEADER)))
    const clock = ctx.settings.get().profile.clock
    const header = turnHeader(m.tsUtc, zoneOf(m.tzName, m.tzOffsetMin), st.repos.messages.previousOnPath(s.id, m.seq)?.tsUtc ?? null, clock)
    return [{ t: 'text', text: m.body ? `${header}\n${m.body}` : header }, ...attachmentBlocks(m.attachments)]
  }

  /**
   * Does a stored draft still describe this path (F24)? The messages it covered are still on the path, none deleted
   * since, and the few after it fit the rollover's "last messages" (an edit, regenerate, variant switch or delete
   * after the draft was written makes it stale).
   */
  function draftHolds(st: ChatStore, s: SessionRow, e: EpochRow, d: Draft, beforeSeq: number): boolean {
    if (d.text === null || !d.hash || d.through >= beforeSeq) return false
    if (coverageOf(st, s, e, d.through + 1).hash !== d.hash) return false
    const after = st.repos.messages.range(s.id, d.through + 1, ROLLOVER_TAIL + 1).filter((m) => m.seq < beforeSeq)
    return after.length <= ROLLOVER_TAIL
  }

  /** Start a new epoch at `user` with a recap of the old one (+ its last messages). */
  async function rollover(t: Turn, s: SessionRow, p: ResolvedProfile, cur: EpochRow, user: MessageRow, draft: string | null): Promise<EpochRow> {
    const R = t.st.repos
    const asked = decodeDraft(cur.recapDraft)
    const { ctl, release } = controller()
    const unlink = link(t.abort.signal, ctl)
    let recap: string
    try {
      recap = draft ?? (await recapForEpoch(t.st, s, cur, ctl.signal, user.seq, asked?.purge === true))
    } finally {
      unlink()
      release()
    }
    const settings = ctx.settings.get()
    const lastLines = transcriptLines(R.messages.tail(s.id, ROLLOVER_TAIL, { beforeSeq: user.seq }), settings.profile.userName, settings.profile.assistantName, settings.profile.clock, 1500)
    const full = lastLines.length ? `${recap}\n\nThe last messages before this point:\n${lastLines.join('\n')}` : recap
    // F24: a refresh asked for while this rollover was condensing (a delete and refresh during "Condensing earlier
    // messages") came after the recap read its messages: it carries over to the new epoch, whose next turn rolls over again.
    const late = R.epochs.current(s.id)
    const lateDraft = late && late.id === cur.id ? decodeDraft(late.recapDraft) : null
    const carry = lateDraft?.force && lateDraft.ask && lateDraft.ask !== asked?.ask ? lateDraft : null
    if (cur.recapDraft !== null || lateDraft) R.epochs.update(cur.id, { recapDraft: null })
    const fresh = R.sessions.byId(s.id) as SessionRow
    let e = createEpoch(t.st.ctx, fresh, p, user.id, full)
    if (carry) {
      e = R.epochs.update(e.id, { recapDraft: encodeDraft({ text: null, through: 0, hash: '', force: true, purge: carry.purge, ask: carry.ask }) })
      log.info('a refresh asked for during the rollover carries over to the next turn')
    }
    hub.emit(s.uid, { t: 'epoch.created', sessionUid: s.uid, epochId: Number(e.id), startSeq: user.seq })
    return e
  }

  /** A stand-in epoch covering a session from its first message (recaps of history that has no transcript). */
  function pseudoEpoch(s: SessionRow): EpochRow {
    return { id: 0n, sessionId: s.id, branchId: 0n, startMessageId: 0n, systemJson: '[]', toolsJson: '[]', protocolsHash: '', toolsVersion: 0, toolMode: 'text', recap: null, recapDraft: null, thinkingStripBefore: null, createdUtc: 0 }
  }

  /**
   * What a recap of an epoch reads (F24): its on-path messages from the start (before `beforeSeq`), minus deleted,
   * hidden, empty and still-streaming ones, plus a fingerprint (the last seq and a hash of the ids) to check later
   * whether the path still holds exactly these messages.
   */
  function coverageOf(st: ChatStore, s: SessionRow, e: EpochRow, beforeSeq?: number): { msgs: MessageRow[]; through: number; hash: string } {
    const start = epochStartSeq(st.ctx, e)
    const msgs: MessageRow[] = []
    for (let seq = start; ; ) {
      const page = st.repos.messages.range(s.id, seq, 500)
      for (const m of page) if ((beforeSeq === undefined || m.seq < beforeSeq) && !m.deleted && !m.hidden && m.status !== 'streaming' && m.body.trim()) msgs.push(m)
      if (page.length < 500 || (beforeSeq !== undefined && page[page.length - 1].seq >= beforeSeq)) break
      seq = page[page.length - 1].seq + 1
    }
    const through = msgs.length ? msgs[msgs.length - 1].seq : 0
    const hash = createHash('sha256')
      .update(msgs.map((m) => String(m.id)).join(','))
      .digest('hex')
      .slice(0, 24)
    return { msgs, through, hash }
  }

  /** Recap of an epoch: previous recap + its messages, map-reduced in ≤ 60k-token chunks (07 C4). */
  async function recapForEpoch(st: ChatStore, s: SessionRow, e: EpochRow, signal: AbortSignal, beforeSeq?: number, purge = false): Promise<string> {
    return (await recapCovering(st, s, e, signal, beforeSeq, purge)).text
  }

  /** The recap and the fingerprint of what it covered (a stored draft is used only while that still holds, F24). */
  async function recapCovering(st: ChatStore, s: SessionRow, e: EpochRow, signal: AbortSignal, beforeSeq?: number, purge = false): Promise<{ text: string; through: number; hash: string }> {
    const { msgs, through, hash } = coverageOf(st, s, e, beforeSeq)
    // F24 (delete and refresh): `e.recap` may summarise a message deleted since — rebuild from an epoch whose own recap
    // predates every deleted message (map-reduced like any recap), so the deleted text leaves the chain for good.
    const seed = purge ? cleanSeed(st, s, e) : null
    if (seed) return { text: await recapOf(s, seed, coverageOf(st, s, seed, beforeSeq).msgs, signal), through, hash }
    return { text: await recapOf(s, e, msgs, signal), through, hash }
  }

  /**
   * Where a recap without the deleted messages starts (F24): the newest on-path epoch that starts at or before the
   * earliest deleted message before `e` (its recap covers only what came before it), or the session's start. Null when
   * no message before `e` is deleted (then `e.recap` is clean).
   */
  function cleanSeed(st: ChatStore, s: SessionRow, e: EpochRow): EpochRow | null {
    const start = epochStartSeq(st.ctx, e)
    let first = 0
    for (let seq = 1; seq < start && !first; ) {
      const page = st.repos.messages.range(s.id, seq, 500)
      for (const m of page) {
        if (m.seq >= start) break
        if (m.deleted) {
          first = m.seq
          break
        }
      }
      if (page.length < 500) break
      seq = page[page.length - 1].seq + 1
    }
    if (!first) return null
    let seed = pseudoEpoch(s)
    let seedSeq = 1
    for (const x of st.repos.epochs.onPath(s.id)) {
      const xs = epochStartSeq(st.ctx, x)
      if (x.id !== e.id && xs <= first && xs >= seedSeq) {
        seed = x
        seedSeq = xs
      }
    }
    return seed
  }

  async function recapOf(s: SessionRow, e: EpochRow, msgs: MessageRow[], signal: AbortSignal): Promise<string> {
    const settings = ctx.settings.get()
    const lines = transcriptLines(msgs, settings.profile.userName, settings.profile.assistantName, settings.profile.clock)
    let recap = e.recap
    try {
      for (const chunk of chunkLines(lines, RECAP_CHUNK_CHARS)) {
        recap = await utilityComplete(ctx, att, { system: PROMPTS.recap.system, user: PROMPTS.recap.user(recap, chunk), maxTokens: 2000 }, signal, s)
      }
      return recap || extractiveRecap(lines, e.recap)
    } catch (err) {
      if (signal.aborted) throw err
      log.warn('recap failed; using the extractive fallback', { error: err })
      return extractiveRecap(lines, e.recap)
    }
  }

  function scheduleDraft(st: ChatStore, s: SessionRow, e: EpochRow): void {
    // Epoch ids of different stores overlap: the key names the session too.
    const key = `${s.uid}:${e.id}`
    if (draftJobs.has(key) || closed) return
    draftJobs.add(key)
    const { ctl, release } = controller()
    own(
      recapCovering(st, s, e, ctl.signal)
        .then((r) => {
          // A temporary chat may have ended meanwhile (its store is closed).
          if (ctl.signal.aborted || (st.temporary && !temps.has(s.uid))) return
          // The epoch may have rolled over meanwhile; a refresh asked for meanwhile stays forced.
          const cur = st.repos.epochs.current(s.id)
          if (!cur || cur.id !== e.id) return
          const asked = decodeDraft(cur.recapDraft)
          // A delete and refresh is waiting: its own recap (without the deleted messages) is the one that counts.
          if (asked?.purge) return
          st.repos.epochs.update(e.id, { recapDraft: encodeDraft({ ...r, force: asked?.force === true, ask: asked?.ask }) })
        })
        .catch((err: unknown) => log.warn('draft recap failed', { error: err }))
        .finally(() => {
          release()
          draftJobs.delete(key)
        })
    )
  }

  /** Titles after the first exchange, summary refresh at idle (07 C13/C18). */
  function afterReply(s: SessionRow): void {
    const settings = ctx.settings.get()
    if (closed) return
    if (settings.chat.autoTitle && s.titleAuto && !s.title.trim()) {
      const { ctl, release } = controller()
      own(
        (async () => {
          const msgs = repos.messages.range(s.id, 1, 6)
          const lines = transcriptLines(msgs, settings.profile.userName, settings.profile.assistantName, settings.profile.clock, 1500)
          if (!lines.length) return
          const title = cleanTitle(await utilityComplete(ctx, att, { system: PROMPTS.title.system, user: PROMPTS.title.user(lines), maxTokens: 1024 }, ctl.signal, s))
          const fresh = repos.sessions.byId(s.id)
          if (!title || !fresh || fresh.title.trim() || !fresh.titleAuto || ctl.signal.aborted) return
          const next = repos.sessions.update(s.id, { title })
          hub.emit(s.uid, { t: 'session.updated', sessionUid: s.uid, session: summaryOf(mainStore(ctx), next) })
          hub.broadcast({ t: 'sessions.changed' })
        })()
          .catch((e: unknown) => log.debug('auto-title failed', { error: e }))
          .finally(release)
      )
    }
    const since = s.messageCount - (typeof s.meta.summaryAt === 'number' ? s.meta.summaryAt : 0)
    if (!s.private && since >= SUMMARY_EVERY) scheduleSummary(s.uid)
  }

  function scheduleSummary(uid: string): void {
    const prev = summaryTimers.get(uid)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      summaryTimers.delete(uid)
      if (closed) return
      if (active.has(uid) || starting.has(uid)) return scheduleSummary(uid)
      const { ctl, release } = controller()
      own(
        summarize(uid, ctl.signal)
          .catch((e: unknown) => log.debug('summary failed', { error: e }))
          .finally(release)
      )
    }, summaryIdleMs)
    timer.unref()
    summaryTimers.set(uid, timer)
  }

  async function summarize(uid: string, signal: AbortSignal): Promise<void> {
    const s = repos.sessions.byUid(uid)
    if (!s || s.private || s.deletedUtc !== null) return
    const settings = ctx.settings.get()
    const lines = transcriptLines(repos.messages.tail(s.id, 40), settings.profile.userName, settings.profile.assistantName, settings.profile.clock, 1500)
    if (!lines.length) return
    const text = (await utilityComplete(ctx, att, { system: PROMPTS.summary.system, user: PROMPTS.summary.user(lines), maxTokens: 1024 }, signal, s)).split('\n')[0].trim().slice(0, 300)
    if (!text || signal.aborted) return
    const fresh = repos.sessions.byId(s.id) as SessionRow
    const next = repos.sessions.update(s.id, { summary: text, summaryUtc: ctx.clock.now(), meta: { ...fresh.meta, summaryAt: fresh.messageCount } })
    hub.emit(uid, { t: 'session.updated', sessionUid: uid, session: summaryOf(mainStore(ctx), next) })
  }

  // ── ChatService ────────────────────────────────────────────────────────────────────────────
  const engine: ChatEngine = {
    stop(sessionUid) {
      const t = active.get(sessionUid)
      if (!t || t.abort.signal.aborted) return
      t.reason = 'stopped'
      t.abort.abort()
    },

    busy: (sessionUid) => active.has(sessionUid) || starting.has(sessionUid),

    unsavedReplies(sessionUid) {
      const out = new Map<string, Message>()
      for (const ps of pendingSaves.values()) if (ps.sessionUid === sessionUid) out.set(ps.asstUid, ps.shown)
      return out
    },

    async startContinuation(sessionUid, sourceUid, client, opts = {}) {
      const { s: s0 } = liveSession(sessionUid)
      liveSession(sourceUid)
      // P22: spoken like any reply when the requesting device speaks replies. The requesting tab is the sender the speech
      // goes to — chosen now, before that tab moves on to the new chat.
      const speaker = client ?? (opts.speak && opts.deviceId ? continuationSpeaker(opts.deviceId, sourceUid, opts.speakClientId) : null)
      await acquire(s0.uid, false)
      try {
        const { s, st } = liveSession(s0.uid)
        const p = await profileFor(s)
        const now = ctx.clock.now()
        // The opener is written in the zone of the source conversation's latest message unless a client asked.
        const last = repos.messages.tail((repos.sessions.byUid(sourceUid) as SessionRow).id, 1)[0]
        const zoned = senderOf(client, client ? undefined : last ? { ts: now, tzOffset: last.tzOffsetMin, tzName: last.tzName } : undefined, now)
        // The speech goes to the speaker's tab; the zone stays the source conversation's.
        const sender = speaker && !client ? { ...zoned, clientId: speaker.id, device: speaker.device.name } : zoned
        const speak = opts.speak === true && !!speaker && !!hub.client(speaker.id)
        const { user, asst } = await persist(st, () => ({
          user: st.repos.messages.append({ sessionId: s.id, role: 'user', body: '', tsUtc: now, tzOffsetMin: sender.tzOffsetMin, tzName: sender.tzName, device: null, hidden: true, meta: { continueOpener: sourceUid } }),
          asst: placeholderRow(st, s, sender, p, now)
        }))
        created(s, user)
        created(s, asst)
        startTurn(st, s, asst, { kind: 'continue', profile: p, sender, speak, talk: false, receivedAt: now, user, text: '', attachments: [], sourceUid })
      } catch (e) {
        starting.delete(s0.uid)
        throw e
      }
    },

    async recap(sessionUid) {
      const s = repos.sessions.byUid(sessionUid)
      if (!s) throw new VesperError('not_found')
      const last = repos.messages.tail(s.id, 1)[0]
      const cacheKey = `chat.recap:${s.id}`
      const cached = repos.kv.get<{ lastId: string; text: string }>(cacheKey)
      if (cached && last && cached.lastId === String(last.id)) return cached.text
      const settings = ctx.settings.get()
      const e = repos.epochs.current(s.id)
      let lines = transcriptLines(repos.messages.tail(s.id, 40), settings.profile.userName, settings.profile.assistantName, settings.profile.clock, 3000)
      while (lines.join('\n').length > CONTINUE_RECAP_CHARS && lines.length > 1) lines = lines.slice(1)
      const { ctl, release } = controller()
      let text: string
      try {
        text = await utilityComplete(ctx, att, { system: PROMPTS.recap.system, user: PROMPTS.recap.user(e?.recap ?? null, lines.join('\n')), maxTokens: 2000 }, ctl.signal, s)
      } catch (err) {
        if (ctl.signal.aborted) throw err
        log.warn('continue recap failed; using the extractive fallback', { error: err })
        text = extractiveRecap(lines, e?.recap ?? null)
      } finally {
        release()
      }
      if (!text) text = extractiveRecap(lines, e?.recap ?? null)
      if (last) repos.kv.set(cacheKey, { lastId: String(last.id), text })
      return text
    },

    async newEpoch(sessionUid, reason) {
      const { s, st } = liveSession(sessionUid)
      const e = st.repos.epochs.current(s.id)
      if (!e) return 0
      // F24: marked first, synchronously, so the next turn starts a new epoch whatever happens below — also when a reply
      // is streaming right now (the refresh used to be dropped then) — and the recap is always computed afresh (a
      // waiting draft may still hold the deleted message).
      // A delete and refresh also purges the deleted text from recaps earlier epochs already wrote (`purge`, kept when
      // another request such as apply protocols comes on top); `ask` lets a rollover already condensing carry it over.
      const purge = reason === 'refresh-context' || decodeDraft(e.recapDraft)?.purge === true
      const ask = randomBytes(6).toString('base64url')
      st.repos.epochs.update(e.id, { recapDraft: encodeDraft({ text: null, through: 0, hash: '', force: true, purge, ask }) })
      const { ctl, release } = controller()
      try {
        const r = await recapCovering(st, s, e, ctl.signal, undefined, purge)
        const cur = !st.temporary || temps.has(s.uid) ? st.repos.epochs.current(s.id) : null
        // Only the latest request writes its recap (an earlier one may predate a later delete).
        const d = cur && cur.id === e.id ? decodeDraft(cur.recapDraft) : null
        if (d?.force && d.ask === ask) st.repos.epochs.update(e.id, { recapDraft: encodeDraft({ ...r, force: true, purge, ask }) })
      } finally {
        release()
      }
      log.info('new epoch requested', { reason })
      // The new epoch starts at the next user turn (its first row carries the recap); `epoch.created` follows then.
      return Number(e.id)
    },

    async close() {
      closed = true
      for (const t of active.values()) {
        t.reason ??= 'shutdown'
        t.abort.abort()
      }
      for (const c of controllers) c.abort()
      for (const timer of summaryTimers.values()) clearTimeout(timer)
      summaryTimers.clear()
      noVisionNoticed.clear()
      sinkWatchers.clear()
      // Turns are owned by `background` too; loop because finishing work may schedule more (it sees `closed`).
      while (background.size) await Promise.allSettled([...background])
      // A reply that could not be saved gets one last try; what still fails stays as the last checkpoint (07 C6/C19).
      if (pendingSaves.size) flushPendingSaves()
      if (saveTimer) clearInterval(saveTimer)
      saveTimer = null
      if (pendingSaves.size) log.warn('replies could not be saved before closing', { count: pendingSaves.size })
      pendingSaves.clear()
      recentSends.clear()
      // Temporary chats end with the server (restart = gone, 07 B9) once nothing writes to them any more.
      await temps.close()
      att.clear()
    },

    stats() {
      return {
        active: active.size,
        starting: starting.size,
        background: background.size,
        controllers: controllers.size,
        timers: summaryTimers.size,
        linkedListeners,
        sinkWatchers: sinkWatchers.size,
        attachmentCacheBytes: att.cachedBytes,
        temporaryChats: temps.stats().chats,
        pendingSaves: pendingSaves.size
      }
    }
  }
  return engine
}
