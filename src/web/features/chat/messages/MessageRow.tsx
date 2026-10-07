/**
 * One row of the conversation (R5/R14/R18, 04 "Messages", 07 D9): user messages right in a bubble, AI replies full
 * width with the static mini Star (the newest mirrors the Star's state through CSS, 07 D5), day separators and
 * time-gap markers, a meta row (relative time, absolute on hover, in the owner's zone) with the actions: copy, edit →
 * branch, regenerate → variant, ‹ n/m ›, speak again, remember this, delete/restore. Articles are focusable for
 * Alt+↑/↓ and carry aria-posinset/aria-setsize (feed semantics).
 */
import { createContext, memo, useContext, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BookmarkPlus, Copy, Ellipsis, Pencil, RotateCcw, Trash2, Undo2, Volume2, Type } from 'lucide-react'
import type { Message } from '@shared/types/domain'
import { formatStamp, relativeAge, type Zone } from '@shared/time'
import { Avatar, type AvatarState } from '../../../components/Avatar'
import { useMessageReplay } from '../../voice'
import { Button } from '../../../components/Button'
import { Checkbox } from '../../../components/Checkbox'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { IconButton } from '../../../components/IconButton'
import { Menu, type MenuItem } from '../../../components/Menu'
import { Skeleton } from '../../../components/Skeleton'
import { TextArea } from '../../../components/TextArea'
import { toast } from '../../../components/Toast'
import { toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { isActiveReply, type ChatRow } from '../../../lib/store/chat.logic'
import { canSpeak, copyMessage, deleteMessage, editMessage, regenerate, rememberText, restoreMessage, speakAgain } from '../actions'
import type { WindowController } from '../window/controller'
import { separatorFor } from '../window/window.logic'
import { useSpeechFor } from '../speech'
import { Attachments, Reasoning, Remembered, ReplyError, StatusLine, ToolLines, VariantSwitcher } from './parts'
import { ReplyBody } from './ReplyBody'

export interface RowContext {
  sessionUid: string
  controller: WindowController
  /** A reply is running in this session (regenerate/edit/variants wait). */
  busy: boolean
  lastSeq: number
  /** The window starts at the beginning of the session (the first row may show its day). */
  knownStart: boolean
  zone: Zone
  zoneName: string | null
  clock: '24h' | '12h'
  now: number
  assistantName: string
  userName: string
  /** Message being edited (uid). */
  editing: string | null
  setEditing(uid: string | null): void
  /** Message to flash (jump target). */
  flash: string | null
  /** Map of finished replies' message uid → reply id (synced reveal after reply.done). */
  replyOf: Record<string, string>
  /** Reasoning of replies finished while this chat was open. */
  reasoningOf: Record<string, string>
}

export const RowCtx = createContext<RowContext | null>(null)

function useRowCtx(): RowContext {
  const c = useContext(RowCtx)
  if (!c) throw new Error('RowCtx missing')
  return c
}

function starToAvatar(s: string): AvatarState {
  if (s === 'speaking') return 'speaking'
  if (s === 'listening' || s === 'transcribing') return 'listening'
  if (s === 'thinking' || s === 'preparing-voice') return 'thinking'
  return 'idle'
}

function Stamp({ m }: { m: Message }): ReactNode {
  const ctx = useRowCtx()
  const abs = formatStamp(m.tsUtc, ctx.zone, ctx.clock)
  return (
    <time className="msg__time" dateTime={new Date(m.tsUtc).toISOString()} title={abs}>
      {relativeAge(m.tsUtc, ctx.now, ctx.zone)}
      <span className="sr-only">, {abs}</span>
    </time>
  )
}

function SeparatorView({ m, prev }: { m: Message; prev: Message | null }): ReactNode {
  const ctx = useRowCtx()
  const sep = separatorFor(m, prev, ctx.now, ctx.zone, ctx.knownStart)
  if (!sep) return null
  return (
    <div className="msg-sep">
      <span className="msg-sep__line" aria-hidden="true" />
      <span className="msg-sep__text">
        {sep.day}
        {sep.day && sep.gap ? ' · ' : null}
        {sep.gap}
      </span>
      <span className="msg-sep__line" aria-hidden="true" />
    </div>
  )
}

/** Alt+↑ / Alt+↓ move between messages (07 D9). */
function onArticleKey(e: KeyboardEvent<HTMLElement>): void {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  const feed = e.currentTarget.closest('[role="feed"]')
  if (!feed) return
  const all = [...feed.querySelectorAll<HTMLElement>('article.msg')]
  const i = all.indexOf(e.currentTarget)
  const next = all[e.key === 'ArrowUp' ? i - 1 : i + 1]
  if (next) {
    e.preventDefault()
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    controllerOf(feed)?.loadOlder()
  }
}

/** The controller is reachable from the feed element for keyboard paging at the window's edge. */
const controllers = new WeakMap<Element, WindowController>()
export function bindFeedController(el: Element | null, c: WindowController): void {
  if (el) controllers.set(el, c)
}
function controllerOf(feed: Element): WindowController | undefined {
  return controllers.get(feed)
}

function DeleteDialog({ m, open, onClose }: { m: Message; open: boolean; onClose: () => void }): ReactNode {
  const [refresh, setRefresh] = useState(false)
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Delete this message?"
      description="It disappears from this chat and from memory. The AI may still see it until the conversation is condensed."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={() => deleteMessage(m, refresh)}
    >
      <Checkbox checked={refresh} onChange={setRefresh} label="Also refresh the AI's context now" description="Starts a condensed context so the AI stops seeing it right away." />
    </ConfirmDialog>
  )
}

function Tombstone({ m }: { m: Message }): ReactNode {
  return (
    <p className="msg__deleted">
      Message deleted ·{' '}
      <button type="button" className="msg__link-btn" onClick={() => void restoreMessage(m.uid).catch((e: unknown) => toast.error(toApiError(e).message))}>
        <Undo2 aria-hidden="true" />
        Restore
      </button>
    </p>
  )
}

function UserEditor({ m }: { m: Message }): ReactNode {
  const ctx = useRowCtx()
  const [text, setText] = useState(m.body)
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    if (!text.trim() || saving) return
    setSaving(true)
    try {
      await editMessage(ctx.sessionUid, m.uid, text, m.attachments.map((a) => a.sha))
      ctx.setEditing(null)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="msg-edit">
      <TextArea
        label="Edit message"
        labelHidden
        value={text}
        minRows={2}
        maxRows={14}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            ctx.setEditing(null)
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <p className="msg-edit__hint">Saving starts a new branch from here; the original stays as version 1.</p>
      <div className="msg-edit__actions">
        <Button size="sm" variant="ghost" onClick={() => ctx.setEditing(null)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!text.trim() || text === m.body || ctx.busy} onClick={() => void save()}>
          Save and send
        </Button>
      </div>
    </div>
  )
}

function MoreMenu({ m, onDelete }: { m: Message; onDelete: () => void }): ReactNode {
  const items: MenuItem[] = [
    { id: 'plain', label: 'Copy as plain text', icon: <Type />, onSelect: () => void copyMessage(m, 'plain') },
    ...(m.role === 'assistant' && canSpeak() ? [{ id: 'speak', label: 'Speak again', icon: <Volume2 />, onSelect: () => void speakAgain(m.uid).catch((e: unknown) => toast.error(toApiError(e).message)) }] : []),
    { id: 'remember', label: 'Remember this', icon: <BookmarkPlus />, onSelect: () => void rememberText(m.body).catch((e: unknown) => toast.error(toApiError(e).message)) },
    { kind: 'separator', id: 'sep' },
    { id: 'delete', label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: onDelete }
  ]
  return <Menu trigger={<IconButton size="sm" label="More actions" icon={<Ellipsis />} />} items={items} placement="bottom-end" aria-label="Message actions" />
}

function UserRow({ row }: { row: ChatRow }): ReactNode {
  const ctx = useRowCtx()
  const m = row.message as Message
  const [del, setDel] = useState(false)
  const editing = ctx.editing === m.uid
  return (
    <article
      className={`msg msg--user${ctx.flash === m.uid ? ' is-flash' : ''}`}
      tabIndex={-1}
      aria-posinset={m.seq}
      aria-setsize={ctx.lastSeq}
      aria-label={`You, ${relativeAge(m.tsUtc, ctx.now, ctx.zone)}`}
      data-seq={m.seq}
      data-uid={m.uid}
      onKeyDown={onArticleKey}
    >
      <SeparatorView m={m} prev={row.prev} />
      <div className="msg__user">
        {m.deleted ? (
          <Tombstone m={m} />
        ) : editing ? (
          <UserEditor m={m} />
        ) : (
          <>
            <Attachments items={m.attachments} align="end" />
            {m.body ? <div className="msg__bubble">{m.body}</div> : null}
            <footer className="msg__meta msg__meta--user">
              <VariantSwitcher message={m} disabled={ctx.busy} />
              <Stamp m={m} />
              <span className="msg__actions">
                <IconButton size="sm" label="Copy" icon={<Copy />} onClick={() => void copyMessage(m)} />
                <IconButton size="sm" label="Edit" icon={<Pencil />} disabled={ctx.busy} onClick={() => ctx.setEditing(m.uid)} />
                <MoreMenu m={m} onDelete={() => setDel(true)} />
              </span>
            </footer>
          </>
        )}
      </div>
      <DeleteDialog m={m} open={del} onClose={() => setDel(false)} />
    </article>
  )
}

function AiRow({ row }: { row: ChatRow }): ReactNode {
  const ctx = useRowCtx()
  const star = useStore((s) => (row.newestAi ? s.presence.star : 'idle'))
  const [del, setDel] = useState(false)
  const m = row.message
  const reply = row.reply
  const active = reply ? isActiveReply(reply) : false
  const text = reply && (reply.text || active) ? reply.text : (m?.body ?? '')
  const ownReplyId = reply?.replyId ?? (m ? (ctx.replyOf[m.uid] ?? null) : null)
  // "Speak again" (R14): once the replay's first chunk is here, the stored reply is revealed again with its audio.
  const replay = useMessageReplay(active ? null : m?.uid)
  const replaying = !!replay.replyId && replay.speech.state !== 'none' && replay.speech.state !== 'failed' && !!replay.speech.heldText
  const replyId = replaying ? replay.replyId : ownReplyId
  // P02: the text is done but this client is still waiting for its voice (the text is held until the audio plays) —
  // say so instead of showing an empty, finished-looking reply; its actions come with the voice.
  const speech = useSpeechFor(replyId)
  const voiceWait = !active && !!replyId && speech.state === 'waiting' && !speech.heldText
  const pending = active || voiceWait
  const error = reply?.error ?? (m?.status === 'error' && !active ? (m.error ?? null) : null)
  const retry = m && !ctx.busy ? () => void regenerate(ctx.sessionUid, m.uid).catch((e: unknown) => toast.error(toApiError(e).message)) : undefined
  const seq = m?.seq
  return (
    <article
      className={`msg msg--ai${m && ctx.flash === m.uid ? ' is-flash' : ''}${row.newestAi ? ' is-newest' : ''}`}
      tabIndex={-1}
      aria-posinset={seq}
      aria-setsize={ctx.lastSeq}
      aria-label={m ? `${ctx.assistantName}, ${relativeAge(m.tsUtc, ctx.now, ctx.zone)}` : ctx.assistantName}
      aria-busy={pending || undefined}
      data-seq={seq}
      data-uid={m?.uid}
      onKeyDown={onArticleKey}
    >
      {m ? <SeparatorView m={m} prev={row.prev} /> : null}
      <div className="msg__ai">
        <Avatar kind="ai" size={26} state={row.newestAi ? starToAvatar(star) : 'idle'} className="msg__avatar" />
        <div className="msg__body">
          {m?.deleted ? (
            <Tombstone m={m} />
          ) : (
            <>
              {reply ? <Reasoning text={reply.reasoning} live={active && !reply.text} /> : m && ctx.reasoningOf[m.uid] ? <Reasoning text={ctx.reasoningOf[m.uid]} live={false} /> : null}
              {reply ? <ToolLines reply={reply} /> : null}
              {reply && active ? <StatusLine reply={reply} hasText={!!text} /> : null}
              {voiceWait ? <VoiceWait /> : null}
              {text || replyId ? <ReplyBody key={replyId ?? ''} replyId={replyId} text={text} streaming={active} interruptedAt={m?.interrupted ? (m.spokenChars ?? null) : null} className="msg__content" /> : null}
              {error ? <ReplyError error={error} onRetry={retry} /> : null}
              {m?.status === 'stopped' && !active ? <p className="msg__note">Stopped</p> : null}
              {m?.truncated && !active ? <p className="msg__note">Cut off at the model’s length limit</p> : null}
              {m && !pending ? (
                <Remembered
                  message={m}
                  controller={ctx.controller}
                  now={ctx.now}
                  zoneName={ctx.zone.name}
                  zoneOffset={ctx.zone.partsAt(ctx.now).offsetMin}
                  assistantName={ctx.assistantName}
                  userName={ctx.userName}
                />
              ) : null}
              {m && !pending ? (
                <footer className="msg__meta">
                  <VariantSwitcher message={m} disabled={ctx.busy} />
                  <Stamp m={m} />
                  {m.model ? <span className="msg__model mono">{m.model}</span> : null}
                  <span className="msg__actions">
                    <IconButton size="sm" label="Copy" icon={<Copy />} onClick={() => void copyMessage(m)} />
                    <IconButton size="sm" label="Regenerate" icon={<RotateCcw />} disabled={ctx.busy} onClick={retry} />
                    <MoreMenu m={m} onDelete={() => setDel(true)} />
                  </span>
                </footer>
              ) : null}
            </>
          )}
        </div>
      </div>
      {m ? <DeleteDialog m={m} open={del} onClose={() => setDel(false)} /> : null}
    </article>
  )
}

/** A finished reply waiting for its first audio (P02): "Preparing voice…" over a shimmer where the text will be. */
function VoiceWait(): ReactNode {
  return (
    <div className="msg__voice-wait" data-testid="voice-wait">
      <p className="msg__status" data-state="preparing-voice">
        <span className="msg__status-dot" aria-hidden="true" />
        <span>Preparing voice…</span>
      </p>
      <Skeleton lines={2} className="msg__voice-shimmer" />
    </div>
  )
}

export const MessageRow = memo(function MessageRow({ row }: { row: ChatRow }): ReactNode {
  return (row.message?.role ?? 'assistant') === 'user' ? <UserRow row={row} /> : <AiRow row={row} />
})
