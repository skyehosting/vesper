/**
 * Session panel (01 "Session panel", R8, R11): this chat's system prompt, memory (on/off, scope, private), the chats
 * the AI can access (links), voice and model overrides, and info (ID, dates, context, tokens, export, continue).
 * A column on the desktop, an edge sheet on phones (the shell decides). Commands and chips can open it at a section
 * (`setPanelOpen(true, 'memory')`). Code-split: loaded the first time it opens.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { BrainCircuit, Info, Link2, ScrollText, Volume2, X } from 'lucide-react'
import type { Session } from '@shared/types/domain'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Skeleton } from '../../components/Skeleton'
import { useStore } from '../../lib/store'
import type { PanelSection } from '../../lib/store/ui'
import { InfoSection } from './InfoSection'
import { LinksSection } from './LinksSection'
import { MemorySection } from './MemorySection'
import { PromptSection } from './PromptSection'
import { VoiceSection } from './VoiceSection'
import './panel.css'

const SECTIONS: { id: PanelSection; title: string; icon: ReactNode; render: (s: Session) => ReactNode; hideTemporary?: boolean }[] = [
  { id: 'prompt', title: 'System prompt', icon: <ScrollText />, render: (s) => <PromptSection session={s} /> },
  { id: 'memory', title: 'Memory', icon: <BrainCircuit />, render: (s) => <MemorySection session={s} />, hideTemporary: true },
  { id: 'links', title: 'AI can access', icon: <Link2 />, render: (s) => <LinksSection session={s} />, hideTemporary: true },
  { id: 'voice', title: 'Voice & model', icon: <Volume2 />, render: (s) => <VoiceSection session={s} /> },
  { id: 'info', title: 'Info', icon: <Info />, render: (s) => <InfoSection session={s} /> }
]

export default function SessionPanel({ onClose, phone }: { onClose: () => void; phone: boolean }): ReactNode {
  const uid = useStore((s) => s.activeSessionUid)
  const session = useStore((s) => s.activeSession)
  const error = useStore((s) => s.activeSessionError)
  const focus = useStore((s) => s.ui.panelFocus)
  const body = useRef<HTMLDivElement>(null)
  const loading = !!uid && !error && (!session || session.uid !== uid)

  // A chip or command asked for a section: bring it into view and move focus to its heading.
  useEffect(() => {
    if (!focus || loading) return
    const h = body.current?.querySelector<HTMLElement>(`[data-section="${focus}"] .psec__title`)
    if (h) {
      const still = document.documentElement.dataset.reduceMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      h.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
      h.focus({ preventScroll: true })
    }
    useStore.getState().clearPanelFocus()
  }, [focus, loading])

  return (
    <div className="panel">
      <div className={`panel__head${phone ? '' : ' app-drag'}`}>
        <h2 className="panel__title">This chat</h2>
        <IconButton label="Close chat panel" icon={<X />} size="sm" onClick={onClose} tooltipSide="bottom" />
      </div>
      <div className="panel__body" ref={body}>
        {!uid ? (
          <p className="panel__muted">Open a chat to see its settings.</p>
        ) : loading ? (
          <div className="panel__loading" data-loading>
            <span className="sr-only">Loading this chat’s settings</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="panel__skel">
                <Skeleton width="40%" height={12} />
                <Skeleton variant="rect" height={64} radius={10} />
              </div>
            ))}
          </div>
        ) : session ? (
          SECTIONS.filter((x) => !(x.hideTemporary && session.temporary)).map((x) => (
            <section key={x.id} className="psec" data-section={x.id} aria-labelledby={`psec-${x.id}`}>
              <h3 className="psec__title" id={`psec-${x.id}`} tabIndex={-1}>
                <span className="psec__icon" aria-hidden="true">
                  {x.icon}
                </span>
                {x.title}
              </h3>
              {x.render(session)}
            </section>
          ))
        ) : (
          <ErrorState compact error={error ?? 'not_found'} />
        )}
      </div>
    </div>
  )
}
