/**
 * Per-session chat views (the windowed timeline of R5 / 07 D1). Only sessions with an open view keep one.
 *
 * Streaming text arrives as many small `reply.delta` events; they are coalesced and applied at most once per
 * animation frame (07 D7: ≤ 1 commit per frame). Any other event for the same session first flushes the buffered
 * deltas, so ordering is preserved (a `reply.done` never overtakes its last delta).
 */
import type { ApiError } from '@shared/errors'
import type { MessagePage } from '@shared/types/domain'
import type { ServerMsg } from '@shared/ws'
import { appendPage, applyChatEvent, applyPage, emptyChat, prependPage, startReload, trimWindow, type ChatView } from './chat.logic'
import type { AppState, SliceCreator } from './types'

export interface ChatSlice {
  chats: Record<string, ChatView>
  chatOpen(uid: string): void
  /** A replacing fetch starts (open, resync, path change, jump); the current rows stay on screen meanwhile. */
  chatReload(uid: string): void
  /** Replace the window with a page. */
  chatLoaded(uid: string, page: MessagePage): void
  chatPrepended(uid: string, page: MessagePage): void
  chatAppended(uid: string, page: MessagePage): void
  chatTrim(uid: string, side: 'top' | 'bottom', count: number): void
  chatFailed(uid: string, error: ApiError): void
  /** Apply a session event; ignored unless that session has an open view. */
  chatEvent(sessionUid: string, msg: ServerMsg): void
  chatClearNotice(uid: string): void
  /** Forget a view (bounded memory: only open sessions keep one). */
  dropChat(uid: string): void
}

type SetFn = (fn: (s: AppState) => Partial<AppState>) => void

// ── delta coalescing (one commit per frame) ────────────────────────────────────────────────────
const buffered = new Map<string, ServerMsg[]>()
let frame: { cancel: () => void } | null = null

function schedule(run: () => void): { cancel: () => void } {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(run)
    return { cancel: () => cancelAnimationFrame(h) }
  }
  const h = setTimeout(run, 16)
  return { cancel: () => clearTimeout(h) }
}

function applyAll(view: ChatView, events: readonly ServerMsg[]): ChatView {
  let v = view
  for (const e of events) v = applyChatEvent(v, e)
  return v
}

function flushSession(set: SetFn, uid: string): void {
  const list = buffered.get(uid)
  if (!list) return
  buffered.delete(uid)
  set((s) => {
    const cur = s.chats[uid]
    if (!cur) return {}
    const next = applyAll(cur, list)
    return next === cur ? {} : { chats: { ...s.chats, [uid]: next } }
  })
}

function flushAll(set: SetFn): void {
  frame = null
  for (const uid of [...buffered.keys()]) flushSession(set, uid)
}

/** Buffered delta count (test hooks, leak checks). */
export function chatBufferStats(): { sessions: number; framePending: boolean } {
  return { sessions: buffered.size, framePending: frame !== null }
}

export const createChatSlice: SliceCreator<ChatSlice> = (set) => {
  const patch = (uid: string, fn: (v: ChatView) => ChatView, create = false): void =>
    set((s) => {
      const cur = s.chats[uid] ?? (create ? emptyChat() : undefined)
      if (!cur) return {}
      const next = fn(cur)
      return next === cur && s.chats[uid] ? {} : { chats: { ...s.chats, [uid]: next } }
    })
  return {
    chats: {},
    chatOpen: (uid) => set((s) => (s.chats[uid] ? {} : { chats: { ...s.chats, [uid]: emptyChat() } })),
    chatReload: (uid) => {
      flushSession(set, uid)
      patch(uid, startReload)
    },
    chatLoaded: (uid, page) => {
      flushSession(set, uid)
      patch(uid, (v) => applyPage(v, page), true)
    },
    chatPrepended: (uid, page) => patch(uid, (v) => prependPage(v, page)),
    chatAppended: (uid, page) => {
      flushSession(set, uid)
      patch(uid, (v) => appendPage(v, page))
    },
    chatTrim: (uid, side, count) => patch(uid, (v) => trimWindow(v, side, count)),
    chatFailed: (uid, error) => patch(uid, (v) => ({ ...v, status: 'error', error }), true),
    chatEvent: (sessionUid, msg) => {
      if (msg.t === 'reply.delta' || msg.t === 'reply.reasoning') {
        const list = buffered.get(sessionUid)
        if (list) list.push(msg)
        else buffered.set(sessionUid, [msg])
        frame ??= schedule(() => flushAll(set))
        return
      }
      flushSession(set, sessionUid)
      patch(sessionUid, (v) => applyChatEvent(v, msg))
    },
    chatClearNotice: (uid) => patch(uid, (v) => (v.notice ? { ...v, notice: null } : v)),
    dropChat: (uid) => {
      buffered.delete(uid)
      if (buffered.size === 0 && frame) {
        frame.cancel()
        frame = null
      }
      set((s) => {
        if (!s.chats[uid]) return {}
        const chats = { ...s.chats }
        delete chats[uid]
        return { chats }
      })
    }
  }
}
