/**
 * <Transcript> — frozen signature (07 E4, BLD-4): the last few turns of a session, compact, for Talk mode under the
 * Star. The newest reply keeps the synced reveal (R14); the list is a log (polite, additions only).
 */
import { useMemo, type ReactNode } from 'react'
import { useStore } from '../../lib/store'
import { chatRows, isActiveReply } from '../../lib/store/chat.logic'
import { useChatFeed } from './feed'
import { ReplyBody } from './messages/ReplyBody'
import './chat.css'

export interface TranscriptProps {
  sessionUid: string
  /** How many recent turns to show (default 6). */
  limit?: number
  className?: string
}

export function Transcript({ sessionUid, limit = 6, className }: TranscriptProps): ReactNode {
  useChatFeed(sessionUid)
  const view = useStore((s) => s.chats[sessionUid])
  const userName = useStore((s) => s.settings?.profile.userName || 'You')
  const assistantName = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const rows = useMemo(() => (view ? chatRows(view).filter((r) => !r.message?.deleted).slice(-limit) : []), [view, limit])
  return (
    <ol className={['transcript', className].filter(Boolean).join(' ')} aria-label="Conversation">
      {rows.map((r) => {
        const role = r.message?.role ?? 'assistant'
        if (role === 'user') {
          return (
            <li key={r.key} className="transcript__item" data-role="user">
              <span className="transcript__who">{userName}</span>
              <p className="transcript__text">{r.message?.body}</p>
            </li>
          )
        }
        const active = r.reply ? isActiveReply(r.reply) : false
        const text = r.reply && (r.reply.text || active) ? r.reply.text : (r.message?.body ?? '')
        const replyId = r.reply?.replyId ?? (r.message ? (view?.replyOf[r.message.uid] ?? null) : null)
        return (
          <li key={r.key} className="transcript__item" data-role="assistant" aria-busy={active || undefined}>
            <span className="transcript__who">{assistantName}</span>
            <ReplyBody replyId={replyId} text={text} streaming={active} interruptedAt={r.message?.interrupted ? (r.message.spokenChars ?? null) : null} className="msg__content transcript__text" />
          </li>
        )
      })}
    </ol>
  )
}
