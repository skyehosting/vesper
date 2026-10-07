/**
 * '/talk/:uid' — Talk mode (07 D6): a calm, full-window stage for a spoken conversation. The big Star (the one canvas,
 * moved here), live captions — your words as you speak, Vesper's reply as it is revealed with the voice (chat barrel
 * <ReplyView>/<Transcript>) — and four controls: Talk/Interrupt (Space), Mute, Hold, End (Esc ends, or interrupts while
 * Vesper is answering). One mic track for the whole visit; speech models pre-warm on open; phones keep the screen on.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowUp, ChevronLeft, ExternalLink, Keyboard, Mic, MicOff, Pause, PhoneOff, Play, RotateCcw, Settings2, Square } from 'lucide-react'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { IconButton } from '../../components/IconButton'
import { Kbd } from '../../components/Kbd'
import { Spinner } from '../../components/Spinner'
import type { PageProps } from '../../app/routes'
import { getAudioEngine } from '../../lib/audio'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { useIsPhone, useMediaQuery } from '../../lib/useMediaQuery'
import { Transcript } from '../chat'
import { micHelp, micPlaceOf } from '../voice'
import { StarStage } from './StarStage'
import { TalkController, talkError } from './talk/controller'
import { primaryAction, TALK_PHASE_TEXT, talkErrorWayOut, type PrimaryAction, type TalkPlace, type TalkState } from './talk/talk.logic'
import './talk.css'

const PRIMARY: Record<PrimaryAction, { label: string; icon: ReactNode }> = {
  send: { label: 'Send now', icon: <ArrowUp /> },
  interrupt: { label: 'Interrupt', icon: <Square /> },
  talk: { label: 'Talk', icon: <Mic /> },
  hold: { label: 'Listening — pause', icon: <Mic /> },
  unmute: { label: 'Unmute', icon: <MicOff /> },
  retry: { label: 'Try again', icon: <RotateCcw /> },
  setup: { label: 'Set up voice input', icon: <Settings2 /> },
  none: { label: 'Getting ready', icon: <Mic /> }
}

export default function TalkPage({ params }: PageProps): ReactNode {
  const uid = params.uid ?? ''
  const phone = useIsPhone()
  const coarse = useMediaQuery('(pointer: coarse)')
  const [ctl] = useState(() => new TalkController({ sessionUid: uid, wakeLock: phone || coarse }))
  const s = useSyncExternalStore(ctl.subscribe, ctl.getState)
  const summary = useStore((st) => st.sessions.items.find((x) => x.uid === uid))
  const chatError = useStore((st) => st.chats[uid]?.error ?? null)
  const paused = useStore((st) => st.presence.paused)
  const desktop = useStore((st) => st.bootstrap?.desktop ?? false)
  // Setup actions only where they work (the desktop app); a mic error's action is the composer's (micHelp).
  const place = useMemo<TalkPlace>(() => ({ desktop, micAction: (code) => micHelp(code, micPlaceOf(desktop)).action }), [desktop])
  const title = summary?.title || 'Conversation'

  useEffect(() => {
    if (!uid) return
    // The chat barrel's <Transcript> keeps the session's view live itself (useChatFeed).
    ctl.start()
    if (__VESPER_TEST__) (window as unknown as { __vesperTalk?: TalkController }).__vesperTalk = ctl
    return () => {
      ctl.stop()
      if (__VESPER_TEST__) delete (window as unknown as { __vesperTalk?: TalkController }).__vesperTalk
    }
  }, [uid, ctl])

  useEffect(() => {
    document.title = `Talk · ${title} · Vesper`
    return () => {
      document.title = 'Vesper'
    }
  }, [title])

  const end = useCallback((): void => {
    ctl.stop()
    navigate(uid ? `/s/${uid}` : '/')
  }, [ctl, uid])
  // The way out of an error Talk mode can't fix by itself (07 D13); "Type instead" is `end` (the composer focuses itself).
  const openVoiceSettings = useCallback((): void => {
    ctl.stop()
    navigate('/settings/voice-in')
  }, [ctl])
  const onPrimary = useCallback((): void => {
    if (primaryAction(ctl.state, place) === 'setup') openVoiceSettings()
    else ctl.primary()
  }, [ctl, openVoiceSettings, place])

  // Space = the big button, Esc = interrupt (while Vesper answers) or end. Not while typing or inside a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return
      if (e.key === ' ' || e.code === 'Space') {
        // A focused button handles Space itself.
        if (t?.closest('button, [role="button"], a[href]')) return
        e.preventDefault()
        onPrimary()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (ctl.state.phase === 'thinking' || ctl.state.phase === 'speaking') ctl.interrupt()
        else end()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctl, end, onPrimary])

  const action = primaryAction(s, place)
  const wayOut = s.phase === 'error' ? talkErrorWayOut(s.error, place) : null
  const primary = action === 'setup' && wayOut ? { ...PRIMARY.setup, label: wayOut.setupLabel } : PRIMARY[action]
  const notFound = chatError?.code === 'not_found'

  return (
    <div className="talk" data-phase={s.phase} data-muted={s.muted || undefined} onPointerDown={() => void getAudioEngine().unlock()}>
      <header className="talk__bar app-drag">
        <Button variant="ghost" size="sm" icon={<ChevronLeft />} onClick={end} className="no-drag talk__back">
          {phone ? 'Chat' : 'Back to chat'}
        </Button>
        <div className="talk__heading">
          <span className="talk__eyebrow">Talk mode</span>
          <h1 className="talk__title" title={title}>
            {title}
          </h1>
        </div>
        <IconButton
          className="no-drag"
          label={paused ? 'Resume the Star’s animation' : 'Pause the Star’s animation'}
          icon={paused ? <Play /> : <Pause />}
          pressed={paused}
          onClick={() => useStore.getState().setStarPaused(!paused)}
          tooltipSide="bottom"
        />
      </header>

      <main className="talk__main">
        <div className="talk__stage">
          <StarStage />
        </div>
        <p className="talk__state" role="status" aria-live="polite">
          {s.phase === 'starting' || s.phase === 'warming-up' ? <Spinner size={14} /> : null}
          <span>{stateText(s)}</span>
        </p>

        {notFound ? (
          <Callout tone="warning" title="This chat doesn’t exist anymore" className="talk__notice">
            It may have been deleted on another device.
          </Callout>
        ) : s.phase === 'insecure' ? (
          <Callout tone="info" title="Voice needs a secure connection" className="talk__notice">
            Microphones only work over HTTPS on other devices. Turn on HTTPS for this network in Settings → Access &amp; security, or use Vesper on your PC.
          </Callout>
        ) : s.phase === 'error' || s.error ? (
          <Callout
            tone={s.phase === 'error' ? 'danger' : 'warning'}
            className="talk__notice"
            actions={
              wayOut ? (
                <>
                  {wayOut.primary === 'setup' || wayOut.settings ? (
                    <Button size="sm" variant={wayOut.primary === 'setup' ? 'primary' : 'secondary'} icon={<Settings2 />} onClick={openVoiceSettings}>
                      {wayOut.primary === 'setup' ? wayOut.setupLabel : 'Open Voice in settings'}
                    </Button>
                  ) : null}
                  {wayOut.windowsSettings && window.vesperDesktop?.openExternal ? (
                    <Button size="sm" variant="secondary" icon={<ExternalLink />} onClick={() => void window.vesperDesktop?.openExternal?.('ms-settings:privacy-microphone')}>
                      Open Windows settings
                    </Button>
                  ) : null}
                  {wayOut.text ? (
                    <Button size="sm" variant="ghost" icon={<Keyboard />} onClick={end}>
                      Type instead
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
          >
            {wayOut?.note ?? talkError(s.error) ?? 'Something went wrong.'}
          </Callout>
        ) : null}

        <Captions uid={uid} s={s} />
      </main>

      <footer className="talk__controls">
        <div className="talk__buttons" role="group" aria-label="Talk controls">
          <div className="talk__side talk__side--start">
            <ControlButton
              label={s.muted ? 'Unmute' : 'Mute'}
              icon={s.muted ? <MicOff /> : <Mic />}
              pressed={s.muted}
              disabled={s.phase === 'insecure' || s.phase === 'error'}
              onClick={() => ctl.setMuted(!s.muted)}
            />
            <ControlButton
              label={s.phase === 'held' ? 'Resume' : 'Hold'}
              icon={s.phase === 'held' ? <Play /> : <Pause />}
              pressed={s.phase === 'held'}
              disabled={s.phase === 'insecure' || s.phase === 'error' || s.phase === 'starting'}
              onClick={() => (s.phase === 'held' ? ctl.resume() : ctl.hold())}
            />
          </div>
          <button
            type="button"
            className="talk__primary"
            data-action={action}
            aria-label={primary.label}
            disabled={action === 'none' || s.phase === 'insecure'}
            onClick={onPrimary}
          >
            <span className="talk__primary-ring" aria-hidden="true" />
            {s.phase === 'starting' || s.phase === 'warming-up' ? <Spinner size={22} /> : primary.icon}
          </button>
          <div className="talk__side talk__side--end">
            <ControlButton label="End" icon={<PhoneOff />} danger onClick={end} />
          </div>
        </div>
        <p className="talk__hint" aria-hidden={phone || coarse ? true : undefined}>
          {phone || coarse ? (
            primary.label
          ) : (
            <>
              <Kbd keys="Space" /> {primary.label.toLowerCase()} · <Kbd keys="Esc" /> {s.phase === 'thinking' || s.phase === 'speaking' ? 'interrupt' : 'end'}
            </>
          )}
        </p>
      </footer>
    </div>
  )
}

function stateText(s: TalkState): string {
  if (s.muted && (s.phase === 'listening' || s.phase === 'transcribing')) return 'Muted — Vesper isn’t listening'
  if (s.phase === 'error') {
    const code = s.error?.code
    if (code === 'mic_denied') return 'Microphone blocked'
    if (code === 'mic_os_blocked') return 'No microphone'
    if (code === 'stt_model_missing' || code === 'stt_unavailable' || code === 'stt_crashed') return 'Speech recognition unavailable'
  }
  return TALK_PHASE_TEXT[s.phase]
}

function ControlButton({
  label,
  icon,
  pressed,
  disabled,
  danger,
  onClick
}: {
  label: string
  icon: ReactNode
  pressed?: boolean
  disabled?: boolean
  danger?: boolean
  onClick(): void
}): ReactNode {
  return (
    <div className="talk__control">
      <IconButton
        label={label}
        icon={icon}
        variant={danger ? 'danger' : 'secondary'}
        size="lg"
        pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        tooltip={false}
        className="talk__control-btn"
      />
      <span className="talk__control-label" aria-hidden="true">
        {label}
      </span>
    </div>
  )
}

/**
 * Live captions: the last turns from the chat barrel's <Transcript> — the newest reply, revealed with the voice, is
 * its last row and is set large — and your words while you speak (they join the transcript once sent).
 */
function Captions({ uid, s }: { uid: string; s: TalkState }): ReactNode {
  const phone = useIsPhone()
  const live = useMemo(() => s.partial.trim(), [s.partial])
  const showYou = !!live && !s.muted && (s.phase === 'listening' || s.phase === 'transcribing')
  return (
    <section className="talk__captions" aria-label="Captions">
      <Transcript sessionUid={uid} limit={phone ? 3 : 5} className="talk__history" />
      {showYou ? (
        <p className="talk__you">
          <span className="talk__who">You</span>
          {live}
        </p>
      ) : null}
    </section>
  )
}
