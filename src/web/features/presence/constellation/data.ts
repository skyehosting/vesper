/**
 * Constellation data: GET /api/memory/manifest (sessions with their links), refreshed when the session list changes;
 * links created by drag (PUT /api/sessions/:uid/links/:shortId, with Undo via DELETE); recall pulses from `reply.tool`
 * (07 A4). Owner: the Constellation page (start() → stop()).
 */
import { toast } from '../../../components/Toast'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { ws } from '../../../lib/ws'
import { getState, pulse, PULSE_MS, setData, setError, setLoading, setReplying } from './model'
import { currentScheduler } from '../host/schedulerRef'

const REFRESH_DEBOUNCE_MS = 600

export interface ConstellationData {
  reload(): void
  stop(): void
}

export function startConstellationData(): ConstellationData {
  let ctrl: AbortController | null = null
  let timer: number | null = null
  let stopped = false
  let subscribedTo: string | null = null
  let unsubscribe: (() => void) | null = null

  const load = (): void => {
    ctrl?.abort()
    const c = new AbortController()
    ctrl = c
    setLoading()
    api('GET /api/memory/manifest', { signal: c.signal })
      .then((m) => {
        if (c.signal.aborted || stopped) return
        // Archived chats stay out of the sky (they are out of the sidebar too); an empty new chat is not a star yet.
        setData(
          m.sessions.filter((s) => !s.archived && !s.deletedUtc && !s.temporary && s.messageCount > 0),
          Date.now()
        )
        followLatest()
      })
      .catch((e: unknown) => {
        if (c.signal.aborted || stopped) return
        setError(toApiError(e))
      })
  }

  const soon = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      load()
    }, REFRESH_DEBOUNCE_MS)
  }

  /** Follow the most recently active session so its reply.tool events (recalls) reach this page. */
  const followLatest = (): void => {
    let best: string | null = null
    let at = -1
    for (const n of getState().nodes) {
      const t = n.s.lastMessageUtc ?? n.s.updatedUtc
      if (t > at) {
        at = t
        best = n.s.uid
      }
    }
    if (best === subscribedTo) return
    unsubscribe?.()
    unsubscribe = best ? ws.subscribe(best) : null
    subscribedTo = best
  }

  const offs = [
    ws.on('sessions.changed', soon),
    ws.on('session.updated', soon),
    ws.on('session.deleted', soon),
    ws.on('reply.tool', (m) => recalled(m.sessionUid, m.sessions)),
    ws.on('reply.done', (m) => {
      if (getState().byUid.get(m.sessionUid) === getState().replying) setReplying(-1)
    }),
    ws.on('reply.error', (m) => {
      if (getState().byUid.get(m.sessionUid) === getState().replying) setReplying(-1)
    })
  ]

  load()

  return {
    reload: load,
    stop() {
      stopped = true
      ctrl?.abort()
      if (timer !== null) window.clearTimeout(timer)
      for (const off of offs) off()
      unsubscribe?.()
    }
  }
}

/** A reply recalled from these sessions (`reply.tool`): their stars pulse, the replying session glows (07 A4). */
export function recalled(sessionUid: string, shortIds: readonly string[]): void {
  const st = getState()
  const idx = shortIds.map((s) => st.byShort.get(s)).filter((i): i is number => i !== undefined)
  const self = st.byUid.get(sessionUid)
  if (self !== undefined) setReplying(self)
  pulse(idx, performance.now())
  currentScheduler()?.pulse(PULSE_MS)
}

/** "A may recall B" (07 C18 links are directional; `bothWays` adds the reverse). Toast with Undo. */
export async function linkSessions(from: number, to: number, bothWays = false): Promise<boolean> {
  const st = getState()
  const a = st.nodes[from]?.s
  const b = st.nodes[to]?.s
  if (!a || !b || a.uid === b.uid) return false
  if (a.links.includes(b.shortId) && (!bothWays || b.links.includes(a.shortId))) {
    toast.info(`“${titleOf(a.title)}” can already recall “${titleOf(b.title)}”.`)
    return false
  }
  try {
    await api('PUT /api/sessions/:uid/links/:shortId', { params: { uid: a.uid, shortId: b.shortId }, body: { bothWays } })
    toast.success(`“${titleOf(a.title)}” can now recall “${titleOf(b.title)}”${bothWays ? ', and the other way round' : ''}.`, {
      title: 'Linked',
      action: {
        label: 'Undo',
        onClick: () => {
          void api('DELETE /api/sessions/:uid/links/:shortId', { params: { uid: a.uid, shortId: b.shortId } }).catch((e: unknown) =>
            toast.error(toApiError(e).message)
          )
          if (bothWays) void api('DELETE /api/sessions/:uid/links/:shortId', { params: { uid: b.uid, shortId: a.shortId } }).catch(() => undefined)
        }
      }
    })
    return true
  } catch (e) {
    toast.error(toApiError(e).message, { title: 'Couldn’t link' })
    return false
  }
}

export function titleOf(t: string): string {
  const s = t.trim() || 'New chat'
  return s.length > 48 ? `${s.slice(0, 47)}…` : s
}
