/**
 * Setup wizard → finale (07 A4): the Star wakes and greets the owner by name — in the chosen voice when one is set up,
 * as the first synced reveal (text held until its audio plays, then revealed in time with it: 07 C14 / R14) — and
 * offers to pair a phone. Without a voice (or if the voice fails within 6 s) the greeting appears word by word.
 * Reaching the finale completes setup (`wizard.completed`), so a restart opens the chats.
 *
 * Owned resources: the sample request, the engine listeners, the reveal binding and the fallback timers are all
 * released on unmount; the Star's state is reset to idle.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, Smartphone } from 'lucide-react'
import { CSRF_HEADER } from '@shared/api'
import type { SpeechChunkHeader, SpeechMime } from '@shared/ws/binary'
import { Button } from '../../../components/Button'
import { Star } from '../../presence'
import { getAudioEngine, registerRevealRoot } from '../../../lib/audio'
import { navigate } from '../../../lib/router'
import { useStore } from '../../../lib/store'
import { flushSettings, setSetting } from '../../settings/save'
import { SHORT_WINDOW, useWizardNav } from '../nav'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import type { WizardStepProps } from '../steps'

const REPLY_ID = 'wizard-hello'
/** 07 C14: a chunk not ready within 6 s falls back to text. */
const VOICE_DEADLINE_MS = 6000

export type GreetingPhase = 'waiting' | 'speaking' | 'done'

export function greetingText(userName: string, assistantName: string): string {
  const who = userName.trim() ? `Hi ${userName.trim()}.` : 'Hi there.'
  return `${who} I’m ${assistantName || 'Vesper'}, and I’m glad you’re here. Ask me anything — I’ll remember what matters, and I’m here whenever you need me.`
}

function mimeOf(contentType: string | null): SpeechMime {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (t === 'audio/wav' || t === 'audio/x-wav' || t === 'audio/wave') return 'audio/wav'
  const l16 = /^audio\/l16;\s*rate=(\d+)/i.exec(contentType ?? '')
  if (l16) return `audio/L16;rate=${Number(l16[1])}`
  return 'audio/mpeg'
}

export default function WizardFinale(_props: WizardStepProps): ReactNode {
  const s = useStore((st) => st.settings)
  const userName = s?.profile.userName ?? ''
  const assistant = s?.profile.assistantName || 'Vesper'
  const voiceOn = !!s?.voice.tts.enabled
  const text = useRef(greetingText(userName, assistant)).current
  const [phase, setPhase] = useState<GreetingPhase>('waiting')
  const [mode, setMode] = useState<'voice' | 'text'>(voiceOn ? 'voice' : 'text')
  // Voice: the text stays hidden until the reveal controller holds it (then its highlight hides what isn't spoken yet).
  const [held, setHeld] = useState(voiceOn)
  const rootRef = useRef<HTMLParagraphElement>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  useWizardNav({ hideNav: true })
  const short = useMediaQuery(SHORT_WINDOW)

  // Setup is complete once the owner gets here (a restart now opens the chats).
  useEffect(() => {
    setSetting('wizard.completed', true, { immediate: true })
    setSetting('wizard.step', null, { immediate: true })
  }, [])

  useEffect(() => {
    const setStar = useStore.getState().setStarState
    let alive = true
    const timers: number[] = []
    const offs: Array<() => void> = []
    const ctl = new AbortController()

    const textReveal = (): void => {
      if (!alive) return
      setMode('text')
      setHeld(false)
      setPhase('speaking')
      setStar('speaking')
      const words = text.split(' ').length
      const reduce = document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches
      timers.push(
        window.setTimeout(
          () => {
            if (!alive) return
            setPhase('done')
            setStar('idle')
          },
          reduce ? 0 : words * 70 + 400
        )
      )
    }

    const speak = async (): Promise<void> => {
      const engine = getAudioEngine()
      const el = rootRef.current
      if (!el) return textReveal()
      // Hold the text until its audio plays, then reveal it in time with the voice (the first synced reveal).
      const header: SpeechChunkHeader = {
        sessionUid: '',
        evSeq: 0,
        replyId: REPLY_ID,
        index: 0,
        src: [0, text.length],
        text,
        spoken: text,
        timeline: null,
        durationMs: 0,
        mime: 'audio/mpeg',
        instant: false,
        final: true
      }
      const deadline = window.setTimeout(() => {
        ctl.abort()
        offs.splice(0).forEach((f) => f())
        engine.stop(REPLY_ID)
        textReveal()
      }, VOICE_DEADLINE_MS)
      timers.push(deadline)
      try {
        const res = await fetch('/api/tts/sample', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
          body: JSON.stringify({ text }),
          signal: ctl.signal
        })
        if (!res.ok) throw new Error(`sample ${res.status}`)
        const bytes = await res.arrayBuffer()
        if (!alive) return
        const h = { ...header, mime: mimeOf(res.headers.get('content-type')) }
        offs.push(registerRevealRoot(REPLY_ID, el, [h]))
        setHeld(false)
        offs.push(
          engine.on('chunkStart', (e) => {
            if (e.replyId !== REPLY_ID) return
            window.clearTimeout(deadline)
            setPhase('speaking')
            setStar('speaking')
          })
        )
        offs.push(
          engine.on('replyEnd', (e) => {
            if (e.replyId !== REPLY_ID || !alive) return
            setPhase('done')
            setStar('idle')
          })
        )
        await engine.unlock()
        engine.enqueue(h, bytes)
      } catch {
        if (!alive || ctl.signal.aborted) return
        window.clearTimeout(deadline)
        offs.splice(0).forEach((f) => f())
        textReveal()
      }
    }

    setStar('thinking')
    timers.push(window.setTimeout(() => (voiceOn ? void speak() : textReveal()), 700))
    return () => {
      alive = false
      ctl.abort()
      for (const t of timers) window.clearTimeout(t)
      for (const f of offs) f()
      getAudioEngine().stop(REPLY_ID)
      useStore.getState().setStarState('idle')
    }
  }, [text, voiceOn])

  useEffect(() => {
    if (phase === 'done') startRef.current?.focus({ preventScroll: true })
  }, [phase])

  const finish = async (to: string): Promise<void> => {
    await flushSettings()
    navigate(to, { replace: true })
  }

  const words = text.split(' ')
  return (
    <div className={`wiz-finale wiz-finale--${phase}`}>
      <div className="wiz-finale__star">
        <Star size={short ? 120 : 180} />
      </div>
      <h1 className="sr-only" tabIndex={-1}>
        {assistant} says hello
      </h1>
      {mode === 'voice' ? (
        <p className={`wiz-finale__greeting${held ? ' is-held' : ''}`} ref={rootRef} aria-live="off">
          {text}
        </p>
      ) : (
        <p className="wiz-finale__greeting wiz-finale__greeting--text" ref={rootRef} aria-label={text}>
          {words.map((w, i) => (
            <span key={i} className="wiz-word" style={{ '--i': i } as CSSProperties} aria-hidden="true">
              {w}{' '}
            </span>
          ))}
        </p>
      )}
      <p className="sr-only" role="status">
        {phase === 'done' ? text : ''}
      </p>
      <div className="wiz-finale__actions" inert={phase !== 'done'}>
        <Button ref={startRef} variant="primary" size="lg" iconRight={<ArrowRight />} onClick={() => void finish('/')}>
          Start chatting
        </Button>
        <Button variant="secondary" size="lg" icon={<Smartphone />} onClick={() => void finish('/settings/access')}>
          Pair your phone
        </Button>
      </div>
      <p className="wiz-finale__note" inert={phase !== 'done'}>
        Pair a phone to talk to {assistant} from anywhere in your home — or later from Settings → Access &amp; security.
      </p>
    </div>
  )
}
