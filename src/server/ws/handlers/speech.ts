/**
 * speech.* handlers and ctx.services.speech (voice-out-server, 07 E1/E2): speech.replay ("speak again"),
 * speech.played (reveal progress acks), speech.cancel (barge-in, from any device). Also registers the TTS key hooks
 * (07 C22: validate before storing, then voices → kv cache → `tts.voices` broadcast) and the 'tts' ProviderTester.
 */
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../../services'
import { onSecret } from '../../settings/secretHooks'
import { bindSpeech, createSpeechService } from '../../speech'

const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

export function register(ctx: ServerContext): void {
  const speech = createSpeechService(ctx)
  ctx.services.speech = speech
  bindSpeech(ctx, speech)
  ctx.services.testers.tts = { test: (input, signal) => speech.test(input, signal) }
  ctx.onClose(() => speech.close())

  ctx.hub.on('speech.', async (client, msg) => {
    switch (msg.t) {
      case 'speech.replay': {
        if (!isStr(msg.messageUid)) throw new VesperError('validation')
        const replyId = await speech.replayFor(msg.messageUid, client)
        ctx.hub.ack(client, msg, { replyId, messageUid: msg.messageUid })
        return
      }
      case 'speech.played':
        if (isStr(msg.replyId) && Number.isFinite(msg.index) && Number.isFinite(msg.revealedChars)) speech.played(msg.replyId, msg.index, msg.revealedChars)
        return
      case 'speech.cancel': {
        if (!isStr(msg.replyId)) throw new VesperError('validation')
        speech.cancel(msg.replyId, typeof msg.spokenChars === 'number' ? msg.spokenChars : undefined, client.id, { beforeAudio: msg.beforeAudio === true })
        ctx.hub.ack(client, msg as { id?: string })
        return
      }
      case 'speech.textFirst':
        if (isStr(msg.replyId)) speech.textFirst(msg.replyId, client.id)
        return
      default:
        throw new VesperError('not_implemented')
    }
  })

  // tts.prewarm (07 D6, Phase 3 engine-int): Talk mode opened — warm the voice provider; best effort, no answer.
  ctx.hub.on('tts.', (_client, msg) => {
    if (msg.t !== 'tts.prewarm') throw new VesperError('not_implemented')
    void speech.prewarm()
  })

  // A speaker that disconnects stops receiving audio; when no speaker is left, synthesis stops (07 C16).
  ctx.hub.onDisconnect((client) => speech.clientGone(client.id))

  onSecret(ctx, {
    match: (name) => name.startsWith('tts:'),
    validate: (name, value, url) => speech.validateKey(name, value, url),
    // Not awaited: the save answers at once; voices arrive as a `tts.voices` broadcast moments later.
    saved: (name) => void speech.keySaved(name),
    deleted: (name) => speech.keyDeleted(name)
  })
}
