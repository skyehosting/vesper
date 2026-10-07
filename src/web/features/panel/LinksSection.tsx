/**
 * "AI can access" (R8, 07 C18): the chats this one may recall (outgoing links) with a both-ways switch and remove,
 * an "Add a chat" picker that searches titles and #IDs, and the chats that can recall this one (incoming). Links are
 * one-way and not transitive; they only matter while the scope includes linked chats.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Link2, Unlink } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import type { Session, SessionLink, SessionSummary } from '@shared/types/domain'
import { Combobox } from '../../components/Combobox'
import { IconButton } from '../../components/IconButton'
import { api } from '../../lib/api'
import { Link } from '../../lib/router'
import { useStore } from '../../lib/store'
import { effectiveScope } from '../sessions/chips.logic'
import { linkSession, unlinkSession } from '../sessions/data'
import { titleOf } from '../sessions/group.logic'

const SEARCH_DEBOUNCE_MS = 200

export function LinksSection({ session }: { session: Session }): ReactNode {
  const scopeDefault = useStore((s) => s.settings?.memory.scopeDefault ?? 'linked')
  const scope = effectiveScope(session.memoryScope, scopeDefault)
  const incoming = new Set(session.linkedFrom.map((l) => l.uid))
  const outgoing = new Set(session.links.map((l) => l.uid))
  const onlyIncoming = session.linkedFrom.filter((l) => !outgoing.has(l.uid))
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    await fn()
    setBusy(null)
  }

  return (
    <div className="psec__body">
      {scope !== 'linked' ? (
        <p className="psec__hint">{scope === 'this' ? 'The scope is “this chat only”, so links are not used right now.' : 'The scope is “all chats”, so the AI can already recall every chat that isn’t private.'}</p>
      ) : null}

      {session.links.length ? (
        <ul className="plinks" aria-label="Chats this one can recall">
          {session.links.map((l) => (
            <LinkRow
              key={l.uid}
              link={l}
              bothWays={incoming.has(l.uid)}
              busy={busy === l.uid}
              onBoth={(v) =>
                void run(l.uid, async () => {
                  // The other side's link to this chat: added or removed on *that* session.
                  if (v) await linkSession(l.uid, session.shortId)
                  else await unlinkSession(l.uid, session.shortId)
                })
              }
              onRemove={() => void run(l.uid, () => unlinkSession(session.uid, l.shortId))}
            />
          ))}
        </ul>
      ) : (
        <p className="psec__empty">No linked chats yet. Link one so the AI can recall it here.</p>
      )}

      <AddLink session={session} />

      {onlyIncoming.length ? (
        <div className="plinks__in">
          <h4 className="psec__sub">Chats that can recall this one</h4>
          <ul className="plinks" aria-label="Chats that can recall this one">
            {onlyIncoming.map((l) => (
              <li key={l.uid} className="plink">
                <Link className="plink__name" to={`/s/${l.uid}`}>
                  <span className="plink__title">{l.title || 'New chat'}</span>
                  <span className="plink__id">{formatShortId(l.shortId)}</span>
                </Link>
                <IconButton
                  size="sm"
                  label={`Let this chat recall ${l.title || formatShortId(l.shortId)} too`}
                  icon={<ArrowLeftRight />}
                  loading={busy === l.uid}
                  onClick={() => void run(l.uid, () => linkSession(session.uid, l.shortId))}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="psec__hint">Links go one way and don’t chain: a chat linked to a linked chat isn’t included.</p>
    </div>
  )
}

function LinkRow({ link, bothWays, busy, onBoth, onRemove }: { link: SessionLink; bothWays: boolean; busy: boolean; onBoth: (v: boolean) => void; onRemove: () => void }): ReactNode {
  const name = link.title || 'New chat'
  return (
    <li className="plink">
      <Link className="plink__name" to={`/s/${link.uid}`}>
        <Link2 aria-hidden="true" />
        <span className="plink__title">{name}</span>
        <span className="plink__id">{formatShortId(link.shortId)}</span>
      </Link>
      <IconButton
        size="sm"
        label={bothWays ? `Both ways: ${name} can recall this chat too` : `One way: let ${name} recall this chat too`}
        icon={<ArrowLeftRight />}
        pressed={bothWays}
        className={`plink__both${bothWays ? ' is-on' : ''}`}
        disabled={busy}
        onClick={() => onBoth(!bothWays)}
      />
      <IconButton size="sm" label={`Unlink ${name}`} icon={<Unlink />} loading={busy} onClick={onRemove} />
    </li>
  )
}

/** "Add a chat": recent chats when empty, server search (titles, #IDs) as you type. */
function AddLink({ session }: { session: Session }): ReactNode {
  const recent = useStore((s) => s.sessions.items)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<SessionSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFound(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    timer.current = window.setTimeout(() => {
      api('GET /api/sessions', { query: { q, limit: 20 }, signal: ctrl.signal })
        .then((r) => {
          if (!ctrl.signal.aborted) setFound(r.items)
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFound([])
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      ctrl.abort()
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [query])

  const taken = useMemo(() => new Set([session.uid, ...session.links.map((l) => l.uid)]), [session])
  const pool = (found ?? recent.slice(0, 30)).filter((s) => !taken.has(s.uid) && !s.temporary)
  const options = pool.map((s) => ({
    value: s.uid,
    label: titleOf(s),
    description: [formatShortId(s.shortId), s.private ? 'private' : null, s.summary ?? null].filter(Boolean).join(' · '),
    keywords: [s.shortId]
  }))

  return (
    <Combobox
      label="Add a chat the AI can recall"
      placeholder="Search titles or #ID…"
      value={null}
      options={options}
      loading={loading}
      onQueryChange={setQuery}
      emptyText={query.trim() ? 'No chat matches.' : 'No other chats yet.'}
      onChange={(uid) => {
        const target = pool.find((s) => s.uid === uid)
        if (target) void linkSession(session.uid, target.shortId)
        setQuery('')
      }}
    />
  )
}
