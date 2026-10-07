/**
 * <PresenceHost> — the lazily loaded body of <StarHost> (07 D5). Owns, for the lifetime of the signed-in app:
 *   - one host element, moved (re-parented, never remounted) into the winning stage target (targets.ts): in a chat
 *     that is the backdrop behind the messages (ChatBackdrop, v1.1), Talk mode's stage, the Constellation, a <Star>;
 *   - the frame scheduler (07 D4) and the state driver;
 *   - what the surface shows: the WebGL canvas (Armilla / orb / nebula / Constellation — chunk loaded on first need),
 *     a 2D twin (Armilla2d on phones and without WebGL, the minimal 2D star), or the static glyph (style Off, hidden
 *     in chat);
 *   - the visible pause control on sized stages (07 D9), adaptive quality, and the presence test hooks.
 * Teardown (sign-out, unmount) releases every listener, timer, observer and the WebGL context.
 */
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play } from 'lucide-react'
import { StarGlyph } from '../../../app/StarGlyph'
import { useStore } from '../../../lib/store'
import type { StarState } from '../../../lib/store/presence'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { drawsIn2d, isGlStyle } from '../prefs.logic'
import { degradeQuality } from '../schedule.logic'
import type { SurfaceMode } from '../schedule.logic'
import { activeTarget, subscribeTargets, type StarTarget } from '../targets'
import { useEffectiveStar } from '../useEffectiveStar'
import { paletteFor } from '../visual.logic'
import { Armilla2d } from '../gl/avatars/armilla/Armilla2d'
import { installDriver } from './driver'
import { Minimal2dStar } from './Minimal2dStar'
import { FrameScheduler } from './scheduler'
import { setCurrentScheduler } from './schedulerRef'
import { installPresenceTestHooks } from './testHooks'
import './host.css'

const GlSurface = lazy(() => import('../gl/GlSurface'))

/** After leaving Constellation with a non-WebGL style, the canvas lingers this long before it is released. */
const GL_LINGER_MS = 30_000
/** The chat backdrop's device-pixel-ratio cap for the 1.0 styles (soft glows read the same at a lower resolution). */
const BACKDROP_DPR_CAP = 1.25
/** Armilla's hairlines need the real pixel density behind text: up to 2 (1 on low quality); 07 H-v11-presence. */
const ARMILLA_DPR_CAP = 2

export default function PresenceHost(): ReactNode {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.className = 'presence-host'
    return el
  })
  const [park] = useState(() => {
    const el = document.createElement('div')
    el.className = 'presence-park'
    el.setAttribute('aria-hidden', 'true')
    return el
  })
  const [scheduler] = useState(() => {
    const s = new FrameScheduler()
    // Test builds in test mode: software WebGL is always slow, so adaptive quality waits for a spec to enable it.
    if (__VESPER_TEST__ && useStore.getState().bootstrap?.isTest) s.watchPace = false
    return s
  })
  const target = useActiveTarget()
  const settingsCfg = useEffectiveStar()
  // Adaptive quality: each struggle report steps down once for this page's life (never persisted).
  const [drops, setDrops] = useState(0)
  useEffect(() => scheduler.onStruggle(() => setDrops((d) => Math.min(2, d + 1))), [scheduler])
  const cfg = useMemo(() => {
    const quality = degradeQuality(settingsCfg.quality, drops)
    return quality === settingsCfg.quality ? settingsCfg : { ...settingsCfg, quality, dprCap: quality === 'low' ? 1 : Math.min(settingsCfg.dprCap, 1.5) }
  }, [settingsCfg, drops])
  const accent = useStore((s) => s.settings?.appearance.accent ?? 'gold')
  const paused = useStore((s) => s.presence.paused)
  // 07 D3: the one game-mode state (ui slice, from Bootstrap and `gamemode.changed`).
  const gameMode = useStore((s) => s.ui.gameMode.active)
  const webgl = useStore((s) => s.presence.webgl)
  const storeState = useStore((s) => s.presence.star)
  const night = useNightStage()
  const palette = useMemo(() => paletteFor(accent), [accent])

  // The state shown: a target's override (galleries, the wizard finale) or the store's.
  const override = useTargetOverride(target)
  const shownState: StarState = override ?? storeState
  const stateRef = useRef<StarState>(shownState)
  stateRef.current = shownState

  const kind = target?.kind ?? null
  const mode: 'star' | 'constellation' | 'none' = !target ? 'none' : kind === 'constellation' ? 'constellation' : 'star'
  const hiddenInChat = kind === 'backdrop' && !cfg.showInChat
  // Behind the messages the 1.0 styles are dim and soft (a lower buffer resolution reads the same); Armilla keeps its
  // hairlines crisp at the real density. Settings' preview (v1.1.3) draws exactly that look.
  const backdrop = kind === 'backdrop' || kind === 'preview'
  const dprCap = !backdrop ? cfg.dprCap : cfg.style === 'armilla' ? (cfg.quality === 'low' ? 1 : Math.min(cfg.dprCap, ARMILLA_DPR_CAP)) : Math.min(cfg.dprCap, BACKDROP_DPR_CAP)
  // Test builds: an exact canvas DPR for the GPU cost measurements (07 H-v11-presence).
  const [dprExact, setDprExact] = useState<number | null>(null)
  const glOk = webgl !== 'unavailable'
  // v1.1: Armilla is the default avatar; it draws as SVG on phones and without WebGL (07 D8), the others as 1.0 did.
  const armilla = cfg.style === 'armilla'
  const in2d = drawsIn2d(cfg.style, cfg.phone, glOk)
  const glStyle = isGlStyle(cfg.style) && glOk && !in2d
  const glShown = glOk && (mode === 'constellation' || (mode === 'star' && glStyle && !hiddenInChat))
  const m2dShown = mode === 'star' && !hiddenInChat && in2d
  const glyphShown = mode === 'star' && !glShown && !m2dShown

  // The context is created the first time the canvas is actually shown (not while parked on a page without a stage),
  // then kept for the page's life with a WebGL style (07 D5: never remounted on route switches).
  const [glEver, setGlEver] = useState(false)
  useEffect(() => {
    if (glShown) setGlEver(true)
  }, [glShown])
  // With a non-WebGL style, a canvas that exists (Constellation visited) lingers a while before it is released.
  const [lingerUntil, setLingerUntil] = useState(0)
  useEffect(() => {
    if (glShown || glStyle || !glEver) return
    if (cfg.style === 'off') {
      setLingerUntil(0)
      return
    }
    setLingerUntil(Date.now() + GL_LINGER_MS)
    const t = window.setTimeout(() => setLingerUntil(0), GL_LINGER_MS)
    return () => window.clearTimeout(t)
  }, [glShown, glStyle, glEver, cfg.style])
  const glMounted = glOk && (glShown || (glEver && glStyle) || lingerUntil > Date.now())

  // Move the host element into the target (or park it). Layout effect: before paint, so it never flashes elsewhere.
  useLayoutEffect(() => {
    const el = target?.el
    if (!el) {
      if (!park.isConnected) document.body.appendChild(park)
      park.appendChild(host)
      return
    }
    el.classList.add('presence-target')
    if (getComputedStyle(el).position === 'static') el.classList.add('presence-target--pos')
    el.appendChild(host)
    el.dataset.starLive = ''
    scheduler.kick(700)
    scheduler.requestFrame()
    return () => {
      delete el.dataset.starLive
      el.classList.remove('presence-target', 'presence-target--pos')
    }
  }, [target, host, park, scheduler])

  useEffect(() => {
    host.dataset.kind = kind ?? 'none'
    // Armilla draws as ink in the light theme, and the backdrop turns light into ink (backdrop.css): no night window.
    host.classList.toggle('presence-host--night', night && mode === 'star' && !backdrop && (glShown || m2dShown) && !armilla)
  }, [host, kind, night, mode, glShown, m2dShown, armilla, backdrop])

  useEffect(() => scheduler.observe(host), [scheduler, host])
  useEffect(() => installDriver(), [])
  useEffect(() => (__VESPER_TEST__ ? installPresenceTestHooks({ scheduler, host, setDpr: setDprExact }) : undefined), [scheduler, host])

  useEffect(() => {
    setCurrentScheduler(scheduler)
    return () => setCurrentScheduler(null)
  }, [scheduler])

  useEffect(
    () => () => {
      scheduler.dispose()
      host.remove()
      park.remove()
    },
    [scheduler, host, park]
  )

  const surfaceMode: SurfaceMode = mode === 'none' ? 'none' : glShown || m2dShown ? mode : 'none'
  useEffect(() => {
    scheduler.update({
      style: cfg.style === 'off' && mode === 'constellation' ? 'orb' : cfg.style,
      mode: surfaceMode,
      state: shownState,
      paused,
      gameMode,
      reducedMotion: cfg.reducedMotion,
      // Armilla's 2D twin (phones) draws at ≤ 30 fps: SVG paths cost more per frame than a shader (07 D8).
      maxFps: in2d && armilla ? Math.min(cfg.maxFps, 30) : cfg.maxFps,
      pauseWhenUnfocused: cfg.pauseWhenUnfocused,
      canDraw: m2dShown || (glShown && webgl === 'ok')
    })
  }, [scheduler, cfg, surfaceMode, shownState, paused, gameMode, m2dShown, glShown, mode, webgl])

  // Accent / theme changes: one crossfaded redraw even at rest.
  useEffect(() => scheduler.kick(400), [scheduler, palette, night, cfg.style])

  // Sized stages get the button; the chat backdrop's pause lives in the top bar (PresenceControls), Talk mode has its
  // own, and /star pause or Settings work everywhere.
  const showPause = mode === 'star' && kind === 'custom' && (glShown || m2dShown) && !cfg.reducedMotion

  return createPortal(
    <>
      {glMounted ? (
        <Suspense fallback={null}>
          <GlSurface
            scheduler={scheduler}
            mode={mode === 'constellation' ? 'constellation' : 'star'}
            shown={glShown}
            style={cfg.style === 'nebula' ? 'nebula' : armilla ? 'armilla' : 'orb'}
            quality={cfg.quality}
            reducedMotion={cfg.reducedMotion}
            dprCap={dprCap}
            dprExact={__VESPER_TEST__ ? dprExact : null}
            palette={palette}
            stateRef={stateRef}
            ink={night}
            backdrop={backdrop}
          />
        </Suspense>
      ) : null}
      {m2dShown && armilla ? (
        <Armilla2d scheduler={scheduler} active={m2dShown} palette={palette} reducedMotion={cfg.reducedMotion} stateRef={stateRef} ink={night} backdrop={backdrop} />
      ) : null}
      {m2dShown && !armilla ? <Minimal2dStar scheduler={scheduler} active={m2dShown} palette={palette} reducedMotion={cfg.reducedMotion} stateRef={stateRef} backdrop={backdrop} /> : null}
      {glyphShown ? (
        <span className="presence-glyph" aria-hidden="true">
          <StarGlyph size={glyphSize(kind)} />
        </span>
      ) : null}
      {showPause ? <PauseToggle paused={paused} /> : null}
    </>,
    host
  )
}

function glyphSize(kind: StarTarget['kind'] | null): number {
  return kind === 'stage' || kind === 'backdrop' ? 160 : kind === 'preview' ? 96 : kind === 'header' ? 24 : 28
}

/** Sized stages get a pause button on hover/focus (always visible while paused): WCAG 2.2.2 / 07 D9. */
function PauseToggle({ paused }: { paused: boolean }): ReactNode {
  const label = paused ? 'Resume the Star’s animation' : 'Pause the Star’s animation'
  return (
    <button
      type="button"
      className="presence-pause no-drag"
      data-paused={paused || undefined}
      aria-label={label}
      aria-pressed={paused}
      title={label}
      onClick={() => useStore.getState().setStarPaused(!paused)}
    >
      {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
    </button>
  )
}

/** The winning stage target. */
function useActiveTarget(): StarTarget | null {
  return useSyncExternalStore(subscribeTargets, activeTarget)
}

/** A target's `data-star-state` (set by <Star state=…>), followed live with an attribute observer. */
function useTargetOverride(target: StarTarget | null): StarState | null {
  const [value, setValue] = useState<StarState | null>(null)
  useEffect(() => {
    const el = target?.el
    const read = (): void => setValue((el?.dataset.starState as StarState | undefined) || null)
    read()
    if (!el) return
    const mo = new MutationObserver(read)
    mo.observe(el, { attributes: true, attributeFilter: ['data-star-state'] })
    return () => mo.disconnect()
  }, [target])
  return value
}

/** Light theme (or system → light): the Star keeps a dark "night window" (04 Themes). */
function useNightStage(): boolean {
  const theme = useStore((s) => s.settings?.appearance.theme ?? 'dark')
  const osLight = useMediaQuery('(prefers-color-scheme: light)')
  return theme === 'light' || (theme === 'system' && osLight)
}
