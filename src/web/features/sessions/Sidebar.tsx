/**
 * Sessions sidebar (R6, 01 "Sessions"): New chat / New temporary chat, title search, the grouped list (Pinned · Today ·
 * Yesterday · This week · Older) with badges, inline rename, pin, archive, delete with undo, keyboard navigation and
 * windowing when long; the Archived and Trash views; and the footer (Memory viewer, Prompt library; Settings, Search,
 * Constellation, Archived, Trash).
 * Live: `sessions.changed` / `session.updated` (wired in boot.ts) keep the store current.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, BookText, Brain, Ghost, MessageSquarePlus, Orbit, PanelLeftClose, Search, Settings, TextSearch, Trash2, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Skeleton } from '../../components/Skeleton'
import { StarGlyph } from '../../app/StarGlyph'
import { Link, navigate, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { deviceZone } from './dates'
import { loadMoreSessions, loadSessions, startNewChat, startTemporaryChat } from './data'
import { groupSessions } from './group.logic'
import { SessionBin } from './SessionBin'
import { SessionList } from './SessionList'
import './sidebar.css'

const SEARCH_DEBOUNCE_MS = 250

export function Sidebar({ onCollapse, phone }: { onCollapse: () => void; phone: boolean }): ReactNode {
  const view = useStore((s) => s.ui.sidebarView)
  const setView = useStore((s) => s.setSidebarView)
  const { pathname } = useLocation()

  return (
    <div className="sidebar">
      <div className="sidebar__head app-drag">
        <Link to="/" className="sidebar__brand" aria-label="Vesper home">
          <StarGlyph size={20} />
          <span>Vesper</span>
        </Link>
        <IconButton label={phone ? 'Close chats' : 'Hide sidebar'} icon={phone ? <X /> : <PanelLeftClose />} size="sm" onClick={onCollapse} tooltipSide="bottom" />
      </div>

      {view === 'chats' ? <ChatsView /> : <SessionBin kind={view} onBack={() => setView('chats')} />}

      <div className="sidebar__foot">
        {/* The memory viewer and the prompt library, labelled and one click away (F52). */}
        <div className="sidebar__foot-row">
          <Link to="/memory" className="sidebar__foot-link" aria-current={pathname === '/memory' || pathname.startsWith('/memory/') ? 'page' : undefined}>
            <Brain aria-hidden="true" />
            <span>Memory</span>
          </Link>
          <Link to="/prompts" className="sidebar__foot-link" aria-current={pathname === '/prompts' ? 'page' : undefined}>
            <BookText aria-hidden="true" />
            <span>Prompts</span>
          </Link>
        </div>
        <div className="sidebar__foot-row">
          <Link to="/settings" className="sidebar__foot-link" aria-current={pathname.startsWith('/settings') ? 'page' : undefined}>
            <Settings aria-hidden="true" />
            <span>Settings</span>
          </Link>
          <div className="sidebar__foot-icons">
            <IconButton label="Search all messages" icon={<TextSearch />} size="sm" aria-current={pathname === '/search' ? 'page' : undefined} onClick={() => navigate('/search')} />
            <IconButton
              label="Constellation"
              icon={<Orbit />}
              size="sm"
              aria-current={pathname === '/constellation' ? 'page' : undefined}
              onClick={() => navigate('/constellation')}
            />
            <IconButton label="Archived chats" icon={<Archive />} size="sm" pressed={view === 'archived'} onClick={() => setView(view === 'archived' ? 'chats' : 'archived')} />
            <IconButton label="Trash" icon={<Trash2 />} size="sm" pressed={view === 'trash'} onClick={() => setView(view === 'trash' ? 'chats' : 'trash')} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ChatsView(): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const tzOverride = useStore((s) => s.settings?.profile.timeZone)
  const activeUid = useStore((s) => s.activeSessionUid)
  const [query, setQuery] = useState(sessions.query)
  const [creating, setCreating] = useState<'chat' | 'temp' | null>(null)
  const firstRun = useRef(true)

  // Debounced server-side search (titles and #IDs; message text is the global search's job).
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const h = window.setTimeout(() => void loadSessions(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(h)
  }, [query])

  // Regroup when the day changes even if nothing else does (Today → Yesterday at local midnight).
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000))
  useEffect(() => {
    const h = window.setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000)
    return () => window.clearInterval(h)
  }, [])
  const groups = useMemo(() => groupSessions(sessions.items, minute * 60_000, deviceZone(tzOverride)), [sessions.items, minute, tzOverride])

  const create = async (kind: 'chat' | 'temp'): Promise<void> => {
    if (creating) return
    setCreating(kind)
    try {
      await (kind === 'chat' ? startNewChat() : startTemporaryChat())
    } finally {
      setCreating(null)
    }
  }

  const searching = query.trim() !== ''
  const firstLoad = !sessions.loaded && sessions.loading

  return (
    <>
      <div className="sidebar__actions">
        <div className="sidebar__new">
          <Button variant="primary" block icon={<MessageSquarePlus />} loading={creating === 'chat'} onClick={() => void create('chat')}>
            New chat
          </Button>
          <IconButton label="New temporary chat" icon={<Ghost />} variant="secondary" loading={creating === 'temp'} onClick={() => void create('temp')} />
        </div>
        <div className="sidebar__search">
          <Search aria-hidden="true" />
          <input
            type="search"
            className="sidebar__search-input"
            placeholder="Search chats"
            aria-label="Search chats by title or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                e.preventDefault()
                setQuery('')
              } else if (e.key === 'ArrowDown') {
                // Into the list: the first chat takes focus.
                const first = e.currentTarget.closest('.sidebar')?.querySelector<HTMLElement>('.srow__link')
                if (first) {
                  e.preventDefault()
                  first.focus()
                }
              }
            }}
          />
        </div>
      </div>

      <nav className="sidebar__list" aria-label="Chat list" aria-busy={sessions.loading || undefined}>
        {searching ? (
          <Link className="sidebar__deep" to={`/search?q=${encodeURIComponent(query.trim())}`}>
            <TextSearch aria-hidden="true" />
            <span>
              Search messages for “<strong>{query.trim()}</strong>”
            </span>
          </Link>
        ) : null}
        {firstLoad ? (
          <div className="sidebar__skeleton" data-loading>
            <span className="sr-only">Loading chats</span>
            {[78, 62, 70, 54, 66].map((w, i) => (
              <Skeleton key={i} width={`${w}%`} height={14} />
            ))}
          </div>
        ) : null}
        {sessions.error && !sessions.items.length ? <ErrorState compact error={sessions.error} onRetry={() => void loadSessions()} /> : null}
        {sessions.loaded && !sessions.items.length && !sessions.error ? (
          searching ? (
            <EmptyState size="sm" headingLevel={3} icon={<Search />} title="No chat titles match" description="Try the message search above, or fewer words." />
          ) : (
            <EmptyState size="sm" headingLevel={3} star title="No chats yet" description="Start one with New chat — it shows up here." />
          )
        ) : null}
        {sessions.items.length ? <SessionList groups={groups} currentUid={activeUid} /> : null}
        {sessions.next ? (
          <div className="sidebar__more">
            <Button size="sm" variant="ghost" loading={sessions.loading} onClick={() => void loadMoreSessions()}>
              Show more
            </Button>
          </div>
        ) : null}
      </nav>
    </>
  )
}
