/**
 * The mic session (R19, 07 C17/D6): one at a time per page. Owns the capture (getMicCapture), the stt.* exchange and
 * the conversation loop; publishes its state into `store.voice` (stt, partial, countdown, micError, micHeld…).
 *
 *   startMic({ mode: 'dictate', sessionUid, onText })   // from a click (unlocks audio, starts capture + stt.start)
 *   finishMic('send')                                   // "send now" / push-to-talk release ('released')
 *   cancelMic()                                         // drop the utterance and close
 *
 * Frames: 16 kHz Int16 from the AudioWorklet → binary kind 2. They are held back while a reply's audio plays (unless
 * barge-in is 'voice') and, in conversation mode, until REARM_MS after the reply to the last utterance has ended.
 * Typing while listening (any typing key, or input in the composer) cancels the auto-send: the transcript goes into
 * the composer instead. Everything a session creates (WS listeners, timers, key listeners, the capture) is released
 * when it ends; `micSessionStats()` proves it (07 D14).
 *
 * Talk mode (07 D6) uses the same session with `persistent: true`: ONE capture track for the whole visit. `holdMic()`
 * closes the server's STT session and stops sending but keeps the track (`releaseTrack` also stops it, e.g. while the
 * window is hidden); `resumeMic()` reopens it (and the track if it was released). When the server ends its session
 * ("send now", a reconnect), a persistent session opens the next one by itself. Only `cancelMic()` ends it.
 */
import { ERRORS, type ApiError, type ErrorCode } from '@shared/errors'
import { BIN_KIND, encodeBinary } from '@shared/ws'
import { toast } from '../../components/Toast'
import { getMicCapture } from '../../lib/audio'
import { toApiError } from '../../lib/errors.logic'
import { micEnvironmentError, type MicEnvironment } from '../../lib/mic/errors.logic'
import { useStore } from '../../lib/store'
import { clientClock, ws } from '../../lib/ws'
import { earcon } from './earcon'
import {
  countdownFor,
  endsAfterFinal,
  finalAction,
  gateOpen,
  isTypingKey,
  MAX_EARLY_FRAMES,
  PREWARM_EVERY_MS,
  REARM_MS,
  STOP_GRACE_MS,
  type BargeIn,
  type MicMode,
  type MicPlace
} from './mic.logic'
import { getVoicePrefs } from './prefs'
import { expectSpeech, interruptSpeech, speakFlag, talkSpeak, unlockAudio } from './speechClient'

export interface MicStartOptions {
  mode: MicMode
  /** Session the utterance belongs to (null: a settings try-it area — nothing is ever sent). */
  sessionUid: string | null
  /** The transcript goes into the composer (dictation, cancelled auto-send, try-it areas). */
  onText?: (text: string) => void
  /** Auto-send through the composer (attachments, commands). Without it the session sends chat.send itself. */
  onSend?: (text: string) => void
  /** Sent from Talk mode: fast voice + Talk budgets (07 D6). */
  talk?: boolean
  /** Called when the session ends (any reason). */
  onEnd?: (reason: EndReason) => void
  /** Who started it (a MicControl instance); `cancelMicOf(owner)` ends it only if it is still theirs. */
  owner?: object
  /**
   * Talk mode (07 D6): one capture for the whole visit — hold/resume keep the track, server-side ends reopen the STT
   * session, the window being hidden is left to the owner (holdMic({releaseTrack:true})). Only cancelMic ends it.
   */
  persistent?: boolean
  /** What happened, for an owner that shows its own states (Talk mode). */
  onEvent?: (e: MicSessionEvent) => void
}

export type MicSessionEvent =
  /** The capture is running (getUserMedia granted, worklet loaded). */
  | { t: 'capture' }
  /** A final transcript (before it is sent). */
  | { t: 'final'; text: string; autoSend: boolean }
  /** The utterance was sent as a chat turn. */
  | { t: 'sent'; text: string; replyId: string | null; messageUid: string | null }
  | { t: 'send-failed'; error: ApiError }
  /** Talk mode: an utterance could not be transcribed (a transient cloud error); the session listens again (F35). */
  | { t: 'lost'; error: ApiError }

export type EndReason = 'done' | 'cancelled' | 'error' | 'replaced' | 'hidden' | 'server' | 'timeout'

interface Active {
  id: number
  o: MicStartOptions
  acked: boolean
  /** The server reported this session's first state (events before it belong to a previous session). */
  serverStarted: boolean
  stopping: boolean
  early: Uint8Array[]
  seq: number
  offs: Array<() => void>
  /** Pending timers of this session (cleared when it ends). */
  timers: Set<number>
  /** Conversation: the reply to the last utterance ('pending' until chat.send is acked). */
  awaiting: string | null
  awaitingDone: boolean
  /** Replies that already ended (a fast reply may finish before chat.send is acked). */
  over: Set<string>
  rearmAt: number
  ttsSent: boolean
  frames: number
  sent: number
  /** Persistent sessions: listening is paused (no STT session on the server, no frames sent; the track may stay). */
  held: boolean
  /** Bumped per stt.start, so the ack of a superseded request is ignored. */
  gen: number
  /** Recent automatic reopens (a server that keeps closing the session must not loop). */
  reopens: number[]
}

/** A persistent session reopens at most this many times per window before it gives up (no reopen loop). */
const MAX_REOPENS = 6
const REOPEN_WINDOW_MS = 10_000

let active: Active | null = null
let nextId = 0
let timers = 0
let lastPrewarm = 0
/** Simulated environment (test builds): an insecure origin without leaving loopback (07 D8 e2e). */
let envOverride: Partial<MicEnvironment> | null = null
const ended: Array<{ id: number; reason: EndReason }> = []
const events: Array<Record<string, unknown>> = []

function logEvent(e: Record<string, unknown>): void {
  events.push({ ...e, at: Math.round(performance.now()) })
  if (events.length > 200) events.shift()
}

/** Recent stt.* events (test builds). */
export function micEvents(): Array<Record<string, unknown>> {
  return [...events]
}

function st() {
  return useStore.getState()
}

function bargeInMode(): BargeIn {
  return st().settings?.voice.stt.bargeIn ?? 'tap'
}

/** The page's capability to capture audio (secure context, getUserMedia, AudioWorklet). */
export function micEnvironment(): MicEnvironment {
  const real: MicEnvironment = {
    isSecureContext: window.isSecureContext,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasAudioWorklet: typeof AudioWorkletNode !== 'undefined'
  }
  return __VESPER_TEST__ && envOverride ? { ...real, ...envOverride } : real
}

/** Test builds: pretend the page is (not) a secure context. */
export function simulateMicEnvironment(o: Partial<MicEnvironment> | null): void {
  if (__VESPER_TEST__) envOverride = o
}

/** Where this page runs, for the mic help texts. */
export function micPlaceOf(desktop: boolean): MicPlace {
  return {
    isSecureContext: micEnvironment().isSecureContext,
    protocol: location.protocol,
    hostname: location.hostname,
    desktop,
    windows: /Windows/i.test(navigator.userAgent)
  }
}

/** Pre-flight error for this page (e.g. 'insecure_context' on a LAN http origin), or null. */
export function micPreflight(): ErrorCode | null {
  return micEnvironmentError(micEnvironment())
}

export function micActive(): boolean {
  return active !== null
}

export function activeMicMode(): MicMode | null {
  return active?.o.mode ?? null
}

/** Load the speech model ahead of the first utterance (hover/focus of the mic, 07 D6). */
export function prewarmStt(): void {
  const now = Date.now()
  if (now - lastPrewarm < PREWARM_EVERY_MS || active) return
  if (!st().settings?.voice.stt.enabled) return
  lastPrewarm = now
  ws.send({ t: 'stt.prewarm' })
}

function setTimer(a: Active, fn: () => void, ms: number): void {
  timers++
  const h = window.setTimeout(() => {
    a.timers.delete(h)
    timers--
    fn()
  }, ms)
  a.timers.add(h)
}

function clearTimers(a: Active): void {
  for (const h of a.timers) {
    window.clearTimeout(h)
    timers--
  }
  a.timers.clear()
}

function speechLive(replyId: string): boolean {
  const s = st().speech[replyId]?.state
  return s === 'waiting' || s === 'speaking'
}

function framesHeld(a: Active, now: number): boolean {
  const v = st().voice
  if (a.awaiting !== null && a.awaitingDone && !speechLive(a.awaiting) && !v.ttsActive) {
    // The reply and its audio are over: listen again shortly (07 D6 re-arm).
    a.awaiting = null
    a.rearmAt = now + REARM_MS
  }
  return !gateOpen({ mode: a.o.mode, muted: v.muted, ttsActive: v.ttsActive, bargeIn: bargeInMode(), awaitingReply: a.awaiting !== null, rearmAt: a.rearmAt, now })
}

function onFrame(a: Active, pcm: Int16Array): void {
  if (active !== a || a.stopping || a.held) return
  a.frames++
  const frame = encodeBinary(BIN_KIND.micPcm, { seq: a.seq++ }, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  if (!a.acked) {
    a.early.push(frame)
    if (a.early.length > MAX_EARLY_FRAMES) a.early.shift()
    return
  }
  const held = framesHeld(a, performance.now())
  if (st().voice.micHeld !== held) st().setVoice({ micHeld: held })
  if (held) return
  if (ws.sendBinary(frame)) a.sent++
}

function syncTtsActive(a: Active): void {
  const on = st().voice.ttsActive
  if (on === a.ttsSent || !a.acked) return
  a.ttsSent = on
  ws.send({ t: 'stt.tts-active', active: on })
}

/** Start listening. Call from a user gesture (it unlocks audio). Replaces any running session. */
export function startMic(o: MicStartOptions): void {
  if (active) endSession(active, 'replaced', true)
  const a: Active = {
    id: ++nextId,
    o,
    acked: false,
    serverStarted: false,
    stopping: false,
    early: [],
    seq: 0,
    offs: [],
    timers: new Set(),
    awaiting: null,
    awaitingDone: false,
    over: new Set(),
    rearmAt: 0,
    ttsSent: st().voice.ttsActive,
    frames: 0,
    sent: 0,
    held: false,
    gen: 0,
    reopens: []
  }
  active = a
  st().setVoice({ micMode: o.mode, micSessionUid: o.sessionUid, stt: 'warming-up', partial: '', micError: null, countdown: null, autoSendCancelled: false, micHeld: false })

  const pre = micPreflight()
  if (pre) return fail(a, pre, false)
  void unlockAudio()
  // A new utterance interrupts the voice (tap barge-in, 07 C15) — except in conversation mode, where the mic stays
  // armed through the reply and waits for it.
  if (o.mode !== 'conversation' && bargeInMode() !== 'off') interruptSpeech()

  wire(a)
  const mic = getMicCapture()
  a.offs.push(mic.onFrames((pcm) => onFrame(a, pcm)))
  a.offs.push(mic.onEnded(() => fail(a, 'mic_os_blocked', true)))
  startCapture(a)
  openServer(a)
}

function startCapture(a: Active): void {
  const prefs = getVoicePrefs()
  getMicCapture()
    .start({
      deviceId: prefs.micDeviceId ?? undefined,
      echoCancellation: prefs.echoCancellation,
      noiseSuppression: prefs.noiseSuppression,
      autoGainControl: prefs.autoGainControl
    })
    .then(
      () => {
        if (active === a) a.o.onEvent?.({ t: 'capture' })
      },
      (e: unknown) => fail(a, toApiError(e).code, true)
    )
}

/** stt.start for this session (again, for a persistent session after hold, "send now" or a reconnect). */
function openServer(a: Active): void {
  const gen = ++a.gen
  a.acked = false
  a.serverStarted = false
  a.stopping = false
  a.ttsSent = st().voice.ttsActive
  ws.request({ t: 'stt.start', sessionUid: a.o.sessionUid, mode: a.o.mode, sampleRate: 16000, ttsActive: a.ttsSent }).then(
    () => {
      if (active !== a || a.gen !== gen || a.held) return
      a.acked = true
      // Frames captured while the server set up (≤ 2 s): send them first, in order.
      for (const f of a.early.splice(0)) if (!framesHeld(a, performance.now())) ws.sendBinary(f)
      syncTtsActive(a)
    },
    (e: unknown) => {
      if (active === a && a.gen === gen) fail(a, toApiError(e).code, false)
    }
  )
}

/** Talk mode lost an utterance to a transient error: tell the user, reopen (bounded by the reopen guard). */
function lost(a: Active, error: ApiError): void {
  st().setVoice({ partial: '', countdown: null, autoSendCancelled: false })
  if (a.o.onEvent) a.o.onEvent({ t: 'lost', error })
  toast.warning(`${error.message} Vesper didn't catch that — please say it again.`)
  reopen(a)
}

/** A persistent session's server side ended by itself: open the next one, unless that keeps happening. */
function reopen(a: Active): void {
  const now = performance.now()
  a.reopens = a.reopens.filter((t) => now - t < REOPEN_WINDOW_MS)
  a.reopens.push(now)
  if (a.reopens.length > MAX_REOPENS) return fail(a, 'stt_unavailable', true)
  openServer(a)
}

/**
 * Persistent sessions (Talk mode): pause listening. The server's STT session closes and nothing is sent; the capture
 * track stays (one track per visit, 07 D6) unless `releaseTrack` (the window is hidden, 07 B17).
 */
export function holdMic(o: { releaseTrack?: boolean } = {}): void {
  const a = active
  if (!a || !a.o.persistent) return
  if (o.releaseTrack) getMicCapture().stop()
  if (a.held) return
  a.held = true
  a.gen++
  a.early = []
  ws.send({ t: 'stt.cancel' })
  a.acked = false
  a.serverStarted = false
  st().setVoice({ stt: 'idle', partial: '', countdown: null, autoSendCancelled: false, micHeld: true })
}

/** Persistent sessions: listen again after holdMic() (re-acquiring the track if it was released). */
export function resumeMic(): void {
  const a = active
  if (!a || !a.o.persistent || !a.held) return
  a.held = false
  void unlockAudio()
  st().setVoice({ stt: 'warming-up', micError: null, micHeld: false })
  if (!getMicCapture().active) startCapture(a)
  openServer(a)
}

export function micHeldNow(): boolean {
  return active?.held ?? false
}

function wire(a: Active): void {
  const mine = (): boolean => active === a
  a.offs.push(
    ws.on('stt.state', (m) => {
      if (__VESPER_TEST__) logEvent({ t: m.t, state: m.state })
      if (!mine() || a.held) return
      if (!a.serverStarted) {
        // Before our first state, 'idle' belongs to the session we just replaced.
        if (m.state === 'warming-up' || m.state === 'listening' || m.state === 'transcribing') a.serverStarted = true
        else return
      }
      if (m.state === 'error') {
        // F35: the server has already ended its session. A persistent session (Talk mode) survives a transient error
        // (a cloud upload that failed twice, a crashed recognizer): say what was lost and listen again.
        const err = m.error ?? { code: 'stt_unavailable' as const, message: ERRORS.stt_unavailable.message, retryable: true }
        if (a.o.persistent && ERRORS[err.code]?.retryable) return lost(a, err)
        // Belt and braces: the server must not keep a session this client has given up on.
        return fail(a, err.code, true)
      }
      // A persistent session (Talk mode) outlives the server's: "send now" or an idle end opens the next one.
      if (m.state === 'idle') return a.o.persistent ? reopen(a) : endSession(a, a.stopping ? 'done' : 'server', false)
      if (m.state === 'listening' && st().voice.stt !== 'listening' && st().voice.stt !== 'transcribing' && a.o.mode !== 'dictate') earcon('start')
      st().setVoice({ stt: m.state, ...(m.state !== 'listening' ? { countdown: null } : {}) })
    }),
    ws.on('stt.vad', (m) => {
      if (__VESPER_TEST__) logEvent({ t: m.t, speaking: m.speaking, endpointInMs: m.endpointInMs })
      if (!mine() || !a.serverStarted || a.held) return
      const v = st().voice
      // Voice barge-in (07 C15): the server only reports speech during TTS after 300 ms of it.
      if (m.speaking && v.ttsActive && bargeInMode() === 'voice') interruptSpeech()
      const c = v.autoSendCancelled ? null : countdownFor({ mode: a.o.mode, speaking: m.speaking, endpointInMs: m.endpointInMs, now: performance.now() })
      const autoSend = a.o.mode !== 'dictate' || !!st().settings?.voice.stt.autoSendDictation
      st().setVoice({ countdown: c ? { ...c, autoSend } : null })
    }),
    ws.on('stt.partial', (m) => {
      if (mine() && a.serverStarted && !a.held) st().setVoice({ partial: m.text })
    }),
    ws.on('stt.final', (m) => {
      if (__VESPER_TEST__) logEvent({ t: m.t, autoSend: m.autoSend })
      if (!mine() || !a.serverStarted || a.held) return
      onFinal(a, m.text, m.autoSend)
    }),
    ws.on('reply.done', (m) => replyOver(a, m.replyId)),
    ws.on('reply.error', (m) => {
      if (m.replyId) replyOver(a, m.replyId)
    }),
    ws.on('reply.status', (m) => {
      if (m.state === 'stopped' || m.state === 'error') replyOver(a, m.replyId)
    }),
    ws.onStatus((info) => {
      if (!mine()) return
      if (a.o.persistent) {
        // The socket dropped: the server closed its STT session. Talk mode keeps the track and reopens when back.
        if (info.status !== 'ready') {
          a.gen++
          a.acked = false
          a.serverStarted = false
        } else if (!a.held && !a.acked) openServer(a)
        return
      }
      // The socket dropped: the server already closed this mic session.
      if (info.status !== 'ready') fail(a, 'stt_unavailable', false)
    }),
    useStore.subscribe((s, prev) => {
      if (s.voice.ttsActive !== prev.voice.ttsActive && mine()) syncTtsActive(a)
    })
  )
  const onKey = (e: KeyboardEvent): void => {
    if (!mine() || !isTypingKey(e)) return
    const t = e.target
    // Keys pressed on the mic button itself (Space/Enter to talk) are not typing.
    if (t instanceof Element && t.closest('[data-mic-control]')) return
    cancelAutoSend()
  }
  const onInput = (e: Event): void => {
    const t = e.target
    if (mine() && t instanceof Element && t.closest('[data-composer], .composer')) cancelAutoSend()
  }
  const onVisibility = (): void => {
    // 07 B17: the mic stops when the window is hidden (a persistent session's owner holds it and releases the track).
    if (mine() && !a.o.persistent && document.visibilityState === 'hidden') endSession(a, 'hidden', true)
  }
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('visibilitychange', onVisibility)
  a.offs.push(() => {
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('visibilitychange', onVisibility)
  })
}

function replyOver(a: Active, replyId: string): void {
  if (active !== a) return
  if (a.awaiting === replyId) a.awaitingDone = true
  a.over.add(replyId)
  if (a.over.size > 20) a.over.delete(a.over.values().next().value as string)
}

/** The user typed while listening: the transcript goes into the composer instead of being sent. */
export function cancelAutoSend(): void {
  if (!active) return
  const v = st().voice
  if (v.autoSendCancelled && v.countdown === null) return
  st().setVoice({ autoSendCancelled: true, countdown: null })
}

function onFinal(a: Active, text: string, autoSend: boolean): void {
  const canSend = a.o.sessionUid !== null || !!a.o.onSend
  const act = finalAction({ mode: a.o.mode, autoSend, cancelled: st().voice.autoSendCancelled, text, canSend })
  st().setVoice({ countdown: null, partial: '', autoSendCancelled: false })
  if (text.trim()) a.o.onEvent?.({ t: 'final', text: text.trim(), autoSend: act === 'send' })
  if (act === 'send') send(a, text.trim())
  else if (act === 'compose') a.o.onText?.(text.trim())
  if (endsAfterFinal(a.o.mode)) endSession(a, 'done', !a.stopping)
}

function send(a: Active, text: string): void {
  if (a.o.onSend && a.o.mode !== 'conversation') return a.o.onSend(text)
  const sessionUid = a.o.sessionUid
  if (!sessionUid) return a.o.onText?.(text)
  // Talk mode is a spoken conversation: replies are spoken whenever a voice is set up, whatever "speak replies" says
  // for typed messages on this device.
  const speak = a.o.talk ? talkSpeak() : speakFlag()
  if (a.o.mode === 'conversation') {
    a.awaiting = 'pending'
    a.awaitingDone = false
  }
  ws.request({
    t: 'chat.send',
    sessionUid,
    text,
    attachments: [],
    client: clientClock(),
    speak,
    // Voice barge-in may talk over a running reply: the new turn replaces it (07 C16 interrupt).
    ...(bargeInMode() === 'voice' ? { interrupt: true } : {}),
    ...(a.o.talk ? { talk: true } : {})
  }).then(
    (ack) => {
      if (speak) expectSpeech(ack.replyId)
      if (active === a && a.awaiting === 'pending') {
        a.awaiting = ack.replyId ?? null
        if (a.awaiting && a.over.has(a.awaiting)) a.awaitingDone = true
      }
      if (active === a) a.o.onEvent?.({ t: 'sent', text, replyId: ack.replyId ?? null, messageUid: ack.messageUid ?? null })
    },
    (e: unknown) => {
      if (active === a && a.awaiting === 'pending') a.awaiting = null
      const err = toApiError(e)
      if (a.o.onEvent) a.o.onEvent({ t: 'send-failed', error: err })
      else toast.error(err.message)
      // Nothing said is lost: it goes into the composer.
      a.o.onText?.(text)
    }
  )
}

/**
 * Finish the utterance: push-to-talk release ('released') or "send now" ('send'). The final transcript still
 * arrives; the session closes after it (or after STOP_GRACE_MS).
 */
export function finishMic(reason: 'released' | 'send' = 'released'): void {
  const a = active
  if (!a || a.stopping) return
  if (a.o.persistent) {
    // Talk mode "send now": the server ends this utterance (final, then idle → the next session opens); the track stays.
    if (!a.held && a.acked) {
      st().setVoice({ countdown: null })
      ws.send({ t: 'stt.stop', reason })
    }
    return
  }
  a.stopping = true
  st().setVoice({ countdown: null })
  const go = (): void => {
    if (active !== a) return
    ws.send({ t: 'stt.stop', reason })
    getMicCapture().stop()
    setTimer(a, () => endSession(a, 'timeout', true), STOP_GRACE_MS)
  }
  // Push-to-talk: keep the last ~150 ms (people release right on their last word).
  if (reason === 'released' && a.o.mode === 'ptt' && a.acked) setTimer(a, go, 150)
  else go()
}

/** Drop the utterance and close the session. */
export function cancelMic(): void {
  if (active) endSession(active, 'cancelled', true)
}

/** End the session only if `owner` started it (a control unmounting must not end someone else's session). */
export function cancelMicOf(owner: object): void {
  if (active && active.o.owner === owner) endSession(active, 'cancelled', true)
}

export function micOwner(): object | null {
  return active?.o.owner ?? null
}

function fail(a: Active, code: ErrorCode, tellServer: boolean): void {
  if (active !== a) return
  endSession(a, 'error', tellServer, code)
}

function endSession(a: Active, reason: EndReason, tellServer: boolean, error?: ErrorCode): void {
  if (active !== a) return
  active = null
  for (const off of a.offs.splice(0)) off()
  clearTimers(a)
  a.early = []
  getMicCapture().stop()
  // Also right after stt.start (not yet acked): the server handles messages in order, so the cancel follows it.
  if (tellServer) ws.send({ t: 'stt.cancel' })
  if (!error && reason !== 'replaced' && a.o.mode !== 'dictate' && a.serverStarted) earcon('stop')
  st().setVoice({
    stt: error ? 'error' : 'idle',
    micError: error ?? null,
    micMode: null,
    micSessionUid: null,
    partial: '',
    countdown: null,
    autoSendCancelled: false,
    micHeld: false
  })
  if (__VESPER_TEST__) {
    ended.push({ id: a.id, reason })
    if (ended.length > 100) ended.shift()
  }
  a.o.onEnd?.(reason)
}

/** Clear a shown mic error (the user dismissed the help). */
export function clearMicError(): void {
  if (!active && st().voice.micError) st().setVoice({ micError: null, stt: 'idle' })
}

/** Leak counters (07 D14): all zero / false when no session is open. */
export function micSessionStats(): { active: boolean; persistent: boolean; held: boolean; listeners: number; timers: number; early: number; capture: boolean; frames: number; sent: number; ended: Array<{ id: number; reason: EndReason }> } {
  return {
    active: active !== null,
    persistent: active?.o.persistent ?? false,
    held: active?.held ?? false,
    listeners: active?.offs.length ?? 0,
    timers,
    early: active?.early.length ?? 0,
    capture: getMicCapture().active,
    frames: active?.frames ?? 0,
    sent: active?.sent ?? 0,
    ended: [...ended]
  }
}
