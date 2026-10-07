/**
 * One remembered message in the memory viewer (R7): the tag exactly as stored ("user response" / "ai response"), the
 * machine timestamp in the one display format (07 C2: "Mon 5 Oct 2026 14:03 (UTC−04:00)", in the zone it was written)
 * with "N days ago", the chat it belongs to (#ID · title), the text (plain, never rendered as HTML), and actions:
 * copy, open in its chat, forget (07 B9 wording).
 */
import { memo, useState, type ReactNode } from 'react'
import { ArrowUpRight, Lock, Trash2 } from 'lucide-react'
import { formatStamp, relativeAge, zoneOf, type Clock, type Zone } from '@shared/time'
import { formatShortId } from '@shared/ids'
import { Badge } from '../../components/Badge'
import { CopyButton } from '../../components/CopyButton'
import { IconButton } from '../../components/IconButton'
import { navigate } from '../../lib/router'
import { previewText, snippetParts, type ViewerItem } from './timeline.logic'
import { cx } from './cx'

/** Where "Open in chat" goes: the chat, asked to bring this message into view (chat-ui reads `?m=`). */
export function messageHref(sessionUid: string, messageUid: string): string {
  return `/s/${encodeURIComponent(sessionUid)}?m=${encodeURIComponent(messageUid)}`
}

const CLAMP_CHARS = 420

export const MemoryEntry = memo(function MemoryEntry({
  item,
  nowUtc,
  viewerZone,
  clock,
  onForget,
  assistantName
}: {
  item: ViewerItem
  nowUtc: number
  viewerZone: Zone
  clock: Clock
  onForget: (item: ViewerItem) => void
  assistantName: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const m = item.message
  const own = zoneOf(m.tzName, m.tzOffsetMin)
  const stamp = formatStamp(m.tsUtc, own, clock)
  const ago = relativeAge(m.tsUtc, nowUtc, viewerZone)
  const user = m.role === 'user'
  const preview = previewText(m.body, undefined, m.role)
  const long = preview.text.length > CLAMP_CHARS || preview.text.split('\n').length > 6
  const who = user ? 'You' : assistantName
  const label = `${m.tag}, ${who}, ${stamp}, chat ${formatShortId(item.session.shortId)}`
  return (
    <article className={cx('ment', user ? 'ment--user' : 'ment--ai')} aria-label={label} data-testid="memory-entry" data-uid={m.uid}>
      <div className="ment__head">
        <span className={cx('ment__tag', user ? 'ment__tag--user' : 'ment__tag--ai')}>{m.tag}</span>
        <time
          className="ment__time tabular"
          dateTime={new Date(m.tsUtc).toISOString()}
          title={`${who} · ${m.device ? `from ${m.device}` : ''}`.replace(/ · $/, '')}
        >
          {stamp}
        </time>
        <span className="ment__ago">{ago}</span>
        {item.onPath === false ? <Badge tone="neutral">earlier version</Badge> : null}
      </div>
      {item.snippet ? (
        <p className="ment__body ment__body--snippet">
          {snippetParts(item.snippet).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </p>
      ) : (
        <p className={cx('ment__body', long && !open && 'is-clamped')}>{preview.text || <em className="ment__empty">(no text — attachments only)</em>}</p>
      )}
      <div className="ment__foot">
        <button
          type="button"
          className="ment__chat"
          onClick={() => navigate(`/s/${encodeURIComponent(item.session.uid)}`)}
          title={item.session.title || 'New chat'}
        >
          <span className="ment__id mono">{formatShortId(item.session.shortId)}</span>
          <span className="ment__chat-title">{item.session.title || 'New chat'}</span>
        </button>
        {item.session.private ? (
          <Badge tone="neutral" icon={<Lock />}>
            Private
          </Badge>
        ) : null}
        {m.attachments.length ? <Badge tone="neutral">{`${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}`}</Badge> : null}
        {!item.snippet && long ? (
          <button type="button" className="ment__more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
        {m.status === 'stopped' ? <Badge tone="warning">stopped early</Badge> : null}
        <span className="ment__actions">
          <CopyButton text={m.body} label="Copy message" size="sm" />
          <IconButton size="sm" label="Open in its chat" icon={<ArrowUpRight />} onClick={() => navigate(messageHref(m.sessionUid, m.uid))} />
          <IconButton size="sm" label="Forget this message" icon={<Trash2 />} onClick={() => onForget(item)} />
        </span>
      </div>
    </article>
  )
})
