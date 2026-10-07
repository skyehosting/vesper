/**
 * In-session search (Ctrl+F, 07 D1): keyword search over this session on the server (it reaches the whole history,
 * not just the loaded window), newest first; Enter / ↓ goes to the next older hit, Shift+Enter / ↑ to the newer one,
 * jumping the window there. Matches in the rendered rows are painted with the CSS Custom Highlight API (no DOM
 * changes; the current hit's row brighter). Earlier versions of a message are selected first (07 C3).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { SearchHit } from '@shared/types/domain'
import { IconButton } from '../../components/IconButton'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import type { WindowController } from './window/controller'

const HL_ALL = 'vesper-find'
const HL_CURRENT = 'vesper-find-current'

function termsOf(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2))]
}

function highlightApi(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'
}

/** Paint every occurrence of `terms` inside the loaded rows; ranges in the `currentUid` row go to the bright set. */
function paint(root: Element | null, terms: string[], currentUid: string | null): void {
  if (!highlightApi()) return
  const all = new Highlight()
  const cur = new Highlight()
  if (root && terms.length) {
    for (const host of root.querySelectorAll<HTMLElement>('.msg__content, .msg__bubble')) {
      const uid = host.closest<HTMLElement>('article.msg')?.dataset.uid ?? null
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('[data-reveal-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      })
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const text = n.data.toLowerCase()
        for (const t of terms) {
          for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
            const r = new Range()
            r.setStart(n, i)
            r.setEnd(n, i + t.length)
            ;(uid && uid === currentUid ? cur : all).add(r)
          }
        }
      }
    }
  }
  CSS.highlights.set(HL_ALL, all)
  CSS.highlights.set(HL_CURRENT, cur)
}

function clearPaint(): void {
  if (!highlightApi()) return
  CSS.highlights.delete(HL_ALL)
  CSS.highlights.delete(HL_CURRENT)
}

export function FindBar({ sessionUid, controller, onClose }: { sessionUid: string; controller: WindowController; onClose: () => void }): ReactNode {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [more, setMore] = useState(false)
  const [index, setIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // Enter pressed before the results arrived: go to the first hit when they do.
  const pendingGo = useRef(false)
  const current = index >= 0 && hits ? hits[index] : null

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  // Search (debounced; a newer query aborts the older request).
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) {
      setHits(null)
      setIndex(-1)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const t = window.setTimeout(() => {
      api('GET /api/search', { query: { q: query, scope: 'session', session: sessionUid, mode: 'keyword', order: 'recent', limit: 100 }, signal: ctrl.signal })
        .then((r) => {
          setHits(r.items)
          setMore(!!r.next)
          setIndex(-1)
          setError(null)
        })

        .catch((e: unknown) => {
          if (!ctrl.signal.aborted) setError(toApiError(e).message)
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false)
        })
    }, 200)
    return () => {
      window.clearTimeout(t)
      ctrl.abort()
    }
  }, [q, sessionUid])

  const go = useCallback(
    (i: number) => {
      if (loading || !hits) {
        pendingGo.current = true
        return
      }
      if (hits.length === 0) return
      const n = (i + hits.length) % hits.length
      setIndex(n)
      const h = hits[n]
      const jump = h.onPath ? controller.jumpToSeq(h.message.seq, true, 'center', false) : controller.jumpToMessage(h.message.uid, false).then(() => undefined)
      void jump.catch((e: unknown) => setError(toApiError(e).message))
    },
    [hits, controller, loading]
  )
  useEffect(() => {
    if (!pendingGo.current || loading || !hits) return
    pendingGo.current = false
    go(0)
  }, [hits, loading, go])

  // Highlights follow the rendered rows (scrolling, paging, streaming).
  useEffect(() => {
    const root = document.querySelector('[data-testid="message-window"]')
    const terms = termsOf(q)
    let frame = 0
    const repaint = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        paint(root, terms, current?.message.uid ?? null)
      })
    }
    repaint()
    const mo = root ? new MutationObserver(repaint) : null
    mo?.observe(root as Element, { childList: true, subtree: true, characterData: true })
    return () => {
      mo?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [q, current])
  useEffect(() => clearPaint, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      go(index + (e.shiftKey || e.key === 'ArrowUp' ? -1 : 1))
    }
  }

  const count = hits === null ? '' : hits.length === 0 ? 'No matches' : `${index >= 0 ? index + 1 : 0} of ${hits.length}${more ? '+' : ''}`
  return (
    <div className="find" role="search" aria-label="Search this conversation" data-testid="find-bar">
      <Search className="find__icon" aria-hidden="true" />
      <input
        ref={input}
        className="find__input"
        type="search"
        value={q}
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        aria-describedby="find-count"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span id="find-count" className="find__count" aria-live="polite">
        {loading ? <Spinner size={12} label="Searching" /> : error ? error : count}
        {current && !current.onPath ? <span className="find__earlier"> · earlier version</span> : null}
      </span>
      <IconButton size="sm" label="Newer match" icon={<ChevronUp />} disabled={!hits?.length} onClick={() => go(index - 1)} />
      <IconButton size="sm" label="Older match" icon={<ChevronDown />} disabled={!hits?.length} onClick={() => go(index + 1)} />
      <IconButton size="sm" label="Close search" icon={<X />} onClick={onClose} />
    </div>
  )
}
