/**
 * <ReplyView> — frozen signature (07 E4, BLD-4): one AI reply rendered like in the chat (markdown, code, math), with
 * the synced reveal when this client speaks it (R14). Talk mode (presence) shows it under the Star.
 */
import type { ReactNode } from 'react'
import { useStore } from '../../lib/store'
import { isActiveReply } from '../../lib/store/chat.logic'
import { useChatFeed } from './feed'
import { ReplyBody } from './messages/ReplyBody'
import './chat.css'

export interface ReplyViewProps {
  sessionUid: string
  /** The in-flight reply (null once only the stored message is known). */
  replyId: string | null
  /** The assistant message, when known (used after the reply finished). */
  messageUid?: string | null
  className?: string
}

export function ReplyView({ sessionUid, replyId, messageUid, className }: ReplyViewProps): ReactNode {
  useChatFeed(sessionUid)
  const live = useStore((s) => (replyId ? (s.chats[sessionUid]?.inflight[replyId] ?? null) : null))
  const uid = messageUid ?? live?.messageUid ?? null
  const message = useStore((s) => (uid ? (s.chats[sessionUid]?.messages.find((m) => m.uid === uid) ?? null) : null))
  const rid = replyId ?? (uid ? (useStore.getState().chats[sessionUid]?.replyOf[uid] ?? null) : null)
  const active = live ? isActiveReply(live) : false
  const text = live && (live.text || active) ? live.text : (message?.body ?? '')
  return (
    <div className={['reply-view', className].filter(Boolean).join(' ')} aria-busy={active || undefined}>
      <ReplyBody replyId={rid} text={text} streaming={active} interruptedAt={message?.interrupted ? (message.spokenChars ?? null) : null} className="msg__content" />
    </div>
  )
}
