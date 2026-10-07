/**
 * Armilla in WebGL: the horizon + three gimbal rings (one ribbon mesh, one draw call), the bead and its halo (one
 * quad), and six pivot jewels (points) — 3 draw calls, no post-processing. Same contract as <StarScene>: drawn only
 * by the presence frame scheduler (07 D4), levels polled only when the frame allows, uniforms mutated in useFrame
 * (never React state per frame), everything created once per quality and disposed with it.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { createLevels, getAudioEngine, getMicCapture, type Levels } from '../../../../../lib/audio'
import type { StarQuality, StarState } from '../../../../../lib/store/presence'
import type { FrameInfo } from '../../../host/scheduler'
import { desaturate, PulseLimiter, stepSpring, throbBrightness, type Rgb, type Spring, type StarPalette } from '../../../visual.logic'
import { easeStage, FULL_STAGE, stageLook, type StageLook } from '../../../host/stageLook'
import {
  armColors,
  createArmLook,
  createGimbals,
  createRingFrame,
  gimbalRadius,
  JEWEL_GLOW,
  R_BEAD,
  R_GIMBAL,
  REST_LEVEL,
  ringFrame,
  stepArmLook,
  stepGimbals,
  Scope,
  SCOPE_N,
  waveAmp
} from './armilla.logic'
import { armillaProbe } from './probe'
import { BEAD_FRAGMENT, JEWEL_FRAGMENT, JEWEL_VERTEX, QUAD_VERTEX, RING_FRAGMENT, RING_VERTEX } from './shaders'

export interface ArmillaSceneProps {
  quality: StarQuality
  reducedMotion: boolean
  palette: StarPalette
  /** Light theme: draw as ink on the page instead of light. */
  ink: boolean
  /** 1 = full; lower when it sits behind text. */
  dim: number
  /** The chat backdrop: read the stage look (behind text: hairlines, no fine band, ink bead outline). */
  backdrop?: boolean
  stateRef: { current: StarState }
  frame: FrameInfo
  onMoving: () => void
}

/** World sizes: horizon, gimbals (outer → inner), bead, and the bead quad's half-size (halo room). */
const R_HORIZON = 1.25
const BEAD_HALF = 1.15
/** Line half-widths (CSS px): horizon, outer, middle, inner. */
const LINE_W = [0.62, 0.38, 0.36, 0.34] as const
/** The horizon carries the oscilloscope (SCOPE_N points across its front): ~1.3 px per vertex across its middle. */
const SEGMENTS: Record<StarQuality, { horizon: number; ring: number }> = {
  low: { horizon: 1024, ring: 160 },
  medium: { horizon: 1536, ring: 256 },
  high: { horizon: 2048, ring: 384 }
}
/** Camera: a few degrees above the horizon's plane, so the horizon reads as a line. */
const ELEVATION = (6.5 * Math.PI) / 180
const CAM_DIST = 5
const FOV = 32
/** What must fit: half-width (horizon + glow) and half-height (outer gimbal + its pins). */
const FIT_W = 1.36
const FIT_H = 0.8

/** Thinking comets: revolutions per second for the horizon and each gimbal. */
const COMET_RATE = [0.12, 0.33, -0.5, 0.75] as const

function ribbonGeometry(q: StarQuality): THREE.BufferGeometry {
  const seg = SEGMENTS[q]
  const counts = [seg.horizon, seg.ring, seg.ring, seg.ring]
  let verts = 0
  let tris = 0
  for (const n of counts) {
    verts += (n + 1) * 2
    tris += n * 2
  }
  const aT = new Float32Array(verts)
  const aSide = new Float32Array(verts)
  const aRing = new Float32Array(verts)
  const index = new Uint32Array(tris * 3)
  let v = 0
  let t = 0
  counts.forEach((n, ring) => {
    const base = v
    for (let i = 0; i <= n; i++) {
      for (const side of [-1, 1]) {
        aT[v] = i / n
        aSide[v] = side
        aRing[v] = ring
        v++
      }
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2
      index[t++] = a
      index[t++] = a + 1
      index[t++] = a + 2
      index[t++] = a + 1
      index[t++] = a + 3
      index[t++] = a + 2
    }
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
  g.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
  g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.6)
  return g
}

/** Premultiplied "over" for every material: alpha 0 adds light (dark theme), alpha > 0 lays ink (light theme). */
function premultiplied(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneMinusSrcAlphaFactor
  m.blendSrcAlpha = THREE.OneFactor
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
  m.transparent = true
  m.depthWrite = false
  m.depthTest = false
  // Ribbons are expanded in screen space: their winding is arbitrary, so no face culling.
  m.side = THREE.DoubleSide
  return m
}

/** a + (b − a) t into `out` (no allocation). */
function lerpInto(out: [number, number, number], a: Rgb, b: Rgb, t: number): [number, number, number] {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** One pivot jewel: (x, y) on a gimbal's plane, through its matrix; the constant glow (they are the gimbals' pins). */
function putJewel(pos: THREE.BufferAttribute, glow: THREE.BufferAttribute, pv: THREE.Vector3, i: number, m: THREE.Matrix4, x: number, y: number): void {
  pv.set(x, y, 0).applyMatrix4(m)
  pos.setXYZ(i, pv.x, pv.y, pv.z)
  glow.setX(i, JEWEL_GLOW)
}

const v3 = (): THREE.Vector3 => new THREE.Vector3()
const c3 = (): THREE.Color => new THREE.Color()
const setC = (c: THREE.Color | THREE.Vector3, rgb: readonly number[]): void => {
  if (c instanceof THREE.Color) c.setRGB(rgb[0], rgb[1], rgb[2])
  else c.set(rgb[0], rgb[1], rgb[2])
}

export function ArmillaScene({ quality, reducedMotion, palette, ink, dim, backdrop = false, stateRef, frame, onMoving }: ArmillaSceneProps): ReactNode {
  const size = useThree((s) => s.size)
  const viewport = useThree((s) => s.viewport)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)

  const scope = useMemo(() => new Scope(), [])
  const scopeTex = useMemo(() => {
    const t = new THREE.DataTexture(scope.data, SCOPE_N, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.wrapS = THREE.ClampToEdgeWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    return t
  }, [scope])
  useEffect(() => () => scopeTex.dispose(), [scopeTex])

  const shared = useMemo(
    () => ({
      uRes: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1 },
      uInk: { value: 0 },
      uBright: { value: 1 },
      uDim: { value: 1 },
      uTime: { value: 0 },
      uCoreR: { value: R_BEAD }
    }),
    []
  )

  const parts = useMemo(() => {
    const ringU = {
      ...shared,
      uRingM: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
      uRadius: { value: [R_HORIZON, R_GIMBAL[0], R_GIMBAL[1], R_GIMBAL[2]] },
      uSwell: { value: 1 },
      uScope: { value: scopeTex },
      uScopeWho: { value: 0 },
      uScopeLevel: { value: 0 },
      uWaveOn: { value: 1 },
      uAmp: { value: 0.05 },
      uGlowPx: { value: 2 },
      uWater: { value: 0 },
      uLineW: { value: [...LINE_W] },
      uRingCol: { value: [v3(), v3(), v3(), v3()] },
      uInkCol: { value: [v3(), v3(), v3(), v3()] },
      uMicCol: { value: v3() },
      uInkMic: { value: v3() },
      uSweep: { value: 0 },
      uComet: { value: [0, 0.25, 0.5, 0.75] },
      uTicks: { value: quality === 'low' ? 0 : 1 },
      uRingGain: { value: [1, 0.62, 0.56, 0.5] },
      uBrightHorizon: { value: 1 },
      uBrightGimbal: { value: 1 },
      uBackdrop: { value: 0 },
      uDebug: { value: 0 }
    }
    const ringMat = premultiplied(new THREE.ShaderMaterial({ uniforms: ringU, vertexShader: RING_VERTEX, fragmentShader: RING_FRAGMENT }))
    const ringGeo = ribbonGeometry(quality)

    const beadU = {
      ...shared,
      uHalf: { value: BEAD_HALF },
      uFlow: { value: 0 },
      uElev: { value: new THREE.Vector2(Math.sin(ELEVATION), Math.cos(ELEVATION)) },
      uLevel: { value: -0.05 },
      uSlosh: { value: 0 },
      uChop: { value: 0 },
      uRipple: { value: 0 },
      uSwirl: { value: 0 },
      uWaveT: { value: 0 },
      uOctaves: { value: quality === 'low' ? 1 : 2 },
      uBeadCol: { value: c3() },
      uRingCol: { value: c3() },
      uHaloCol: { value: c3() },
      uMicCol: { value: c3() },
      uInkBead: { value: c3() },
      uInkRing: { value: c3() },
      uError: { value: 0 },
      uHalo: { value: 1 },
      uListen: { value: 0 },
      uBehind: { value: 0 }
    }
    const beadMat = premultiplied(new THREE.ShaderMaterial({ uniforms: beadU, vertexShader: QUAD_VERTEX, fragmentShader: BEAD_FRAGMENT }))
    const quad = new THREE.PlaneGeometry(2, 2)

    // The jewels are the gimbals' pins: their own brightness (the gimbals', no audio term), not the shared one.
    const jewelU = { ...shared, uBright: { value: 1 }, uSize: { value: 6 }, uCol: { value: c3() }, uInkCol: { value: c3() } }
    const jewelMat = premultiplied(new THREE.ShaderMaterial({ uniforms: jewelU, vertexShader: JEWEL_VERTEX, fragmentShader: JEWEL_FRAGMENT }))
    const jewelGeo = new THREE.BufferGeometry()
    jewelGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3))
    jewelGeo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(6), 1))
    jewelGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
    return { ringU, ringMat, ringGeo, beadU, beadMat, quad, jewelU, jewelMat, jewelGeo }
  }, [quality, shared, scopeTex])

  useEffect(
    () => () => {
      parts.ringMat.dispose()
      parts.ringGeo.dispose()
      parts.beadMat.dispose()
      parts.quad.dispose()
      parts.jewelMat.dispose()
      parts.jewelGeo.dispose()
    },
    [parts]
  )

  // Fit: the camera sits a few degrees above the horizon plane; the instrument fits the canvas.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.position.set(0, Math.sin(ELEVATION) * CAM_DIST, Math.cos(ELEVATION) * CAM_DIST)
    cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.fov = FOV
    const halfH = Math.tan((FOV * Math.PI) / 360) * CAM_DIST
    const aspect = size.width / Math.max(1, size.height)
    cam.zoom = Math.min((aspect * halfH) / FIT_W, halfH / FIT_H)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const buf = gl.getDrawingBufferSize(new THREE.Vector2())
    shared.uRes.value.copy(buf)
    shared.uDpr.value = viewport.dpr
    // The curves keep their on-screen proportions at every size: ±16 px at full scale (armilla.logic waveAmp).
    const pxPerWorld = (size.height / 2 / halfH) * cam.zoom
    parts.ringU.uAmp.value = waveAmp(pxPerWorld)
    // Hand the shared camera back as the Star expects it (it sets the position only, never the rotation).
    return () => {
      cam.position.set(0, 0, 5)
      cam.rotation.set(0, 0, 0)
      cam.zoom = 1
      cam.updateProjectionMatrix()
    }
  }, [camera, size.width, size.height, viewport.dpr, gl, shared, parts, quality])

  // Colours (accent × theme × saturation are applied per frame from these).
  const colors = useMemo(() => armColors(palette), [palette])
  useEffect(() => {
    shared.uInk.value = ink ? 1 : 0
  }, [ink, shared])
  useEffect(() => {
    shared.uDim.value = dim
  }, [dim, shared])

  const sim = useRef({
    look: createArmLook(stateRef.current),
    gimbals: createGimbals(),
    out: createLevels() as Levels,
    mic: createLevels() as Levels,
    pulse: new PulseLimiter(),
    rf: createRingFrame(),
    stage: { ...FULL_STAGE } as StageLook,
    bead: { x: 1, v: 0 } as Spring,
    env: 0,
    micEnv: 0,
    time: 0,
    flow: 0,
    waveT: 0,
    comet: [0, 0.25, 0.5, 0.75],
    scopeVer: -1,
    level: REST_LEVEL,
    slosh: 0,
    tmp: [0, 0, 0] as [number, number, number],
    mixA: [0, 0, 0] as [number, number, number],
    mixB: [0, 0, 0] as [number, number, number],
    m: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
    rx: new THREE.Matrix4(),
    ry: new THREE.Matrix4(),
    pv: new THREE.Vector3()
  })

  // GPU timing (test builds, on request): EXT_disjoint_timer_query_webgl2 around this canvas's render.
  const timer = useRef<{ ext: unknown; q: WebGLQuery | null; pending: WebGLQuery[] } | null>(null)
  useFrame(() => {
    if (!__VESPER_TEST__ || !armillaProbe.timing) return
    const ctx = gl.getContext() as WebGL2RenderingContext
    if (!timer.current) timer.current = { ext: ctx.getExtension('EXT_disjoint_timer_query_webgl2'), q: null, pending: [] }
    const t = timer.current
    if (!t.ext) return
    const ext = t.ext as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
    t.q = ctx.createQuery()
    if (t.q) ctx.beginQuery(ext.TIME_ELAPSED_EXT, t.q)
  }, 0.5)
  useFrame(() => {
    if (!__VESPER_TEST__ || !armillaProbe.timing || !timer.current?.q) return
    const ctx = gl.getContext() as WebGL2RenderingContext
    const t = timer.current
    const ext = t.ext as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
    ctx.endQuery(ext.TIME_ELAPSED_EXT)
    if (t.q) t.pending.push(t.q)
    t.q = null
    while (t.pending.length) {
      const q = t.pending[0]
      if (!ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) break
      const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT) as boolean
      const ns = ctx.getQueryParameter(q, ctx.QUERY_RESULT) as number
      if (!disjoint) armillaProbe.gpuMs.push(ns / 1e6)
      if (armillaProbe.gpuMs.length > 600) armillaProbe.gpuMs.shift()
      ctx.deleteQuery(q)
      t.pending.shift()
    }
  }, 1.5)

  useFrame(() => {
    const t0 = __VESPER_TEST__ ? performance.now() : 0
    const s = sim.current
    const dt = frame.dt
    const state = stateRef.current
    const motion = reducedMotion ? 0 : 1
    const look = s.look
    let moving = stepArmLook(look, state, dt)

    // ── audio ──
    if (frame.poll) {
      getAudioEngine().output.read(s.out)
      getMicCapture().input.read(s.mic)
    } else {
      const k = Math.exp(-dt / 0.25)
      s.out.rms *= k
      s.out.low *= k
      s.out.mid *= k
      s.out.high *= k
      s.out.onset *= k
      s.mic.rms *= k
      s.mic.low *= k
      s.mic.mid *= k
      s.mic.high *= k
    }
    if (__VESPER_TEST__ && armillaProbe.inject) {
      const inj = armillaProbe.inject
      if (inj.out) Object.assign(s.out, inj.out)
      if (inj.mic) Object.assign(s.mic, inj.mic)
    }
    const envTau = reducedMotion ? 0.35 : 0.06
    s.env += (s.out.rms - s.env) * (1 - Math.exp(-dt / envTau))
    s.micEnv += (s.mic.rms - s.micEnv) * (1 - Math.exp(-dt / (reducedMotion ? 0.35 : 0.08)))
    const ai = look.voice
    const me = look.ring
    // The horizon's oscilloscope: the audio of whoever is louder (weighted by the state) — the samples the analyser
    // read this frame (the decoded TTS chunk, or the mic); who = 1 for the owner (their colour). The AI's frame is the
    // one from an output latency ago (what the speakers play now); the owner's is live. Reduced motion: a still ring.
    if (motion > 0) {
      const owner = s.micEnv * me > s.env * ai
      const engine = getAudioEngine()
      const src = owner ? getMicCapture().input : engine.output
      scope.step(dt, frame.poll ? src.samples() : null, src.sampleRate, owner ? me : ai, owner ? 1 : 0, owner ? 0 : engine.outputDelayS())
      // Keep drawing at full rate while a voice is drawn or still on its way (0 fps once the line is flat).
      if (scope.busy) moving = true
    }
    if (scope.version !== s.scopeVer) {
      s.scopeVer = scope.version
      scopeTex.needsUpdate = true
    }
    const pulse = reducedMotion ? 0 : s.pulse.step(s.out.onset * ai, frame.now, dt)

    // ── the stage: behind the chat's text (hairlines, no fine band, ink bead outline) or full ──
    if (easeStage(s.stage, backdrop ? stageLook() : FULL_STAGE, dt)) moving = true
    const behind = s.stage.behind

    // ── clocks ──
    if (motion > 0) {
      s.time += dt * (1 - 0.8 * look.calm)
      s.flow += dt * (0.5 + 1.6 * look.spin + 0.6 * ai + 0.3 * me) * (1 - 0.8 * look.calm)
      s.waveT += dt
      for (let i = 0; i < 4; i++) s.comet[i] = (s.comet[i] + dt * COMET_RATE[i] + 1) % 1
    }

    // ── gimbals: they turn in every state (a slow counter-turn while the AI speaks), never with the audio ──
    const nod = 0.05 * Math.sin(s.time * 0.31) + 0.03 * Math.sin(s.time * 0.53 + 1)
    if (stepGimbals(s.gimbals, look, dt, motion, nod)) moving = true
    const g = s.gimbals
    const [m1, m2, m3] = s.m
    m1.makeRotationY(g.a0)
    m2.copy(m1).multiply(s.rx.makeRotationX(g.a1))
    m3.copy(m2).multiply(s.ry.makeRotationY(g.a2))
    const ru = parts.ringU
    ru.uRingM.value[1].copy(m1)
    ru.uRingM.value[2].copy(m2)
    ru.uRingM.value[3].copy(m3)

    // Radii: thinking draws them in a little (gather), a slow breath at rest — never audio: only the horizon shows the
    // voice (owner, v1.1; armilla.logic gimbalRadius).
    const radius = ru.uRadius.value as number[]
    const nowS = frame.now / 1000
    radius[1] = gimbalRadius(0, look, nowS, motion)
    radius[2] = gimbalRadius(1, look, nowS, motion)
    radius[3] = gimbalRadius(2, look, nowS, motion)
    ru.uScopeWho.value = scope.who
    ru.uScopeLevel.value = scope.level
    ru.uWaveOn.value = motion
    ru.uSwell.value = motion * (1 - ai) * (1 - me)
    // Behind text the sweep is gentler (≤ 0.6) and the comet head longer: no flicker against glyph edges.
    ru.uSweep.value = Math.min(look.sweep * motion + look.sweep * (1 - motion) * 0.15, 1 - 0.4 * behind)
    const comets = ru.uComet.value as number[]
    for (let i = 0; i < 4; i++) comets[i] = s.comet[i]
    ru.uBackdrop.value = behind
    ru.uGlowPx.value = 2 * (1 - 0.4 * behind)

    // ── brightness (07 D9: audio moves the horizon and the bead ≤ 15 %, pulses ≤ 3/s; the thinking throb ±6 %) ──
    // The gimbals and their jewels take no audio term at all (owner, v1.1): ringFrame.
    const throb = reducedMotion ? 1 : throbBrightness(nowS, look.throb)
    const rf = ringFrame(s.rf, look, s.env, s.micEnv, pulse, throb, behind)
    ru.uBrightHorizon.value = rf.brightHorizon
    ru.uBrightGimbal.value = rf.brightGimbal
    const gains = ru.uRingGain.value as number[]
    for (let i = 0; i < 4; i++) gains[i] = rf.gains[i]
    shared.uBright.value = rf.brightHorizon
    shared.uTime.value = s.time

    // ── colours (no per-frame allocations) ──
    const sat = look.saturation
    const tmp = s.tmp
    const A = s.mixA
    const B = s.mixB
    const ringCols = ru.uRingCol.value as THREE.Vector3[]
    const inkCols = ru.uInkCol.value as THREE.Vector3[]
    const tint = 0.35 * look.face * me
    setC(ringCols[0], desaturate(colors.horizon, sat, tmp))
    setC(ringCols[1], desaturate(lerpInto(A, colors.ring, colors.mic, tint), sat, tmp))
    setC(ringCols[2], desaturate(lerpInto(B, lerpInto(A, colors.ring, colors.bead, 0.18), colors.mic, tint), sat, tmp))
    setC(ringCols[3], desaturate(lerpInto(B, lerpInto(A, colors.ring, colors.bead, 0.36), colors.mic, tint), sat, tmp))
    setC(inkCols[0], desaturate(colors.inkHorizon, sat, tmp))
    const inkTint = desaturate(lerpInto(A, colors.inkRing, colors.inkMic, tint), sat, tmp)
    setC(inkCols[1], inkTint)
    setC(inkCols[2], inkTint)
    setC(inkCols[3], inkTint)
    setC(ru.uMicCol.value, desaturate(colors.mic, sat, tmp))
    setC(ru.uInkMic.value, desaturate(colors.inkMic, sat, tmp))

    // ── bead (it keeps its answer to the voice: the liquid, the halo) ──
    const bu = parts.beadU
    const beadBreath = motion * 0.02 * Math.sin(nowS * Math.PI * 2 * 0.2) * (1 - ai)
    stepSpring(s.bead, 1 + (0.11 * s.env + 0.04 * pulse) * ai * motion + 0.03 * s.micEnv * me * motion + 0.06 * look.gather + beadBreath, dt)
    shared.uCoreR.value = R_BEAD * s.bead.x
    bu.uFlow.value = s.flow
    bu.uBehind.value = behind
    // The liquid: at rest just below the horizon line (two lines, not one); it rises a little while you speak
    // (filling with your words) and while a voice is prepared; long waves follow the AI's low band, short ones its
    // mids/highs; your voice rings concentric ripples on it.
    const levelTarget = REST_LEVEL + (0.22 * look.face * me + 0.18 * look.gather + 0.1 * ai) * motion
    s.level += (levelTarget - s.level) * (1 - Math.exp(-dt / 0.5))
    bu.uLevel.value = s.level
    // Where the waterline sits on screen (view-space height above the bead's centre): back lines above it show
    // through the glass.
    parts.ringU.uWater.value = s.level * R_BEAD * s.bead.x * Math.cos(ELEVATION)
    s.slosh += (s.out.low * ai * motion * (0.4 + 0.9 * s.env) - s.slosh) * (1 - Math.exp(-dt / 0.12))
    bu.uSlosh.value = s.slosh
    bu.uChop.value = (0.6 * s.out.mid + 0.4 * s.out.high) * ai * motion
    bu.uRipple.value = s.micEnv * me * motion
    bu.uSwirl.value = look.spin * motion
    bu.uWaveT.value = s.waveT
    bu.uError.value = look.error
    bu.uHalo.value = 0.85 + 0.3 * look.gather + 0.25 * ai * s.env
    bu.uListen.value = look.face * me
    setC(bu.uBeadCol.value, desaturate(colors.bead, sat, tmp))
    setC(bu.uRingCol.value, desaturate(colors.ring, sat, tmp))
    setC(bu.uHaloCol.value, desaturate(colors.halo, sat, tmp))
    setC(bu.uMicCol.value, desaturate(colors.mic, sat, tmp))
    setC(bu.uInkBead.value, desaturate(colors.inkBead, sat, tmp))
    setC(bu.uInkRing.value, desaturate(colors.inkRing, sat, tmp))

    // ── jewels: the pins between the gimbals — part of the gimbals, so a constant glow and the gimbal brightness ──
    const pos = parts.jewelGeo.getAttribute('position') as THREE.BufferAttribute
    const glow = parts.jewelGeo.getAttribute('aGlow') as THREE.BufferAttribute
    const top = radius[1]
    const mid12 = (radius[1] + radius[2]) / 2
    const mid23 = (radius[2] + radius[3]) / 2
    putJewel(pos, glow, s.pv, 0, m1, 0, top)
    putJewel(pos, glow, s.pv, 1, m1, 0, -top)
    putJewel(pos, glow, s.pv, 2, m2, mid12, 0)
    putJewel(pos, glow, s.pv, 3, m2, -mid12, 0)
    putJewel(pos, glow, s.pv, 4, m3, 0, mid23)
    putJewel(pos, glow, s.pv, 5, m3, 0, -mid23)
    pos.needsUpdate = true
    glow.needsUpdate = true
    const ju = parts.jewelU
    ju.uBright.value = rf.brightGimbal
    setC(ju.uCol.value, desaturate(lerpInto(A, colors.ring, colors.bead, 0.5), sat, tmp))
    setC(ju.uInkCol.value, desaturate(colors.inkRing, sat, tmp))

    if (__VESPER_TEST__) ru.uDebug.value = armillaProbe.debug ? 1 : 0
    if (moving) onMoving()
    if (__VESPER_TEST__) {
      const p = armillaProbe
      p.frames++
      p.cpuMs.push(performance.now() - t0)
      if (p.cpuMs.length > 600) p.cpuMs.shift()
      p.scope = scope
      p.last = { wave: scope.level, delayMs: scope.delayS * 1000, latencyMs: getAudioEngine().outputDelayS() * 1000, env: s.env, micEnv: s.micEnv, low: s.out.low, mid: s.out.mid, high: s.out.high, onset: s.out.onset, pulses: s.pulse.fired, bright: rf.brightHorizon, brightGimbal: rf.brightGimbal, behind, resX: shared.uRes.value.x, resY: shared.uRes.value.y, dpr: shared.uDpr.value, r1: radius[1], a0: g.a0, a1: g.a1, a2: g.a2, look: { ...look } }
    }
  })

  return (
    <>
      <mesh geometry={parts.quad} material={parts.beadMat} scale={BEAD_HALF} renderOrder={0} frustumCulled={false} />
      <mesh geometry={parts.ringGeo} material={parts.ringMat} renderOrder={1} frustumCulled={false} />
      <points geometry={parts.jewelGeo} material={parts.jewelMat} renderOrder={2} frustumCulled={false} />
    </>
  )
}
