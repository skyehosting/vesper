/**
 * RememberedChip (07 A4) — "Remembered · 3" under an AI reply that used recalled memories (`reply.tool` /
 * `Message.recalled`). It expands in place to the recalled rounds: session (#ID · title), when ("Mon 5 Oct 2026 14:03
 * (UTC−04:00)" · "23 days ago"), who said it, the text, and Jump to / Forget actions. Items may arrive after expanding
 * (`onExpand` → fetch, `items` undefined meanwhile shows skeletons).
 *
 *   <RememberedChip count={msg.recalled} items={recalls} onExpand={load} onJump={(r) => go(r)} onForget={(r) => forget(r)} />
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, CornerDownRight, Sparkles, Trash2 } from 'lucide-react'
import { formatStamp, relativeAge, zoneOf } from '@shared/time'
import { Button } from './Button'
import { Skeleton } from './Skeleton'
import { cx } from './internal/cx'
import './RememberedChip.css'

export interface RecalledItem {
  id: string
  sessionUid: string
  sessionShortId?: string
  sessionTitle: string
  role: 'user' | 'assistant'
  /** Plain text (never rendered as markdown/HTML here). */
  text: string
  tsUtc: number
  tzName?: string | null
  tzOffsetMin?: number
  /** From this same session (no session label needed). */
  sameSession?: boolean
}

export interface RememberedChipProps {
  count: number
  items?: readonly RecalledItem[]
  onExpand?: () => void
  onJump?: (item: RecalledItem) => void
  onForget?: (item: RecalledItem) => void
  /** "now" for relative ages (tests pin it). */
  nowUtc?: number
  /** Viewer's zone for absolute times; defaults to the item's own zone. */
  viewerZone?: { name: string | null; offsetMin: number }
  assistantName?: string
  userName?: string
  defaultOpen?: boolean
  className?: string
}

export function RememberedChip({
  count,
  items,
  onExpand,
  onJump,
  onForget,
  nowUtc,
  viewerZone,
  assistantName = 'Vesper',
  userName = 'You',
  defaultOpen = false,
  className
}: RememberedChipProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const regionId = useId()
  if (count <= 0) return null
  const now = nowUtc ?? Date.now()

  return (
    <div className={cx('remembered', open && 'is-open', className)}>
      <button
        type="button"
        className="remembered__chip"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => {
          if (!open) onExpand?.()
          setOpen(!open)
        }}
      >
        <Sparkles aria-hidden="true" className="remembered__spark" />
        <span>
          Remembered <span className="remembered__count">· {count}</span>
        </span>
        <ChevronDown aria-hidden="true" className="remembered__chev" />
      </button>
      {open ? (
        <div id={regionId} className="remembered__panel" role="region" aria-label={`${count} remembered ${count === 1 ? 'message' : 'messages'}`}>
          {items === undefined ? (
            <div className="remembered__loading" aria-busy="true">
              <Skeleton lines={2} />
              <Skeleton lines={2} />
            </div>
          ) : items.length === 0 ? (
            <p className="remembered__empty">These memories were forgotten or are no longer available.</p>
          ) : (
            <ol className="remembered__list">
              {items.map((it) => {
                const zone = viewerZone ? zoneOf(viewerZone.name, viewerZone.offsetMin) : zoneOf(it.tzName ?? null, it.tzOffsetMin ?? 0)
                return (
                  <li key={it.id} className="remembered__item">
                    <div className="remembered__meta">
                      {!it.sameSession ? (
                        <span className="remembered__session">
                          {it.sessionShortId ? <span className="remembered__id mono">#{it.sessionShortId}</span> : null}
                          <span className="remembered__title">{it.sessionTitle}</span>
                        </span>
                      ) : null}
                      <time dateTime={new Date(it.tsUtc).toISOString()} title={formatStamp(it.tsUtc, zone)}>
                        {relativeAge(it.tsUtc, now, zone)}
                      </time>
                    </div>
                    <p className="remembered__text">
                      <span className="remembered__who">{it.role === 'user' ? userName : assistantName}:</span> {it.text}
                    </p>
                    <p className="remembered__stamp">{formatStamp(it.tsUtc, zone)}</p>
                    {onJump || onForget ? (
                      <div className="remembered__actions">
                        {onJump ? (
                          <Button size="sm" variant="ghost" icon={<CornerDownRight />} onClick={() => onJump(it)}>
                            Jump to
                          </Button>
                        ) : null}
                        {onForget ? (
                          <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => onForget(it)} aria-label={`Forget this memory from ${it.sessionTitle}`}>
                            Forget
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  )
}
