/**
 * Timeline scrubber (research 03 §4.4 step 9, 07 D1/D9): the global position in a session of any length — the loaded
 * window is only 3 pages, so the scrollbar can't say where you are in a million messages. Dates come from the
 * `timeline` samples. Dragging previews the date; the window jumps on release or after 150 ms of stillness.
 * Keyboard: a slider (↑/↓ one page, PgUp/PgDn 10 %, Home/End).
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { TimelineSample } from '@shared/types/domain'
import type { Zone } from '@shared/time'
import { formatCount, fractionOf, seqAt, shortDate, timeAtSeq } from './window.logic'

export interface ScrubberProps {
  lastSeq: number
  /** Seq of the row at the top of the viewport. */
  topSeq: number
  pageSize: number
  samples: readonly TimelineSample[]
  zone: Zone
  onSeek(seq: number): void
}

const IDLE_MS = 150
const MIN_THUMB = 28

export function Scrubber({ lastSeq, topSeq, pageSize, samples, zone, onSeek }: ScrubberProps): ReactNode {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [keySeq, setKeySeq] = useState<number | null>(null)
  const idle = useRef<number | null>(null)
  const sought = useRef<number | null>(null)

  const clearIdle = (): void => {
    if (idle.current !== null) window.clearTimeout(idle.current)
    idle.current = null
  }
  useEffect(() => clearIdle, [])
  // A keyboard seek settles once the window arrives there.
  useEffect(() => {
    if (keySeq !== null && Math.abs(topSeq - keySeq) <= pageSize) setKeySeq(null)
  }, [topSeq, keySeq, pageSize])

  const seek = (seq: number): void => {
    if (sought.current === seq) return
    sought.current = seq
    onSeek(seq)
  }
  const seekSoon = (seq: number): void => {
    clearIdle()
    idle.current = window.setTimeout(() => {
      idle.current = null
      seek(seq)
    }, IDLE_MS)
  }

  const fracAt = (clientY: number): number => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return 0
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    sought.current = null
    const f = fracAt(e.clientY)
    setDrag(f)
    seekSoon(seqAt(f, lastSeq))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const f = fracAt(e.clientY)
    if (drag !== null) {
      setDrag(f)
      seekSoon(seqAt(f, lastSeq))
    } else if (e.pointerType === 'mouse') setHover(f)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    clearIdle()
    seek(seqAt(fracAt(e.clientY), lastSeq))
    setDrag(null)
  }

  const current = keySeq ?? (drag !== null ? seqAt(drag, lastSeq) : topSeq)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowUp: -pageSize, ArrowDown: pageSize, PageUp: -Math.ceil(lastSeq / 10), PageDown: Math.ceil(lastSeq / 10) }[e.key]
    let next: number | null = null
    if (step !== undefined) next = current + step
    else if (e.key === 'Home') next = 1
    else if (e.key === 'End') next = lastSeq
    if (next === null) return
    e.preventDefault()
    next = Math.min(lastSeq, Math.max(1, next))
    sought.current = null
    setKeySeq(next)
    seekSoon(next)
  }

  const frac = drag ?? fractionOf(current, lastSeq)
  const date = (seq: number): string => {
    const t = timeAtSeq(samples, seq)
    return t === null ? '' : shortDate(t, zone)
  }
  const valueText = `${date(current) ? `${date(current)}, ` : ''}message ${formatCount(current)} of ${formatCount(lastSeq)}`
  const preview = drag !== null ? seqAt(drag, lastSeq) : hover !== null ? seqAt(hover, lastSeq) : null
  const thumbPct = Math.max(1, Math.min(30, (pageSize * 3 * 100) / Math.max(1, lastSeq)))

  return (
    <div className={`scrubber${drag !== null ? ' is-dragging' : ''}`} data-reveal-skip="">
      <div
        ref={track}
        className="scrubber__track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          clearIdle()
          setDrag(null)
        }}
        onPointerLeave={() => setHover(null)}
      >
        <span className="scrubber__rail" aria-hidden="true" />
        <div
          className="scrubber__thumb"
          role="slider"
          tabIndex={0}
          aria-label="Position in this conversation"
          aria-orientation="vertical"
          aria-valuemin={1}
          aria-valuemax={lastSeq}
          aria-valuenow={current}
          aria-valuetext={valueText}
          onKeyDown={onKeyDown}
          style={{ '--f': frac, '--h': `max(${MIN_THUMB}px, ${thumbPct}%)` } as CSSProperties}
        />
        {preview !== null ? (
          <div className="scrubber__bubble" style={{ top: `${(drag ?? hover ?? 0) * 100}%` }} aria-hidden="true">
            <span className="scrubber__date">{date(preview) || '…'}</span>
            <span className="scrubber__pos">
              {formatCount(preview)} / {formatCount(lastSeq)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
