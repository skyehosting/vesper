/**
 * Constellation overlays and panels: star labels and the hover/selection card (positioned from the scene's projection,
 * imperatively — no React render per frame), the drag-to-link line, the accessible session list (the keyboard and
 * screen-reader way through the map, 07 D9), and the "Link to…" dialog.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link2, Lock, MessageSquare, Pin } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import { formatDate, relativeAge, zoneOf } from '@shared/time'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Checkbox } from '../../../components/Checkbox'
import { Combobox } from '../../../components/Combobox'
import { Dialog } from '../../../components/Dialog'
import { IconButton } from '../../../components/IconButton'
import { titleOf } from './data'
import { getState, onProjected, subscribe, view, type CNode, type ConstellationState } from './model'

export function useConstellation(): ConstellationState {
  return useSyncExternalStore(subscribe, getState)
}

const localZone = zoneOf(Intl.DateTimeFormat().resolvedOptions().timeZone, -new Date().getTimezoneOffset())

export function describeAge(utc: number | null): string {
  return utc ? relativeAge(utc, Date.now(), localZone) : 'never'
}

export function describeDate(utc: number): string {
  return formatDate(localZone.partsAt(utc))
}

export function countLabel(n: number): string {
  return `${n.toLocaleString()} message${n === 1 ? '' : 's'}`
}

// ── labels ─────────────────────────────────────────────────────────────────────────────────────
/** Which stars carry a name: the hovered/selected/drag ones, search hits (≤ 12), else the five most recent. */
function labelled(st: ConstellationState): number[] {
  const set = new Set<number>()
  for (const i of [st.hover, st.selected, st.drag?.from ?? -1, st.drag?.over ?? -1, st.replying]) if (i >= 0) set.add(i)
  if (st.matches) {
    for (let i = 0; i < st.nodes.length && set.size < 14; i++) if (st.matches[i]) set.add(i)
  } else {
    const recent = st.nodes
      .map((n, i) => ({ i, t: n.s.lastMessageUtc ?? n.s.updatedUtc }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5)
    for (const r of recent) set.add(r.i)
  }
  return [...set]
}

export function StarLabels(): ReactNode {
  const st = useConstellation()
  const indices = useMemo(() => labelled(st), [st])
  const refs = useRef(new Map<number, HTMLDivElement>())

  useEffect(() => {
    // Widths are measured once per label set (transforms never change them).
    const widths = new Map<number, number>()
    for (const [i, el] of refs.current) widths.set(i, el.offsetWidth)
    const placed: Array<[number, number, number, number]> = []
    const place = (): void => {
      const p = view.projected
      placed.length = 0
      // In priority order (hover/selection first): a label that would overlap one already placed stays hidden.
      for (const i of indices) {
        const el = refs.current.get(i)
        if (!el) continue
        const o = i * 4
        const z = p[o + 2]
        const x = p[o] + Math.max(6, p[o + 3]) + 6
        const y = p[o + 1] - 9
        const w = widths.get(i) ?? 120
        let ok = z > -1 && z < 1 && x > -40 && y > view.insetTop - 4 && x + w < view.width - view.insetRight - 8 && y < view.height - 24
        if (ok) ok = !placed.some(([px, py, pw]) => x < px + pw + 4 && px < x + w + 4 && Math.abs(py - y) < 18)
        el.style.visibility = ok ? 'visible' : 'hidden'
        if (ok) {
          placed.push([x, y, w, 18])
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        }
      }
    }
    place()
    return onProjected(place)
  }, [indices])

  return (
    <div className="cst-labels" aria-hidden="true">
      {indices.map((i) => {
        const n = st.nodes[i]
        if (!n) return null
        const hot = i === st.hover || i === st.selected || i === st.drag?.over
        return (
          <div
            key={n.s.uid}
            ref={(el) => {
              if (el) refs.current.set(i, el)
              else refs.current.delete(i)
            }}
            className="cst-label"
            data-hot={hot || undefined}
            data-private={n.s.private || undefined}
          >
            {titleOf(n.s.title)}
          </div>
        )
      })}
    </div>
  )
}

// ── drag line ──────────────────────────────────────────────────────────────────────────────────
export function DragLine(): ReactNode {
  const st = useConstellation()
  const line = useRef<SVGLineElement>(null)
  const drag = st.drag
  useEffect(() => {
    if (!drag) return
    const place = (): void => {
      const el = line.current
      if (!el) return
      const p = view.projected
      const d = getState().drag
      if (!d) return
      const o = d.from * 4
      el.setAttribute('x1', String(p[o]))
      el.setAttribute('y1', String(p[o + 1]))
      const to = d.over >= 0 ? d.over * 4 : -1
      el.setAttribute('x2', String(to >= 0 ? p[to] : d.x))
      el.setAttribute('y2', String(to >= 0 ? p[to + 1] : d.y))
    }
    place()
    return onProjected(place)
  }, [drag])
  if (!drag) return null
  const from = st.nodes[drag.from]
  const over = drag.over >= 0 ? st.nodes[drag.over] : null
  return (
    <>
      <svg className="cst-drag" width="100%" height="100%" aria-hidden="true">
        <line ref={line} data-over={over ? '' : undefined} />
      </svg>
      <div className="cst-drag__hint" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }} aria-hidden="true">
        {over && from ? `Let “${titleOf(from.s.title)}” recall “${titleOf(over.s.title)}”` : 'Drop on another star to link'}
      </div>
    </>
  )
}

// ── card ───────────────────────────────────────────────────────────────────────────────────────
export function StarFacts({ node, head = true }: { node: CNode; head?: boolean }): ReactNode {
  const s = node.s
  return (
    <>
      {head ? (
        <div className="cst-card__head">
          <span className="cst-card__title">{titleOf(s.title)}</span>
          <span className="cst-card__id mono">{formatShortId(s.shortId)}</span>
        </div>
      ) : null}
      <dl className="cst-card__facts">
        <div>
          <dt>Started</dt>
          <dd>{describeDate(s.createdUtc)}</dd>
        </div>
        <div>
          <dt>Last active</dt>
          <dd>{describeAge(s.lastMessageUtc ?? s.updatedUtc)}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd className="tabular">{s.messageCount.toLocaleString()}</dd>
        </div>
      </dl>
      {s.summary ? <p className="cst-card__summary">{s.summary}</p> : null}
      <div className="cst-card__badges">
        {s.private ? (
          <Badge size="sm" icon={<Lock />} tone="neutral">
            Private
          </Badge>
        ) : null}
        {s.pinned ? (
          <Badge size="sm" icon={<Pin />} tone="neutral">
            Pinned
          </Badge>
        ) : null}
        {s.links.length ? (
          <Badge size="sm" icon={<Link2 />} tone="accent">
            Recalls {s.links.length}
          </Badge>
        ) : null}
        {s.linkedFrom.length ? (
          <Badge size="sm" tone="neutral">
            Recalled by {s.linkedFrom.length}
          </Badge>
        ) : null}
      </div>
    </>
  )
}

/** The floating card next to the hovered (or selected) star; informational, so the pointer passes through it. */
export function StarCard({ index }: { index: number }): ReactNode {
  const st = useConstellation()
  const ref = useRef<HTMLDivElement>(null)
  const node = index >= 0 ? st.nodes[index] : undefined

  useEffect(() => {
    if (index < 0) return
    const place = (): void => {
      const el = ref.current
      if (!el) return
      const p = view.projected
      const o = index * 4
      const x = p[o]
      const y = p[o + 1]
      const visible = p[o + 2] > -1 && p[o + 2] < 1
      el.style.visibility = visible ? 'visible' : 'hidden'
      const w = el.offsetWidth
      const h = el.offsetHeight
      const r = Math.max(8, p[o + 3]) + 14
      // Prefer the right of the star; flip left / clamp inside the stage.
      const right = view.width - view.insetRight - 12
      let left = x + r
      if (left + w > right) left = x - r - w
      left = Math.max(12, Math.min(right - w, left))
      const top = Math.max(12, Math.min(view.height - h - 12, y - h / 2))
      el.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`
    }
    place()
    return onProjected(place)
  }, [index, node])

  if (!node) return null
  return (
    <div ref={ref} className="cst-card" aria-hidden="true" data-private={node.s.private || undefined}>
      <StarFacts node={node} />
      <div className="cst-card__hint">Click to open · drag onto another star to link</div>
    </div>
  )
}

// ── list ───────────────────────────────────────────────────────────────────────────────────────
export interface SessionListProps {
  onOpen(i: number): void
  onLink(i: number): void
  onFocusStar(i: number): void
}

export function SessionList({ onOpen, onLink, onFocusStar }: SessionListProps): ReactNode {
  const st = useConstellation()
  const rows = useMemo(() => {
    const idx = st.nodes.map((_, i) => i)
    const filtered = st.matches ? idx.filter((i) => st.matches?.[i]) : idx
    return filtered.sort((a, b) => (st.nodes[b].s.lastMessageUtc ?? st.nodes[b].s.updatedUtc) - (st.nodes[a].s.lastMessageUtc ?? st.nodes[a].s.updatedUtc))
  }, [st.nodes, st.matches])

  if (!rows.length) return <p className="cst-list__empty">{st.query ? `No conversations match “${st.query}”.` : 'No conversations yet.'}</p>

  return (
    <ul className="cst-list__rows" aria-label="Conversations in the constellation">
      {rows.map((i) => {
        const s = st.nodes[i].s
        const links = s.links.length + s.linkedFrom.length
        return (
          <li key={s.uid} className="cst-row" data-selected={st.selected === i || undefined} data-private={s.private || undefined}>
            <button
              type="button"
              className="cst-row__main"
              onClick={() => onOpen(i)}
              onFocus={() => onFocusStar(i)}
              onMouseEnter={() => onFocusStar(i)}
              aria-describedby={undefined}
              aria-label={`${titleOf(s.title)}, ${countLabel(s.messageCount)}, last active ${describeAge(s.lastMessageUtc ?? s.updatedUtc)}${s.private ? ', private' : ''}${links ? `, ${links} link${links === 1 ? '' : 's'}` : ''}. Open`}
            >
              <span className="cst-row__dot" aria-hidden="true" style={{ opacity: 0.35 + 0.65 * st.nodes[i].bright }} />
              <span className="cst-row__text">
                <span className="cst-row__title">{titleOf(s.title)}</span>
                <span className="cst-row__meta">
                  <MessageSquare aria-hidden="true" />
                  <span className="tabular">{s.messageCount.toLocaleString()}</span>
                  <span aria-hidden="true">·</span>
                  {describeAge(s.lastMessageUtc ?? s.updatedUtc)}
                  {s.private ? <Lock aria-hidden="true" className="cst-row__lock" /> : null}
                </span>
              </span>
            </button>
            <IconButton
              size="sm"
              label={`Link “${titleOf(s.title)}” to…`}
              icon={<Link2 />}
              className="cst-row__link"
              onClick={() => onLink(i)}
              tooltipSide="left"
            />
          </li>
        )
      })}
    </ul>
  )
}

// ── link dialog ────────────────────────────────────────────────────────────────────────────────
export function LinkDialog({ from, onClose, onLink }: { from: number; onClose(): void; onLink(to: number, bothWays: boolean): Promise<boolean> }): ReactNode {
  const st = useConstellation()
  const source = st.nodes[from]
  const [to, setTo] = useState<string | null>(null)
  const [both, setBoth] = useState(false)
  const [busy, setBusy] = useState(false)
  const options = useMemo(
    () =>
      st.nodes
        .filter((n) => n.s.uid !== source?.s.uid)
        .map((n) => ({
          value: n.s.uid,
          label: titleOf(n.s.title),
          description: `${formatShortId(n.s.shortId)} · ${countLabel(n.s.messageCount)}${source?.s.links.includes(n.s.shortId) ? ' · already linked' : ''}`
        })),
    [st.nodes, source]
  )
  if (!source) return null
  const submit = async (): Promise<void> => {
    const idx = to ? st.byUid.get(to) : undefined
    if (idx === undefined) return
    setBusy(true)
    const ok = await onLink(idx, both)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Link “${titleOf(source.s.title)}”`}
      description="A linked conversation can recall the other one. Links show as lines between stars."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!to} loading={busy} onClick={() => void submit()}>
            Link
          </Button>
        </>
      }
    >
      <div className="cst-linkdlg">
        <Combobox
          label="Conversation it may recall"
          value={to}
          onChange={setTo}
          options={options}
          placeholder="Search conversations…"
          emptyText="No other conversations"
        />
        <Checkbox checked={both} onChange={setBoth} label="Both ways" description="Each conversation can recall the other." />
      </div>
    </Dialog>
  )
}
