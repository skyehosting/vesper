/**
 * Talk mode controller (07 D6): the side effects behind talk.logic.ts. The microphone belongs to the voice client:
 * Talk mode runs voice-client's mic session in its persistent conversation mode, so there is ONE mic pipeline
 * (capture, stt.* exchange, frames held while Vesper speaks unless voice barge-in, re-arm 250 ms after the audio,
 * `chat.send {talk:true}` on each final). What stays here is Talk mode's own:
 *   - one capture track for the whole visit: Hold and the window being hidden pause listening (`holdMic`), Mute holds
 *     frames back (`voice.muted`), only End releases the session;
 *   - `tts.prewarm` + `stt.prewarm` on open and after a reconnect;
 *   - Interrupt = voice-client's barge-in (speech.cancel with how far the voice got) + `chat.stop` while the reply is
 *     still being written;
 *   - Wake Lock on phones while Talk mode is open and visible;
 *   - the page's phases (talk.logic.ts), fed from the voice slice, the reply events and the AudioEngine.
 * start() → stop(): every listener, timer, the wake lock and the mic session are released.
 */
import { apiError, type ApiError } from '@shared/errors'
import { getAudioEngine } from '../../../lib/audio'
import { useStore } from '../../../lib/store'
import { ws } from '../../../lib/ws'
import { cancelMicOf, finishMic, holdMic, interruptSpeech, micActive, micPreflight, resumeMic, startMic, type MicSessionEvent } from '../../voice'
import { initialTalk, talkReducer, type TalkEvent, type TalkState } from './talk.logic'

const NO_SPEECH_GRACE_MS = 900

interface WakeLockLike {
  release(): Promise<void>
  addEventListener?(type: 'release', cb: () => void): void
}

export interface TalkControllerOptions {
  sessionUid: string
  /** Hold the screen awake (phones). */
  wakeLock: boolean
}

export class TalkController {
  state: TalkState = initialTalk()
  private readonly listeners = new Set<() => void>()
  private readonly offs: Array<() => void> = []
  private readonly spokenReplies = new Set<string>()
  private readonly replyDone = new Set<string>()
  private graceTimer: number | null = null
  private wake: WakeLockLike | null = null
  private started = false
  private stopped = false
  private wasReady = false
  /** Put on hold because the window was hidden (resume when it is visible again). */
  private hiddenHold = false
  /** This visit's mic session ended in an error (cleared from the voice slice when Talk mode ends). */
  private micFailed = false

  constructor(private readonly o: TalkControllerOptions) {}

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  getState = (): TalkState => this.state

  start(): void {
    if (this.started) return
    this.started = true
    const pre = micPreflight()
    if (pre === 'insecure_context') {
      this.dispatch({ t: 'insecure' })
      return
    }
    const engine = getAudioEngine()
    void engine.unlock()
    this.prewarm()
    this.offs.push(
      // The mic session publishes the STT state and the live words into the voice slice.
      useStore.subscribe((s, prev) => {
        const v = s.voice
        const p = prev.voice
        if (v.stt !== p.stt || (v.stt === 'error' && v.micError !== p.micError)) this.dispatch({ t: 'stt.state', state: v.stt, error: v.stt === 'error' ? apiError(v.micError ?? 'stt_unavailable') : undefined })
        if (v.partial !== p.partial && v.partial) this.dispatch({ t: 'stt.partial', text: v.partial })
      }),
      ws.on('reply.status', (m) => {
        if (m.sessionUid !== this.o.sessionUid) return
        this.dispatch({ t: 'reply.status', replyId: m.replyId, messageUid: m.messageUid, state: m.state })
      }),
      ws.on('reply.done', (m) => {
        if (m.sessionUid !== this.o.sessionUid) return
        this.replyDone.add(m.replyId)
        this.onReplyDone(m.replyId)
      }),
      ws.on('reply.error', (m) => {
        if (m.sessionUid !== this.o.sessionUid) return
        this.dispatch({ t: 'reply.error', replyId: m.replyId, error: m.error })
      }),
      ws.onStatus((info) => {
        // The mic session reopens its STT session by itself after a reconnect; warm the voice again too.
        if (info.status !== 'ready') this.wasReady = false
        else if (!this.wasReady) {
          this.wasReady = true
          this.prewarm()
        }
      }),
      engine.on('chunkStart', (e) => {
        this.spokenReplies.add(e.replyId)
        this.dispatch({ t: 'speech.start', replyId: e.replyId })
      }),
      engine.on('replyEnd', (e) => {
        if (engine.isPlaying()) return
        this.dispatch({ t: 'speech.end', replyId: e.replyId })
      })
    )
    this.wasReady = ws.connected()
    if (pre) {
      this.dispatch({ t: 'mic.error', error: apiError(pre) })
      return
    }
    this.openMic()
    if (this.o.wakeLock) void this.acquireWake()
    // 07 B17: the mic stops while the window is hidden; Talk mode goes on hold and picks up when it is back.
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') {
        if (this.state.phase !== 'held' && this.state.phase !== 'error' && this.state.phase !== 'insecure') {
          this.hiddenHold = true
          // Not hold(): a reply that is being spoken keeps playing; only listening stops.
          this.dispatch({ t: 'hold' })
        }
        holdMic({ releaseTrack: true })
        return
      }
      if (this.o.wakeLock && !this.wake) void this.acquireWake()
      if (this.hiddenHold) {
        this.hiddenHold = false
        this.resume()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    this.offs.push(() => document.removeEventListener('visibilitychange', onVis))
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const off of this.offs.splice(0)) off()
    if (this.graceTimer !== null) window.clearTimeout(this.graceTimer)
    this.graceTimer = null
    cancelMicOf(this)
    // Talk mode's own mic failure stays in Talk mode: it must not leave the composer mics showing a problem that was
    // never theirs (review F51). Only when no other session took the mic since.
    if (this.micFailed && !micActive() && useStore.getState().voice.micError) useStore.getState().setVoice({ micError: null, stt: 'idle' })
    void this.wake?.release().catch(() => undefined)
    this.wake = null
    this.state = talkReducer(this.state, { t: 'end' })
    useStore.getState().setVoice({ muted: false })
    this.listeners.clear()
  }

  // ── user actions ──
  primary(): void {
    const s = this.state
    if (s.phase === 'error') return this.retry()
    if (s.phase === 'held') return this.resume()
    if (s.phase === 'thinking' || s.phase === 'speaking') return this.interrupt()
    if (s.muted) return this.setMuted(false)
    if (s.phase === 'listening' || s.phase === 'transcribing') {
      // Words so far: end the utterance now (its final is sent; the next one opens by itself). Nothing: pause.
      if (s.partial.trim()) finishMic('send')
      else this.hold()
    }
  }

  setMuted(muted: boolean): void {
    if (muted === this.state.muted) return
    this.dispatch({ t: 'mute', muted })
    // The mic session holds frames back while muted; the track stays (07 D6 Mute).
    useStore.getState().setVoice({ muted, ...(muted ? { partial: '' } : {}) })
  }

  hold(): void {
    if (this.state.phase === 'held') return
    if (this.state.phase === 'thinking' || this.state.phase === 'speaking') this.interrupt()
    holdMic()
    this.dispatch({ t: 'hold' })
  }

  resume(): void {
    if (this.state.phase !== 'held') return
    void getAudioEngine().unlock()
    this.dispatch({ t: 'resume' })
    resumeMic()
  }

  interrupt(): void {
    const s = this.state
    if (s.phase !== 'thinking' && s.phase !== 'speaking') return
    // Barge-in (07 C15): voice-client stops the audio, freezes the reveal and tells the server how far it got.
    const spoke = interruptSpeech()
    const id = s.replyId
    if (!id || !this.replyDone.has(id)) ws.send({ t: 'chat.stop', sessionUid: this.o.sessionUid })
    else if (!spoke) getAudioEngine().stop(id)
    this.dispatch({ t: 'interrupt' })
  }

  retry(): void {
    if (this.state.phase !== 'error') return
    this.dispatch({ t: 'retry' })
    this.openMic()
  }

  // ── internals ──
  private dispatch(e: TalkEvent): void {
    if (this.stopped) return
    if (e.t === 'mic.error' || (e.t === 'stt.state' && e.state === 'error')) this.micFailed = true
    const next = talkReducer(this.state, e)
    if (next === this.state) return
    this.state = next
    for (const l of [...this.listeners]) l()
  }

  private prewarm(): void {
    // 07 D6: warm both ends so the first reply speaks fast; errors surface at stt.start / speech time.
    ws.send({ t: 'tts.prewarm' })
    ws.send({ t: 'stt.prewarm' })
  }

  /** voice-client's mic session in Talk mode: conversation, persistent (one track), replies spoken with the fast voice. */
  private openMic(): void {
    startMic({
      mode: 'conversation',
      sessionUid: this.o.sessionUid,
      talk: true,
      persistent: true,
      owner: this,
      onEvent: (e) => this.onMic(e)
    })
  }

  private onMic(e: MicSessionEvent): void {
    switch (e.t) {
      case 'capture':
        return this.dispatch({ t: 'mic.ready' })
      case 'final':
        if (e.autoSend) this.dispatch({ t: 'stt.final', text: e.text })
        return
      case 'sent':
        return this.dispatch({ t: 'sent', replyId: e.replyId, messageUid: e.messageUid })
      case 'send-failed':
        return this.dispatch({ t: 'send.failed', error: e.error })
    }
  }

  private onReplyDone(replyId: string): void {
    const engine = getAudioEngine()
    const spoken = this.spokenReplies.has(replyId) && engine.isPlaying()
    if (spoken) {
      this.dispatch({ t: 'reply.done', replyId, spoken: true })
      return
    }
    // Speech may still be on its way (the first chunk lands just after the text is final); wait a moment.
    if (this.graceTimer !== null) window.clearTimeout(this.graceTimer)
    this.graceTimer = window.setTimeout(
      () => {
        this.graceTimer = null
        this.dispatch({ t: 'reply.done', replyId, spoken: getAudioEngine().isPlaying() })
      },
      this.spokenReplies.has(replyId) ? 0 : NO_SPEECH_GRACE_MS
    )
  }

  private async acquireWake(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } }
    if (!nav.wakeLock || document.visibilityState !== 'visible' || this.stopped) return
    try {
      const lock = await nav.wakeLock.request('screen')
      if (this.stopped) {
        void lock.release().catch(() => undefined)
        return
      }
      this.wake = lock
      lock.addEventListener?.('release', () => {
        if (this.wake === lock) this.wake = null
      })
    } catch {
      // Denied (battery saver, not visible): the screen may sleep; nothing else changes.
    }
  }

  /** Leak checks. */
  stats(): { listeners: number; offs: number; graceTimer: boolean; wake: boolean } {
    return { listeners: this.listeners.size, offs: this.offs.length, graceTimer: this.graceTimer !== null, wake: !!this.wake }
  }
}

export function talkError(e: ApiError | null): string | null {
  if (!e) return null
  switch (e.code) {
    case 'mic_denied':
      return 'Vesper needs permission to use the microphone. Allow it in the browser or Windows privacy settings, then try again.'
    case 'mic_os_blocked':
      return 'The microphone is unavailable — it may be unplugged or blocked by Windows privacy settings.'
    case 'insecure_context':
      return 'Voice needs a secure connection (HTTPS) on other devices.'
    case 'stt_model_missing':
      return 'The speech model isn’t installed yet. Download it in Settings → Voice in.'
    case 'stt_unavailable':
      return 'Speech recognition isn’t available right now.'
    default:
      return e.message
  }
}
