/**
 * <MicControl> — frozen signature (07 E4, BLD-4): the mic button for the composer and Talk mode (R19).
 *
 * Modes (research 07 §3.2): dictate (tap; the transcript goes into the composer, or is sent when "auto-send" is on),
 * push-to-talk (hold the button, or Space/Enter while it is focused; sends on release), conversation (hands-free:
 * sends after the silence wait, listens again 250 ms after the reply's voice ends). Around the button: the live input
 * level and the countdown ring of the silence wait (typing cancels the auto-send). Above it, a small bubble with the
 * state and the live partial transcript. Errors (denied, blocked by Windows, insecure origin, no model) open clear
 * help instead of a dead button.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, AudioLines, Check, Lock, Mic, MicOff } from 'lucide-react'
import { Button } from '../../components/Button'
import { Popover } from '../../components/Popover'
import { Spinner } from '../../components/Spinner'
import { Tooltip } from '../../components/Tooltip'
import { cx } from '../../components/internal/cx'
import { usePosition } from '../../components/internal/usePosition'
import { getMicCapture } from '../../lib/audio'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { countdownLeft, micHelp, micLabel, type MicMode } from './mic.logic'
import { cancelMic, cancelMicOf, clearMicError, finishMic, micPlaceOf, micPreflight, prewarmStt, startMic } from './micSession'
import './mic.css'

export type { MicMode } from './mic.logic'

export interface MicControlProps {
  /** Session the utterance belongs to (null = outside a chat, e.g. a settings try-it area). */
  sessionUid: string | null
  /** Defaults to the `voice.stt.mode` setting. */
  mode?: MicMode
  size?: 'md' | 'lg'
  /** Final transcript (dictation fills the composer; conversation mode sends by itself). */
  onText?: (text: string) => void
  disabled?: boolean
  className?: string
  /** Optional (additive): auto-sends go through the composer instead of a direct chat.send (dictation, push-to-talk). */
  onSend?: (text: string) => void
  /** Optional (additive): Talk mode — replies use the fast voice (07 D6). */
  talk?: boolean
}

const RING_R = 21
const RING_C = 2 * Math.PI * RING_R

export function MicControl({ sessionUid, mode: modeProp, size = 'md', onText, onSend, talk, disabled, className }: MicControlProps): ReactNode {
  const owner = useRef({}).current
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [mine, setMine] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const pttDownAt = useRef(0)
  const textRef = useRef(onText)
  const sendRef = useRef(onSend)
  textRef.current = onText
  sendRef.current = onSend

  const sttSettings = useStore((s) => s.settings?.voice.stt)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const v = useStore((s) => s.voice)
  const assistant = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const mode: MicMode = modeProp ?? sttSettings?.mode ?? 'dictate'
  const enabled = sttSettings?.enabled ?? false

  const preflight = micPreflight()
  const live = mine && v.micMode !== null
  const state = live ? v.stt : 'idle'
  const error = !live ? v.micError : null
  const insecure = preflight === 'insecure_context'
  const problem = insecure ? 'insecure_context' : error
  const needsSetup = !enabled && !problem
  const countdownKind = live && v.countdown ? (v.countdown.autoSend ? 'send' : 'finish') : null

  // A control that goes away (composer unmounts, route change) takes its session with it (privacy).
  useEffect(() => () => cancelMicOf(owner), [owner])

  useMicLevel(wrapRef, live && (state === 'listening' || state === 'warming-up' || state === 'transcribing'))

  // Push-to-talk hint ("hold to talk") disappears by itself.
  useEffect(() => {
    if (!hint) return
    const h = window.setTimeout(() => setHint(null), 2400)
    return () => window.clearTimeout(h)
  }, [hint])

  const begin = (): void => {
    if (disabled) return
    setHint(null)
    setMine(true)
    startMic({
      mode,
      sessionUid,
      owner,
      talk,
      onText: (t) => textRef.current?.(t),
      onSend: sendRef.current ? (t) => sendRef.current?.(t) : undefined,
      onEnd: () => setMine(false)
    })
  }

  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    // Problems and "not set up" open the help popover (the Popover toggles unless we prevent it).
    if (problem || needsSetup) return
    e.preventDefault()
    if (mode === 'ptt') return
    if (!live) return begin()
    if (v.countdown) return finishMic('send')
    if (mode === 'conversation') return cancelMic()
    finishMic('released')
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (mode !== 'ptt' || problem || needsSetup || e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pttDownAt.current = performance.now()
    begin()
  }
  const onPointerUp = (): void => {
    if (mode !== 'ptt' || !pttDownAt.current) return
    const held = performance.now() - pttDownAt.current
    pttDownAt.current = 0
    if (held < 250) {
      cancelMic()
      setHint('Hold the button while you talk')
      return
    }
    finishMic('released')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape' && live) {
      e.preventDefault()
      e.stopPropagation()
      cancelMic()
      return
    }
    if (mode !== 'ptt' || problem || needsSetup || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault()
    if (e.repeat || pttDownAt.current) return
    pttDownAt.current = performance.now()
    begin()
  }
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (mode !== 'ptt' || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault()
    onPointerUp()
  }

  // A problem left by an ended session is in the name too (the red dot is aria-hidden; review F51).
  const label = needsSetup ? 'Voice input is off' : micLabel({ mode, state: error ? 'error' : state, countdown: countdownKind, insecure })
  const icon =
    problem || needsSetup ? (
      <MicOff />
    ) : state === 'warming-up' ? (
      <Spinner size={size === 'lg' ? 18 : 16} />
    ) : countdownKind === 'send' ? (
      <ArrowUp />
    ) : countdownKind === 'finish' ? (
      <Check />
    ) : mode === 'conversation' && !live ? (
      <AudioLines />
    ) : (
      <Mic />
    )

  const leftFrac = useCountdownLeft(v.countdown, live)
  const button = (
    <button
      ref={btnRef}
      type="button"
      data-mic-control=""
      data-state={problem ? 'error' : state}
      data-mode={mode}
      aria-label={label}
      aria-pressed={mode === 'ptt' ? live : undefined}
      disabled={disabled}
      className={cx('mic-btn', `mic-btn--${size}`, live && 'is-live', error && 'is-problem', (needsSetup || insecure) && 'is-off')}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerEnter={() => enabled && !problem && prewarmStt()}
      onFocus={() => enabled && !problem && prewarmStt()}
      onContextMenu={mode === 'ptt' ? (e) => e.preventDefault() : undefined}
    >
      <span className="mic-btn__level" aria-hidden="true" />
      <span className="mic-btn__icon" aria-hidden="true">
        {icon}
      </span>
      {insecure ? (
        <span className="mic-btn__badge" aria-hidden="true">
          <Lock />
        </span>
      ) : error ? (
        <span className="mic-btn__dot" aria-hidden="true" />
      ) : null}
    </button>
  )

  const status = statusText({ state, mode, live, countdown: countdownKind, cancelled: v.autoSendCancelled, held: v.micHeld, tts: v.ttsActive, assistant })

  return (
    <span ref={wrapRef} className={cx('mic', `mic--${size}`, className)} data-testid="mic-control">
      {v.countdown && live ? (
        <svg className="mic__ring" viewBox="0 0 48 48" aria-hidden="true">
          <circle className="mic__ring-track" cx="24" cy="24" r={RING_R} />
          <circle className="mic__ring-fill" cx="24" cy="24" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - leftFrac)} />
        </svg>
      ) : null}
      {problem || needsSetup ? (
        <Popover
          trigger={button}
          open={helpOpen}
          onOpenChange={(o) => {
            setHelpOpen(o)
            if (!o && error) clearMicError()
          }}
          placement="top-end"
          width={340}
          title={needsSetup ? 'Voice input is off' : micHelp(problem as string, micPlaceOf(desktop)).title}
          className="mic-help"
        >
          {(close) => (needsSetup ? <SetupHelp desktop={desktop} close={close} /> : <ProblemHelp code={problem as string} desktop={desktop} close={close} retry={begin} />)}
        </Popover>
      ) : (
        <Tooltip content={label} describe={false} disabled={live}>
          {button}
        </Tooltip>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {live ? status.announce : ''}
      </span>
      <MicBubble anchor={btnRef} open={(live && state !== 'idle') || !!hint} status={hint ?? status.line} partial={live ? v.partial : ''} tone={v.autoSendCancelled ? 'muted' : 'normal'} />
    </span>
  )
}

function statusText(o: { state: string; mode: MicMode; live: boolean; countdown: 'send' | 'finish' | null; cancelled: boolean; held: boolean; tts: boolean; assistant: string }): { line: string; announce: string } {
  if (!o.live) return { line: '', announce: '' }
  if (o.state === 'warming-up') return { line: 'Starting the microphone…', announce: 'Starting the microphone' }
  if (o.state === 'transcribing') return { line: 'Transcribing…', announce: 'Transcribing' }
  if (o.cancelled) return { line: "Won't send — the text will go to the message box", announce: 'Auto-send cancelled' }
  if (o.countdown === 'send') return { line: 'Sending soon — keep talking, or type to edit first', announce: 'Sending soon' }
  if (o.countdown === 'finish') return { line: 'Finishing — keep talking to add more', announce: 'Finishing' }
  if (o.held) return o.tts ? { line: `${o.assistant} is speaking — I'll listen when she's done`, announce: `${o.assistant} is speaking` } : { line: 'Waiting for the reply…', announce: 'Waiting for the reply' }
  if (o.mode === 'ptt') return { line: 'Listening — release to send', announce: 'Listening' }
  if (o.mode === 'conversation') return { line: 'Listening — just talk', announce: 'Listening' }
  return { line: 'Listening…', announce: 'Listening' }
}

/** The countdown share left, ticking at 10 fps (CSS smooths it; reduced motion shows the steps). */
function useCountdownLeft(c: { endsAt: number; totalMs: number } | null, live: boolean): number {
  const [left, setLeft] = useState(1)
  useEffect(() => {
    if (!c || !live) return
    setLeft(countdownLeft(c, performance.now()))
    const h = window.setInterval(() => setLeft(countdownLeft(c, performance.now())), 100)
    return () => window.clearInterval(h)
  }, [c, live])
  return left
}

/** Writes the input level into `--mic-level` once per frame while listening (no React render per frame). */
function useMicLevel(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const levels = { rms: 0, low: 0, mid: 0, high: 0, onset: 0 }
    const input = getMicCapture().input
    let frame = 0
    let last = -1
    const tick = (): void => {
      input.read(levels)
      // Speech RMS sits low on the linear scale: lift it so normal talking fills most of the ring.
      const x = Math.min(1, Math.sqrt(levels.rms) * 1.6)
      const q = Math.round(x * 50) / 50
      if (q !== last) {
        last = q
        el.style.setProperty('--mic-level', String(q))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.style.removeProperty('--mic-level')
    }
  }, [ref, on])
}

function MicBubble({ anchor, open, status, partial, tone }: { anchor: RefObject<HTMLElement | null>; open: boolean; status: string; partial: string; tone: 'normal' | 'muted' }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  usePosition(open, anchor, ref, { placement: 'top-end', offset: 12 })
  if (!open) return null
  return createPortal(
    <div ref={ref} className={cx('popup', 'glass', 'mic-bubble', tone === 'muted' && 'is-muted')} aria-hidden="true" data-testid="mic-bubble">
      <p className="mic-bubble__status">
        <span className="mic-bubble__dot" />
        {status}
      </p>
      {partial ? <p className="mic-bubble__partial">{partial}</p> : null}
    </div>,
    document.body
  )
}

function SetupHelp({ desktop, close }: { desktop: boolean; close: () => void }): ReactNode {
  return (
    <>
      <p>Talk instead of typing: your voice is turned into text on your PC.</p>
      {desktop ? (
        <div className="mic-help__actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              close()
              navigate('/settings/voice-in')
            }}
          >
            Set up voice input
          </Button>
        </div>
      ) : (
        <p className="mic-help__note">Turn it on in Vesper on your PC: Settings → Voice in.</p>
      )}
    </>
  )
}

function ProblemHelp({ code, desktop, close, retry }: { code: string; desktop: boolean; close: () => void; retry: () => void }): ReactNode {
  const h = micHelp(code, micPlaceOf(desktop))
  return (
    <>
      <p>{h.body}</p>
      {h.steps.length ? (
        <ol className="mic-help__steps">
          {h.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      <div className="mic-help__actions">
        {h.action === 'open-windows-privacy' && window.vesperDesktop?.openExternal ? (
          <Button size="sm" variant="primary" onClick={() => void window.vesperDesktop?.openExternal?.('ms-settings:privacy-microphone')}>
            Open Windows settings
          </Button>
        ) : null}
        {h.action === 'settings-access' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              close()
              navigate('/settings/access')
            }}
          >
            Open access settings
          </Button>
        ) : null}
        {h.action === 'settings-voice-in' && desktop ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              close()
              navigate('/settings/voice-in')
            }}
          >
            Open voice settings
          </Button>
        ) : null}
        {h.action === 'retry' || h.action === 'open-windows-privacy' ? (
          <Button
            size="sm"
            onClick={() => {
              close()
              clearMicError()
              retry()
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </>
  )
}
