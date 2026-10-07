/**
 * Session list loading and every session action (create, rename, pin, archive, delete with undo, restore, trash,
 * links, continue), shared by the sidebar, the top bar, the session panel, the palette and the slash commands.
 * Every action keeps the store in step (list rows + the active session's detail) so the UI never waits for the
 * `session.updated` echo; the echo then confirms the same values.
 */
import type { CreateSessionBody, PatchSessionBody } from '@shared/api'
import { formatShortId } from '@shared/ids'
import type { Session, SessionSummary } from '@shared/types/domain'
import { toast } from '../../components/Toast'
import { copyText } from '../../components/internal/clipboard'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { getLocation, navigate } from '../../lib/router'
import { ws } from '../../lib/ws'
import { useStore } from '../../lib/store'
import { summaryOf } from '../../lib/store/session'
import { speakRepliesNow } from './speakReplies'

const PAGE = 100
let listAbort: AbortController | null = null
let latest: Promise<void> = Promise.resolve()

/**
 * (Re)load the first page of the list for `q` ('' = all). A newer call aborts an older one, and the older promise then
 * resolves when the newer load finishes — so `await loadSessions()` always means "the list is current".
 * Pinned chats are fetched alongside the first page so the Pinned group is complete however old they are.
 */
export function loadSessions(q = useStore.getState().sessions.query): Promise<void> {
  listAbort?.abort()
  const ctrl = new AbortController()
  listAbort = ctrl
  useStore.getState().setSessionsLoading(true)
  const run = async (): Promise<void> => {
    try {
      // A refresh of the same list keeps what was already paged in (up to the server's 200), so a live update doesn't
      // shrink the list under the reader.
      const cur = useStore.getState().sessions
      const limit = cur.query === q ? Math.min(200, Math.max(PAGE, cur.items.length)) : PAGE
      const [res, pinned] = await Promise.all([
        api('GET /api/sessions', { query: { q: q || undefined, limit }, signal: ctrl.signal }),
        q ? Promise.resolve(null) : api('GET /api/sessions', { query: { filter: 'pinned', limit: 200 }, signal: ctrl.signal })
      ])
      if (!ctrl.signal.aborted) {
        const seen = new Set(res.items.map((s) => s.uid))
        const extra = (pinned?.items ?? []).filter((s) => !seen.has(s.uid))
        useStore.getState().setSessionList([...res.items, ...extra], res.next, q)
      }
    } catch (e) {
      if (!ctrl.signal.aborted) useStore.getState().setSessionsLoading(false, toApiError(e))
    } finally {
      if (listAbort === ctrl) listAbort = null
    }
    if (ctrl.signal.aborted) await latest
  }
  const p = run()
  latest = p
  return p
}

let moreInflight = false

export async function loadMoreSessions(): Promise<void> {
  const { sessions } = useStore.getState()
  if (!sessions.next || sessions.loading || moreInflight) return
  moreInflight = true
  useStore.getState().setSessionsLoading(true)
  try {
    const res = await api('GET /api/sessions', { query: { q: sessions.query || undefined, cursor: sessions.next, limit: PAGE } })
    useStore.getState().appendSessions(res.items, res.next)
  } catch (e) {
    useStore.getState().setSessionsLoading(false, toApiError(e))
  } finally {
    moreInflight = false
  }
}

/** Create a session and put it at the top of the list. */
export async function createSession(body: CreateSessionBody = {}): Promise<Session> {
  const session = await api('POST /api/sessions', { body })
  useStore.getState().upsertSession(session)
  return session
}

/** New chat → open it. Errors become a toast. */
export async function startNewChat(body: CreateSessionBody = {}): Promise<Session | null> {
  try {
    const s = await createSession(body)
    navigate(`/s/${s.uid}`)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

/** Temporary chat (07 B9): kept in memory only, never saved, embedded or recalled. */
export async function startTemporaryChat(): Promise<Session | null> {
  try {
    const s = await createSession({ temporary: true })
    navigate(`/s/${s.uid}`)
    return s
  } catch (e) {
    const err = toApiError(e)
    toast.error(err.code === 'not_implemented' ? "Temporary chats aren't available yet." : err.message)
    return null
  }
}

/** Store the result of a PATCH/restore/link call everywhere it shows. */
export function applySession(s: Session): void {
  const st = useStore.getState()
  st.upsertSession(summaryOf(s))
  if (st.activeSessionUid === s.uid) st.setActiveSessionDetail(s)
}

/**
 * PATCH a session. The open chat's detail is updated optimistically (PatchSessionBody keys are Session fields), so a
 * switch or radio in the panel moves at once; a failure puts the previous values back.
 */
export async function patchSession(uid: string, body: PatchSessionBody): Promise<Session> {
  const st = useStore.getState()
  const prev = st.activeSession?.uid === uid ? st.activeSession : null
  if (prev) {
    const next: Session = { ...prev, ...body } as Session
    if (body.systemPrompt !== undefined) next.hasPrompt = body.systemPrompt.trim() !== ''
    st.setActiveSessionDetail(next)
  }
  try {
    const s = await api('PATCH /api/sessions/:uid', { params: { uid }, body })
    applySession(s)
    return s
  } catch (e) {
    if (prev && useStore.getState().activeSession?.uid === uid) useStore.getState().setActiveSessionDetail(prev)
    throw e
  }
}

/** PATCH with a toast on failure; returns null when it failed. */
export async function trySession(uid: string, body: PatchSessionBody, okText?: string): Promise<Session | null> {
  try {
    const s = await patchSession(uid, body)
    if (okText) toast.success(okText)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

export function renameSession(uid: string, title: string): Promise<Session | null> {
  return trySession(uid, { title: title.trim().slice(0, 200) })
}

export function setPinned(uid: string, pinned: boolean): Promise<Session | null> {
  return trySession(uid, { pinned })
}

/** The chat to show after `uid` leaves the list: the next one down, else the one above, else none. */
export function neighbourOf(uid: string, order: readonly SessionSummary[]): string | null {
  const i = order.findIndex((s) => s.uid === uid)
  if (i < 0) return null
  return order[i + 1]?.uid ?? order[i - 1]?.uid ?? null
}

/** Leaving the open chat: go to its neighbour first so the `session.deleted` echo finds us elsewhere. */
function leaveIfOpen(uid: string, order: readonly SessionSummary[]): boolean {
  if (getLocation().pathname !== `/s/${uid}`) return false
  const next = neighbourOf(uid, order)
  navigate(next ? `/s/${next}` : '/', { replace: true })
  return true
}

export async function archiveSession(uid: string, order: readonly SessionSummary[] = []): Promise<void> {
  const st = useStore.getState()
  const row = st.sessions.items.find((s) => s.uid === uid)
  const wasOpen = leaveIfOpen(uid, order)
  st.removeSession(uid)
  try {
    await patchSession(uid, { archived: true })
    toast.success(`Archived “${row?.title || 'New chat'}”`, {
      action: {
        label: 'Undo',
        onClick: () => {
          void unarchiveSession(uid).then((s) => {
            if (s && wasOpen) navigate(`/s/${uid}`)
          })
        }
      }
    })
  } catch (e) {
    if (row) useStore.getState().upsertSession(row)
    toast.error(toApiError(e).message)
  }
}

export function unarchiveSession(uid: string): Promise<Session | null> {
  return trySession(uid, { archived: false })
}

/** Soft delete (kept in Trash for 30 days) with an Undo toast. */
export async function deleteSession(uid: string, order: readonly SessionSummary[] = []): Promise<void> {
  const st = useStore.getState()
  const row = st.sessions.items.find((s) => s.uid === uid) ?? (st.activeSession?.uid === uid ? summaryOf(st.activeSession) : undefined)
  const temporary = row?.temporary ?? false
  const wasOpen = leaveIfOpen(uid, order)
  st.removeSession(uid)
  try {
    await api('DELETE /api/sessions/:uid', { params: { uid } })
    if (temporary) {
      toast.info('Temporary chat ended. Nothing was saved.')
      return
    }
    toast.info(`Moved “${row?.title || 'New chat'}” to Trash`, {
      durationMs: 7000,
      action: {
        label: 'Undo',
        onClick: () => {
          void restoreSession(uid).then((s) => {
            if (s && wasOpen) navigate(`/s/${uid}`)
          })
        }
      }
    })
  } catch (e) {
    if (row) useStore.getState().upsertSession(row)
    toast.error(toApiError(e).message)
  }
}

export async function restoreSession(uid: string): Promise<Session | null> {
  try {
    const s = await api('POST /api/sessions/:uid/restore', { params: { uid } })
    applySession(s)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

export async function emptyTrash(): Promise<number | null> {
  try {
    const r = await api('POST /api/trash/empty')
    toast.success(r.purged === 1 ? 'Deleted 1 chat for good.' : `Deleted ${r.purged} chats for good.`)
    return r.purged
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

/** `/continue #ID` and "Continue in a new chat" (07 C18): the new chat opens with a recap of the source. */
export async function continueSession(sourceUid: string): Promise<Session | null> {
  try {
    // P22: the opener is spoken like any reply when this device speaks replies (the voice client is loaded lazily).
    // The tab names itself, so it speaks the opener wherever /continue was typed (another chat, the sidebar).
    const speak = speakRepliesNow()
    const self = speak ? ws.clientId : null
    const s = await createSession({ continueFrom: sourceUid, ...(speak ? { speak: true, ...(self ? { speakClientId: self } : {}) } : {}) })
    if (speak) void import('../voice/speechClient').then((v) => v.expectSpeechIn(s.uid))
    navigate(`/s/${s.uid}`)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

export async function linkSession(uid: string, shortId: string, bothWays = false): Promise<Session | null> {
  try {
    const s = await api('PUT /api/sessions/:uid/links/:shortId', { params: { uid, shortId }, body: { bothWays } })
    applySession(s)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

export async function unlinkSession(uid: string, shortId: string): Promise<Session | null> {
  try {
    const s = await api('DELETE /api/sessions/:uid/links/:shortId', { params: { uid, shortId } })
    applySession(s)
    return s
  } catch (e) {
    toast.error(toApiError(e).message)
    return null
  }
}

/** Find a session by what the user typed: "#K7Q2MX", "k7q2mx", or a uid. Looks in the list, then asks the server. */
export async function resolveSessionRef(ref: string, normalize: (s: string) => string | null): Promise<SessionSummary | null> {
  const raw = ref.trim()
  if (!raw) return null
  const items = useStore.getState().sessions.items
  const short = normalize(raw)
  const local = items.find((s) => (short && s.shortId === short) || s.uid === raw)
  if (local) return local
  try {
    if (short) {
      const res = await api('GET /api/sessions', { query: { q: short, limit: 5 } })
      return res.items.find((s) => s.shortId === short) ?? null
    }
    return summaryOf(await api('GET /api/sessions/:uid', { params: { uid: raw } }))
  } catch {
    return null
  }
}

/** Copy "#K7Q2MX" with a confirmation. */
export async function copySessionId(shortId: string): Promise<void> {
  const text = formatShortId(shortId)
  if (await copyText(text)) toast.success(`Copied ${text}`)
  else toast.info(`Chat ID ${text}`)
}

const LAST_KEY = 'vesper.lastSession'

/** The last session opened on this device (per origin). */
export function lastSessionUid(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

export function rememberSession(uid: string): void {
  try {
    localStorage.setItem(LAST_KEY, uid)
  } catch {
    // storage unavailable
  }
}
