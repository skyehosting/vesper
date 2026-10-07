/**
 * Sessions list (sidebar) and the active session (sessions-ui). Loading actions live in features/sessions/data.ts.
 *
 * `activeSession` is the full `Session` of the open chat (top bar, session panel, commands); it is refreshed from PATCH
 * responses and refetched when `session.updated` says it changed. List rows are `SessionSummary`s.
 */
import type { ApiError } from '@shared/errors'
import type { Session, SessionSummary } from '@shared/types/domain'
import { applySummary } from './session.logic'
import type { SliceCreator } from './types'

export interface SessionListState {
  items: SessionSummary[]
  /** Cursor for the next page, null at the end. */
  next: string | null
  /** The search the list was loaded for ('' = all). */
  query: string
  loaded: boolean
  loading: boolean
  error: ApiError | null
}

export interface SessionSlice {
  sessions: SessionListState
  activeSessionUid: string | null
  /** Full detail of the active session (null while loading or when none is open). */
  activeSession: Session | null
  /** Why the active session's detail could not load (not found, network…). */
  activeSessionError: ApiError | null
  setActiveSession(uid: string | null): void
  setActiveSessionError(e: ApiError | null): void
  setActiveSessionDetail(s: Session | null): void
  setSessionsLoading(loading: boolean, error?: ApiError | null): void
  setSessionList(items: SessionSummary[], next: string | null, query: string): void
  appendSessions(items: SessionSummary[], next: string | null): void
  upsertSession(s: SessionSummary): void
  removeSession(uid: string): void
}

export { summaryOf } from './session.logic'

export const createSessionSlice: SliceCreator<SessionSlice> = (set) => ({
  sessions: { items: [], next: null, query: '', loaded: false, loading: false, error: null },
  activeSessionUid: null,
  activeSession: null,
  activeSessionError: null,
  setActiveSession: (uid) =>
    set((s) =>
      s.activeSessionUid === uid ? {} : { activeSessionUid: uid, activeSession: s.activeSession?.uid === uid ? s.activeSession : null, activeSessionError: null }
    ),
  setActiveSessionError: (activeSessionError) => set({ activeSessionError }),
  setActiveSessionDetail: (detail) =>
    set((s) => {
      if (detail && detail.uid !== s.activeSessionUid) return {}
      return { activeSession: detail, activeSessionError: null }
    }),
  setSessionsLoading: (loading, error = null) => set((s) => ({ sessions: { ...s.sessions, loading, error } })),
  setSessionList: (items, next, query) =>
    set((s) => ({ sessions: { ...s.sessions, items, next, query, loaded: true, loading: false, error: null } })),
  appendSessions: (items, next) =>
    set((s) => {
      const seen = new Set(s.sessions.items.map((x) => x.uid))
      return {
        sessions: { ...s.sessions, items: [...s.sessions.items, ...items.filter((x) => !seen.has(x.uid))], next, loading: false }
      }
    }),
  upsertSession: (session) =>
    set((s) => {
      const r = applySummary(s.sessions.items, s.activeSession, session)
      if (r.items === s.sessions.items && r.active === s.activeSession) return {}
      return { sessions: { ...s.sessions, items: [...r.items] }, activeSession: r.active }
    }),
  removeSession: (uid) =>
    set((s) => ({
      sessions: { ...s.sessions, items: s.sessions.items.filter((x) => x.uid !== uid) },
      activeSessionUid: s.activeSessionUid === uid ? null : s.activeSessionUid,
      activeSession: s.activeSession?.uid === uid ? null : s.activeSession
    }))
})
