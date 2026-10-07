/**
 * A session id in a reply (07 C18): `#K7Q2MX` that names one of the owner's chats renders as a chip — click opens
 * that chat. Ids are resolved from the loaded session list first, then once per id through `GET /api/sessions?q=`
 * (cached for the page); an id that names no chat (a hex colour, a hashtag) stays plain text. The chip's text is
 * exactly the source text, so the synced reveal's character mapping is unchanged.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { formatShortId } from '@shared/ids'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/router'
import { useStore } from '../../../lib/store'

interface Known {
  uid: string
  title: string
}

/** shortId → the chat it names (null: no such chat). Absent: not looked up yet. */
const resolved = new Map<string, Known | null>()
const pending = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
const MAX_CACHE = 500

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

const getVersion = (): number => version

function lookup(shortId: string): void {
  if (resolved.has(shortId) || pending.has(shortId)) return
  pending.add(shortId)
  api('GET /api/sessions', { query: { q: shortId, limit: 5 } })
    .then((r) => {
      const s = r.items.find((x) => x.shortId === shortId)
      if (resolved.size >= MAX_CACHE) resolved.delete(resolved.keys().next().value as string)
      resolved.set(shortId, s ? { uid: s.uid, title: s.title || 'New chat' } : null)
    })
    .catch(() => undefined) // offline: plain text now, tried again on the next render after reconnecting
    .finally(() => {
      pending.delete(shortId)
      emit()
    })
}

/** Forget what was looked up (a chat was created, renamed or deleted elsewhere). */
export function clearSessionChipCache(): void {
  resolved.clear()
  emit()
}

export function sessionChipCacheSize(): number {
  return resolved.size
}

export function SessionChip({ shortId, children }: { shortId: string; children?: ReactNode }): ReactNode {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const listed = useStore((s) => s.sessions.items.find((x) => x.shortId === shortId))
  const known: Known | null | undefined = listed ? { uid: listed.uid, title: listed.title || 'New chat' } : resolved.get(shortId)
  useEffect(() => {
    if (known === undefined) lookup(shortId)
  }, [known, shortId])
  if (!known) return <span className="md-session md-session--plain">{children}</span>
  const href = `/s/${known.uid}`
  return (
    <a
      href={href}
      className="md-session"
      title={`Open “${known.title}”`}
      aria-label={`${formatShortId(shortId)}, open the chat “${known.title}”`}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}
