/**
 * Drives `presence.star` (state.logic.ts) from what this client knows: replies in progress in the sessions it follows
 * (WS reply.* and `subscribed` in-flight lists — independent of how chat-ui keeps its views), audio playing here (the
 * AudioEngine's chunk events), the voice slice (stt state, mute) and the connection. Game mode (07 D3) is read
 * from the ui slice (Bootstrap + `gamemode.changed`, kept by the shell) — there is one copy. A reply whose text is done
 * but whose voice this client is still waiting for keeps the Star at "Preparing voice…" until its audio starts, fails
 * or is cancelled (P02; the voice slice's per-reply speech).
 *
 * install() returns the cleanup; <PresenceHost> owns it. Every listener and timer is released there.
 */
import type { ReplyState } from '@shared/types/domain'
import { getAudioEngine } from '../../../lib/audio'
import type { StarState } from '../../../lib/store/presence'
import { useStore } from '../../../lib/store'
import { ws } from '../../../lib/ws'
import { deriveStarState, ERROR_HOLD_MS, waitingVoices } from '../state.logic'

/** The connection banner's patience: a short blip doesn't dim the Star. */
const OFFLINE_AFTER_MS = 4000
/** Gaps between speech chunks (or an underrun) shorter than this don't leave the speaking state. */
const SPEAKING_HOLD_MS = 450
/** A reply we never heard the end of (lost event, other device) stops counting after this. */
const STALE_REPLY_MS = 10 * 60_000

const TERMINAL: ReadonlySet<ReplyState> = new Set<ReplyState>(['done', 'stopped', 'error'])

interface ReplyEntry {
  sessionUid: string
  state: ReplyState
  at: number
}

export interface DriverStats {
  replies: number
  timers: number
}

let active: { stats: () => DriverStats; recompute: () => void } | null = null
/** Test builds only: a state held over whatever the driver derives (screenshots of listening/thinking in a chat). */
let forced: StarState | null = null

export function forceStarState(s: StarState | null): void {
  if (!__VESPER_TEST__) return
  forced = s
  active?.recompute()
}

/** For leak tests: what the installed driver holds right now. */
export function driverStats(): DriverStats | null {
  return active?.stats() ?? null
}

export function installDriver(): () => void {
  const st = useStore.getState
  const replies = new Map<string, ReplyEntry>()
  /** Finished replies this client is still waiting to hear (speech 'waiting' at reply.done). */
  let voiceWait: string[] = []
  let errorAt: number | null = null
  let offline = false
  let speaking = false
  let offlineTimer: number | null = null
  let errorTimer: number | null = null
  let speakTimer: number | null = null
  const engine = getAudioEngine()

  const recompute = (): void => {
    const now = Date.now()
    const states: ReplyState[] = []
    for (const [id, r] of replies) {
      if (now - r.at > STALE_REPLY_MS || !ws.isSubscribed(r.sessionUid)) replies.delete(id)
      else states.push(r.state)
    }
    const speech = st().speech
    voiceWait = waitingVoices(voiceWait, (id) => speech[id]?.state)
    if (voiceWait.length) states.push('preparing-voice')
    const v = st().voice
    const derived = deriveStarState({ offline, speaking, stt: v.stt, muted: v.muted, replies: states, errorAt, now })
    st().setStarState(__VESPER_TEST__ && forced ? forced : derived)
  }

  const setReply = (replyId: string, sessionUid: string, state: ReplyState): void => {
    if (TERMINAL.has(state)) {
      replies.delete(replyId)
      if (state === 'done') awaitVoice(replyId)
    } else replies.set(replyId, { sessionUid, state, at: Date.now() })
  }

  /** The reply's text is done: if its voice has not started here yet, the Star keeps preparing it. */
  const awaitVoice = (replyId: string): void => {
    if (st().speech[replyId]?.state === 'waiting' && !voiceWait.includes(replyId)) voiceWait = [...voiceWait, replyId]
  }

  const clearTimer = (h: number | null): null => {
    if (h !== null) window.clearTimeout(h)
    return null
  }

  const markSpeaking = (): void => {
    speakTimer = clearTimer(speakTimer)
    if (engine.isPlaying()) {
      if (!speaking) {
        speaking = true
        recompute()
      }
      return
    }
    // Hold the speaking look across short gaps between chunks.
    speakTimer = window.setTimeout(() => {
      speakTimer = null
      const now = engine.isPlaying()
      if (now !== speaking) {
        speaking = now
        recompute()
      }
    }, SPEAKING_HOLD_MS)
  }

  const offs: Array<() => void> = [
    ws.on('reply.status', (m) => {
      setReply(m.replyId, m.sessionUid, m.state)
      recompute()
    }),
    ws.on('reply.snapshot', (m) => {
      setReply(m.reply.replyId, m.sessionUid, m.reply.state)
      recompute()
    }),
    ws.on('reply.done', (m) => {
      replies.delete(m.replyId)
      awaitVoice(m.replyId)
      recompute()
    }),
    ws.on('reply.error', (m) => {
      if (m.replyId) replies.delete(m.replyId)
      // A busy session is a notice, not a failure of the presence.
      if (m.error.code !== 'session_busy') {
        errorAt = Date.now()
        errorTimer = clearTimer(errorTimer)
        errorTimer = window.setTimeout(() => {
          errorTimer = null
          recompute()
        }, ERROR_HOLD_MS + 20)
      }
      recompute()
    }),
    ws.on('subscribed', (m) => {
      for (const [id, r] of replies) if (r.sessionUid === m.sessionUid) replies.delete(id)
      for (const r of m.inflight) setReply(r.replyId, m.sessionUid, r.state)
      recompute()
    }),
    ws.on('session.deleted', (m) => {
      for (const [id, r] of replies) if (r.sessionUid === m.sessionUid) replies.delete(id)
      recompute()
    }),
    ws.on('session.ended', (m) => {
      for (const [id, r] of replies) if (r.sessionUid === m.sessionUid) replies.delete(id)
      recompute()
    }),
    ws.onStatus((info) => {
      if (info.status === 'ready') {
        offlineTimer = clearTimer(offlineTimer)
        if (offline) {
          offline = false
          recompute()
        }
        return
      }
      // Replies come back with the next `subscribed`; until then nothing is known to be in progress.
      if (replies.size) {
        replies.clear()
        recompute()
      }
      if (offlineTimer === null && !offline) {
        offlineTimer = window.setTimeout(() => {
          offlineTimer = null
          offline = ws.status !== 'ready'
          recompute()
        }, OFFLINE_AFTER_MS)
      }
    }),
    engine.on('chunkStart', markSpeaking),
    engine.on('chunkEnd', markSpeaking),
    engine.on('replyEnd', markSpeaking),
    engine.on('underrun', markSpeaking),
    useStore.subscribe((s, prev) => {
      if (s.voice !== prev.voice || s.speech !== prev.speech) recompute()
    })
  ]

  speaking = engine.isPlaying()
  recompute()

  active = {
    recompute,
    stats: () => ({ replies: replies.size + voiceWait.length, timers: [offlineTimer, errorTimer, speakTimer].filter((t) => t !== null).length })
  }

  return () => {
    for (const off of offs) off()
    offlineTimer = clearTimer(offlineTimer)
    errorTimer = clearTimer(errorTimer)
    speakTimer = clearTimer(speakTimer)
    replies.clear()
    voiceWait = []
    active = null
    st().setStarState('idle')
  }
}
