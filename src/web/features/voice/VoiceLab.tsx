/**
 * '/voice-lab' — test builds only (07 B10): the voice client on its own, for e2e and screenshots while the composer
 * and the wizard shell are built in parallel. Views (?view=):
 *   composer  — a message box with <MicControl>, plus the latest reply of ?session= rendered from
 *               useReplySpeech (heldText + registerRevealRoot, as chat-ui does) with "interrupted · show rest";
 *   wizard-out / wizard-in — the wizard steps 4 and 5 inside a wizard-like card.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { IconButton } from '../../components/IconButton'
import type { PageProps } from '../../app/routes'
import { registerRevealRoot, getRevealController } from '../../lib/audio'
import { useLocation } from '../../lib/router'
import { clientClock, ws } from '../../lib/ws'
import { MicControl } from './MicControl'
import { useReplySpeech } from './replySpeech'
import { expectSpeech, speakFlag } from './speechClient'
import WizardVoiceIn from './WizardVoiceIn'
import WizardVoiceOut from './WizardVoiceOut'
import { StepPreview } from '../wizard/NavBar'
import type { MicMode } from './mic.logic'
import '../chat/chat.css'
import './lab.css'

export default function VoiceLab(_props: PageProps): ReactNode {
  const { search } = useLocation()
  const q = new URLSearchParams(search)
  const view = q.get('view') ?? 'composer'
  if (view === 'wizard-out' || view === 'wizard-in') {
    const Step = view === 'wizard-out' ? WizardVoiceOut : WizardVoiceIn
    return (
      <div className="vlab vlab--wizard">
        <div className="vlab__card">
          <StepPreview step={Step} onNext={() => undefined} onBack={() => undefined} onSkip={() => undefined} />
        </div>
      </div>
    )
  }
  return <ComposerLab sessionUid={q.get('session')} mode={(q.get('mode') as MicMode | null) ?? undefined} />
}

function ComposerLab({ sessionUid, mode }: { sessionUid: string | null; mode?: MicMode }): ReactNode {
  const [text, setText] = useState('')
  const [replyId, setReplyId] = useState<string | null>(null)
  const [sent, setSent] = useState<string[]>([])

  useEffect(() => {
    if (!sessionUid) return
    const unsub = ws.subscribe(sessionUid)
    const off = ws.on('reply.status', (m) => {
      if (m.sessionUid === sessionUid) setReplyId(m.replyId)
    })
    return () => {
      off()
      unsub()
    }
  }, [sessionUid])

  const send = async (t: string): Promise<void> => {
    if (!sessionUid || !t.trim()) return
    setSent((s) => [...s, t])
    setText('')
    const speak = speakFlag()
    const ack = await ws.request({ t: 'chat.send', sessionUid, text: t, attachments: [], client: clientClock(), speak })
    if (speak) expectSpeech(ack.replyId)
  }

  return (
    <div className="vlab">
      <header className="vlab__bar">
        <h1>Voice lab</h1>
      </header>
      <div className="vlab__feed" data-testid="lab-feed">
        {sent.map((s, i) => (
          <p key={i} className="vlab__user">
            {s}
          </p>
        ))}
        {replyId ? <LabReply replyId={replyId} sessionUid={sessionUid} /> : null}
      </div>
      <form
        className="composer vlab__composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send(text)
        }}
      >
        <div className="composer__box">
          {/* The real composer's structure (chat.css), so the lab looks and lays out like the chat. */}
          <div className="composer__row">
            <div className="composer__field">
              <textarea
                className="composer__input textarea"
                data-composer=""
                rows={1}
                value={text}
                aria-label="Message"
                placeholder="Message Vesper…"
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <MicControl sessionUid={sessionUid} mode={mode} onText={(t) => setText((cur) => (cur ? `${cur} ${t}` : t))} onSend={(t) => void send(t)} />
            <IconButton type="submit" label="Send" icon={<ArrowUp />} variant="primary" disabled={!text.trim()} />
          </div>
        </div>
      </form>
    </div>
  )
}

/** Renders a reply the way chat-ui does: heldText while this device speaks it (revealed in sync), else the text. */
function LabReply({ replyId, sessionUid }: { replyId: string; sessionUid: string | null }): ReactNode {
  const speech = useReplySpeech(replyId)
  const ref = useRef<HTMLDivElement>(null)
  const [deltas, setDeltas] = useState('')
  const [shown, setShown] = useState(false)
  useEffect(() => {
    setDeltas('')
    setShown(false)
    const offD = ws.on('reply.delta', (m) => m.replyId === replyId && setDeltas((d) => d + m.text))
    const offDone = ws.on('reply.done', (m) => m.replyId === replyId && setDeltas(m.message.body))
    return () => {
      offD()
      offDone()
    }
  }, [replyId, sessionUid])
  const synced = speech.heldText !== null
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !synced) return
    return registerRevealRoot(replyId, el, speech.headers)
    // Bound once per reply: later chunk headers are picked up from the engine.
  }, [replyId, synced])
  const interrupted = speech.state === 'interrupted'
  return (
    <article className="vlab__reply" data-testid="lab-reply" data-speech={speech.state}>
      <div ref={ref} className="vlab__text" data-testid="lab-reply-text">
        {synced ? speech.heldText : deltas}
      </div>
      {interrupted && !shown ? (
        <button
          type="button"
          className="vlab__rest"
          onClick={() => {
            getRevealController().finish(replyId)
            setShown(true)
          }}
        >
          — interrupted · show rest
        </button>
      ) : null}
      <p className="vlab__meta">speech: {speech.state}</p>
    </article>
  )
}
