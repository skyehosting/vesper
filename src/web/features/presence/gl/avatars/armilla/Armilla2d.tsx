/**
 * Armilla without WebGL (phones, blocked GPUs; 07 D8): the same instrument as SVG. The gimbals are projected with the
 * same pose math as the GL scene (armilla.logic), split into front and back halves (the back dimmer, hidden behind the
 * bead); the horizon is the same live oscilloscope (Scope / horizonWave): the real voice standing still across its front,
 * the AI's one output latency late, the owner's live. One scheduled frame writes a handful of path `d`s and CSS
 * variables — the same frame budget, rest at 0 fps, the same flash limits; only the horizon (and the bead) follow the
 * voice, the gimbals never do (ringFrame). No CSS filters on moving elements; point buffers and matrices are
 * preallocated (the path strings are the only per-frame garbage).
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createLevels, getAudioEngine, getMicCapture } from '../../../../../lib/audio'
import type { StarState } from '../../../../../lib/store/presence'
import type { FrameInfo, FrameScheduler } from '../../../host/scheduler'
import { capCurve } from '../../../backdrop.logic'
import { easeStage, FULL_STAGE, stageLook } from '../../../host/stageLook'
import { desaturate, PulseLimiter, stepSpring, throbBrightness, type Rgb, type StarPalette } from '../../../visual.logic'
import {
  armColors,
  createArmLook,
  createGimbals,
  createRingFrame,
  gimbalRadius,
  horizonWave,
  R_BEAD,
  REST_LEVEL,
  ringFrame,
  stepArmLook,
  stepGimbals,
  Scope,
  waveAmp
} from './armilla.logic'
import { armillaProbe } from './probe'
import './armilla2d.css'

export interface Armilla2dProps {
  scheduler: FrameScheduler
  active: boolean
  palette: StarPalette
  reducedMotion: boolean
  stateRef: { current: StarState }
  ink: boolean
  /** 1 = full strength. */
  dim?: number
  /** The chat backdrop (v1.1): the luminance cap (stageLook.ts) bounds each element's opacity — light or ink. */
  backdrop?: boolean
}

const R_H = 1.25
const ELEV = (6.5 * Math.PI) / 180
const CE = Math.cos(ELEV)
const SE = Math.sin(ELEV)
const RING_PTS = 56
/** The horizon's front carries the oscilloscope: a point every ~2.5 CSS px (96–400); its back half is still. */
const HORIZON_FRONT_MAX = 400
const HORIZON_BACK_PTS = 64
/** The SVG's viewBox half-extents (user units). */
const VB_HW = 1.42
const VB_HH = 1.0
/** The horizon fades out over this many CSS px before the drawing's edge (never cut off). */
const EDGE_FADE_PX = 24

/**
 * Behind text the cap is shared out so stacked elements stay within it where they overlap (SVG has no final cap pass
 * like GL's LumaCap; the worst pixel is the horizon and a gimbal crossing in front of the bead): the halo's peak
 * ≤ 0.25 × cap, the whole bead ≤ 0.4 × cap, a line ≤ 0.7 × cap. At cap 1: all 1. Measured: contrast.ts at 390×844.
 */
const LINE_SHARE = 0.7
function capShares(node: HTMLElement, cap: number): void {
  const f = cap >= 0.999 ? 1 : 0.4 + 0.6 * Math.min(1, Math.max(0, (cap - 0.22) / 0.78))
  node.style.setProperty('--arm-bead-o', (cap >= 0.999 ? 1 : cap * f).toFixed(3))
  // The halo's gradient peaks at 0.32 × 0.8 ≈ 0.26.
  node.style.setProperty('--arm-halo-o', (cap >= 0.999 ? 1 : Math.min(1, (0.25 * cap * (f / 0.4)) / 0.26)).toFixed(3))
}

/** A line's opacity behind text: the cap's curve over its share. */
const lineCap = (x: number, cap: number): number => (cap >= 0.999 ? x : capCurve(x, LINE_SHARE * cap))

const css = (c: readonly number[]): string => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`

/** Row-major 3×3 rotations, written in place. */
function set9(o: Float64Array, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): void {
  o[0] = a
  o[1] = b
  o[2] = c
  o[3] = d
  o[4] = e
  o[5] = f
  o[6] = g
  o[7] = h
  o[8] = i
}
function setRy(o: Float64Array, a: number): void {
  set9(o, Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a))
}
function setRx(o: Float64Array, a: number): void {
  set9(o, 1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a))
}
function mulInto(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
}

/** Project (x, y, z) into `pts` at point i: an orthographic view from ELEV above the horizon plane; [x, y, depth]. */
function put(pts: Float64Array, i: number, x: number, y: number, z: number): void {
  pts[i * 3] = x
  pts[i * 3 + 1] = -(y * CE - z * SE)
  pts[i * 3 + 2] = z * CE + y * SE
}

/** A path through the points on the front (depth ≥ −0.02) or the back (and outside the bead), broken into runs. */
function pathOf(pts: Float64Array, n: number, front: boolean, beadR: number): string {
  let d = ''
  let open = false
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3]
    const y = pts[i * 3 + 1]
    const z = pts[i * 3 + 2]
    const keep = front ? z >= -0.02 : z < 0.02 && Math.hypot(x, y) > beadR * 1.05
    if (keep) {
      d += `${open ? 'L' : 'M'}${x.toFixed(4)} ${y.toFixed(4)}`
      open = true
    } else open = false
  }
  return d
}

export function Armilla2d({ scheduler, active, palette, reducedMotion, stateRef, ink, dim = 1, backdrop = false }: Armilla2dProps): ReactNode {
  const el = useRef<HTMLDivElement>(null)
  const rm = useRef(reducedMotion)
  rm.current = reducedMotion
  const bd = useRef(backdrop)
  bd.current = backdrop
  const dimRef = useRef(dim)
  dimRef.current = dim
  const inkRef = useRef(ink)
  inkRef.current = ink
  const colors = useMemo(() => armColors(palette), [palette])
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  /** CSS px per world unit (the SVG fits its viewBox: "meet"), from the resize observer. */
  const pxPerWorld = useRef(0)

  useEffect(() => {
    const node = el.current
    if (!node) return
    node.dataset.ink = ink ? 'true' : 'false'
    node.style.setProperty('--arm-dim', String(dim))
    // Colours are written by the frame (saturation folded in); force them now.
    delete node.dataset.sat
    scheduler.requestFrame()
  }, [colors, ink, dim, scheduler])

  // The horizon's edge fade, in user units: from the drawing's real edge (the SVG fits the viewBox: "meet").
  useEffect(() => {
    const node = el.current
    if (!node) return
    const grad = node.querySelector('#arm2d-hfade') as SVGLinearGradientElement | null
    if (!grad) return
    const stops = grad.querySelectorAll('stop')
    const fit = (): void => {
      const w = node.clientWidth
      const h = node.clientHeight
      if (!w || !h) return
      const scale = Math.min(w / (2 * VB_HW), h / (2 * VB_HH))
      pxPerWorld.current = scale
      const edge = w / 2 / scale
      const f = Math.min(0.49, EDGE_FADE_PX / scale / (2 * edge))
      grad.setAttribute('x1', String(-edge))
      grad.setAttribute('x2', String(edge))
      stops[1]?.setAttribute('offset', String(f))
      stops[2]?.setAttribute('offset', String(1 - f))
    }
    fit()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    ro?.observe(node)
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    const node = el.current
    if (!node) return
    const q = (sel: string): SVGElement => node.querySelector(sel) as SVGElement
    const ringFront = [q('[data-r="1f"]'), q('[data-r="2f"]'), q('[data-r="3f"]')]
    const ringBack = [q('[data-r="1b"]'), q('[data-r="2b"]'), q('[data-r="3b"]')]
    const hFront = q('[data-h="f"]')
    const hGlow = q('[data-h="g"]')
    const hBack = q('[data-h="b"]')
    const bead = q('.arm2d__bead') as SVGCircleElement
    const clip = q('.arm2d__clip') as SVGCircleElement
    const liquid = q('.arm2d__liquid')
    const meniscus = q('.arm2d__meniscus')
    let level = REST_LEVEL
    let slosh = 0
    const look = createArmLook(stateRef.current)
    const gimbals = createGimbals()
    const scope = new Scope()
    const out = createLevels()
    const mic = createLevels()
    const pulse = new PulseLimiter()
    const spring = { x: 1, v: 0 }
    const rf = createRingFrame()
    const rgb: [number, number, number] = [0, 0, 0]
    const ringPts = [new Float64Array((RING_PTS + 1) * 3), new Float64Array((RING_PTS + 1) * 3), new Float64Array((RING_PTS + 1) * 3)]
    const hFrontPts = new Float64Array((HORIZON_FRONT_MAX + 1) * 3)
    const hBackPts = new Float64Array((HORIZON_BACK_PTS + 1) * 3)
    const mA = new Float64Array(9)
    const mats = [new Float64Array(9), new Float64Array(9), new Float64Array(9)]
    let env = 0
    let micEnv = 0
    let time = 0
    let waveT = 0
    let lastSat = ''
    const stage = { ...(bd.current ? stageLook() : FULL_STAGE) }
    // Apply the cap right away: a surface that rests at 0 fps must not wait for a frame to be legible.
    node.style.setProperty('--arm-cap', String(stage.cap))
    capShares(node, stage.cap)
    node.style.setProperty('--arm-h', String(lineCap(0.85, stage.cap)))
    node.style.setProperty('--arm-g', String(lineCap(0.53, stage.cap)))

    /** Colours with the look's saturation folded in (no CSS filter); written only when they change. */
    const paint = (sat: number): void => {
      const key = `${sat.toFixed(2)}${inkRef.current ? 'i' : 'l'}`
      if (key === lastSat && node.dataset.sat === key) return
      lastSat = key
      node.dataset.sat = key
      const c = colorsRef.current
      const i = inkRef.current
      const s = node.style
      const set = (name: string, col: Rgb): void => s.setProperty(name, css(desaturate(col, sat, rgb)))
      set('--arm-ring', i ? c.inkRing : c.ring)
      set('--arm-horizon', i ? c.inkHorizon : c.horizon)
      set('--arm-mic', i ? c.inkMic : c.mic)
      set('--arm-bead', i ? c.inkBead : c.bead)
      set('--arm-halo', i ? c.inkBead : c.halo)
    }

    const render = (f: FrameInfo): void => {
      const reduced = rm.current
      const motion = reduced ? 0 : 1
      let moving = stepArmLook(look, stateRef.current, f.dt)
      if (f.poll) {
        getAudioEngine().output.read(out)
        getMicCapture().input.read(mic)
      } else {
        const k = Math.exp(-f.dt / 0.25)
        out.rms *= k
        out.low *= k
        out.mid *= k
        out.high *= k
        out.onset = 0
        mic.rms *= k
        mic.low *= k
        mic.mid *= k
        mic.high *= k
      }
      env += (out.rms - env) * (1 - Math.exp(-f.dt / (reduced ? 0.35 : 0.06)))
      micEnv += (mic.rms - micEnv) * (1 - Math.exp(-f.dt / (reduced ? 0.35 : 0.08)))
      const ai = look.voice
      const me = look.ring
      const scale = pxPerWorld.current || node.clientWidth / (2 * VB_HW) || 100
      if (motion) {
        // The oscilloscope of whoever is louder (weighted by the state), as in the GL scene (the AI's an output latency late).
        const owner = micEnv * me > env * ai
        const engine = getAudioEngine()
        const src = owner ? getMicCapture().input : engine.output
        scope.step(f.dt, f.poll ? src.samples() : null, src.sampleRate, owner ? me : ai, owner ? 1 : 0, owner ? 0 : engine.outputDelayS())
        if (scope.busy) moving = true
        time += f.dt * (1 - 0.8 * look.calm)
        waveT += f.dt
      }
      if (easeStage(stage, bd.current ? stageLook() : FULL_STAGE, f.dt)) moving = true
      const behind = stage.behind
      const p = reduced ? 0 : pulse.step(out.onset * ai, f.now, f.dt)
      const nod = 0.05 * Math.sin(time * 0.31) + 0.03 * Math.sin(time * 0.53 + 1)
      if (stepGimbals(gimbals, look, f.dt, motion, nod)) moving = true
      setRy(mats[0], gimbals.a0)
      setRx(mA, gimbals.a1)
      mulInto(mats[1], mats[0], mA)
      setRy(mA, gimbals.a2)
      mulInto(mats[2], mats[1], mA)
      stepSpring(spring, 1 + (0.11 * env + 0.04 * p) * ai * motion + 0.03 * micEnv * me * motion + 0.06 * look.gather, f.dt)
      const beadR = R_BEAD * spring.x
      const nowS = f.now / 1000
      for (let i = 0; i < 3; i++) {
        // The gimbals turn but never move with audio: only the horizon shows the voice (owner, v1.1).
        const r = gimbalRadius(i as 0 | 1 | 2, look, nowS, motion)
        const m = mats[i]
        const pts = ringPts[i]
        for (let k = 0; k <= RING_PTS; k++) {
          const th = (k / RING_PTS) * Math.PI * 2
          const lx = r * Math.cos(th)
          const ly = r * Math.sin(th)
          put(pts, k, m[0] * lx + m[1] * ly, m[3] * lx + m[4] * ly, m[6] * lx + m[7] * ly)
        }
        ringFront[i].setAttribute('d', pathOf(pts, RING_PTS + 1, true, beadR))
        // Behind the bead: hidden by it.
        ringBack[i].setAttribute('d', pathOf(pts, RING_PTS + 1, false, beadR))
      }
      // The horizon's front, uniform in x (left end → right end), carries the wave; the back half runs behind the bead.
      const amp = waveAmp(scale)
      const nF = Math.max(96, Math.min(HORIZON_FRONT_MAX, Math.round((2 * R_H * scale) / 2.5)))
      for (let k = 0; k <= nF; k++) {
        const x = R_H * (-1 + (2 * k) / nF)
        const th = Math.acos(Math.max(-1, Math.min(1, x / R_H)))
        put(hFrontPts, k, x, motion ? horizonWave(scope, th, amp) : 0, R_H * Math.sin(th))
      }
      for (let k = 0; k <= HORIZON_BACK_PTS; k++) {
        const th = Math.PI + (k / HORIZON_BACK_PTS) * Math.PI
        put(hBackPts, k, R_H * Math.cos(th), motion ? horizonWave(scope, th, amp) : 0, R_H * Math.sin(th))
      }
      const front = pathOf(hFrontPts, nF + 1, true, beadR)
      hFront.setAttribute('d', front)
      hGlow.setAttribute('d', front)
      hBack.setAttribute('d', pathOf(hBackPts, HORIZON_BACK_PTS + 1, false, beadR))
      bead.setAttribute('r', beadR.toFixed(4))
      clip.setAttribute('r', (beadR * 0.985).toFixed(4))
      // The liquid: level and waves as in the GL bead (seen nearly edge-on, so the waterline is a gentle curve).
      level += (REST_LEVEL + (0.22 * look.face * me + 0.18 * look.gather + 0.1 * ai) * motion - level) * (1 - Math.exp(-f.dt / 0.5))
      slosh += (out.low * ai * motion * (0.4 + 0.9 * env) - slosh) * (1 - Math.exp(-f.dt / 0.12))
      let wl = ''
      for (let k = 0; k <= 24; k++) {
        const u = (k / 24) * 2 - 1
        const x = u * beadR
        const h =
          level +
          slosh * 0.075 * Math.sin(3.1 * u - 4.6 * waveT) +
          micEnv * me * motion * 0.035 * Math.sin(16 * Math.abs(u) + 7 * waveT) +
          0.012 * Math.sin(1.7 * u + 0.8 * time)
        wl += `${k ? 'L' : 'M'}${x.toFixed(4)} ${(-(h * CE) * beadR + SE * 0.55 * beadR).toFixed(4)}`
      }
      meniscus.setAttribute('d', wl)
      liquid.setAttribute('d', `${wl}L${beadR.toFixed(4)} ${beadR.toFixed(4)}L${(-beadR).toFixed(4)} ${beadR.toFixed(4)}Z`)
      // Brightness: the horizon (and the bead) with the voice, the gimbals without (ringFrame) — as opacities.
      ringFrame(rf, look, env, micEnv, p, reduced ? 1 : throbBrightness(nowS, look.throb), behind)
      paint(look.saturation)
      const st = node.style
      // Behind text each element goes through the cap's curve (GL LumaCap's twin): bounded, but never all scaled down.
      const cap = stage.cap
      st.setProperty('--arm-h', lineCap(Math.min(1, 0.85 * rf.brightHorizon * rf.gains[0]), cap).toFixed(3))
      st.setProperty('--arm-g', lineCap(Math.min(1, 0.85 * rf.brightGimbal * rf.gains[1]), cap).toFixed(3))
      st.setProperty('--arm-cap', cap.toFixed(3))
      capShares(node, cap)
      st.setProperty('--arm-glow', (1 - 0.75 * behind).toFixed(3))
      st.setProperty('--arm-listen', (look.face * me).toFixed(3))
      st.setProperty('--arm-error', look.error.toFixed(3))
      node.dataset.behind = behind > 0.5 ? 'true' : 'false'
      st.setProperty('--arm-dim', String(dimRef.current))
      if (moving) scheduler.kick(50)
      if (__VESPER_TEST__) {
        armillaProbe.frames++
        armillaProbe.scope = scope
        armillaProbe.last = { wave: scope.level, delayMs: scope.delayS * 1000, env, micEnv, low: out.low, mid: out.mid, high: out.high, onset: out.onset, pulses: pulse.fired, bright: rf.brightHorizon, brightGimbal: rf.brightGimbal }
      }
    }
    scheduler.setRenderer(render)
    return () => scheduler.releaseRenderer(render)
  }, [active, scheduler, stateRef])

  return (
    <div ref={el} className="arm2d" aria-hidden="true">
      <svg viewBox={`${-VB_HW} ${-VB_HH} ${2 * VB_HW} ${2 * VB_HH}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="arm2d-halo">
            <stop offset="0" stopColor="var(--arm-halo)" stopOpacity="0.32" />
            <stop offset="0.35" stopColor="var(--arm-halo)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--arm-halo)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="arm2d-glass" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.7" stopColor="var(--arm-ring)" stopOpacity="0.02" />
            <stop offset="1" stopColor="var(--arm-ring)" stopOpacity="0.35" />
          </radialGradient>
          <linearGradient id="arm2d-liquid" x1="0" y1="0" x2="0" y2="1">
            <stop className="arm2d__lq-top" offset="0.45" />
            <stop className="arm2d__lq-deep" offset="1" />
          </linearGradient>
          {/* The horizon's colour, fading out over the last 24 px before the drawing's edge (offsets set on resize). */}
          <linearGradient id="arm2d-hfade" gradientUnits="userSpaceOnUse" x1={-VB_HW} y1="0" x2={VB_HW} y2="0">
            <stop className="arm2d__hf arm2d__hf--end" offset="0" />
            <stop className="arm2d__hf" offset="0.05" />
            <stop className="arm2d__hf" offset="0.95" />
            <stop className="arm2d__hf arm2d__hf--end" offset="1" />
          </linearGradient>
          <clipPath id="arm2d-clip">
            <circle className="arm2d__clip" r={R_BEAD} />
          </clipPath>
        </defs>
        <circle className="arm2d__halo" r="0.9" fill="url(#arm2d-halo)" />
        <g className="arm2d__back">
          <path data-h="b" className="arm2d__horizon" />
          <path data-r="1b" className="arm2d__ring" />
          <path data-r="2b" className="arm2d__ring" />
          <path data-r="3b" className="arm2d__ring" />
        </g>
        {/* The bead as one layer: behind text the whole glass is bounded by the cap (its parts stack inside it). */}
        <g className="arm2d__beadg">
          <g clipPath="url(#arm2d-clip)">
            <path className="arm2d__liquid" fill="url(#arm2d-liquid)" />
            <path className="arm2d__meniscus" />
          </g>
          <circle className="arm2d__bead" r={R_BEAD} fill="url(#arm2d-glass)" />
          {/* The window reflection: a soft second, wider circle instead of a blur filter. */}
          <circle className="arm2d__spec-soft" cx={-R_BEAD * 0.42} cy={-R_BEAD * 0.45} r={R_BEAD * 0.2} />
          <circle className="arm2d__spec" cx={-R_BEAD * 0.42} cy={-R_BEAD * 0.45} r={R_BEAD * 0.11} />
        </g>
        <g className="arm2d__front">
          <path data-r="1f" className="arm2d__ring arm2d__ring--outer" />
          <path data-r="2f" className="arm2d__ring" />
          <path data-r="3f" className="arm2d__ring" />
          <path data-h="g" className="arm2d__horizon-glow" />
          <path data-h="f" className="arm2d__horizon" />
        </g>
      </svg>
    </div>
  )
}
