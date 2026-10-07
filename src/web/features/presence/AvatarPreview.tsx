/**
 * Settings → Presence & appearance: the avatar LIVE, as it looks behind a conversation (v1.1.3; owner: "have previews
 * in the settings"). The preview's box is a stage target (kind 'preview', targets.ts): while the page is open the one
 * presence surface moves here (07 D5 — never a second WebGL context) and draws with the chat backdrop's look for this
 * theme, state, visibility and size, the luminance cap included (backdrop.logic → stageLook), behind a few lines of
 * sample text — so the owner sees what "Avatar visibility" does to legibility before leaving Settings.
 *
 * "Preview speaking" plays a short synthetic voice clip (lib/audio/synth.ts, loaded on the first click) through the
 * real AudioEngine at the owner's volume: the presence driver turns the state to speaking and the horizon draws that
 * clip's real waveform. Leaving the page stops the clip and hands the stage look back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AudioLines, Square } from 'lucide-react'
import { Button } from '../../components/Button'
import { getAudioEngine } from '../../lib/audio'
import { useStore } from '../../lib/store'
import { useIsPhone } from '../../lib/useMediaQuery'
import { ARMILLA_ASPECT, backdropLook, MAX_SCALE } from './backdrop.logic'
import { useLightTheme } from './ChatBackdrop'
import { setStageLook } from './host/stageLook'
import { STAR_STATE_TEXT } from './state.logic'
import { registerTarget } from './targets'
import { useEffectiveStar } from './useEffectiveStar'
import './backdrop.css'

/** What the clip "says" (its rhythm: one buzz per letter, a pause per space — synth.ts). */
const CLIP = 'Here is a gentle plan for tomorrow. Shall I remind you an hour before?'
/** The sample text column (CSS px, at most): the cap's message column in the preview. */
const COLUMN_MAX = 520

export function AvatarPreview(): ReactNode {
  const frame = useRef<HTMLDivElement>(null)
  const avatar = useRef<HTMLDivElement>(null)
  const cfg = useEffectiveStar()
  const phone = useIsPhone()
  const light = useLightTheme()
  const state = useStore((s) => s.presence.star)
  const gameMode = useStore((s) => s.ui.gameMode.active)
  const name = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const [area, setArea] = useState({ w: 0, h: 0 })
  const [animate, setAnimate] = useState(false)
  const [playing, setPlaying] = useState(false)
  const clip = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const measure = (): void => setArea((a) => (a.w === el.clientWidth && a.h === el.clientHeight ? a : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    const el = avatar.current
    if (!el) return
    return registerTarget(el, 'preview')
  }, [])

  const armilla = cfg.style === 'armilla'
  const look = backdropLook({ mode: 'conversation', state, reading: false, gameMode, reducedMotion: cfg.reducedMotion, theme: light ? 'light' : 'dark', phone, visibility: cfg.visibility })
  // The box: sized for its speaking scale (CSS only shrinks it, as in the chat), as large as the frame allows × size.
  const aspect = armilla ? ARMILLA_ASPECT : 1
  const shownH = Math.max(0, Math.min(area.h * 0.8 * cfg.size, (area.h * 0.98) / MAX_SCALE.conversation, area.w / aspect / MAX_SCALE.conversation))
  const boxH = Math.round(shownH * MAX_SCALE.conversation)
  const boxW = Math.min(area.w, Math.round(boxH * aspect))
  const scale = boxH > 0 ? (shownH / boxH) * look.scale : 1
  const transform = `translate(${Math.round(area.w / 2 - boxW / 2)}px, ${Math.round(area.h / 2 - boxH / 2)}px) scale(${scale.toFixed(4)})`
  const ready = area.w > 0 && area.h > 0
  const shownW = boxW * scale
  const colHalf = shownW > 0 ? Math.round(Math.min(0.5, Math.min(COLUMN_MAX, area.w - 48) / 2 / shownW) * 1e4) / 1e4 : 0.5
  const colEdge = shownW > 0 ? Math.round((24 / shownW) * 1e4) / 1e4 : 0

  useEffect(
    () => setStageLook({ cap: look.cap, capOut: look.capOut, presence: look.presence, behind: look.behind, colHalf, colEdge }),
    [look.cap, look.capOut, look.presence, look.behind, colHalf, colEdge]
  )
  useEffect(() => () => setStageLook(null), [])

  // Placed first without a transition (as the chat backdrop), then size/strength changes ease.
  useEffect(() => {
    if (!ready || animate) return
    const r = requestAnimationFrame(() => setAnimate(true))
    return () => cancelAnimationFrame(r)
  }, [ready, animate])

  // The clip ends (or is stopped): the button goes back. Leaving the page stops it.
  useEffect(() => {
    const engine = getAudioEngine()
    const off = engine.on('replyEnd', (e) => {
      if (e.replyId !== clip.current) return
      clip.current = null
      setPlaying(false)
    })
    return () => {
      off()
      if (clip.current) engine.stop(clip.current)
      clip.current = null
    }
  }, [])

  const toggleSpeaking = async (): Promise<void> => {
    const engine = getAudioEngine()
    if (clip.current) {
      engine.stop(clip.current)
      return
    }
    await engine.unlock()
    const { synthReply } = await import('../../lib/audio/synth')
    const id = `avatar-preview-${Date.now()}`
    clip.current = id
    setPlaying(true)
    for (const c of synthReply(id, [CLIP], { amplitude: 0.22 })) engine.enqueue(c.header, c.bytes)
  }

  return (
    <div className="avatar-preview">
      <div ref={frame} className="avatar-preview__frame" role="img" aria-label={`Live preview: ${name}’s avatar behind a conversation — ${STAR_STATE_TEXT[state]}`}>
        <div
          className="chat-backdrop"
          aria-hidden="true"
          data-mode="conversation"
          data-state={state}
          data-ink={(light && !armilla) || undefined}
          data-avatar={armilla ? 'armilla' : undefined}
          data-ready={ready || undefined}
          data-animate={animate || undefined}
        >
          <div ref={avatar} className="chat-backdrop__avatar" id="star-stage-preview" style={{ width: boxW, height: boxH, transform, opacity: look.opacity }} />
        </div>
        <div className="avatar-preview__text" aria-hidden="true">
          <p className="avatar-preview__msg">
            Here is a gentle plan for tomorrow: a slow start, the long walk by the river, and the call with Mia at four. Shall I remind you an
            hour before?
          </p>
          <p className="avatar-preview__meta">{name} · 9:41</p>
        </div>
      </div>
      <div className="avatar-preview__bar">
        <span className="avatar-preview__caption">Live preview · what the avatar looks like behind your messages.</span>
        <Button
          size="sm"
          variant="secondary"
          icon={playing ? <Square /> : <AudioLines />}
          disabled={cfg.style === 'off'}
          onClick={() => void toggleSpeaking()}
          data-testid="avatar-preview-speak"
        >
          {playing ? 'Stop' : 'Preview speaking'}
        </Button>
      </div>
    </div>
  )
}
