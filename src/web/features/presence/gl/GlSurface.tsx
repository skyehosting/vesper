/**
 * The one WebGL canvas of the app (07 D5): an R3F <Canvas> with `frameloop="never"`, driven by the presence frame
 * scheduler (07 D4). It shows the avatar (Armilla, the v1.1 default, or the 1.0 orb / nebula) or the Constellation
 * map — the same context for both — and
 * lives as long as <PresenceHost> keeps it mounted: moving between stages re-parents the host element, never this
 * component. Unmounting it (style Off, real teardown) disposes everything and forces the context loss (R3F does both).
 *
 * Context loss (07 D5): the event is prevented so the browser may restore it; while lost, the scheduler draws nothing;
 * on restore three.js re-uploads its resources and one frame is drawn.
 *
 * Bloom (postprocessing) runs for the orb / nebula on `high` quality only; `medium`/`low` fake the glow in the shaders
 * (research 07 §2.6). Armilla draws its own glow in one pass. Behind the chat's text every frame goes through the
 * luminance cap (stageLook.ts; in the light theme it caps how much ink a pixel lays instead).
 */
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { BloomEffect, Effect, EffectComposer, EffectPass, RenderPass } from 'postprocessing'
import * as THREE from 'three'
import type { StarQuality, StarState } from '../../../lib/store/presence'
import { useStore } from '../../../lib/store'
import type { FrameScheduler } from '../host/scheduler'
import type { StarPalette } from '../visual.logic'
import { glCounters } from './glStats'
import { easeStage, FULL_STAGE, stageLook, subscribeStageLook, type StageLook } from '../host/stageLook'
import { EDGE_FADE_EFFECT, LUMA_CAP_EFFECT } from './starShaders'
import { StarScene } from './StarScene'
import { ArmillaScene } from './avatars/armilla/ArmillaScene'

const ConstellationScene = lazy(() => import('../constellation/ConstellationScene'))

export interface GlSurfaceProps {
  scheduler: FrameScheduler
  mode: 'star' | 'constellation'
  /** The canvas is shown (false = parked: kept alive, drawing nothing). */
  shown: boolean
  style: 'armilla' | 'orb' | 'nebula'
  quality: StarQuality
  reducedMotion: boolean
  dprCap: number
  palette: StarPalette
  stateRef: { current: StarState }
  /** Light theme: Armilla draws as ink instead of light (and the backdrop's cap bounds the ink). */
  ink?: boolean
  /** The surface is the chat backdrop (v11): frames go through the luminance cap while one applies (stageLook.ts). */
  backdrop?: boolean
  /** Test builds: render at exactly this device-pixel ratio (GPU cost measurements), whatever the display's. */
  dprExact?: number | null
}

// No R3F pointer events: the Star is decorative and Constellation handles its own input on the page (07 D9).
const NO_EVENTS = (): { enabled: boolean; priority: number } => ({ enabled: false, priority: 0 })

export default function GlSurface(props: GlSurfaceProps): ReactNode {
  const { quality, dprCap } = props
  const lostRef = useRef(false)
  return (
    <GlErrorBoundary>
      <Canvas
        className="presence-canvas"
        aria-hidden="true"
        frameloop="never"
        flat
        linear
        dpr={props.dprExact ? [props.dprExact, props.dprExact] : [Math.min(1, dprCap), dprCap]}
        gl={{ alpha: true, antialias: quality !== 'low', powerPreference: 'default', premultipliedAlpha: true, stencil: false }}
        events={NO_EVENTS as never}
        // A short debounce moves R3F's size update out of the ResizeObserver callback (no "RO loop" errors on resizes).
        // offsetSize: the backdrop scales its box with a CSS transform (state changes); that must not resize the buffer.
        resize={{ scroll: false, debounce: { scroll: 0, resize: 12 }, offsetSize: true }}
        camera={{ fov: 32, near: 0.1, far: 400, position: [0, 0, 5] }}
        onCreated={(state) => {
          glCounters.created++
          glCounters.live++
          state.gl.setClearColor(0x000000, 0)
          // R3F sizes the drawing buffer after the first measure; draw once it exists.
          props.scheduler.requestFrame()
        }}
        style={{ position: 'absolute', inset: 0, visibility: props.shown ? 'visible' : 'hidden' }}
      >
        <Bridge {...props} lostRef={lostRef} />
        {props.mode === 'constellation' ? (
          <Suspense fallback={null}>
            <ConstellationScene scheduler={props.scheduler} frame={props.scheduler.frame} reducedMotion={props.reducedMotion} palette={props.palette} />
          </Suspense>
        ) : props.style === 'armilla' ? (
          <ArmillaScene
            quality={props.quality}
            reducedMotion={props.reducedMotion}
            palette={props.palette}
            ink={!!props.ink}
            dim={1}
            backdrop={!!props.backdrop}
            stateRef={props.stateRef}
            frame={props.scheduler.frame}
            onMoving={() => props.scheduler.kick(50)}
          />
        ) : (
          <StarScene
            style={props.style === 'nebula' ? 'nebula' : 'orb'}
            quality={props.quality}
            reducedMotion={props.reducedMotion}
            palette={props.palette}
            stateRef={props.stateRef}
            frame={props.scheduler.frame}
            onMoving={() => props.scheduler.kick(50)}
            bloom={props.quality === 'high'}
          />
        )}
      </Canvas>
    </GlErrorBoundary>
  )
}

/** Connects R3F to the scheduler: renders through the composer, handles resize and context loss, counts frames. */
function Bridge({ scheduler, shown, quality, mode, style, ink = false, lostRef, backdrop = false }: GlSurfaceProps & { lostRef: { current: boolean } }): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const advance = useThree((s) => s.advance)
  // Armilla draws its own glow in one pass (no bloom).
  const bloomOn = quality === 'high' && mode === 'star' && style !== 'armilla'
  // The cap pass only while a cap below 1 applies or is still easing out: a dark hero draws straight (no composer).
  const needCap = useSyncExternalStore(subscribeStageLook, capBelowOne)
  const [linger, setLinger] = useState(false)
  const hadCap = useRef(needCap)
  useEffect(() => {
    if (hadCap.current && !needCap) setLinger(true)
    hadCap.current = needCap
  }, [needCap])
  const capOn = backdrop && mode === 'star' && (needCap || linger)
  // Armilla's light theme lays ink (real alpha): the cap bounds the ink's coverage instead of the light.
  const capInk = capOn && ink && style === 'armilla'

  const { composer, cap } = useMemo(() => {
    if (!bloomOn && !capOn) return { composer: null, cap: null }
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType })
    c.addPass(new RenderPass(scene, camera))
    const effects: Effect[] = []
    if (bloomOn) effects.push(new BloomEffect({ intensity: 0.75, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.68, levels: 6 }))
    // The bloom spreads light toward the canvas edge; fade it out before it gets there (no visible box).
    if (bloomOn) effects.push(new Effect('EdgeFade', EDGE_FADE_EFFECT))
    // The chat backdrop's legibility guard comes last: nothing after it may brighten a pixel (v11, backdrop.logic.ts).
    const t = stageLook()
    const u = {
      uCap: new THREE.Uniform(t.cap),
      uCapOut: new THREE.Uniform(t.capOut),
      uColHalf: new THREE.Uniform(t.colHalf),
      uColEdge: new THREE.Uniform(t.colEdge),
      uInk: new THREE.Uniform(capInk ? 1 : 0)
    }
    if (capOn) effects.push(new Effect('LumaCap', LUMA_CAP_EFFECT, { uniforms: new Map<string, THREE.Uniform>(Object.entries(u)) }))
    c.addPass(new EffectPass(camera, ...effects))
    return { composer: c, cap: capOn ? u : null }
  }, [bloomOn, capOn, capInk, gl, scene, camera])

  useEffect(() => () => composer?.dispose(), [composer])

  // The backdrop's stage look, eased per drawn frame (a cap change is a crossfade, not a jump).
  const stage = useRef<StageLook>({ ...stageLook() })

  useEffect(() => {
    composer?.setSize(size.width, size.height)
    scheduler.requestFrame()
  }, [composer, size.width, size.height, scheduler])

  // Draw through the scheduler only: priority 1 takes over R3F's own render.
  useFrame(() => {
    if (lostRef.current) return
    if (cap) {
      const st = stage.current
      if (easeStage(st, backdrop ? stageLook() : FULL_STAGE, scheduler.frame.dt)) scheduler.kick(50)
      cap.uCap.value = st.cap
      cap.uCapOut.value = st.capOut
      cap.uColHalf.value = st.colHalf
      cap.uColEdge.value = st.colEdge
      if (linger && !capBelowOne() && st.cap >= 0.999 && st.capOut >= 0.999) setLinger(false)
    }
    if (composer) composer.render(scheduler.frame.dt)
    else gl.render(scene, camera)
    glCounters.rendered++
  }, 1)

  // R3F commits in its own reconciler, after the host's: when the canvas hides because the 2D star took over, this
  // cleanup can run after the 2D star set its renderer — release only our own (v11: found switching styles in chat).
  useEffect(() => {
    if (!shown) return
    const mine = (f: { now: number }): void => advance(f.now)
    scheduler.setRenderer(mine)
    return () => scheduler.releaseRenderer(mine)
  }, [shown, scheduler, advance])

  useEffect(() => {
    const canvas = gl.domElement
    const onLost = (e: Event): void => {
      e.preventDefault()
      lostRef.current = true
      glCounters.lost++
      useStore.getState().setWebglStatus('lost')
      scheduler.update({ canDraw: false })
    }
    const onRestored = (): void => {
      lostRef.current = false
      glCounters.restored++
      useStore.getState().setWebglStatus('ok')
      scheduler.update({ canDraw: true })
      scheduler.requestFrame()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    useStore.getState().setWebglStatus('ok')
    scheduler.update({ canDraw: true })
    glCounters.renderer = gl
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      // Teardown: R3F disposes the renderer and forces the context loss right after this cleanup.
      glCounters.renderer = null
      glCounters.live = Math.max(0, glCounters.live - 1)
      scheduler.update({ canDraw: false })
    }
  }, [gl, scheduler, lostRef])

  return null
}

function capBelowOne(): boolean {
  const t = stageLook()
  return t.cap < 0.999 || t.capOut < 0.999
}

/** WebGL unavailable (blocked GPU, no WebGL2): the host falls back to the 2D star and Constellation to its list. */
class GlErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[vesper presence] WebGL unavailable', error, info.componentStack)
    useStore.getState().setWebglStatus('unavailable')
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
