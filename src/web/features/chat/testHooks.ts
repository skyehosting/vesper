/**
 * `window.__vesperTest.chat` (test builds only, 07 B10): leak counters for everything chat-ui owns, and a synthetic
 * speaker for the synced-reveal gate (BLD-5): `armSpeech(sessionUid)` makes the next reply of that session behave like
 * one this client speaks — its text is held from the first status event, then, when the reply is done, its body is
 * split into sentence chunks and played through the real AudioEngine (audio-core's synthetic speech, exact timelines),
 * each chunk's text arriving with its audio exactly as voice-client delivers `heldText`.
 */
import type { SpeechChunkHeader } from '@shared/ws/binary'
import { getAudioEngine } from '../../lib/audio'
import { chatBufferStats } from '../../lib/store/chat'
import { registerTestHooks } from '../../lib/testHooks'
import { ws } from '../../lib/ws'
import type { ReplySpeech } from '../voice'
import { openLayerCount } from '../../components/internal/layers'
import { kitStats } from '../../components/internal/stats'
import { chatBusStats } from './bus'
import { feedStats } from './feed'
import { attachmentUrlCount } from './composer/useAttachments'
import { setSpeechOverride, speechOverrideCount } from './speech'
import { nowTickerStats } from './time'
import { chunkText, spokenOf } from './testHooks.logic'

interface Armed {
  sessionUid: string
  replyId: string | null
  offs: Array<() => void>
  log: { replyId: string | null; chunks: number; endAt: number | null; firstAudioAt: number | null }
}

let armed: Armed | null = null

interface ArmOptions {
  charMs?: number
  gapMs?: number
  delayMs?: number
  audioLagMs?: number
}

function disarm(): void {
  if (!armed) return
  for (const off of armed.offs) off()
  armed.offs = []
}

async function play(replyId: string, body: string, opts: ArmOptions): Promise<void> {
  const { synthPcm, encodeWav } = await import('../../lib/audio/synth')
  const engine = getAudioEngine()
  engine.unlock()
  const rate = 24000
  let src = 0
  const chunks = chunkText(body).map((md, index, all) => {
    const spoken = spokenOf(md)
    const pcm = synthPcm(spoken, { sampleRate: rate, charMs: opts.charMs ?? 22, gapMs: opts.gapMs ?? 40 })
    const header: SpeechChunkHeader = {
      sessionUid: '',
      evSeq: 0,
      replyId,
      index,
      src: [src, src + md.length],
      text: md,
      spoken,
      timeline: { startsMs: pcm.startsMs, endsMs: pcm.endsMs },
      durationMs: pcm.durationMs,
      mime: 'audio/wav',
      instant: false,
      final: index === all.length - 1
    }
    src += md.length
    return { header, bytes: encodeWav(pcm.pcm, rate) }
  })
  const headers: SpeechChunkHeader[] = []
  let held = ''
  const state = (s: ReplySpeech['state']): void => setSpeechOverride(replyId, { state: s, heldText: held, headers: [...headers] })
  const offEnd = engine.on('replyEnd', (e) => {
    if (e.replyId !== replyId) return
    offEnd()
    if (armed?.log.replyId === replyId) armed.log.endAt = engine.now()
    state(e.interrupted ? 'interrupted' : 'done')
  })
  const offStart = engine.on('chunkStart', (e) => {
    if (e.replyId !== replyId || e.index !== 0) return
    offStart()
    if (armed?.log.replyId === replyId) armed.log.firstAudioAt = engine.now()
  })
  for (const c of chunks) {
    held += c.header.text
    headers.push(c.header)
    state('speaking')
    // `audioLagMs`: a later chunk's text is held (in the DOM, hidden) this long before its audio is queued — the reveal
    // rests at the previous chunk's end, as when a chunk's audio is late.
    if (opts.audioLagMs && c.header.index > 0) await new Promise((r) => setTimeout(r, opts.audioLagMs))
    engine.enqueue(c.header, c.bytes.slice(0))
    if (armed?.log.replyId === replyId) armed.log.chunks++
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
  }
}

export function installChatTestHooks(): void {
  if (!__VESPER_TEST__) return
  registerTestHooks('chat', {
    counters: () => ({
      bus: chatBusStats(),
      ticker: nowTickerStats().listeners,
      tickerRunning: nowTickerStats().running,
      objectUrls: attachmentUrlCount(),
      deltaBuffers: chatBufferStats().sessions,
      speechOverrides: speechOverrideCount(),
      feeds: feedStats(),
      kit: kitStats(),
      layers: openLayerCount()
    }),
    /** The next reply in `sessionUid` is held and then "spoken" with synthetic audio (see the file header). */
    armSpeech: (sessionUid: string, opts: ArmOptions = {}) => {
      disarm()
      const a: Armed = { sessionUid, replyId: null, offs: [], log: { replyId: null, chunks: 0, endAt: null, firstAudioAt: null } }
      armed = a
      a.offs.push(
        ws.on('reply.status', (m) => {
          if (m.sessionUid !== sessionUid || a.replyId) return
          a.replyId = m.replyId
          a.log.replyId = m.replyId
          setSpeechOverride(m.replyId, { state: 'waiting', heldText: '', headers: [] })
        }),
        ws.on('reply.done', (m) => {
          if (m.sessionUid !== sessionUid || m.replyId !== a.replyId) return
          disarm()
          void play(m.replyId, m.message.body, opts)
        })
      )
      return true
    },
    speechLog: () => armed?.log ?? null,
    clearSpeech: () => {
      disarm()
      if (armed?.replyId) setSpeechOverride(armed.replyId, null)
      armed = null
    },
    /** Barge-in for the synthetic speaker (what voice-client does on interrupt). */
    stopSpeech: () => {
      if (armed?.replyId) getAudioEngine().stop(armed.replyId)
    }
  })
}
