/**
 * The speech client (R14, 07 C14–C16): binds the WebSocket and the AudioEngine to the SpeechTracker and publishes
 * each reply's speech into the store for `useReplySpeech`. Installed once per page by `installVoiceClient()`.
 *
 * - binary kind-1 frames → engine.enqueue(header, copy of the payload) (decoding detaches the buffer);
 * - speech.end / speech.error / speech.degraded / targeted reply.snapshot → done / failed (text-first + a toast);
 * - engine chunkEnd → `speech.played` acks; chunkStart/replyEnd → `voice.speakingReplyId`, `voice.ttsActive`;
 * - barge-in (07 C15): typing in the composer, Stop, or the mic's voice barge-in → speech.cancel + engine.stop, the
 *   reveal freezes ("— interrupted · show rest");
 * - the AudioContext is unlocked on the first user gesture (only when a voice is set up), and the server is told
 *   (`client.state.audioUnlocked`) so perDevice 'all' can route speech here.
 */
import type { ApiError } from '@shared/errors'
import { BIN_KIND, type SpeechChunkHeader } from '@shared/ws'
import { toast } from '../../components/Toast'
import { getAudioEngine, getRevealController } from '../../lib/audio'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { setAudioUnlocked, ws } from '../../lib/ws'
import { effectiveAutoSpeak } from './prefs.logic'
import { getVoicePrefs, setVoicePrefs, subscribeVoicePrefs } from './prefs'
import { SpeechTracker, type FailReason } from './speech.logic'
import { speakRepliesNow } from '../sessions/speakReplies'

/** Don't stack "Voice unavailable" toasts when several replies fail in a row. */
const TOAST_GAP_MS = 30_000

let tracker: SpeechTracker | null = null
let offs: Array<() => void> = []
let lastToastAt = 0
let liveTimers = 0
let unlockWired: (() => void) | null = null

function isHeader(h: unknown): h is SpeechChunkHeader {
  if (!h || typeof h !== 'object') return false
  const o = h as Partial<SpeechChunkHeader>
  return typeof o.replyId === 'string' && typeof o.index === 'number' && Array.isArray(o.src) && typeof o.text === 'string'
}

function textFirstMode(): boolean {
  return useStore.getState().settings?.voice.tts.reveal === 'text-first'
}

function createTracker(): SpeechTracker {
  const st = useStore.getState
  return new SpeechTracker({
    setTimer: (fn, ms) => {
      liveTimers++
      return window.setTimeout(() => {
        liveTimers--
        fn()
      }, ms)
    },
    clearTimer: (h) => {
      liveTimers--
      window.clearTimeout(h as number)
    },
    effects: {
      enqueue: (h, payload) => getAudioEngine().enqueue(h, payload.slice().buffer),
      stop: (replyId) => getAudioEngine().stop(replyId),
      finishReveal: (replyId) => getRevealController().finish(replyId),
      finalize: (replyId, lastIndex) => getAudioEngine().finalize(replyId, lastIndex),
      sendCancel: (replyId, spokenChars, beforeAudio) => {
        ws.send({ t: 'speech.cancel', replyId, spokenChars, ...(beforeAudio ? { beforeAudio } : {}) })
        if (__VESPER_TEST__) {
          sentCancels.push({ replyId, spokenChars, beforeAudio })
          if (sentCancels.length > 50) sentCancels.shift()
        }
      },
      sendPlayed: (replyId, index, revealedChars) => void ws.send({ t: 'speech.played', replyId, index, revealedChars }),
      unavailable: (replyId, reason) => voiceUnavailable(replyId, reason),
      publish: (replyId, speech) => {
        // Text-first mode (Settings → reveal): the text comes from reply.delta; speech only adds audio.
        if (speech && textFirstMode() && speech.heldText !== null) speech = { ...speech, heldText: null }
        st().setReplySpeech(replyId, speech)
      }
    }
  })
}

function voiceUnavailable(replyId: string, reason: FailReason): void {
  useStore.getState().setVoice({ degraded: true })
  // Our own 6 s rule gave up (07 C14): ask the server for the text now (a targeted snapshot, then deltas) instead of
  // waiting for reply.done. The other failure reasons came from the server, which already switched us to text.
  if (reason === 'timeout') ws.send({ t: 'speech.textFirst', replyId })
  const now = Date.now()
  if (now - lastToastAt < TOAST_GAP_MS) return
  lastToastAt = now
  const why = reason === 'degraded' ? 'The connection is too slow for audio' : reason === 'timeout' ? "The voice didn't arrive in time" : "The voice couldn't be generated"
  toast.warning(`Voice unavailable. ${why}, so this reply is shown as text.`)
  if (__VESPER_TEST__) lastFailures.push({ replyId, reason })
}

const lastFailures: Array<{ replyId: string; reason: FailReason }> = []
const sentCancels: Array<{ replyId: string; spokenChars: number; beforeAudio: boolean }> = []

function getTracker(): SpeechTracker {
  tracker ??= createTracker()
  return tracker
}

// ── public API ────────────────────────────────────────────────────────────────────────────────

/** Whether replies to this device should be spoken now: a voice is set up and "speak replies" is on here. */
export function wantSpeech(): boolean {
  // One answer for the whole client (features/sessions/speakReplies.ts): it must match what the composer sent.
  return speakRepliesNow()
}

/**
 * The `speak` flag for chat.send / chat.regenerate / chat.edit (chat-ui, Talk mode). Also unlocks audio from the
 * calling gesture. Pair with `expectSpeech(ack.replyId)` when it returned true.
 */
export function speakFlag(): boolean {
  const on = wantSpeech()
  if (on) void unlockAudio()
  return on
}

/**
 * The `speak` flag for Talk mode (07 D6): a spoken conversation speaks whenever a voice is set up, whatever the
 * per-device "speak replies" says for typed messages. Unlocks audio from the calling gesture.
 */
export function talkSpeak(): boolean {
  const on = !!useStore.getState().settings?.voice.tts.enabled
  if (on) void unlockAudio()
  return on
}

/** How long a /continue's opener may take to start before this client stops waiting to claim it (P22). */
const EXPECT_IN_MS = 60_000
let expectIn: { sessionUid: string; until: number } | null = null

/**
 * The next reply in `sessionUid` is spoken here (P22: the /continue opener, started by the server with `speak` for
 * this device). Its id is not known yet: the first reply.status / subscribed in-flight reply of that chat claims it.
 */
export function expectSpeechIn(sessionUid: string): void {
  if (textFirstMode()) return
  expectIn = { sessionUid, until: Date.now() + EXPECT_IN_MS }
}

function claimExpected(sessionUid: string, replyId: string): void {
  if (!expectIn || expectIn.sessionUid !== sessionUid) return
  const live = Date.now() < expectIn.until
  expectIn = null
  if (live) expectSpeech(replyId)
}

/** This client asked for `replyId` to be spoken: track it from now (state 'waiting'). */
export function expectSpeech(replyId: string | undefined | null): void {
  if (!replyId || textFirstMode()) return
  useStore.getState().setVoice({ degraded: false })
  getTracker().expect(replyId)
}

/**
 * Barge-in (07 C15): stop every reply speaking on this device (speech.cancel tells the server, which stops it on every
 * device and records how far it got). Returns true when something was speaking.
 */
export function interruptSpeech(): boolean {
  const t = getTracker()
  const now = getAudioEngine().now()
  let any = false
  for (const id of t.live()) any = t.bargeIn(id, now) || any
  return any
}

/** "Speak again" (speech.replay): plays the stored reply with synced reveal. Resolves with the replay's replyId. */
export async function speakAgain(messageUid: string): Promise<string | null> {
  void unlockAudio()
  interruptSpeech()
  try {
    const ack = await ws.request({ t: 'speech.replay', messageUid })
    if (!ack.replyId) return null
    expectSpeech(ack.replyId)
    useStore.getState().setReplay(messageUid, ack.replyId)
    return ack.replyId
  } catch (e) {
    const err: ApiError = toApiError(e)
    toast.error(err.code === 'not_found' ? "This reply can't be spoken again." : err.message)
    return null
  }
}

/** Resume/create the AudioContext (must run inside a user gesture the first time). */
export async function unlockAudio(): Promise<boolean> {
  const ok = await getAudioEngine().unlock()
  if (ok) setAudioUnlocked(true)
  return ok
}

/** Per-device "speak replies" (the top-bar toggle). */
export function setAutoSpeak(on: boolean): void {
  setVoicePrefs({ autoSpeak: on })
  if (on) void unlockAudio()
  else interruptSpeech()
}

function syncAutoSpeak(): void {
  const s = useStore.getState()
  const v = effectiveAutoSpeak(getVoicePrefs(), s.settings?.voice.tts.autoSpeak ?? true)
  s.setVoice({ autoSpeak: v })
}

// ── installation ──────────────────────────────────────────────────────────────────────────────

/** First pointer/key gesture unlocks audio, but only once a voice is set up (no AudioContext otherwise). */
function wireUnlock(): () => void {
  const onGesture = (): void => {
    if (!useStore.getState().settings?.voice.tts.enabled) return
    void unlockAudio().then((ok) => {
      if (ok) off()
    })
  }
  const off = (): void => {
    window.removeEventListener('pointerdown', onGesture, true)
    window.removeEventListener('keydown', onGesture, true)
    if (unlockWired === off) unlockWired = null
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
  unlockWired = off
  return off
}

/** Typing in the composer interrupts a speaking reply (07 C15), unless barge-in is off. */
function onComposerInput(e: Event): void {
  const t = e.target
  if (!(t instanceof Element) || !t.closest('[data-composer], .composer')) return
  if (useStore.getState().settings?.voice.stt.bargeIn === 'off') return
  // After this input event has been handled: stopping the voice updates the store at once, and a synchronous
  // re-render of the (controlled) composer before React saw the keystroke put the old text back — the first characters
  // typed over a speaking reply were lost (found with P22's e2e).
  window.setTimeout(() => void interruptSpeech(), 0)
}

export function installSpeechClient(): () => void {
  if (offs.length) return uninstallSpeechClient
  const t = getTracker()
  const engine = getAudioEngine()
  const st = useStore.getState
  syncAutoSpeak()
  offs = [
    ws.onBinary(BIN_KIND.speechChunk, (h, payload) => {
      if (isHeader(h)) t.chunk(h, payload)
    }),
    ws.on('reply.status', (m) => {
      claimExpected(m.sessionUid, m.replyId)
      t.status(m.replyId, m.state)
      // Stop pressed (here or elsewhere): the queued audio must not keep talking.
      if (m.state === 'stopped' && t.live().includes(m.replyId)) t.bargeIn(m.replyId, engine.now())
    }),
    // Fallback when a sender did not call expectSpeech(): a chat request acked while this device speaks replies is
    // expected to speak (a wrong guess is undone by the first reply.delta, which a synced speaker never gets).
    ws.on('ack', (m) => {
      if (m.replyId && m.messageUid && !m.replyId.startsWith('rp_') && wantSpeech() && !t.isExpected(m.replyId)) expectSpeech(m.replyId)
    }),
    ws.on('reply.delta', (m) => t.delta(m.replyId)),
    ws.on('reply.done', (m) => t.replyDone(m.replyId)),
    ws.on('reply.error', (m) => {
      if (m.replyId) t.replyError(m.replyId)
    }),
    ws.on('reply.snapshot', (m) => t.snapshot(m.reply.replyId, m.evSeq === 0)),
    ws.on('subscribed', (m) => {
      const r = m.inflight[0]
      if (r) claimExpected(m.sessionUid, r.replyId)
    }),
    ws.on('speech.preparing', (m) => t.preparing(m.replyId)),
    ws.on('speech.end', (m) => t.speechEnd(m.replyId)),
    ws.on('speech.error', (m) => t.speechError(m.replyId)),
    ws.on('speech.degraded', (m) => t.degraded(m.replyId)),
    ws.on('speech.stopped', (m) => t.stopped(m.replyId, engine.now())),
    engine.on('chunkStart', (e) => {
      t.chunkStart(e.replyId, e.index, e.at)
      st().setVoice({ speakingReplyId: e.replyId, ttsActive: true })
    }),
    engine.on('chunkEnd', (e) => t.chunkEnd(e.replyId, e.index)),
    engine.on('replyEnd', (e) => {
      t.replyEnd(e.replyId, e.interrupted)
      if (st().voice.speakingReplyId === e.replyId) st().setVoice({ speakingReplyId: null, ttsActive: engine.isPlaying() })
    }),
    engine.on('underrun', (e) => t.underrun(e.replyId, e.index)),
    subscribeVoicePrefs(syncAutoSpeak),
    useStore.subscribe((s, prev) => {
      if (s.settings?.voice.tts.autoSpeak !== prev.settings?.voice.tts.autoSpeak) syncAutoSpeak()
    }),
    wireUnlock()
  ]
  document.addEventListener('input', onComposerInput, true)
  offs.push(() => document.removeEventListener('input', onComposerInput, true))
  return uninstallSpeechClient
}

export function uninstallSpeechClient(): void {
  for (const off of offs) off()
  offs = []
  expectIn = null
  tracker?.reset()
}

/** Leak counters and state for tests (07 D14). */
export function speechClientStats(): { installed: boolean; listeners: number; unlockWired: boolean; timers: number; records: number; live: number } {
  const s = tracker?.stats() ?? { records: 0, timers: 0, live: 0 }
  return { installed: offs.length > 0, listeners: offs.length, unlockWired: unlockWired !== null, timers: liveTimers, records: s.records, live: s.live }
}

export function speechFailures(): Array<{ replyId: string; reason: FailReason }> {
  return [...lastFailures]
}

/** speech.cancel messages this client sent (test builds). */
export function speechCancels(): Array<{ replyId: string; spokenChars: number; beforeAudio: boolean }> {
  return [...sentCancels]
}
