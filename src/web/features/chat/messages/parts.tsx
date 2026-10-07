/**
 * Pieces of a message row: the reply status line (thinking / remembering "…" / preparing voice / speaking), the
 * reasoning disclosure, attachments, the ‹ n/m › variant switcher, the "Remembered" chip with its recalled rounds
 * (07 A4), and reply errors with their actions (07 C19/D13).
 */
import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Paperclip } from 'lucide-react'
import type { AttachmentRef, Message } from '@shared/types/domain'
import type { ApiError, ErrorAction } from '@shared/errors'
import { Dialog } from '../../../components/Dialog'
import { Disclosure } from '../../../components/Disclosure'
import { ErrorState } from '../../../components/ErrorState'
import { IconButton } from '../../../components/IconButton'
import { RememberedChip, type RecalledItem } from '../../../components/RememberedChip'
import { toast } from '../../../components/Toast'
import { useConfirm } from '../../../components/ConfirmDialog'
import { formatBytes } from '../../../components/internal/files.logic'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { navigate } from '../../../lib/router'
import type { InflightView } from '../../../lib/store/chat.logic'
import type { WindowController } from '../window/controller'

// ── status ─────────────────────────────────────────────────────────────────────────────────────

const STATE_LABEL: Partial<Record<InflightView['state'], string>> = {
  queued: 'Waiting',
  thinking: 'Thinking',
  recalling: 'Remembering',
  summarizing: 'Condensing earlier messages',
  recapping: 'Catching up',
  writing: 'Writing',
  'preparing-voice': 'Preparing voice',
  speaking: 'Speaking'
}

/** The reply's current step, from `reply.status` (+ the query of the last memory tool call). */
export function StatusLine({ reply, hasText }: { reply: InflightView; hasText: boolean }): ReactNode {
  const label = STATE_LABEL[reply.state]
  if (!label) return null
  // Once text is flowing, "Writing" is self-evident; voice steps still show.
  if (hasText && (reply.state === 'writing' || reply.state === 'thinking')) return null
  const tool = reply.state === 'recalling' ? reply.tools[reply.tools.length - 1] : undefined
  return (
    <p className="msg__status" data-state={reply.state}>
      <span className="msg__status-dot" aria-hidden="true" />
      <span>
        {label}
        {tool?.query ? (
          <>
            {' '}
            <q className="msg__status-q">{tool.query}</q>
          </>
        ) : null}
        …
      </span>
    </p>
  )
}

/** Memory lookups done during the reply ("Looked through memory for “…” · 3 found"). */
export function ToolLines({ reply }: { reply: InflightView }): ReactNode {
  const done = reply.state === 'recalling' ? reply.tools.slice(0, -1) : reply.tools
  if (done.length === 0) return null
  return (
    <ul className="msg__tools" aria-label="Memory lookups">
      {done.map((t, i) => (
        <li key={i}>
          {t.kind === 'recall' ? 'Recalled' : t.kind === 'sessions' ? 'Looked at past conversations' : 'Looked through memory'}
          {t.query ? (
            <>
              {' for '}
              <q>{t.query}</q>
            </>
          ) : null}
          {` · ${t.count} found`}
        </li>
      ))}
    </ul>
  )
}

export function Reasoning({ text, live }: { text: string; live: boolean }): ReactNode {
  if (!text.trim()) return null
  return (
    <Disclosure className="msg__reasoning" summary={live ? 'Thinking…' : 'Thought process'}>
      <p className="msg__reasoning-text">{text}</p>
    </Disclosure>
  )
}

// ── attachments ────────────────────────────────────────────────────────────────────────────────

const attUrl = (a: AttachmentRef, q = ''): string => `/api/attachments/${encodeURIComponent(a.sha)}${q}`

export function Attachments({ items, align }: { items: readonly AttachmentRef[]; align: 'start' | 'end' }): ReactNode {
  const [open, setOpen] = useState<AttachmentRef | null>(null)
  if (items.length === 0) return null
  return (
    <>
      <ul className={`msg-atts msg-atts--${align}`} aria-label="Attachments">
        {items.map((a) =>
          a.kind === 'image' ? (
            <li key={a.sha}>
              <button type="button" className="msg-att msg-att--image" onClick={() => setOpen(a)} aria-label={`Open image ${a.name}`}>
                <img src={attUrl(a, '?thumb=1')} alt="" loading="lazy" decoding="async" width={a.width && a.height ? Math.round((96 * a.width) / a.height) : undefined} height={96} />
              </button>
            </li>
          ) : (
            <li key={a.sha}>
              <a className="msg-att msg-att--file" href={attUrl(a, '?download=1')} download={a.name} title={a.name}>
                <span className="msg-att__icon" aria-hidden="true">
                  {a.kind === 'pdf' || a.kind === 'docx' || a.kind === 'text' ? <FileText /> : <Paperclip />}
                </span>
                <span className="msg-att__text">
                  <span className="msg-att__name">{a.name}</span>
                  <span className="msg-att__meta">
                    {a.kind === 'other' ? 'File' : a.kind.toUpperCase()} · {formatBytes(a.size)}
                    {a.textState === 'failed' ? ' · text not readable' : a.textState === 'truncated' ? ' · text shortened' : ''}
                  </span>
                </span>
              </a>
            </li>
          )
        )}
      </ul>
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? ''} size="lg">
        {open ? (
          <figure className="msg-lightbox">
            <img src={attUrl(open)} alt={open.name} />
            <figcaption>
              <ImageIcon aria-hidden="true" />
              {open.width && open.height ? `${open.width} × ${open.height} · ` : ''}
              {formatBytes(open.size)} ·{' '}
              <a href={attUrl(open, '?download=1')} download={open.name}>
                Download
              </a>
            </figcaption>
          </figure>
        ) : null}
      </Dialog>
    </>
  )
}

// ── variants ‹ n/m › (07 C3, G7: 1-based) ────────────────────────────────────────────────────────

export function VariantSwitcher({ message, disabled }: { message: Message; disabled: boolean }): ReactNode {
  const [busy, setBusy] = useState(false)
  const v = message.variant
  if (!v || v.count < 2) return null
  const go = async (delta: number): Promise<void> => {
    setBusy(true)
    try {
      const list = await api('GET /api/sessions/:uid/variants/:seq', { params: { uid: message.sessionUid, seq: message.seq } })
      const target = list.find((x) => x.index === v.index + delta)
      if (target) await api('POST /api/sessions/:uid/variants/:seq', { params: { uid: message.sessionUid, seq: message.seq }, body: { branchId: target.branchId } })
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }
  const what = message.role === 'user' ? 'version of your message' : 'reply'
  return (
    <span className="msg-variants" role="group" aria-label={`${message.role === 'user' ? 'Version' : 'Reply'} ${v.index} of ${v.count}`}>
      <IconButton size="sm" label={`Previous ${what}`} icon={<ChevronLeft />} disabled={disabled || busy || v.index <= 1} onClick={() => void go(-1)} />
      <span className="msg-variants__n" aria-hidden="true">
        {v.index} / {v.count}
      </span>
      <IconButton size="sm" label={`Next ${what}`} icon={<ChevronRight />} disabled={disabled || busy || v.index >= v.count} onClick={() => void go(1)} />
    </span>
  )
}

// ── "Remembered" chip (07 A4) ──────────────────────────────────────────────────────────────────

export function Remembered({ message, controller, now, zoneName, zoneOffset, assistantName, userName }: {
  message: Message
  controller: WindowController
  now: number
  zoneName: string | null
  zoneOffset: number
  assistantName: string
  userName: string
}): ReactNode {
  const [items, setItems] = useState<RecalledItem[] | undefined>(undefined)
  const [count, setCount] = useState<number | null>(null)
  const { confirm, dialog } = useConfirm()
  const n = count ?? message.recalled ?? 0
  if (n <= 0 && items === undefined) return null
  const load = (): void => {
    if (items !== undefined) return
    api('GET /api/messages/:uid/recalled', { params: { uid: message.uid } })
      .then((hits) =>
        setItems(
          hits.map((h) => ({
            id: h.messageUid,
            sessionUid: h.sessionUid,
            sessionShortId: h.shortId,
            sessionTitle: h.sessionTitle || 'Untitled chat',
            role: h.tag === 'user response' ? 'user' : 'assistant',
            text: h.body.length > 600 ? `${h.body.slice(0, 600)}…` : h.body,
            tsUtc: h.tsUtc,
            tzName: h.tzName,
            tzOffsetMin: h.tzOffsetMin,
            sameSession: h.sessionUid === message.sessionUid
          }))
        )
      )
      .catch((e: unknown) => {
        setItems([])
        toast.error(toApiError(e).message)
      })
  }
  const jump = (it: RecalledItem): void => {
    if (it.sessionUid === controller.uid) void controller.jumpToMessage(it.id).catch((e: unknown) => toast.error(toApiError(e).message))
    else navigate(`/s/${it.sessionUid}?m=${encodeURIComponent(it.id)}`)
  }
  const forget = async (it: RecalledItem): Promise<void> => {
    const ok = await confirm({
      title: 'Forget this memory?',
      description: `The original message in “${it.sessionTitle}” is deleted and Vesper won't recall it again. You can restore it from that chat for 30 days.`,
      confirmLabel: 'Forget',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await api('DELETE /api/memory/messages/:uid', { params: { uid: it.id } })
      setItems((cur) => cur?.filter((x) => x.id !== it.id))
      setCount((c) => Math.max(0, (c ?? n) - 1))
      toast.success('Forgotten.')
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }
  return (
    <>
      <RememberedChip
        className="msg__remembered"
        count={Math.max(n, items?.length ?? 0)}
        items={items}
        onExpand={load}
        onJump={jump}
        onForget={(it) => void forget(it)}
        nowUtc={now}
        viewerZone={{ name: zoneName, offsetMin: zoneOffset }}
        assistantName={assistantName}
        userName={userName || 'You'}
      />
      {dialog}
    </>
  )
}

// ── errors (07 C19 / D13) ──────────────────────────────────────────────────────────────────────

export function ReplyError({ error, onRetry }: { error: ApiError | { code: string; message: string }; onRetry?: () => void }): ReactNode {
  const onAction = (a: ErrorAction): void => {
    if (a.kind === 'settings') navigate(`/settings/${a.section}`)
    else if (a.kind === 'retry') onRetry?.()
    else if (a.kind === 'login') navigate('/login')
  }
  return <ErrorState className="msg__error" compact error={error as ApiError} onRetry={onRetry} onAction={onAction} />
}
