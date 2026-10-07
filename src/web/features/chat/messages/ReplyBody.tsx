/**
 * The text of an AI reply, with the synced reveal (R14, 07 C14/C15).
 *
 * - This client speaks the reply (`useReplySpeech(replyId).state` waiting/speaking/done/interrupted): render ONLY the
 *   held text (it grows chunk by chunk together with its audio) and register the root with the RevealController, which
 *   hides every glyph until its audio plays (CSS Custom Highlight API: no DOM changes, no layout jump). Block elements
 *   and (while held) every text run carry `data-src-*` mdast offsets so chunk boundaries are exact (F34); UI inside the
 *   root is `[data-reveal-skip]`.
 * - Barge-in: the reveal freezes; "— interrupted · show rest" finishes it and shows the whole reply.
 * - Speech failed / not speaking: render from deltas (or the stored body) like any reply.
 * The root is unregistered on unmount (VirtualList eviction, session switch) and re-registered on remount; the
 * controller keeps each reply's timing, so the reveal resumes where the audio is.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { registerRevealRoot, getRevealController } from '../../../lib/audio'
import { Markdown } from '../markdown/Markdown'
import { isHeld, useSpeechFor } from '../speech'
import { cutAt } from './cut.logic'

export interface ReplyBodyProps {
  /** The reply that produced this text (live, or remembered after reply.done). */
  replyId: string | null
  /** Text from deltas / snapshot while streaming, else the stored body. */
  text: string
  streaming: boolean
  /** Stored as interrupted (07 C15): characters actually spoken. */
  interruptedAt?: number | null
  className?: string
}

export function ReplyBody({ replyId, text, streaming, interruptedAt, className }: ReplyBodyProps): ReactNode {
  const speech = useSpeechFor(replyId)
  const [showRest, setShowRest] = useState(false)
  const held = !!replyId && isHeld(speech) && speech.heldText !== null && !showRest
  const root = useRef<HTMLDivElement>(null)
  const headers = useRef(speech.headers)
  headers.current = speech.headers

  useLayoutEffect(() => {
    const el = root.current
    if (!held || !replyId || !el) return
    return registerRevealRoot(replyId, el, headers.current)
  }, [held, replyId])

  const interruptedLive = held && speech.state === 'interrupted'
  const storedCut = !held && !showRest && interruptedAt != null && interruptedAt < text.length
  // Deltas never reach the speaking client: after "show rest" the held text stands in until the full body arrives.
  const shown = held ? (speech.heldText ?? '') : storedCut ? cutAt(text, interruptedAt) : text || speech.heldText || ''

  return (
    <>
      <div ref={root} className={className} data-reply-root={replyId ?? undefined} data-held={held ? '' : undefined}>
        <Markdown text={shown} streaming={held ? speech.state !== 'done' : streaming} className={streaming && !held ? 'is-streaming' : undefined} srcTags={held} />
      </div>
      {interruptedLive || storedCut ? (
        <p className="msg__interrupted">
          <span aria-hidden="true">— </span>interrupted ·{' '}
          <button
            type="button"
            className="msg__link-btn"
            onClick={() => {
              if (replyId) getRevealController().finish(replyId)
              setShowRest(true)
            }}
          >
            show rest
          </button>
        </p>
      ) : null}
    </>
  )
}
