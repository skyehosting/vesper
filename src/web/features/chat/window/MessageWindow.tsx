/**
 * MessageWindow — the unlimited history view (R5, 07 D1, research 03 §4.4) on the kit's VirtualList:
 *   - a contiguous window of ≤ 3N messages (N = chat.pageSize); older/newer pages load near the edges (one request
 *     per direction) and the far end unloads — never rows on screen, focused, selected, or while the pointer is down;
 *   - VirtualList keeps the reader's place across prepends, evictions and async height changes (anchor by key), and
 *     follows the bottom while pinned at the live edge (streaming, reveal);
 *   - "Jump to latest" with the count of new messages, the timeline scrubber, flash-highlighted jump targets;
 *   - per-device view state saved on scroll idle (150 ms) and when leaving; Alt+↑/↓ between messages (07 D9).
 * The live reply survives eviction: its text lives in the store (inflight), not in the row.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, RotateCcw } from 'lucide-react'
import type { TimelineSample } from '@shared/types/domain'
import { Avatar } from '../../../components/Avatar'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { VirtualList, type Key, type VirtualListHandle } from '../../../components/VirtualList'
import { api } from '../../../lib/api'
import { useStore } from '../../../lib/store'
import { chatRows, isActiveReply, lastMessageOf, type ChatRow, type ChatView } from '../../../lib/store/chat.logic'
import { registerTestHooks } from '../../../lib/testHooks'
import { onChat } from '../bus'
import { bindFeedController, MessageRow, RowCtx, type RowContext } from '../messages/MessageRow'
import { useClock, useNow, useViewerZone } from '../time'
import type { WindowController, WindowTarget } from './controller'
import { Scrubber } from './Scrubber'
import { saveViewState } from './viewState'
import { trimCount, windowCap } from './window.logic'
import { formatStamp } from '@shared/time'

type StartRow = { key: 'start'; start: true }
type Item = ChatRow | StartRow

const isStart = (it: Item): it is StartRow => 'start' in it
/** The list's end counts as reached within this many pixels (VirtualList's own at-bottom threshold). */
const BOTTOM_SLACK_PX = 32
const getKey = (it: Item): Key => it.key

export interface MessageWindowProps {
  view: ChatView
  controller: WindowController
  sessionTitle: string
  createdUtc: number | null
  /** Rendered between the list and the composer edge (empty-session hints etc.). */
  children?: ReactNode
}

export function MessageWindow({ view, controller, sessionTitle, createdUtc }: MessageWindowProps): ReactNode {
  const uid = controller.uid
  const pageSize = controller.pageSize
  const list = useRef<VirtualListHandle>(null)
  const zone = useViewerZone()
  const clock = useClock()
  const now = useNow()
  const assistantName = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const userName = useStore((s) => s.settings?.profile.userName || '')
  const [editing, setEditing] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [keep, setKeep] = useState<Key[]>([])
  const [topSeq, setTopSeq] = useState(view.hiSeq)
  const [samples, setSamples] = useState<TimelineSample[]>([])
  const load = useSyncLoadState(controller)

  const rows = useMemo(() => chatRows(view), [view])
  const items = useMemo<Item[]>(() => (!view.hasBefore && rows.length > 0 ? [{ key: 'start', start: true }, ...rows] : rows), [rows, view.hasBefore])
  const busy = useMemo(() => Object.values(view.inflight).some(isActiveReply), [view.inflight])

  // Latest values for callbacks registered once.
  const live = useRef({ view, items, atBottom })
  live.current = { view, items, atBottom }

  // ── place: anchor ↔ seq ────────────────────────────────────────────────────────────────────
  const seqOfKey = useCallback((k: Key): number | null => {
    const it = live.current.items.find((x) => x.key === k)
    if (!it || isStart(it)) return it ? (live.current.view.messages[0]?.seq ?? null) : null
    return it.message?.seq ?? live.current.view.hiSeq
  }, [])
  const keyOfSeq = useCallback((seq: number): Key | null => {
    let best: ChatRow | null = null
    for (const it of live.current.items) {
      if (isStart(it) || !it.message) continue
      if (it.message.seq >= seq) return it.key
      best = it
    }
    return best?.key ?? null
  }, [])

  const viewAnchor = useCallback(() => {
    const a = list.current?.getAnchor()
    const seq = a ? seqOfKey(a.key) : null
    if (!a || seq === null) return null
    return { seq, offset: a.offset, pinned: live.current.atBottom && !live.current.view.hasAfter }
  }, [seqOfKey])

  // ── positioning after replaces / in-window jumps ────────────────────────────────────────────
  const flashTimer = useRef<number | null>(null)
  /**
   * A jump to a message unpins the list from the bottom; when the conversation's end is in view anyway (a short chat,
   * or the newest message is the target) nothing scrolls, so no scroll event would ever pin it again and "Jump to
   * latest" stayed on screen (P21). Re-pin once the jump has laid out.
   */
  const pinIfAtEnd = useCallback((h: VirtualListHandle): void => {
    requestAnimationFrame(() => {
      const el = h.element()
      if (!el || live.current.view.hasAfter || h.isAtBottom()) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX) h.scrollToBottom()
    })
  }, [])
  const apply = useCallback(
    (t: WindowTarget): boolean => {
      const h = list.current
      if (!h) return false
      if (t.kind === 'bottom') {
        h.scrollToBottom()
        setAtBottom(true)
        return true
      }
      const key = keyOfSeq(t.seq)
      if (key === null) return false
      if (t.kind === 'anchor') {
        const ok = h.restoreAnchor({ key, offset: t.offset })
        if (ok) pinIfAtEnd(h)
        return ok
      }
      h.scrollToKey(key, { align: t.align ?? 'center', padding: t.align === 'start' ? 8 : 0 })
      pinIfAtEnd(h)
      if (t.flash) {
        setFlash(String(key))
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => {
          flashTimer.current = null
          setFlash(null)
        }, 1800)
      }
      // Focus the target for keyboard and screen-reader users once it is rendered (not when the jump came from the
      // search box, which keeps focus for Enter / Shift+Enter).
      if (t.focus) {
        requestAnimationFrame(() => h.element()?.querySelector<HTMLElement>(`article[data-uid="${CSS.escape(String(key))}"]`)?.focus({ preventScroll: true }))
      }
      return true
    },
    [keyOfSeq, pinIfAtEnd]
  )
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    },
    []
  )

  useLayoutEffect(() => {
    const t = controller.target
    if (!t) return
    controller.target = null
    if (!apply(t) && t.kind !== 'bottom') apply({ kind: 'bottom' })
  }, [view.gen, controller, apply])

  // ── trimming the far end (step 2/3) ────────────────────────────────────────────────────────
  const pointerDown = useRef(false)
  const pendingTrim = useRef<'top' | 'bottom' | null>(null)
  const keepRef = useRef<Key[]>([])
  keepRef.current = keep

  const maybeTrim = useCallback(
    (side: 'top' | 'bottom') => {
      const v = useStore.getState().chats[uid]
      const h = list.current
      if (!v || !h) return
      const cap = windowCap(pageSize)
      if (v.messages.length <= cap) {
        pendingTrim.current = null
        return
      }
      if (pointerDown.current) {
        pendingTrim.current = side
        return
      }
      const its = live.current.items
      const protectedSeqs: number[] = []
      const r = h.renderedRange()
      if (r) for (let i = r[0]; i <= r[1]; i++) addSeq(its[i], protectedSeqs)
      for (const k of keepRef.current) addSeq(its.find((x) => x.key === k), protectedSeqs)
      const focusRow = (document.activeElement as HTMLElement | null)?.closest?.('[data-vkey]') as HTMLElement | null
      if (focusRow && h.element()?.contains(focusRow)) addSeq(its[Number(focusRow.dataset.vindex)], protectedSeqs)
      // The live reply's row stays: its reveal root is bound to it.
      for (const rep of Object.values(v.inflight)) {
        const m = rep.messageUid ? v.messages.find((x) => x.uid === rep.messageUid) : undefined
        if (m) protectedSeqs.push(m.seq)
      }
      const lo = protectedSeqs.length ? Math.min(...protectedSeqs) : null
      const hi = protectedSeqs.length ? Math.max(...protectedSeqs) : null
      const n = trimCount(
        v.messages.map((m) => m.seq),
        cap,
        side,
        lo,
        hi
      )
      if (n > 0) useStore.getState().chatTrim(uid, side, n)
      pendingTrim.current = v.messages.length - n > cap ? side : null
    },
    [uid, pageSize]
  )

  // Live replies grow the window at the bottom (no page load, so no onExtended): trim the top back to 3N, or a chat
  // left open at the live edge keeps every message it ever received (07 D1; found by the text-replies soak).
  const edge = useRef({ lo: view.loSeq, hi: view.hiSeq })
  useEffect(() => {
    const prev = edge.current
    edge.current = { lo: view.loSeq, hi: view.hiSeq }
    if (!(view.hiSeq > prev.hi && view.loSeq === prev.lo) || view.messages.length <= windowCap(pageSize)) return
    const h = requestAnimationFrame(() => maybeTrim('top'))
    return () => cancelAnimationFrame(h)
  }, [view.loSeq, view.hiSeq, view.messages.length, pageSize, maybeTrim])

  useEffect(() => {
    controller.viewAnchor = viewAnchor
    controller.positioner = apply
    controller.onExtended = (side) => requestAnimationFrame(() => maybeTrim(side === 'top' ? 'bottom' : 'top'))
    return () => {
      controller.viewAnchor = null
      controller.positioner = null
      controller.onExtended = null
    }
  }, [controller, viewAnchor, apply, maybeTrim])

  // ── edges ──────────────────────────────────────────────────────────────────────────────────
  // Measured in pixels on the live scroller (research 03 §4.4: within ~1.5 viewports of an end). The rendered index
  // range alone is not enough: right after a trim it is computed before the anchor compensation lands.
  const checkEdges = useCallback(() => {
    const el = list.current?.element()
    const { view: v } = live.current
    if (!el || v.status !== 'ready') return
    const margin = el.clientHeight * 1.5
    if (v.hasBefore && el.scrollTop < margin) controller.loadOlder()
    if (v.hasAfter && el.scrollHeight - el.scrollTop - el.clientHeight < margin) controller.loadNewer()
  }, [controller])
  const onRange = useCallback(() => checkEdges(), [checkEdges])
  // A load that finished without moving the range (a short window) re-checks the edges.
  useEffect(() => {
    if (!load.up && !load.down && !load.replace) checkEdges()
  }, [view.loSeq, view.hiSeq, load.up, load.down, load.replace, checkEdges])

  // ── scroll tracking: scrubber position, view-state save, deferred trims ──────────────────────
  useEffect(() => {
    const el = list.current?.element()
    if (!el) return
    bindFeedController(el, controller)
    let raf = 0
    let idle = 0
    // The last known place: refs are already detached when this effect is cleaned up on unmount.
    let place = viewAnchor()
    const save = (): void => {
      if (place) saveViewState(uid, { anchorSeq: place.seq, offsetPx: place.offset, pinned: place.pinned })
    }
    const onScroll = (): void => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          place = viewAnchor() ?? place
          if (place) setTopSeq(place.seq)
          checkEdges()
        })
      if (idle) window.clearTimeout(idle)
      idle = window.setTimeout(() => {
        idle = 0
        save()
        if (pendingTrim.current) maybeTrim(pendingTrim.current)
      }, 150)
    }
    const down = (): void => {
      pointerDown.current = true
    }
    const up = (): void => {
      if (!pointerDown.current) return
      pointerDown.current = false
      if (pendingTrim.current) maybeTrim(pendingTrim.current)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      save()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (raf) cancelAnimationFrame(raf)
      if (idle) window.clearTimeout(idle)
    }
  }, [controller, uid, viewAnchor, maybeTrim, checkEdges])

  // Keep the rows holding a text selection mounted (07 D1).
  useEffect(() => {
    const onSel = (): void => {
      const el = list.current?.element()
      const sel = document.getSelection()
      const next: Key[] = []
      if (el && sel && !sel.isCollapsed) {
        for (const n of [sel.anchorNode, sel.focusNode]) {
          const row = (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>('[data-vkey]')
          const k = row && el.contains(row) ? live.current.items[Number(row.dataset.vindex)]?.key : undefined
          if (k !== undefined && !next.includes(k)) next.push(k)
        }
      }
      setKeep((cur) => (cur.length === next.length && cur.every((k, i) => k === next[i]) ? cur : next))
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // /edit-last and ↑ in an empty composer: edit the newest user message, brought into view.
  useEffect(
    () =>
      onChat('edit-last', (e) => {
        if (e.sessionUid !== uid) return
        const m = lastMessageOf(live.current.view, 'user')
        if (!m) return
        setEditing(m.uid)
        apply({ kind: 'seq', seq: m.seq, flash: false })
      }),
    [uid, apply]
  )

  // ── "Jump to latest" + unread ──────────────────────────────────────────────────────────────
  const leftAt = useRef<number | null>(null)
  const pinnedToEdge = atBottom && !view.hasAfter
  if (pinnedToEdge) leftAt.current = null
  else if (leftAt.current === null) leftAt.current = view.lastSeq
  const unread = leftAt.current === null ? 0 : Math.max(0, view.lastSeq - leftAt.current)

  // ── scrubber samples ───────────────────────────────────────────────────────────────────────
  const showScrubber = view.lastSeq > pageSize
  const sampledAt = useRef(0)
  useEffect(() => {
    if (!showScrubber) return
    if (sampledAt.current && view.lastSeq - sampledAt.current < Math.max(50, sampledAt.current * 0.02)) return
    sampledAt.current = view.lastSeq
    const ctrl = new AbortController()
    api('GET /api/sessions/:uid/timeline', { params: { uid }, query: { samples: 32 }, signal: ctrl.signal })
      .then(setSamples)
      .catch(() => undefined)
    return () => ctrl.abort()
  }, [uid, showScrubber, view.lastSeq])

  // ── test hooks (07 D1 gates) ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!__VESPER_TEST__) return
    return registerTestHooks('chat', {
      window: () => {
        const v = useStore.getState().chats[uid]
        const el = list.current?.element()
        return {
          uid,
          rows: v?.messages.length ?? 0,
          loSeq: v?.loSeq ?? 0,
          hiSeq: v?.hiSeq ?? 0,
          lastSeq: v?.lastSeq ?? 0,
          hasBefore: v?.hasBefore ?? false,
          hasAfter: v?.hasAfter ?? false,
          domMessages: el?.querySelectorAll('article.msg').length ?? 0,
          rendered: list.current?.renderedRange() ?? null,
          atBottom: live.current.atBottom,
          anchor: viewAnchor(),
          loading: controller.getState()
        }
      },
      scrollBy: (dy: number) => list.current?.element()?.scrollBy(0, dy),
      scrollToTop: () => {
        const el = list.current?.element()
        if (el) el.scrollTop = 0
      },
      scrollToBottom: () => list.current?.scrollToBottom(),
      jumpToSeq: (seq: number) => controller.jumpToSeq(seq, true),
      pageSize: () => controller.pageSize
    })
  }, [uid, controller, viewAnchor])

  const ctx = useMemo<RowContext>(
    () => ({
      sessionUid: uid,
      controller,
      busy,
      lastSeq: view.lastSeq,
      knownStart: !view.hasBefore,
      zone,
      zoneName: zone.name,
      clock,
      now,
      assistantName,
      userName,
      editing,
      setEditing,
      flash,
      replyOf: view.replyOf,
      reasoningOf: view.reasoningOf
    }),
    [uid, controller, busy, view.lastSeq, view.hasBefore, zone, clock, now, assistantName, userName, editing, flash, view.replyOf, view.reasoningOf]
  )

  const renderItem = useCallback(
    (it: Item) =>
      isStart(it) ? (
        <div className="chat-start">
          <Avatar kind="ai" size={36} />
          <p className="chat-start__title">The beginning of “{sessionTitle}”</p>
          {createdUtc ? <p className="chat-start__date">{formatStamp(createdUtc, zone, clock)}</p> : null}
        </div>
      ) : (
        <MessageRow row={it} />
      ),
    [sessionTitle, createdUtc, zone, clock]
  )

  return (
    <RowCtx.Provider value={ctx}>
      <div className={showScrubber ? 'mw has-scrubber' : 'mw'}>
        <VirtualList<Item>
          ref={list}
          className="mw__list"
          items={items}
          getKey={getKey}
          renderItem={renderItem}
          estimateSize={140}
          overscan={900}
          followOutput={!view.hasAfter}
          initialScroll={controller.target && controller.target.kind !== 'bottom' ? 'top' : 'bottom'}
          onAtBottomChange={setAtBottom}
          onRangeChange={onRange}
          keepKeys={keep}
          role="feed"
          aria-label="Messages"
          aria-busy={load.replace || load.up || load.down}
          paddingTop={12}
          paddingBottom={20}
          data-testid="message-window"
        />
        {load.up || load.upError ? (
          <div className="mw__edge mw__edge--top" role={load.upError ? 'alert' : 'status'}>
            {load.upError ? (
              <>
                <span>Couldn't load earlier messages.</span>
                <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => controller.loadOlder()}>
                  Retry
                </Button>
              </>
            ) : (
              <>
                <Spinner size={14} />
                <span>Loading earlier messages…</span>
              </>
            )}
          </div>
        ) : null}
        {load.down || load.downError ? (
          <div className="mw__edge mw__edge--bottom" role={load.downError ? 'alert' : 'status'}>
            {load.downError ? (
              <>
                <span>Couldn't load newer messages.</span>
                <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => controller.loadNewer()}>
                  Retry
                </Button>
              </>
            ) : (
              <>
                <Spinner size={14} />
                <span>Loading newer messages…</span>
              </>
            )}
          </div>
        ) : null}
        {!pinnedToEdge && items.length > 0 ? (
          <button type="button" className="mw__jump" onClick={() => void controller.jumpLatest()} data-testid="jump-latest">
            <ArrowDown aria-hidden="true" />
            <span>Jump to latest</span>
            {unread > 0 ? <span className="mw__unread">{unread > 99 ? '99+' : unread} new</span> : null}
          </button>
        ) : null}
        {showScrubber ? <Scrubber lastSeq={view.lastSeq} topSeq={topSeq} pageSize={pageSize} samples={samples} zone={zone} onSeek={(seq) => void controller.jumpToSeq(seq, false, 'start')} /> : null}
      </div>
    </RowCtx.Provider>
  )
}

function addSeq(it: Item | undefined, out: number[]): void {
  if (it && !isStart(it) && it.message) out.push(it.message.seq)
}

function useSyncLoadState(c: WindowController) {
  const [s, setS] = useState(c.getState())
  useEffect(() => {
    setS(c.getState())
    return c.subscribe(() => setS(c.getState()))
  }, [c])
  return s
}
