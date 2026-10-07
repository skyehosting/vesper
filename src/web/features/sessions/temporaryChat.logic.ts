/**
 * What a temporary chat is, in one wording (phase 5a P25): Settings → Chat, Settings → Privacy and README.md all show
 * this text, and tests/unit/docs/owner-docs.test.ts ties its numbers to the server's lifetime rules
 * (src/server/chat/temporary.ts: ends on close, after NO_SUBSCRIBER_MS with no device subscribed, after MAX_IDLE_MS
 * without activity, or at quit; attachments live in the temp dir until it ends).
 */
export const TEMPORARY_CHAT_TEXT =
  'A temporary chat lives only while Vesper runs: its messages are kept in memory (attached files in a temporary folder that is emptied when it ends), and it is never saved, added to memory or exported. It ends when you close it, about 10 minutes after you leave it (when no device has it open), after 24 hours without use, or when Vesper quits. The AI service you use still receives its messages.'

/** When it ends, said inside the chat itself (P25): the banner over the composer and the header's Temporary pill. */
const ENDS = 'It ends about 10 minutes after you leave it.'
export const TEMPORARY_CHAT_BANNER = `Temporary chat: not saved and not remembered. ${ENDS} The AI service still receives these messages.`
export const TEMPORARY_CHAT_TOOLTIP = `Not saved, embedded or remembered. ${ENDS} The AI service still receives these messages.`
export const TEMPORARY_CHAT_PILL_LABEL = 'Temporary chat: not saved; it ends about 10 minutes after you leave it; the AI service still receives these messages'
