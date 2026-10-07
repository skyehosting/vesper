/**
 * Message actions shared by the rows, the slash commands and Talk mode: send, regenerate (→ variant), edit (→ branch),
 * stop, delete/restore, "Speak again", "Remember this", copy. Each returns a promise that rejects with an
 * ApiErrorException-compatible error; callers show it.
 */
import type { Message } from '@shared/types/domain'
import { copyText } from '../../components/internal/clipboard'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { clientClock, ws } from '../../lib/ws'
import { expectSpeech, speakAgain as replayReply, speakFlag } from '../voice'
import { markdownToPlain } from './markdown/blocks.logic'

export function canSpeak(): boolean {
  return !!useStore.getState().settings?.voice.tts.enabled
}

/*
 * Spoken replies (R14): `speakFlag()` is the one per-device answer ("speak replies", 07 D8) and unlocks audio from the
 * sending gesture; `expectSpeech(replyId)` tells the speech client to hold the reply for its audio (synced reveal: the
 * speaker gets no deltas). Every turn this device starts goes through these three.
 */
/** How long a send may wait for the connection to come back (it is resent unchanged after each reconnect, F62). */
export const SEND_TIMEOUT_MS = 60_000

/** A fresh client message id (getRandomValues also works outside secure contexts). */
export function newClientMsgId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return `cm_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Send a message (F62): it carries a client message id and is resent unchanged when the socket drops before the ack
 * — the server answers a repeat with the original ack, so a lost ack never makes a duplicate turn. Pass the same
 * `clientMsgId` to send the same message again after a failure the client couldn't decide.
 */
export async function sendMessage(sessionUid: string, text: string, attachments: string[], o: { speak?: boolean; interrupt?: boolean; clientMsgId?: string } = {}): Promise<void> {
  const speak = o.speak ?? speakFlag()
  const clientMsgId = o.clientMsgId ?? newClientMsgId()
  const ack = await ws.request(
    { t: 'chat.send', sessionUid, text, attachments, client: clientClock(), speak, clientMsgId, ...(o.interrupt ? { interrupt: true } : {}) },
    { resend: true, timeoutMs: SEND_TIMEOUT_MS }
  )
  if (speak) expectSpeech(ack.replyId)
}

export async function regenerate(sessionUid: string, messageUid: string): Promise<void> {
  const speak = speakFlag()
  const ack = await ws.request({ t: 'chat.regenerate', sessionUid, messageUid, speak, client: clientClock() })
  if (speak) expectSpeech(ack.replyId)
}

export async function editMessage(sessionUid: string, messageUid: string, text: string, attachments: string[]): Promise<void> {
  const speak = speakFlag()
  const ack = await ws.request({ t: 'chat.edit', sessionUid, messageUid, text, attachments, speak, client: clientClock() })
  if (speak) expectSpeech(ack.replyId)
}

export function stopReply(sessionUid: string): void {
  ws.send({ t: 'chat.stop', sessionUid })
}

/** "Speak again" (R14): voice-client replays the stored reply with its own synced reveal (errors become a toast). */
export async function speakAgain(messageUid: string): Promise<void> {
  await replayReply(messageUid)
}

/** Soft delete with an Undo toast (07 B9). `refresh` also starts a new epoch so the AI stops seeing it. */
export async function deleteMessage(m: Message, refresh = false): Promise<void> {
  await api('DELETE /api/messages/:uid', { params: { uid: m.uid }, query: refresh ? { refresh: '1' } : {} })
  toast.info('Message deleted.', {
    id: `deleted-${m.uid}`,
    action: {
      label: 'Undo',
      onClick: () => {
        void restoreMessage(m.uid).catch((e: unknown) => toast.error(toApiError(e).message))
      }
    }
  })
}

export async function restoreMessage(messageUid: string): Promise<void> {
  await api('POST /api/messages/:uid/restore', { params: { uid: messageUid } })
}

/** Pinned fact from a message (07 A4 "Remember this"); facts are short, so long messages are cut at a word. */
export const FACT_MAX = 2000

export function factText(body: string): string {
  const plain = markdownToPlain(body).replace(/\s+/g, ' ').trim()
  if (plain.length <= FACT_MAX) return plain
  const cut = plain.slice(0, FACT_MAX - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), FACT_MAX - 200))}…`
}

export async function rememberText(text: string): Promise<void> {
  const t = text.trim()
  if (!t) throw new Error('Nothing to remember')
  await api('POST /api/facts', { body: { text: factText(t) } })
  toast.success('Vesper will remember this.', { title: 'Pinned to “About you”' })
}

export async function copyMessage(m: Pick<Message, 'body'>, as: 'markdown' | 'plain' = 'markdown'): Promise<void> {
  const ok = await copyText(as === 'plain' ? markdownToPlain(m.body) : m.body)
  if (ok) toast.success(as === 'plain' ? 'Copied as plain text.' : 'Copied.', { id: 'copied', durationMs: 1800 })
  else toast.error("Couldn't copy. Select the text and press Ctrl+C.")
}
