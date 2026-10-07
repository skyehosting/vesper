/**
 * The chat backdrop (presence v2 layout; owner feedback on 1.0.0): the one presence surface (07 D5 — a stage target,
 * never a second canvas) sits centred in the visible chat area BEHIND the message list. The list scrolls over it; the
 * box never scrolls and never remounts. Layout numbers and the legibility rules live in backdrop.logic.ts.
 *
 *   <ChatBackdrop />      first child of the chat body (the area between the top bar and the composer)
 *   <AvatarAnchor />      an empty chat's hero slot: while one is mounted the avatar moves onto it, at hero strength
 *   <PresenceControls />  the top bar's presence group: state words, pause (07 D9), show/hide
 *
 * The box is decorative: aria-hidden, pointer-events none (clicks, selection and scrolling go to the messages). Size,
 * position and strength change with CSS transform/opacity (compositor only: a state change costs no WebGL frame);
 * the luminance cap goes to the renderer through stageLook.ts.
 *
 * v1.1.3 (owner: "when switching between sessions … it starts in the upper left and then moves into the center"): the
 * box is shown only once the chat body is measured and the chat's view has settled, and its first placement there is
 * never animated — on a session switch, a route change or the first mount it appears where it belongs. Only a later
 * change of the layout (an empty chat's hero ↔ a conversation, a resize) transitions.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Pause, Play, Sparkles } from 'lucide-react'
import { IconButton } from '../../components/IconButton'
import { useStore } from '../../lib/store'
import { useIsPhone, useMediaQuery } from '../../lib/useMediaQuery'
import { ARMILLA_ASPECT, backdropAvailable, backdropBox, backdropGeometry, backdropLook, columnHalf, type BackdropAvailable, type BackdropGeometry } from './backdrop.logic'
import { setStageLook } from './host/stageLook'
import { setChatStageCollapsed, useChatStageCollapsed } from './stagePref'
import { STAR_STATE_TEXT } from './state.logic'
import { registerTarget } from './targets'
import { useEffectiveStar } from './useEffectiveStar'
import './backdrop.css'

/** After the last scroll / while text is selected, the avatar stays in its calm "reading" strength this long. */
const READING_HOLD_MS = 1200
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

// ── the anchor store: an empty chat's hero slot, and the hero size the slot should reserve ─────────────────────────
let anchorEl: HTMLElement | null = null
let heroPx = 0
const anchorListeners = new Set<() => void>()
const emitAnchor = (): void => {
  for (const l of [...anchorListeners]) l()
}
const subscribeAnchor = (cb: () => void): (() => void) => {
  anchorListeners.add(cb)
  return () => void anchorListeners.delete(cb)
}
const getAnchor = (): HTMLElement | null => anchorEl
const getHero = (): number => heroPx

export function useChatBackdrop(): BackdropAvailable {
  const cfg = useEffectiveStar()
  const phone = useIsPhone()
  const collapsed = useChatStageCollapsed()
  return backdropAvailable({ phone, showInChat: cfg.showInChat, style: cfg.style, collapsed })
}

/** Light theme (or system → light): the host turns the avatar's light into ink (backdrop.css). */
export function useLightTheme(): boolean {
  const theme = useStore((s) => s.settings?.appearance.theme ?? 'dark')
  const osLight = useMediaQuery('(prefers-color-scheme: light)')
  return theme === 'light' || (theme === 'system' && osLight)
}

/**
 * @param settled the chat's view is past its first load (no loading rows): until then the box waits, hidden, so it
 *   never first appears at a layout that is about to change (an empty chat's hero).
 */
export function ChatBackdrop({ settled = true }: { settled?: boolean }): ReactNode {
  const available = useChatBackdrop()
  if (!available.shown) return null
  return <Backdrop settled={settled} />
}

function Backdrop({ settled }: { settled: boolean }): ReactNode {
  const layer = useRef<HTMLDivElement>(null)
  const avatar = useRef<HTMLDivElement>(null)
  const phone = useIsPhone()
  const cfg = useEffectiveStar()
  const state = useStore((s) => s.presence.star)
  const gameMode = useStore((s) => s.ui.gameMode.active)
  const light = useLightTheme()
  const anchor = useSyncExternalStore(subscribeAnchor, getAnchor)
  const [body, setBody] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [centre, setCentre] = useState<{ x: number; y: number } | null>(null)
  const [reading, setReading] = useState(false)
  const [follow, setFollow] = useState(false)

  // The visible chat area = the layer's box (inset 0 in the chat body).
  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    const measure = (): void => setBody((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  // Armilla (the v1.1 default) is wide: its horizon line runs across the message column. It draws its own ink in the
  // light theme (no invert filter), with the same cap on how much ink a pixel lays (GlSurface / Armilla2d).
  const armilla = cfg.style === 'armilla'
  const geo: BackdropGeometry = useMemo(() => backdropGeometry(body.w, body.h, phone, cfg.size), [body.w, body.h, phone, cfg.size])

  // Tell the hero slot how much room to keep.
  useEffect(() => {
    if (heroPx === geo.hero) return
    heroPx = geo.hero
    emitAnchor()
  }, [geo.hero])
  useEffect(
    () => () => {
      heroPx = 0
      emitAnchor()
    },
    []
  )

  // Follow the anchor (its box moves with the empty state's layout and, in short windows, its scrolling).
  useLayoutEffect(() => {
    const el = layer.current
    if (!anchor || !el) {
      setCentre(null)
      return
    }
    let followTimer = 0
    const place = (): void => {
      const a = anchor.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      const next = { x: Math.round(a.left + a.width / 2 - b.left), y: Math.round(a.top + a.height / 2 - b.top) }
      setCentre((c) => (c && c.x === next.x && c.y === next.y ? c : next))
    }
    const onScroll = (): void => {
      setFollow(true)
      window.clearTimeout(followTimer)
      followTimer = window.setTimeout(() => setFollow(false), 160)
      place()
    }
    place()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    ro?.observe(anchor)
    ro?.observe(el)
    const host = el.parentElement
    host?.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      ro?.disconnect()
      host?.removeEventListener('scroll', onScroll, { capture: true })
      window.clearTimeout(followTimer)
    }
  }, [anchor])

  // Reading: scrolling the messages or holding a selection in them calms the avatar (opacity only — no frames).
  useEffect(() => {
    const host = layer.current?.parentElement
    if (!host) return
    let timer = 0
    let on = false
    const set = (v: boolean): void => {
      if (v === on) return
      on = v
      setReading(v)
    }
    const hold = (): void => {
      set(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const sel = document.getSelection()
        if (sel && !sel.isCollapsed && sel.anchorNode && host.contains(sel.anchorNode)) hold()
        else set(false)
      }, READING_HOLD_MS)
    }
    const onSelection = (): void => {
      const sel = document.getSelection()
      if (sel && !sel.isCollapsed && sel.anchorNode && host.contains(sel.anchorNode)) hold()
    }
    // Wheel/touch/keys mean the reader scrolls; a programmatic scroll (new message, jump) does not count.
    host.addEventListener('wheel', hold, { passive: true })
    host.addEventListener('touchmove', hold, { passive: true })
    const onKey = (e: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(e.key)) hold()
    }
    host.addEventListener('keydown', onKey)
    document.addEventListener('selectionchange', onSelection)
    return () => {
      host.removeEventListener('wheel', hold)
      host.removeEventListener('touchmove', hold)
      host.removeEventListener('keydown', onKey)
      document.removeEventListener('selectionchange', onSelection)
      window.clearTimeout(timer)
    }
  }, [])

  const mode = anchor ? 'hero' : 'conversation'
  const look = backdropLook({ mode, state, reading, gameMode, reducedMotion: cfg.reducedMotion, theme: light ? 'light' : 'dark', phone, visibility: cfg.visibility })
  // The box is sized per mode for its largest (speaking) scale: CSS only ever shrinks the canvas, and the hero renders
  // a hero-sized buffer (the canvas follows the box's size: a resize, never a remount).
  const box = backdropBox(geo, mode, armilla ? ARMILLA_ASPECT : 1)
  const size = mode === 'hero' ? geo.hero : geo.conversation
  const cx = centre?.x ?? geo.cx
  const cy = centre?.y ?? geo.cy
  const scale = box.h > 0 ? (size / box.h) * look.scale : 1
  const transform = `translate(${cx - box.w / 2}px, ${cy - box.h / 2}px) scale(${scale.toFixed(4)})`
  const ready = body.w > 0 && body.h > 0 && settled
  // Transitions only after the box has been shown at its place: the first placement (mount, session switch, route
  // change) is instant. Two frames, so the browser has computed the placed transform before transitions turn on.
  const [animate, setAnimate] = useState(false)
  useLayoutEffect(() => {
    if (!ready) {
      setAnimate(false)
      return
    }
    if (animate) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAnimate(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [ready, animate])
  // The cap's message column in canvas-width fractions (the canvas is the box, shown at `scale`).
  const shownW = box.w * scale
  const colHalf = shownW > 0 ? Math.round(Math.min(0.5, columnHalf(geo.width) / shownW) * 1e4) / 1e4 : 0.5
  const colEdge = shownW > 0 ? Math.round((24 / shownW) * 1e4) / 1e4 : 0

  // The renderer's half: the caps, presence and "behind text". Reset when the backdrop goes.
  useEffect(
    () => setStageLook({ cap: look.cap, capOut: look.capOut, presence: look.presence, behind: look.behind, colHalf, colEdge }),
    [look.cap, look.capOut, look.presence, look.behind, colHalf, colEdge]
  )
  useEffect(() => () => setStageLook(null), [])

  useEffect(() => {
    const el = avatar.current
    if (!el) return
    return registerTarget(el, 'backdrop')
  }, [])

  // A mode change resizes the box: start from what was on screen and animate to the new size (no jump).
  const flip = useRef<{ mode: string; cx: number; cy: number; shown: number } | null>(null)
  useLayoutEffect(() => {
    const el = avatar.current
    const prev = flip.current
    flip.current = { mode, cx, cy, shown: size * look.scale }
    if (!el || !prev || prev.mode === mode || box.h <= 0 || !animate) return
    el.style.transition = 'none'
    el.style.transform = `translate(${prev.cx - box.w / 2}px, ${prev.cy - box.h / 2}px) scale(${(prev.shown / box.h).toFixed(4)})`
    void el.offsetWidth
    el.style.transition = ''
    el.style.transform = transform
  })

  return (
    <div
      ref={layer}
      className="chat-backdrop"
      aria-hidden="true"
      data-mode={mode}
      data-state={state}
      data-reading={reading || undefined}
      data-ink={(light && !armilla) || undefined}
      data-avatar={armilla ? 'armilla' : undefined}
      data-follow={follow || undefined}
      data-ready={ready || undefined}
      data-animate={animate || undefined}
    >
      <div
        ref={avatar}
        className="chat-backdrop__avatar"
        id="star-stage-backdrop"
        style={{
          width: box.w,
          height: box.h,
          transform,
          opacity: look.opacity
        }}
      />
    </div>
  )
}

/**
 * An empty chat's hero slot: reserves the room the avatar takes above the greeting, and while it is mounted the
 * backdrop moves onto it at hero strength (no cap: no text is drawn over it).
 */
export function AvatarAnchor(): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const hero = useSyncExternalStore(subscribeAnchor, getHero)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    anchorEl = el
    emitAnchor()
    return () => {
      if (anchorEl === el) {
        anchorEl = null
        emitAnchor()
      }
    }
  }, [])
  // The corona's outer third is faint: the greeting may tuck under it, so the slot keeps ~80 % of the hero height.
  const h = Math.round(hero * 0.8)
  return <div ref={ref} className="avatar-anchor" aria-hidden="true" style={{ width: hero, height: h }} />
}

/**
 * The top bar's presence group (desktop and phone): the state in words while something happens (07 D9: the canvas is
 * aria-hidden), the pause control while the avatar is active or paused (07 D9 / WCAG 2.2.2 — the backdrop sits under
 * the messages, so its control lives here; an idle avatar drifts slowly and comes to rest by itself within 20 s, and
 * /star pause and Settings pause it any time — so the tight top bar keeps its chips at rest), and show/hide.
 */
export function PresenceControls(): ReactNode {
  const available = useChatBackdrop()
  const collapsed = useChatStageCollapsed()
  const state = useStore((s) => s.presence.star)
  const paused = useStore((s) => s.presence.paused)
  const cfg = useEffectiveStar()
  const phone = useIsPhone()
  const name = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  // Phones: the top bar has no room (the title would truncate); pause and hide live in Settings → Appearance there.
  if (!available.toggle || phone) return null
  const pauseLabel = paused ? 'Resume the avatar’s animation' : 'Pause the avatar’s animation'
  return (
    <>
      {available.shown && state !== 'idle' ? (
        <span className="presence-state no-drag" data-state={state}>
          <span className="presence-state__dot" aria-hidden="true" />
          <span className="sr-only">{name}: </span>
          {STAR_STATE_TEXT[state]}
        </span>
      ) : null}
      {available.shown && !cfg.reducedMotion && (state !== 'idle' || paused) ? (
        <IconButton label={pauseLabel} icon={paused ? <Play /> : <Pause />} pressed={paused} className="no-drag" onClick={() => useStore.getState().setStarPaused(!paused)} tooltipSide="bottom" />
      ) : null}
      <IconButton
        label={collapsed ? 'Show Vesper behind the chat' : 'Hide Vesper behind the chat'}
        icon={<Sparkles />}
        pressed={!collapsed}
        className="no-drag"
        onClick={() => setChatStageCollapsed(!collapsed)}
        tooltipSide="bottom"
      />
    </>
  )
}
