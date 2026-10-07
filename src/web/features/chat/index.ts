/**
 * Chat feature barrel — the cross-feature exports with frozen signatures (07 E4). Talk mode (presence) and others
 * import only from here.
 */
export { ReplyView, type ReplyViewProps } from './ReplyView'
export { Transcript, type TranscriptProps } from './Transcript'
/** Keep a session's view live outside the chat page (Talk mode): subscribe + latest page, reference-counted. */
export { useChatFeed } from './feed'
