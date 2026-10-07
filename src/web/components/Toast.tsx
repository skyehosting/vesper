/**
 * Toast — frozen API (07 E4, BLD-14): ui-kit owns internals and styling, never these exports.
 *
 *   toast.success('Saved')
 *   toast.error('Could not reach the AI service', { action: { label: 'Retry', onClick: retry } })
 *   const id = toast.info('Indexing…', { durationMs: 0 }); toast.dismiss(id)
 *
 * Callable from anywhere (no hook needed). <Toaster /> is mounted once at the app root. Toasts stack (newest at the
 * bottom, at most 4 visible), dismiss themselves after their duration, and pause while hovered or focused.
 * Errors are announced assertively (role=alert), everything else politely (role=status).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import './Toast.css'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  title?: string
  /** ms before it closes; 0 = until dismissed. Default 4 s (errors 7 s). */
  durationMs?: number
  action?: { label: string; onClick: () => void }
  /** Reusing an id replaces that toast (e.g. progress updates) instead of stacking a new one. */
  id?: string
}

export interface ToastItem {
  id: string
  tone: ToastTone
  text: string
  title?: string
  durationMs: number
  action?: ToastOptions['action']
  /** Bumped on replace so the timer restarts. */
  version: number
}

const MAX_VISIBLE = 4
let items: ToastItem[] = []
let counter = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of [...listeners]) l()
}

function show(tone: ToastTone, text: string, opts: ToastOptions = {}): string {
  const id = opts.id ?? `t${++counter}`
  const durationMs = opts.durationMs ?? (tone === 'error' ? 7000 : 4000)
  const existing = items.find((t) => t.id === id)
  const item: ToastItem = { id, tone, text, title: opts.title, durationMs, action: opts.action, version: (existing?.version ?? 0) + 1 }
  items = existing ? items.map((t) => (t.id === id ? item : t)) : [...items, item].slice(-20)
  emit()
  return id
}

function dismiss(id: string): void {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export const toast = {
  show,
  info: (text: string, opts?: ToastOptions) => show('info', text, opts),
  success: (text: string, opts?: ToastOptions) => show('success', text, opts),
  warning: (text: string, opts?: ToastOptions) => show('warning', text, opts),
  error: (text: string, opts?: ToastOptions) => show('error', text, opts),
  dismiss,
  clear: (): void => {
    items = []
    emit()
  },
  /** Current toasts (tests, ui-kit gallery). */
  list: (): readonly ToastItem[] => items
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const getItems = (): ToastItem[] => items

const ICONS: Record<ToastTone, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  error: <CircleAlert />
}

export function Toaster(): ReactNode {
  const all = useSyncExternalStore(subscribe, getItems, getItems)
  const visible = all.slice(-MAX_VISIBLE)
  return createPortal(
    <section className="toast-region" aria-label="Notifications">
      {/* Not <ol>/<li>: a role=status/alert item stops being a listitem, which axe reports as a broken list. */}
      <div className="toast-list">
        {visible.map((t) => (
          <ToastView key={t.id} item={t} />
        ))}
      </div>
    </section>,
    document.body
  )
}

function ToastView({ item }: { item: ToastItem }): ReactNode {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(item.durationMs)
  const startedAt = useRef(0)

  // A replaced toast (same id, new version) gets its full time again.
  useEffect(() => {
    remaining.current = item.durationMs
  }, [item.version, item.durationMs])

  useEffect(() => {
    if (item.durationMs <= 0 || paused) return
    startedAt.current = performance.now()
    const h = window.setTimeout(() => dismiss(item.id), Math.max(0, remaining.current))
    return () => {
      window.clearTimeout(h)
      remaining.current -= performance.now() - startedAt.current
    }
  }, [paused, item.id, item.version, item.durationMs])

  return (
    <div
      className={`toast glass toast--${item.tone}`}
      role={item.tone === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      <span className="toast__icon" aria-hidden="true">
        {ICONS[item.tone]}
      </span>
      <div className="toast__body">
        {item.title ? <div className="toast__title">{item.title}</div> : null}
        <div className="toast__text">{item.text}</div>
      </div>
      {item.action ? (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            item.action?.onClick()
            dismiss(item.id)
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => dismiss(item.id)}>
        <X />
      </button>
    </div>
  )
}
