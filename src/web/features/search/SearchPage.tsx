/**
 * '/search' — search every message (GET /api/search): keyword (FTS on this PC) or by meaning (Voyage AI, when memory
 * is set up), filtered by chat, date and who said it, newest first or best match. Each hit shows the chat, the time
 * (07 C2 format), who said it and the snippet with the matches highlighted; opening one jumps to that message
 * (/s/:uid?m=<messageUid> — chat-ui loads the window around it). Off-path hits are marked "earlier version" (07 C3).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, History, SearchX, TextSearch, User } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import type { ApiError } from '@shared/errors'
import type { SearchHit } from '@shared/types/domain'
import type { PageProps } from '../../app/routes'
import { TopBarContent } from '../../app/topBar'
import { Badge, LeavesPcBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Combobox } from '../../components/Combobox'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Segmented } from '../../components/Segmented'
import { Select } from '../../components/Select'
import { Skeleton } from '../../components/Skeleton'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { Link, navigate, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { useIsPhone } from '../../lib/useMediaQuery'
import { ageOf, deviceZone, formatDate, partsOf, stampOf } from '../sessions/dates'
import { titleOf } from '../sessions/group.logic'
import { filterHits, parseSearchParams, pastBound, searchPath, snippetRuns, whenFrom, type RoleFilter, type SearchMode, type SearchOrder, type SearchState, type WhenFilter } from './search.logic'
import './search.css'

const DEBOUNCE_MS = 250
const PAGE = 30
/** Extra pages fetched automatically when client-side filters leave too few hits. */
const AUTO_PAGES = 3

interface Results {
  key: string
  hits: SearchHit[]
  next: string | null
  loading: boolean
  error: ApiError | null
}

export default function SearchPage(_props: PageProps): ReactNode {
  const { search } = useLocation()
  const urlState = useMemo(() => parseSearchParams(search), [search])
  const [text, setText] = useState(urlState.q)
  const input = useRef<HTMLInputElement>(null)
  const memoryOn = useStore((s) => s.settings?.memory.enabled ?? false)
  const memState = useStore((s) => s.ui.memoryStatus?.state ?? null)
  const semanticOk = memoryOn && (memState === 'ready' || memState === 'loading' || memState === 'degraded')
  const tz = useStore((s) => s.settings?.profile.timeZone)
  const phone = useIsPhone()

  useEffect(() => {
    document.title = 'Search · Vesper'
    input.current?.focus()
    return () => {
      document.title = 'Vesper'
    }
  }, [])

  // Typing updates the URL (replace, debounced) — the URL is the one source of truth for the query.
  useEffect(() => {
    if (text === urlState.q) return
    const h = window.setTimeout(() => navigate(searchPath({ ...urlState, q: text.trim() ? text : '' }), { replace: true }), DEBOUNCE_MS)
    return () => window.clearTimeout(h)
  }, [text])
  // Back/forward or a link changed the query.
  useEffect(() => {
    if (urlState.q !== text.trim() && urlState.q !== text) setText(urlState.q)
  }, [urlState.q])

  const set = (patch: Partial<SearchState>): void => navigate(searchPath({ ...urlState, q: text, ...patch }), { replace: true })
  const state: SearchState = semanticOk ? urlState : { ...urlState, mode: 'keyword' }
  const fromUtc = whenFrom(state.when, Date.now(), deviceZone(tz))
  const results = useSearch(state, fromUtc)

  const shown = results ? filterHits(results.hits, state.role, fromUtc) : []
  const q = state.q.trim()

  return (
    <div className="search">
      <TopBarContent>
        <h1 className="search__heading">Search</h1>
      </TopBarContent>
      <div className="search__inner">
        <form
          className="search__box"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(searchPath({ ...urlState, q: text }), { replace: true })
          }}
        >
          <TextSearch aria-hidden="true" />
          <input
            ref={input}
            type="search"
            className="search__input"
            aria-label="Search all messages"
            placeholder="Search all your messages…"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                const first = document.querySelector<HTMLElement>('.shit__link')
                if (first) {
                  e.preventDefault()
                  first.focus()
                }
              }
            }}
          />
        </form>

        <div className="search__filters">
          <div className="search__mode">
            <Segmented<SearchMode>
              aria-label="Search by"
              block={phone}
              size="sm"
              value={state.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 'keyword', label: 'Words' },
                { value: 'semantic', label: 'Meaning', disabled: !semanticOk }
              ]}
            />
            {state.mode === 'semantic' ? <LeavesPcBadge service="Voyage AI" what="search text" /> : null}
          </div>
          <SessionFilter value={state.session} onChange={(session) => set({ session })} />
          <Select<WhenFilter>
            label="When"
            labelHidden
            size="sm"
            value={state.when}
            onChange={(when) => set({ when })}
            options={[
              { value: 'any', label: 'Any time' },
              { value: 'today', label: 'Today' },
              { value: 'week', label: 'Past 7 days' },
              { value: 'month', label: 'Past 30 days' },
              { value: 'year', label: 'Past year' }
            ]}
          />
          <Segmented<RoleFilter>
            className="search__who"
            block={phone}
            aria-label="Who said it"
            size="sm"
            value={state.role}
            onChange={(role) => set({ role })}
            options={[
              { value: 'any', label: 'Anyone' },
              { value: 'user', label: 'You' },
              { value: 'assistant', label: 'AI' }
            ]}
          />
          <Select<SearchOrder>
            label="Sort"
            labelHidden
            size="sm"
            value={state.order}
            onChange={(order) => set({ order })}
            options={[
              { value: 'recent', label: 'Newest first' },
              { value: 'relevance', label: 'Best match' }
            ]}
          />
        </div>
        {!semanticOk ? (
          <p className="search__note">{memoryOn ? 'Search by meaning needs a Voyage AI key (Settings → Memory).' : 'Search by meaning needs memory turned on (Settings → Memory). Word search works on this PC.'}</p>
        ) : null}

        <div className="search__results" aria-busy={results?.loading || undefined}>
          {!q ? (
            <EmptyState
              icon={<TextSearch />}
              title="Search everything you’ve said"
              description="Words find exact matches on this PC. With memory set up, Meaning finds messages about the same thing in other words."
            />
          ) : !results || (results.loading && !results.hits.length) ? (
            <div className="search__skeleton" data-loading>
              <span className="sr-only">Searching</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="shit shit--skel">
                  <Skeleton width="34%" height={11} />
                  <Skeleton lines={2} />
                </div>
              ))}
            </div>
          ) : results.error && !results.hits.length ? (
            <ErrorState error={results.error} onRetry={() => navigate(searchPath(state), { replace: true })} />
          ) : !shown.length && !results.next ? (
            <EmptyState icon={<SearchX />} title={`No messages match “${q}”`} description={state.role !== 'any' || state.when !== 'any' || state.session ? 'Try removing a filter or using fewer words.' : 'Try fewer or different words.'} />
          ) : (
            <>
              <p className="search__count" role="status">
                {shown.length === 1 ? '1 message' : `${shown.length}${results.next ? '+' : ''} messages`}
              </p>
              <ol className="search__list">
                {shown.map((h) => (
                  <Hit key={h.message.uid} hit={h} />
                ))}
              </ol>
              {results.next ? (
                <div className="search__more">
                  <Button variant="secondary" loading={results.loading} onClick={() => results.more?.()}>
                    Show more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Hit({ hit }: { hit: SearchHit }): ReactNode {
  const m = hit.message
  const you = m.role === 'user'
  return (
    <li className="shit">
      <Link className="shit__link" to={`/s/${hit.session.uid}?m=${encodeURIComponent(m.uid)}`}>
        <span className="shit__meta">
          <span className={`shit__who${you ? ' is-you' : ''}`}>
            {you ? <User aria-hidden="true" /> : <Bot aria-hidden="true" />}
            {you ? 'You' : 'AI'}
          </span>
          <span className="shit__chat">{titleOf({ title: hit.session.title, temporary: false })}</span>
          <span className="shit__id">{formatShortId(hit.session.shortId)}</span>
          <span className="shit__when" title={stampOf(m.tsUtc)}>
            {ageOf(m.tsUtc)}
            <span className="shit__date"> · {formatDate(partsOf(m.tsUtc))}</span>
          </span>
          {hit.onPath ? null : (
            <Badge size="sm" icon={<History />}>
              earlier version
            </Badge>
          )}
        </span>
        <span className="shit__snippet">
          {snippetRuns(hit.snippet).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
        </span>
        <span className="sr-only">, {stampOf(m.tsUtc)}</span>
      </Link>
    </li>
  )
}

/** "All chats" or one chat (titles and #IDs, searched on the server as you type). */
function SessionFilter({ value, onChange }: { value: string; onChange: (uid: string) => void }): ReactNode {
  const items = useStore((s) => s.sessions.items)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<typeof items | null>(null)
  const [chosen, setChosen] = useState<{ uid: string; label: string } | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFound(null)
      return
    }
    const ctrl = new AbortController()
    const h = window.setTimeout(() => {
      api('GET /api/sessions', { query: { q, limit: 20 }, signal: ctrl.signal })
        .then((r) => {
          if (!ctrl.signal.aborted) setFound(r.items)
        })
        .catch(() => undefined)
    }, 200)
    return () => {
      ctrl.abort()
      window.clearTimeout(h)
    }
  }, [query])

  const pool = (found ?? items.slice(0, 40)).filter((s) => !s.temporary)
  const options = [
    { value: '', label: 'All chats' },
    ...(chosen && chosen.uid === value && !pool.some((s) => s.uid === value) ? [{ value: chosen.uid, label: chosen.label }] : []),
    ...pool.map((s) => ({ value: s.uid, label: titleOf(s), description: formatShortId(s.shortId), keywords: [s.shortId] }))
  ]
  // A session from the URL that isn't in the list yet still shows a name.
  const known = options.find((o) => o.value === value)
  return (
    <div className="search__session">
      <Combobox
        label="Chat"
        labelHidden
        size="sm"
        placeholder="All chats"
        value={known ? value : ''}
        options={options}
        onQueryChange={setQuery}
        emptyText="No chat matches."
        onChange={(v) => {
          const o = options.find((x) => x.value === v)
          setChosen(o && v ? { uid: v, label: o.label } : null)
          setQuery('')
          onChange(v ?? '')
        }}
      />
    </div>
  )
}

/** Fetch pages for the current state; pages more automatically while client-side filters hide most hits. */
function useSearch(state: SearchState, fromUtc: number | null): (Results & { more?: () => void }) | null {
  const key = JSON.stringify([state.q.trim(), state.mode, state.session, state.order])
  const [res, setRes] = useState<Results | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  const fetchPage = (cursor: string | null, prev: SearchHit[], auto: number): void => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setRes((r) => ({ key, hits: prev, next: r?.key === key ? r.next : null, loading: true, error: null }))
    api('GET /api/search', {
      query: { q: state.q.trim(), mode: state.mode, order: state.order, limit: PAGE, ...(state.session ? { scope: 'session' as const, session: state.session } : {}), ...(cursor ? { cursor } : {}) },
      signal: ctrl.signal
    })
      .then((r) => {
        if (ctrl.signal.aborted) return
        const hits = [...prev, ...r.items.filter((h) => !prev.some((p) => p.message.uid === h.message.uid))]
        const next = pastBound(hits, state.order, fromUtc) ? null : r.next
        setRes({ key, hits, next, loading: false, error: null })
        if (next && auto > 0 && filterHits(hits, state.role, fromUtc).length < 10) fetchPage(next, hits, auto - 1)
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setRes({ key, hits: prev, next: null, loading: false, error: toApiError(e) })
      })
  }

  useEffect(() => {
    if (!state.q.trim()) {
      setRes(null)
      return
    }
    fetchPage(null, [], AUTO_PAGES)
    return () => ctrlRef.current?.abort()
  }, [key])

  // Filters that only narrow the page (role, date) may need more pages; nothing to refetch from scratch.
  useEffect(() => {
    if (res && !res.loading && res.next && filterHits(res.hits, state.role, fromUtc).length < 10) fetchPage(res.next, res.hits, AUTO_PAGES)
  }, [state.role, state.when])

  if (!res || res.key !== key) return state.q.trim() ? { key, hits: [], next: null, loading: true, error: null } : null
  return { ...res, more: res.next ? () => fetchPage(res.next, res.hits, 0) : undefined }
}

