/**
 * Memory viewer → Timeline (R7, 07 D12/D13): every remembered message newest first, grouped by day, filterable by
 * chat, who said it and dates; search by words (FTS) or by meaning (Voyage, when memory is on) through GET
 * /api/search. Keyset pages load as the list nears its end (one request at a time; a filter change aborts the old
 * one). Filters live in the URL (`/memory?q=…&session=…`) so `/recall` and links can open a prepared view. Phones get
 * the filters in a bottom sheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Filter, MessageSquarePlus, RotateCcw, Search, SearchX, X } from 'lucide-react'
import type { ApiError } from '@shared/errors'
import { formatShortId } from '@shared/ids'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Badge'
import { Combobox } from '../../components/Combobox'
import { useConfirm } from '../../components/ConfirmDialog'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Segmented } from '../../components/Segmented'
import { Sheet } from '../../components/Sheet'
import { Skeleton } from '../../components/Skeleton'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { VirtualList } from '../../components/VirtualList'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { getLocation, navigate } from '../../lib/router'
import { useIsPhone } from '../../lib/useMediaQuery'
import { createSession } from '../sessions/data'
import { MemoryEntry } from './MemoryEntry'
import { useLive } from './live'
import { manifest, memoryStatus } from './stores'
import {
  activeFilterCount,
  buildRows,
  EMPTY_FILTERS,
  fromHit,
  fromTimeline,
  hitPasses,
  timelineQuery,
  type Row,
  type TimelineFilters,
  type ViewerItem
} from './timeline.logic'
import { useSettings } from './settings'
import { useViewerZone } from './zone'

const PAGE = 50
const SEARCH_DEBOUNCE_MS = 250

function filtersFromUrl(search: string): TimelineFilters {
  const p = new URLSearchParams(search)
  const role = p.get('role')
  return {
    q: p.get('q') ?? '',
    mode: p.get('mode') === 'semantic' ? 'semantic' : 'keyword',
    session: p.get('session'),
    role: role === 'user' || role === 'assistant' ? role : 'all',
    from: p.get('from') ?? '',
    to: p.get('to') ?? ''
  }
}

function filtersToSearch(f: TimelineFilters): string {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.mode === 'semantic') p.set('mode', 'semantic')
  if (f.session) p.set('session', f.session)
  if (f.role !== 'all') p.set('role', f.role)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  const s = p.toString()
  return s ? `?${s}` : ''
}

interface ListState {
  items: ViewerItem[]
  next: string | null
  loading: boolean
  more: boolean
  error: ApiError | null
  /** Search hits that the local role/date filters dropped (so "no results" can say why). */
  hidden: number
}

const EMPTY_LIST: ListState = { items: [], next: null, loading: true, more: false, error: null, hidden: 0 }

export function Timeline(): ReactNode {
  const phone = useIsPhone()
  const settings = useSettings()
  const { zone, clock } = useViewerZone()
  const { data: status } = useLive(memoryStatus)
  const { data: man } = useLive(manifest)
  const [filters, setFilters] = useState<TimelineFilters>(() => filtersFromUrl(getLocation().search))
  const [typed, setTyped] = useState(filters.q)
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [sheet, setSheet] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const ctl = useRef<AbortController | null>(null)
  const { confirm, dialog } = useConfirm()
  const semanticOk = (settings?.memory.enabled ?? false) && status !== null && status.state !== 'keyword-only' && status.state !== 'disabled'
  const assistantName = settings?.profile.assistantName || 'Vesper'

  // Search text → filters, debounced.
  useEffect(() => {
    if (typed === filters.q) return
    const t = window.setTimeout(() => setFilters((f) => ({ ...f, q: typed.trim() })), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [typed, filters.q])

  // Filters → URL (replace: filtering isn't navigation).
  useEffect(() => {
    const want = filtersToSearch(filters)
    const loc = getLocation()
    if (loc.search !== want && loc.pathname.startsWith('/memory')) navigate(`${loc.pathname}${want}`, { replace: true })
  }, [filters])

  const fetchPage = useCallback(
    async (f: TimelineFilters, cursor: string | null, signal: AbortSignal): Promise<{ items: ViewerItem[]; next: string | null; hidden: number }> => {
      if (f.q) {
        const r = await api('GET /api/search', {
          query: {
            q: f.q,
            scope: f.session ? 'session' : 'all',
            ...(f.session ? { session: f.session } : {}),
            mode: f.mode === 'semantic' && semanticOk ? 'semantic' : 'keyword',
            order: 'recent',
            limit: PAGE,
            ...(cursor ? { cursor } : {})
          },
          signal
        })
        const pass = r.items.filter((h) => hitPasses(h.message, f, zone))
        return { items: pass.map(fromHit), next: r.next, hidden: r.items.length - pass.length }
      }
      const r = await api('GET /api/memory/timeline', { query: timelineQuery(f, zone, cursor, PAGE), signal })
      return { items: r.items.map(fromTimeline), next: r.next, hidden: 0 }
    },
    [zone, semanticOk]
  )

  const reload = useCallback(() => {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    setNow(Date.now())
    setList((l) => ({ ...EMPTY_LIST, items: l.items.length && !l.error ? l.items : [], loading: true }))
    fetchPage(filters, null, c.signal).then(
      (r) => {
        if (!c.signal.aborted) setList({ items: r.items, next: r.next, loading: false, more: false, error: null, hidden: r.hidden })
      },
      (e: unknown) => {
        if (!c.signal.aborted) setList({ ...EMPTY_LIST, loading: false, error: toApiError(e) })
      }
    )
  }, [filters, fetchPage])

  useEffect(() => {
    reload()
    return () => ctl.current?.abort()
  }, [reload])

  const loadMore = useCallback(() => {
    if (!list.next || list.loading || list.more || list.error) return
    const c = ctl.current ?? new AbortController()
    ctl.current = c
    setList((l) => ({ ...l, more: true }))
    fetchPage(filters, list.next, c.signal).then(
      (r) => {
        if (!c.signal.aborted) setList((l) => ({ ...l, items: [...l.items, ...r.items], next: r.next, more: false, hidden: l.hidden + r.hidden }))
      },
      (e: unknown) => {
        if (!c.signal.aborted) {
          setList((l) => ({ ...l, more: false }))
          toast.error(toApiError(e).message, { title: 'Couldn’t load more' })
        }
      }
    )
  }, [list, filters, fetchPage])

  const forget = useCallback(
    async (item: ViewerItem): Promise<void> => {
      const ok = await confirm({
        title: 'Forget this message?',
        description:
          'It is removed from memory and search on this PC, and from its chat. The AI may still see it in that chat until the conversation is condensed. Text already sent to Voyage AI can’t be called back.',
        confirmLabel: 'Forget',
        tone: 'danger'
      })
      if (!ok) return
      try {
        await api('DELETE /api/memory/messages/:uid', { params: { uid: item.message.uid } })
      } catch (e) {
        toast.error(toApiError(e).message, { title: 'Couldn’t forget that message' })
        return
      }
      setList((l) => ({ ...l, items: l.items.filter((x) => x.message.uid !== item.message.uid) }))
      toast.success('Forgotten.', {
        action: {
          label: 'Undo',
          onClick: () => {
            void api('POST /api/messages/:uid/restore', { params: { uid: item.message.uid } }).then(
              () => reload(),
              (e: unknown) => toast.error(toApiError(e).message)
            )
          }
        }
      })
    },
    [confirm, reload]
  )

  const relevanceView = filters.q !== '' && filters.mode === 'semantic' && semanticOk
  const rows = useMemo(() => buildRows(list.items, zone, now, !relevanceView), [list.items, zone, now, relevanceView])
  const sessionOptions = useMemo(
    () =>
      (man?.sessions ?? []).map((s) => ({
        value: s.uid,
        label: s.title || 'New chat',
        description: `${formatShortId(s.shortId)} · ${s.messageCount} messages`,
        keywords: [s.shortId]
      })),
    [man]
  )
  const sessionTitle = filters.session ? (man?.sessions.find((s) => s.uid === filters.session)?.title ?? 'This chat') : null
  const count = activeFilterCount(filters)
  const set = (patch: Partial<TimelineFilters>): void => setFilters((f) => ({ ...f, ...patch }))
  const clearAll = (): void => {
    setTyped('')
    setFilters({ ...EMPTY_FILTERS, mode: filters.mode })
  }

  const filterControls = (
    <>
      <Segmented
        aria-label="Who said it"
        size="sm"
        value={filters.role}
        onChange={(v) => set({ role: v })}
        options={[
          { value: 'all', label: 'Everyone' },
          { value: 'user', label: 'You' },
          { value: 'assistant', label: assistantName }
        ]}
      />
      <Combobox
        label="Chat"
        labelHidden={!phone}
        size="sm"
        placeholder="All chats"
        value={filters.session}
        onChange={(v) => set({ session: v })}
        options={sessionOptions}
        clearable
        emptyText="No chat matches"
        wrapClassName="mtl__session"
      />
      <div className="mtl__dates">
        <TextField
          type="date"
          size="sm"
          label="From"
          labelHidden={!phone}
          aria-label="From date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => set({ from: e.target.value })}
          wrapClassName="mtl__date"
        />
        <span className="mtl__dash" aria-hidden="true">
          –
        </span>
        <TextField
          type="date"
          size="sm"
          label="To"
          labelHidden={!phone}
          aria-label="To date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => set({ to: e.target.value })}
          wrapClassName="mtl__date"
        />
      </div>
    </>
  )

  const emptyAll = !list.loading && !list.error && list.items.length === 0 && !filters.q && count === 0

  return (
    <div className="mtl">
      <div className="mtl__bar">
        <div className="mtl__search">
          <TextField
            type="search"
            label="Search memory"
            labelHidden
            placeholder={filters.mode === 'semantic' && semanticOk ? 'Describe what you’re looking for…' : 'Search remembered messages…'}
            leading={<Search />}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') set({ q: typed.trim() })
              if (e.key === 'Escape' && typed) {
                e.stopPropagation()
                setTyped('')
                set({ q: '' })
              }
            }}
            wrapClassName="mtl__search-field"
          />
          <Segmented
            aria-label="Search by"
            size="sm"
            value={filters.mode === 'semantic' && semanticOk ? 'semantic' : 'keyword'}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: 'keyword', label: 'Words' },
              { value: 'semantic', label: 'Meaning', disabled: !semanticOk }
            ]}
          />
          {phone ? (
            <Button size="sm" icon={<Filter />} onClick={() => setSheet(true)} aria-label={count ? `Filters, ${count} on` : 'Filters'}>
              {count ? `Filters · ${count}` : 'Filters'}
            </Button>
          ) : null}
        </div>
        {!phone ? <div className="mtl__filters">{filterControls}</div> : null}
        {count > 0 || filters.q ? (
          <div className="mtl__chips" aria-label="Active filters">
            {filters.q ? (
              <Chip size="sm" onRemove={() => (setTyped(''), set({ q: '' }))} removeLabel="Clear the search">
                {`“${filters.q}”`}
              </Chip>
            ) : null}
            {sessionTitle ? (
              <Chip size="sm" onRemove={() => set({ session: null })} removeLabel="Show all chats">
                {sessionTitle}
              </Chip>
            ) : null}
            {filters.role !== 'all' ? (
              <Chip size="sm" onRemove={() => set({ role: 'all' })} removeLabel="Show everyone">
                {filters.role === 'user' ? 'Said by you' : `Said by ${assistantName}`}
              </Chip>
            ) : null}
            {filters.from || filters.to ? (
              <Chip size="sm" onRemove={() => set({ from: '', to: '' })} removeLabel="Any date">
                {filters.from && filters.to ? `${filters.from} – ${filters.to}` : filters.from ? `From ${filters.from}` : `Until ${filters.to}`}
              </Chip>
            ) : null}
            <button type="button" className="mtl__clear" onClick={clearAll}>
              Clear all
            </button>
          </div>
        ) : null}
        {!semanticOk && filters.mode === 'semantic' ? <p className="mnote">Searching by meaning needs Voyage memory to be on. Showing word matches.</p> : null}
      </div>

      <div className="mtl__list" aria-busy={list.loading || list.more}>
        {list.error ? (
          <ErrorState error={list.error} onRetry={reload} />
        ) : list.loading && list.items.length === 0 ? (
          <div className="mtl__skeleton" data-loading>
            {[0, 1, 2].map((i) => (
              <div key={i} className="ment ment--skeleton">
                <Skeleton width="40%" />
                <Skeleton lines={2} />
              </div>
            ))}
          </div>
        ) : emptyAll ? (
          <EmptyState
            icon={<MessageSquarePlus />}
            title="Nothing remembered yet"
            description="Every message you and the AI exchange appears here, tagged and timestamped, as soon as it’s sent."
            actions={
              <Button
                variant="primary"
                onClick={() =>
                  void createSession().then(
                    (s) => navigate(`/s/${s.uid}`),
                    (e: unknown) => toast.error(toApiError(e).message)
                  )
                }
              >
                Start a chat
              </Button>
            }
          />
        ) : list.items.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={filters.q ? `No matches for “${filters.q}”` : 'Nothing matches these filters'}
            description={
              list.hidden > 0
                ? `${list.hidden} result${list.hidden === 1 ? ' was' : 's were'} hidden by the filters.`
                : filters.q && filters.mode === 'keyword' && semanticOk
                  ? 'Try searching by meaning — it finds things said in other words.'
                  : 'Try other words or clear the filters.'
            }
            actions={
              <>
                {filters.q && filters.mode === 'keyword' && semanticOk ? (
                  <Button variant="primary" onClick={() => set({ mode: 'semantic' })}>
                    Search by meaning
                  </Button>
                ) : null}
                <Button icon={<X />} onClick={clearAll}>
                  Clear filters
                </Button>
              </>
            }
          />
        ) : (
          <VirtualList<Row>
            items={rows}
            getKey={(r) => r.key}
            estimateSize={140}
            gap={10}
            paddingTop={4}
            paddingBottom={24}
            onEndReached={loadMore}
            aria-label="Remembered messages"
            data-testid="memory-timeline"
            className="mtl__scroller"
            renderItem={(r) =>
              r.kind === 'day' ? (
                <h3 className="mtl__day">{r.label}</h3>
              ) : (
                <MemoryEntry item={r.item} nowUtc={now} viewerZone={zone} clock={clock} assistantName={assistantName} onForget={(it) => void forget(it)} />
              )
            }
          />
        )}
        {list.more ? (
          <div className="mtl__more">
            <Spinner size={16} label="Loading older messages" />
          </div>
        ) : null}
      </div>
      {list.loading && list.items.length > 0 ? (
        <div className="mtl__refresh" role="status">
          <Spinner size={14} /> Updating…
        </div>
      ) : null}
      {phone ? (
        <Sheet
          open={sheet}
          onClose={() => setSheet(false)}
          title="Filters"
          side="bottom"
          footer={
            <>
              <Button icon={<RotateCcw />} onClick={() => setFilters({ ...EMPTY_FILTERS, q: filters.q, mode: filters.mode })}>
                Reset
              </Button>
              <Button variant="primary" onClick={() => setSheet(false)}>
                Show results
              </Button>
            </>
          }
        >
          <div className="mtl__sheet">{filterControls}</div>
        </Sheet>
      ) : null}
      {dialog}
    </div>
  )
}
