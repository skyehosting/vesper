/**
 * A session's live feed for views outside the chat page (Talk mode's ReplyView/Transcript, 07 E4): subscribe, apply
 * events, load the latest page — reference-counted, so several components share one subscription, and released when
 * the last one unmounts. When the chat page already holds the view, nothing extra is opened.
 */
import { useEffect } from 'react'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { ws } from '../../lib/ws'

const EVENTS = ['subscribed', 'message.created', 'message.updated', 'message.deleted', 'reply.status', 'reply.delta', 'reply.reasoning', 'reply.tool', 'reply.snapshot', 'reply.done', 'reply.error'] as const
const FEED_PAGE = 30

const feeds = new Map<string, { count: number; close: () => void }>()

function open(uid: string): () => void {
  const st = useStore.getState
  st().chatOpen(uid)
  let ctrl: AbortController | null = null
  const load = (): void => {
    ctrl?.abort()
    const c = new AbortController()
    ctrl = c
    st().chatReload(uid)
    api('GET /api/sessions/:uid/messages', { params: { uid }, query: { mode: 'latest', limit: FEED_PAGE }, signal: c.signal })
      .then((p) => {
        if (!c.signal.aborted) st().chatLoaded(uid, p)
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted) st().chatFailed(uid, toApiError(e))
      })
  }
  const unsubscribe = ws.subscribe(uid)
  const offs = EVENTS.map((t) =>
    ws.on(t, (m) => {
      if (m.sessionUid === uid) st().chatEvent(uid, m)
    })
  )
  offs.push(
    ws.onResync((s) => {
      if (s === uid) load()
    }),
    ws.on('session.path_changed', (m) => {
      if (m.sessionUid === uid) load()
    })
  )
  load()
  return () => {
    ctrl?.abort()
    for (const off of offs) off()
    unsubscribe()
    st().dropChat(uid)
  }
}

/** Keep `sessionUid`'s view live while the calling component is mounted. */
export function useChatFeed(sessionUid: string | null): void {
  useEffect(() => {
    if (!sessionUid) return
    const cur = feeds.get(sessionUid)
    if (cur) cur.count++
    else if (!useStore.getState().chats[sessionUid]) feeds.set(sessionUid, { count: 1, close: open(sessionUid) })
    else return
    return () => {
      const f = feeds.get(sessionUid)
      if (!f) return
      if (--f.count === 0) {
        feeds.delete(sessionUid)
        f.close()
      }
    }
  }, [sessionUid])
}

export function feedStats(): number {
  return feeds.size
}
