/**
 * The grouped chat list (R6): Pinned · Today · Yesterday · This week · Older, one roving tab stop (↑/↓, Home/End,
 * PgUp/PgDn; F2 rename; Delete → Trash with undo; Shift+F10 menu), and windowed rendering once the list is long
 * (fixed row heights → exact offsets, see sidebar.logic.ts). The focused row always stays rendered, and pages load
 * as the end comes into view.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/types/domain'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useStore } from '../../lib/store'
import { archiveSession, continueSession, copySessionId, deleteSession, loadMoreSessions, renameSession, setPinned } from './data'
import type { SessionGroup } from './group.logic'
import { SessionRow, type RowActions } from './SessionRow'
import { flattenGroups, moveFocus, rowOffsets, sessionOrder, VIRTUALIZE_AT, windowRange, type RowMetrics } from './sidebar.logic'

const OVERSCAN_PX = 600
const LOAD_MORE_PX = 400

export function SessionList({ groups, currentUid, labelledBy }: { groups: SessionGroup[]; currentUid: string | null; labelledBy?: string }): ReactNode {
  const coarse = useMediaQuery('(pointer: coarse), (max-width: 719.98px)')
  // Rows carry 1 px of breathing room above and below the link, so touch rows are 46 px for a 44 px target (07 D8).
  const metrics: RowMetrics = useMemo(() => ({ row: coarse ? 46 : 34, header: 30, gap: 14 }), [coarse])
  const rows = useMemo(() => flattenGroups(groups), [groups])
  const offsets = useMemo(() => rowOffsets(rows, metrics), [rows, metrics])
  const order = useMemo(() => sessionOrder(rows), [rows])
  const orderUids = useMemo(() => order.map((s) => s.uid), [order])
  const hasMore = useStore((s) => s.sessions.next !== null)

  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(800)
  const [focusUid, setFocusUid] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const pendingFocus = useRef<string | null>(null)

  const virtual = rows.length > VIRTUALIZE_AT
  const total = offsets[offsets.length - 1] ?? 0

  // The tab stop: the focused row if it still exists, else the open chat, else the first row.
  const tabUid = (focusUid && orderUids.includes(focusUid) ? focusUid : null) ?? (currentUid && orderUids.includes(currentUid) ? currentUid : null) ?? orderUids[0] ?? null

  useLayoutEffect(() => {
    const el = scroller.current?.parentElement
    if (!el) return
    setViewport(el.clientHeight)
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The scrolling element is the parent <nav> (it also holds the empty/error states).
  useEffect(() => {
    const el = scroller.current?.parentElement
    if (!el) return
    const onScroll = (): void => {
      setScrollTop(el.scrollTop)
      if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - LOAD_MORE_PX) void loadMoreSessions()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore])

  const scrollIntoView = useCallback(
    (uid: string): void => {
      const el = scroller.current?.parentElement
      const i = rows.findIndex((r) => r.key === uid)
      if (!el || i < 0) return
      const top = offsets[i] + (scroller.current?.offsetTop ?? 0)
      const bottom = offsets[i + 1] + (scroller.current?.offsetTop ?? 0)
      // Keep a group heading visible above the first row of a group.
      const head = i > 0 && rows[i - 1].kind === 'header' ? offsets[i - 1] + (scroller.current?.offsetTop ?? 0) : top
      if (head < el.scrollTop) el.scrollTop = head
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8
      setScrollTop(el.scrollTop)
    },
    [rows, offsets]
  )

  // Bring the open chat into view when it changes (opened from the palette, a search hit, /continue).
  useEffect(() => {
    if (currentUid) scrollIntoView(currentUid)
    // Only on navigation; not on every list update.
  }, [currentUid])

  // Focus moves after the target row has rendered.
  useLayoutEffect(() => {
    const uid = pendingFocus.current
    if (!uid) return
    const a = scroller.current?.querySelector<HTMLElement>(`a[data-uid="${CSS.escape(uid)}"]`)
    if (a) {
      pendingFocus.current = null
      a.focus({ preventScroll: true })
    }
  })

  const focusRow = useCallback(
    (uid: string) => {
      pendingFocus.current = uid
      setFocusUid(uid)
      scrollIntoView(uid)
    },
    [scrollIntoView]
  )

  const actions: RowActions = useMemo(
    () => ({
      rename: (uid, title) => {
        setRenaming(null)
        focusRow(uid)
        void renameSession(uid, title)
      },
      startRename: (uid) => setRenaming(uid),
      cancelRename: () =>
        setRenaming((uid) => {
          if (uid) pendingFocus.current = uid
          return null
        }),
      pin: (uid, pinned) => void setPinned(uid, pinned),
      archive: (uid) => void archiveSession(uid, order),
      remove: (uid) => {
        const next = moveFocus(orderUids, uid, 'ArrowDown')
        const fallback = next === uid ? moveFocus(orderUids, uid, 'ArrowUp') : next
        if (fallback && fallback !== uid) focusRow(fallback)
        void deleteSession(uid, order)
      },
      copyId: (shortId) => void copySessionId(shortId),
      continueIn: (uid) => void continueSession(uid),
      onKeyDown: (e: KeyboardEvent<HTMLAnchorElement>, s: SessionSummary) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'F2' && !s.temporary) {
          e.preventDefault()
          setRenaming(s.uid)
          return
        }
        if (e.key === 'Delete') {
          e.preventDefault()
          actions.remove(s.uid)
          return
        }
        const to = moveFocus(orderUids, s.uid, e.key)
        if (to === null) return
        e.preventDefault()
        focusRow(to)
      },
      onFocus: (uid) => setFocusUid(uid)
    }),
    // `actions` refers to itself only inside handlers (after creation).
    [order, orderUids, focusRow]
  )

  const range = virtual ? windowRange(offsets, Math.max(0, scrollTop - (scroller.current?.offsetTop ?? 0)), viewport, OVERSCAN_PX) : rows.length ? ([0, rows.length - 1] as [number, number]) : null
  const visible: number[] = []
  if (range) for (let i = range[0]; i <= range[1]; i++) visible.push(i)
  // Never unmount the row holding focus or being renamed (07 D9 "focus never lost"), and keep the list's tab stop
  // rendered so Tab always lands in the list however far it is scrolled.
  for (const keep of [focusUid, renaming, tabUid]) {
    if (!keep || !range) continue
    const i = rows.findIndex((r) => r.key === keep)
    if (i >= 0 && (i < range[0] || i > range[1]) && !visible.includes(i)) visible.push(i)
  }

  return (
    <div ref={scroller} className="slist" style={{ height: total }} aria-labelledby={labelledBy} data-virtual={virtual || undefined} data-rows={rows.length}>
      {visible.map((i) => {
        const r = rows[i]
        const style = { top: offsets[i], height: offsets[i + 1] - offsets[i] }
        if (r.kind === 'header') {
          return (
            <h2 key={r.key} className={`slist__heading${r.first ? ' is-first' : ''}`} style={style}>
              {r.label}
            </h2>
          )
        }
        return (
          <div key={r.key} className="slist__row" style={style}>
            <SessionRow session={r.session} current={r.session.uid === currentUid} tabStop={r.session.uid === tabUid} renaming={renaming === r.session.uid} actions={actions} />
          </div>
        )
      })}
    </div>
  )
}
