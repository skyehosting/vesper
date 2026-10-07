/**
 * VirtualList — a generic windowed list for long, variable-height content (chat-ui builds the history window of R5 /
 * 07 D1 on it). Only rows near the viewport are in the DOM; heights are measured with one ResizeObserver; the reader's
 * place is kept by an explicit anchor (research 03 §4.2: native scroll anchoring fails at scrollTop 0), so prepending
 * a page, evicting rows above, or an image loading above the viewport doesn't move what's on screen.
 *
 * - `followOutput`: while the view is at the bottom it stays there as content grows (streaming replies); any upward
 *   intent (wheel, keys, touch drag) releases it.
 * - The row holding focus is never unmounted (07 D9 "focus never lost on eviction").
 * - Imperative handle: scrollToIndex/scrollToKey (align start|center|end|auto), scrollToBottom, getAnchor/restoreAnchor
 *   (persist `{key, offset}` per session), isAtBottom.
 *
 *   const list = useRef<VirtualListHandle>(null)
 *   <VirtualList ref={list} items={rows} getKey={(m) => m.seq} renderItem={(m) => <Message m={m} />} followOutput
 *     initialScroll="bottom" onStartReached={loadOlder} aria-label="Messages" />
 */
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TouchEvent
} from 'react'
import { flushSync } from 'react-dom'
import { cx } from './internal/cx'
import { track } from './internal/stats'
import {
  anchorAt,
  buildOffsets,
  isAtBottom,
  meanSize,
  scrollTopFor,
  scrollTopForIndex,
  visibleRange,
  type Anchor,
  type Key,
  type ScrollAlign
} from './internal/virtualList.logic'
import './VirtualList.css'

export type { Anchor, Key, ScrollAlign } from './internal/virtualList.logic'

export interface ScrollToOptions {
  align?: ScrollAlign
  behavior?: ScrollBehavior
  /** Space kept above/below the row (px). */
  padding?: number
}

export interface VirtualListHandle {
  scrollToIndex(index: number, o?: ScrollToOptions): void
  /** False when no row has this key. */
  scrollToKey(key: Key, o?: ScrollToOptions): boolean
  scrollToBottom(o?: { behavior?: ScrollBehavior }): void
  /** The row at the top of the viewport and its offset — persist it to restore the view later. */
  getAnchor(): Anchor | null
  restoreAnchor(a: Anchor): boolean
  isAtBottom(): boolean
  /** Indices currently rendered. */
  renderedRange(): [number, number] | null
  element(): HTMLDivElement | null
}

export interface VirtualListProps<T> {
  items: readonly T[]
  getKey: (item: T, index: number) => Key
  renderItem: (item: T, index: number) => ReactNode
  /** Height guess for unmeasured rows (px); replaced by the measured mean once a few rows are known. */
  estimateSize?: number
  /** Extra pixels rendered above and below the viewport. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
  followOutput?: boolean
  initialScroll?: 'top' | 'bottom' | Anchor
  /** Distance from the bottom that still counts as "at the bottom" (px). */
  atBottomThreshold?: number
  onAtBottomChange?: (atBottom: boolean) => void
  /**
   * Within `reachThreshold` px of the top — load older rows. Fires once per first item: again only after the list
   * starts with a different row (a page was prepended, or the far end trimmed and the window moved), even when the
   * item count stays the same (a window capped at 3N rows).
   */
  onStartReached?: () => void
  /** The same at the bottom, once per last item. */
  onEndReached?: () => void
  reachThreshold?: number
  /** Rendered index range changed. */
  onRangeChange?: (start: number, end: number) => void
  /** Rows that stay mounted while scrolled away, e.g. the ends of a text selection (07 D1: never evict a selection). */
  keepKeys?: readonly Key[]
  role?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-busy'?: boolean
  'data-testid'?: string
  className?: string
  style?: CSSProperties
  /** Padding inside the scroller around the rows (px). */
  paddingTop?: number
  paddingBottom?: number
  ref?: Ref<VirtualListHandle>
}

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateSize = 80,
  overscan = 800,
  gap = 0,
  followOutput = false,
  initialScroll = 'top',
  atBottomThreshold = 32,
  onAtBottomChange,
  onStartReached,
  onEndReached,
  reachThreshold = 600,
  onRangeChange,
  keepKeys,
  role,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  'aria-busy': ariaBusy,
  'data-testid': testId,
  className,
  style,
  paddingTop = 0,
  paddingBottom = 0,
  ref
}: VirtualListProps<T>): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const sizes = useRef(new Map<Key, number>())
  const [version, setVersion] = useState(0)
  const [, setTick] = useState(0)
  const scrollTop = useRef(0)
  const viewport = useRef(0)
  const anchor = useRef<Anchor | null>(null)
  const atBottom = useRef(initialScroll === 'bottom')
  const focusedKey = useRef<Key | null>(null)
  const lastRange = useRef<[number, number] | null>(null)
  // The first/last key each reach callback last fired for (not the count: a capped window keeps its length).
  const reached = useRef<{ start: Key | undefined; end: Key | undefined }>({ start: undefined, end: undefined })
  const initialized = useRef(false)
  const cb = useRef({ onAtBottomChange, onStartReached, onEndReached, onRangeChange })
  cb.current = { onAtBottomChange, onStartReached, onEndReached, onRangeChange }

  const keys = useMemo(() => items.map((it, i) => getKey(it, i)), [items, getKey])
  const indexOfKey = useMemo(() => {
    const m = new Map<Key, number>()
    keys.forEach((k, i) => m.set(k, i))
    return m
  }, [keys])
  const offsets = useMemo(() => {
    const est = meanSize(sizes.current.values(), estimateSize)
    return buildOffsets(keys.length, (i) => sizes.current.get(keys[i]) ?? est, gap)
    // `version` bumps when a measurement changes.
  }, [keys, estimateSize, gap, version])
  const total = offsets[offsets.length - 1]
  const indexOf = useCallback((k: Key) => indexOfKey.get(k) ?? -1, [indexOfKey])

  // Where the scroller will be once this render's layout effect has restored the anchor. Rendering rows for the old
  // scrollTop after a prepend/trim above would mount the wrong rows for one commit (the rows on screen unmount and
  // remount: focus, selection and reveal roots inside them would be lost) — chat-ui, Phase 3.
  const expectedTop = (): number => {
    if (!initialized.current) return scrollTop.current
    if (followOutputRef.current && atBottom.current) return Math.max(0, offsets[offsets.length - 1] + paddingTop + paddingBottom - (viewport.current || 0))
    const a = anchor.current
    const t = a ? scrollTopFor(offsets, indexOf, a) : null
    return t === null ? scrollTop.current : Math.max(0, t + paddingTop)
  }
  const rangeNow = (): [number, number] | null => visibleRange(offsets, Math.max(0, expectedTop() - paddingTop), viewport.current || 800, overscan)

  // ── measurement: one observer for every rendered row ──────────────────────────────────────────
  const ro = useRef<ResizeObserver | null>(null)
  const observed = useRef(new Map<Element, Key>())
  /** The list's width at the last row measurement (a width change re-wraps every row: see the observer). */
  const listWidth = useRef(0)
  const relayoutFrame = useRef(0)
  const refCache = useRef(new Map<Key, (el: HTMLDivElement | null) => () => void>())
  // Created lazily (row refs attach before this component's effects run, and StrictMode re-attaches them).
  const getRO = (): ResizeObserver => {
    if (ro.current) return ro.current
    ro.current = new ResizeObserver((entries) => {
      let changed = false
      for (const e of entries) {
        const key = observed.current.get(e.target)
        if (key === undefined) continue
        const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight
        if (Math.abs((sizes.current.get(key) ?? -1) - h) > 0.5) {
          sizes.current.set(key, h)
          changed = true
        }
      }
      // A row that grew (streaming, an image) is re-laid out before paint, so rows never overlap for a frame. When the
      // list itself changed width (window resize, phone rotation) every row re-wraps: re-laying out inside this
      // callback would resize rows the observer already reported this frame (a "ResizeObserver loop" error), so that
      // one waits a frame.
      const w = scroller.current?.offsetWidth ?? 0
      const resized = listWidth.current !== 0 && Math.abs(w - listWidth.current) > 0.5
      listWidth.current = w
      if (!changed) return
      if (!resized) flushSync(() => setVersion((v) => v + 1))
      else if (!relayoutFrame.current) {
        track('kit.frames', 1)
        relayoutFrame.current = requestAnimationFrame(() => {
          relayoutFrame.current = 0
          track('kit.frames', -1)
          setVersion((v) => v + 1)
        })
      }
    })
    track('kit.observers', 1)
    return ro.current
  }
  // New rows are measured synchronously after render (below) and handed to the observer on the next frame: observing
  // inside an observer callback's re-render would leave "undelivered notifications" (a ResizeObserver loop error).
  const toObserve = useRef(new Set<Element>())
  const observeFrame = useRef(0)
  const flushObserve = (): void => {
    observeFrame.current = 0
    track('kit.frames', -1)
    for (const el of toObserve.current) if (el.isConnected && observed.current.has(el)) getRO().observe(el)
    toObserve.current.clear()
  }
  /** A stable ref callback per row key (a new function each render would re-observe every row). */
  const refFor = (key: Key): ((el: HTMLDivElement | null) => () => void) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el) => {
        if (el) {
          observed.current.set(el, key)
          toObserve.current.add(el)
          if (!observeFrame.current) {
            observeFrame.current = requestAnimationFrame(flushObserve)
            track('kit.frames', 1)
          }
        }
        return () => {
          refCache.current.delete(key)
          if (!el) return
          observed.current.delete(el)
          toObserve.current.delete(el)
          ro.current?.unobserve(el)
        }
      }
      refCache.current.set(key, fn)
    }
    return fn
  }

  // Measure rows right after each render, before paint (first heights, and rows whose content just changed).
  useLayoutEffect(() => {
    let changed = false
    for (const [el, key] of observed.current) {
      const h = el.getBoundingClientRect().height
      if (Math.abs((sizes.current.get(key) ?? -1) - h) > 0.5) {
        sizes.current.set(key, h)
        changed = true
      }
    }
    if (changed) setVersion((v) => v + 1)
  })

  // Viewport size + teardown of the row observer.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    viewport.current = el.clientHeight
    const vro = new ResizeObserver(() => {
      if (el.clientHeight === viewport.current) return
      viewport.current = el.clientHeight
      if (followOutputRef.current && atBottom.current) el.scrollTop = el.scrollHeight
      setTick((t) => t + 1)
    })
    vro.observe(el)
    track('kit.observers', 1)
    return () => {
      vro.disconnect()
      track('kit.observers', -1)
    }
  }, [])
  useLayoutEffect(
    () => () => {
      if (observeFrame.current) {
        cancelAnimationFrame(observeFrame.current)
        observeFrame.current = 0
        track('kit.frames', -1)
      }
      if (relayoutFrame.current) {
        cancelAnimationFrame(relayoutFrame.current)
        relayoutFrame.current = 0
        track('kit.frames', -1)
      }
      if (!ro.current) return
      ro.current.disconnect()
      ro.current = null
      track('kit.observers', -1)
    },
    []
  )
  const followOutputRef = useRef(followOutput)
  followOutputRef.current = followOutput

  const setAtBottom = (v: boolean): void => {
    if (atBottom.current === v) return
    atBottom.current = v
    cb.current.onAtBottomChange?.(v)
  }

  const checkReach = (): void => {
    const st = scrollTop.current
    const n = keys.length
    if (n === 0) return
    const first = keys[0]
    const last = keys[n - 1]
    if (st <= reachThreshold && reached.current.start !== first) {
      reached.current.start = first
      cb.current.onStartReached?.()
    }
    if (total - (st + viewport.current) <= reachThreshold && reached.current.end !== last) {
      reached.current.end = last
      cb.current.onEndReached?.()
    }
  }

  const syncRange = (): void => {
    const r = rangeNow()
    const prev = lastRange.current
    if (r?.[0] !== prev?.[0] || r?.[1] !== prev?.[1]) setTick((t) => t + 1)
  }

  // ── keep the place after any layout change (items or sizes) ───────────────────────────────────
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (!initialized.current) {
      initialized.current = true
      if (initialScroll === 'bottom') el.scrollTop = el.scrollHeight
      else if (typeof initialScroll === 'object') {
        const t = scrollTopFor(offsets, indexOf, initialScroll)
        if (t !== null) el.scrollTop = t + paddingTop
      }
    } else if (followOutput && atBottom.current) {
      el.scrollTop = el.scrollHeight
    } else if (anchor.current) {
      const t = scrollTopFor(offsets, indexOf, anchor.current)
      if (t !== null && Math.abs(t + paddingTop - el.scrollTop) > 0.5) el.scrollTop = t + paddingTop
    }
    scrollTop.current = el.scrollTop
    if (!anchor.current || indexOf(anchor.current.key) < 0) anchor.current = anchorAt(offsets, keys, Math.max(0, el.scrollTop - paddingTop))
    syncRange()
    checkReach()
  }, [offsets])

  // Forget sizes of rows that left the list (evicted pages), so the map can't grow without bound.
  useLayoutEffect(() => {
    if (sizes.current.size <= keys.length * 2 + 200) return
    const live = new Set(keys)
    for (const k of [...sizes.current.keys()]) if (!live.has(k)) sizes.current.delete(k)
  }, [keys])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    scrollTop.current = el.scrollTop
    anchor.current = anchorAt(offsets, keys, Math.max(0, el.scrollTop - paddingTop))
    setAtBottom(isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight, atBottomThreshold))
    syncRange()
    checkReach()
  }

  // Upward intent releases the bottom pin even within the threshold (research 03 §4.4 step 4).
  const touchY = useRef<number | null>(null)
  const release = (): void => setAtBottom(false)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') release()
  }
  const onTouchStart = (e: TouchEvent<HTMLDivElement>): void => {
    touchY.current = e.touches[0]?.clientY ?? null
  }
  const onTouchMove = (e: TouchEvent<HTMLDivElement>): void => {
    const y = e.touches[0]?.clientY
    if (touchY.current !== null && y !== undefined && y > touchY.current + 4) release()
  }

  const scrollToTop = (t: number, behavior?: ScrollBehavior): void => {
    const el = scroller.current
    if (!el) return
    if (behavior === 'smooth') el.scrollTo({ top: t, behavior })
    else el.scrollTop = t
    scrollTop.current = el.scrollTop
    syncRange()
  }

  useImperativeHandle(
    ref,
    (): VirtualListHandle => ({
      scrollToIndex(index, o = {}) {
        if (keys.length === 0) return
        const i = Math.min(keys.length - 1, Math.max(0, index))
        const align = o.align ?? 'start'
        const t = scrollTopForIndex(offsets, i, viewport.current, align, Math.max(0, scrollTop.current - paddingTop), o.padding ?? 0)
        // The first row at the start means the very top, list padding included.
        const st = i === 0 && align === 'start' ? 0 : t + paddingTop
        // The target becomes the anchor, so rows measured above it later don't push it away.
        anchor.current = { key: keys[i], offset: offsets[i] + paddingTop - st }
        setAtBottom(false)
        scrollToTop(st, o.behavior)
      },
      scrollToKey(key, o) {
        const i = indexOf(key)
        if (i < 0) return false
        this.scrollToIndex(i, o)
        return true
      },
      scrollToBottom(o = {}) {
        setAtBottom(true)
        scrollToTop(scroller.current?.scrollHeight ?? total, o.behavior)
      },
      getAnchor: () => (anchor.current ? { ...anchor.current } : null),
      restoreAnchor(a) {
        const t = scrollTopFor(offsets, indexOf, a)
        if (t === null) return false
        anchor.current = { ...a }
        setAtBottom(false)
        scrollToTop(t + paddingTop)
        return true
      },
      isAtBottom: () => atBottom.current,
      renderedRange: () => lastRange.current,
      element: () => scroller.current
    }),
    [keys, offsets, indexOf, total, paddingTop]
  )

  // ── render ───────────────────────────────────────────────────────────────────────────────────
  const range = rangeNow()
  lastRange.current = range
  const render: number[] = []
  if (range) for (let i = range[0]; i <= range[1]; i++) render.push(i)
  const fi = focusedKey.current !== null ? indexOf(focusedKey.current) : -1
  if (fi >= 0 && range && (fi < range[0] || fi > range[1])) render.push(fi)
  if (keepKeys && range) {
    for (const k of keepKeys) {
      const ki = indexOf(k)
      if (ki >= 0 && (ki < range[0] || ki > range[1]) && !render.includes(ki)) render.push(ki)
    }
  }
  // Kept rows in document order, so the reading order (and Alt+Up/Down between articles) stays sequential.
  render.sort((a, b) => a - b)

  useLayoutEffect(() => {
    if (range) cb.current.onRangeChange?.(range[0], range[1])
  }, [range?.[0], range?.[1]])

  return (
    <div
      ref={scroller}
      className={cx('virtual-list', className)}
      style={style}
      role={role}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-busy={ariaBusy}
      data-testid={testId}
      onScroll={onScroll}
      onWheel={(e) => {
        if (e.deltaY < 0) release()
      }}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onFocus={(e) => {
        const row = (e.target as Element).closest<HTMLElement>('[data-vkey]')
        if (row) focusedKey.current = keys[Number(row.dataset.vindex)] ?? null
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusedKey.current = null
      }}
    >
      <div className="virtual-list__inner" style={{ height: total + paddingTop + paddingBottom }}>
        {render.map((i) => {
          const key = keys[i]
          return (
            <div key={key} ref={refFor(key)} className="virtual-list__row" data-vkey={String(key)} data-vindex={i} style={{ transform: `translateY(${offsets[i] + paddingTop}px)` }}>
              {renderItem(items[i], i)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
