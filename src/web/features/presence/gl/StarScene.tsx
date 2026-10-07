/**
 * The Star in WebGL (research 07 §2.2–2.4): corona billboard → displaced orb (or the nebula cloud) → motes. One
 * uniform set feeds every material; useFrame mutates it (never React state per frame). Levels are read from the
 * AudioEngine output and the mic once per drawn frame, and only when the scheduler allows polling (07 D4).
 *
 * Geometry and materials are created once per (style, quality) and disposed when they change or the canvas goes.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { createLevels, getAudioEngine, getMicCapture, type Levels } from '../../../lib/audio'
import type { StarQuality, StarState } from '../../../lib/store/presence'
import type { FrameInfo } from '../host/scheduler'
import { audioBrightness, createLook, PulseLimiter, stepLook, stepSpring, throbBrightness, type Spring, type StarPalette } from '../visual.logic'
import { CORONA_FRAGMENT, FRONT_GLOW_FRAGMENT, MOTES_FRAGMENT, MOTES_VERTEX, NEBULA_FRAGMENT, ORB_FRAGMENT, ORB_VERTEX, QUAD_VERTEX } from './starShaders'

export interface StarSceneProps {
  style: 'orb' | 'nebula'
  quality: StarQuality
  reducedMotion: boolean
  palette: StarPalette
  /** Read every frame (the host writes the store state or a target's override into it). */
  stateRef: { current: StarState }
  frame: FrameInfo
  /** Called when a crossfade is still running (keeps the scheduler drawing). */
  onMoving: () => void
  /** Real bloom runs (high quality): the front glow is toned down. */
  bloom: boolean
}

/** World units: the orb, the corona billboard (half-size) and the visible half-height at the camera distance (1.43). */
const ORB_R = 0.44
const CORONA_HALF = 1.4

/** Light adds up (ONE, ONE) and alpha is left alone: the glow lights the stage behind the canvas. */
function additive(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.OneFactor
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
  m.transparent = true
  m.depthWrite = false
  return m
}
const DETAIL: Record<StarQuality, number> = { low: 10, medium: 22, high: 40 }
const MOTES: Record<StarQuality, number> = { low: 140, medium: 360, high: 720 }

type U = { value: number }
type UV = { value: THREE.Color }

export interface StarUniforms {
  uTime: U
  uEnv: U
  uLow: U
  uMid: U
  uHigh: U
  uPulse: U
  uMic: U
  uEnergy: U
  uBright: U
  uSwirl: U
  uNoise: U
  uGather: U
  uSat: U
  uError: U
  uRing: U
  uVoice: U
  uMotion: U
  uCore: UV
  uBody: UV
  uCorona: UV
  uRim: UV
  uMicCol: UV
  [k: string]: U | UV
}

function makeUniforms(): StarUniforms {
  const f = (v = 0): U => ({ value: v })
  const c = (): UV => ({ value: new THREE.Color() })
  return {
    uTime: f(),
    uEnv: f(),
    uLow: f(),
    uMid: f(),
    uHigh: f(),
    uPulse: f(),
    uMic: f(),
    uEnergy: f(0.8),
    uBright: f(1),
    uSwirl: f(0.3),
    uNoise: f(0.5),
    uGather: f(1),
    uSat: f(1),
    uError: f(),
    uRing: f(),
    uVoice: f(),
    uMotion: f(1),
    uCore: c(),
    uBody: c(),
    uCorona: c(),
    uRim: c(),
    uMicCol: c()
  }
}

function setColors(u: StarUniforms, p: StarPalette): void {
  u.uCore.value.setRGB(...p.core)
  u.uBody.value.setRGB(...p.body)
  u.uCorona.value.setRGB(...p.corona)
  u.uRim.value.setRGB(...p.rim)
  u.uMicCol.value.setRGB(...p.mic)
}

/** Seeded PRNG so the motes look the same on every load (and in screenshots). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function moteGeometry(count: number): THREE.BufferGeometry {
  const rnd = mulberry32(7)
  const seeds = new Float32Array(count * 4)
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rnd() * Math.PI * 2
    // Denser near the orb, thinning outward.
    seeds[i * 4 + 1] = 0.62 + Math.pow(rnd(), 1.6) * 0.58
    seeds[i * 4 + 2] = (rnd() - 0.5) * 0.22
    seeds[i * 4 + 3] = rnd()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
  // Positions are computed in the shader; give the bounds explicitly so culling never drops the swarm.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.6)
  return g
}

export function StarScene({ style, quality, reducedMotion, palette, stateRef, frame, onMoving, bloom }: StarSceneProps): ReactNode {
  const uniforms = useMemo(makeUniforms, [])
  const size = useThree((s) => s.size)
  const viewport = useThree((s) => s.viewport)
  const camera = useThree((s) => s.camera)
  const orb = useRef<THREE.Mesh>(null)

  const parts = useMemo(() => {
    const extra = {
      uOrbR: { value: ORB_R / CORONA_HALF },
      uPx: { value: 600 },
      uOctaves: { value: quality === 'low' ? 3 : quality === 'medium' ? 4 : 5 },
      uGlow: { value: 1 },
      uOrbWorld: { value: style === 'orb' ? ORB_R : 0 }
    }
    const all = { ...uniforms, ...extra }
    const quad = new THREE.PlaneGeometry(2, 2)
    // The corona sits at the orb's centre with the depth test on: the orb hides the part behind it.
    const corona = additive(
      new THREE.ShaderMaterial({ uniforms: all, vertexShader: QUAD_VERTEX, fragmentShader: style === 'nebula' ? NEBULA_FRAGMENT : CORONA_FRAGMENT })
    )
    const orbGeo = style === 'orb' ? new THREE.IcosahedronGeometry(ORB_R, DETAIL[quality]) : null
    const orbMat = style === 'orb' ? new THREE.ShaderMaterial({ uniforms: all, vertexShader: ORB_VERTEX, fragmentShader: ORB_FRAGMENT }) : null
    const glowMat =
      style === 'orb'
        ? additive(new THREE.ShaderMaterial({ uniforms: all, vertexShader: QUAD_VERTEX, fragmentShader: FRONT_GLOW_FRAGMENT, depthTest: false }))
        : null
    const moteGeo = moteGeometry(MOTES[quality])
    const moteMat = additive(new THREE.ShaderMaterial({ uniforms: all, vertexShader: MOTES_VERTEX, fragmentShader: MOTES_FRAGMENT }))
    return { extra, quad, corona, orbGeo, orbMat, glowMat, moteGeo, moteMat }
  }, [style, quality, uniforms])

  useEffect(() => {
    parts.extra.uGlow.value = bloom ? 0.55 : 1
  }, [parts, bloom])

  useEffect(
    () => () => {
      parts.quad.dispose()
      parts.corona.dispose()
      parts.orbGeo?.dispose()
      parts.orbMat?.dispose()
      parts.glowMat?.dispose()
      parts.moteGeo.dispose()
      parts.moteMat.dispose()
    },
    [parts]
  )

  useEffect(() => setColors(uniforms, palette), [uniforms, palette])

  // Fit the composition to the stage: the Star (with its corona) always fits the shorter side.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.position.set(0, 0, 5)
    cam.fov = 32
    cam.zoom = Math.min(1, size.width / Math.max(1, size.height))
    cam.updateProjectionMatrix()
    // Device pixels per world unit at distance 1 (for point sizes).
    parts.extra.uPx.value = ((size.height * viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360))) * cam.zoom
  }, [camera, size.width, size.height, viewport.dpr, parts])

  const sim = useRef({
    look: createLook(stateRef.current),
    out: createLevels() as Levels,
    mic: createLevels() as Levels,
    pulse: new PulseLimiter(),
    spring: { x: 1, v: 0 } as Spring,
    time: 0,
    env: 0,
    micEnv: 0
  })

  useFrame(() => {
    const s = sim.current
    const dt = frame.dt
    const state = stateRef.current
    const motion = reducedMotion ? 0 : 1
    if (stepLook(s.look, state, dt)) onMoving()
    // Audio: polled only when the scheduler allows (speaking/listening, visible); otherwise ease to silence.
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
    }
    // Reduced motion: brightness follows the voice slowly; no pulses, no displacement (07 D9).
    const envTau = reducedMotion ? 0.35 : 0.06
    s.env += (s.out.rms - s.env) * (1 - Math.exp(-dt / envTau))
    s.micEnv += (s.mic.rms - s.micEnv) * (1 - Math.exp(-dt / (reducedMotion ? 0.35 : 0.08)))
    const pulse = reducedMotion ? 0 : s.pulse.step(s.out.onset * s.look.voice, frame.now, dt)
    if (!reducedMotion) s.time += dt * (0.55 + 0.45 * s.look.swirl)
    const u = uniforms
    u.uTime.value = s.time
    u.uEnv.value = s.env
    u.uLow.value = s.out.low * motion
    u.uMid.value = s.out.mid * motion
    u.uHigh.value = s.out.high * motion
    u.uPulse.value = pulse
    u.uMic.value = s.micEnv
    u.uMotion.value = motion
    u.uEnergy.value = s.look.energy
    u.uSwirl.value = s.look.swirl
    u.uNoise.value = s.look.noise
    u.uGather.value = s.look.gather
    u.uSat.value = s.look.saturation
    u.uError.value = s.look.error
    u.uRing.value = s.look.ring
    u.uVoice.value = s.look.voice
    u.uBright.value =
      audioBrightness(s.env * s.look.voice + s.micEnv * s.look.ring * 0.5, pulse * s.look.voice) *
      (reducedMotion ? 1 : throbBrightness(frame.now / 1000, s.look.throb))
    // The orb swells with the voice (critically damped: no overshoot) and breathes when idle (12 breaths/min).
    const breath = reducedMotion ? 0 : 0.018 * Math.sin((frame.now / 1000) * Math.PI * 2 * 0.2) * (1 - s.look.voice)
    const target = 1 + (0.09 * s.env + 0.035 * pulse) * s.look.voice * motion + 0.025 * s.look.ring * s.micEnv * motion + breath
    stepSpring(s.spring, target, dt)
    if (orb.current) {
      orb.current.scale.setScalar(s.spring.x)
      if (!reducedMotion) orb.current.rotation.y += dt * 0.05 * (0.4 + s.look.swirl)
    }
  })

  return (
    <>
      <mesh geometry={parts.quad} material={parts.corona} scale={CORONA_HALF} renderOrder={0} frustumCulled={false} />
      {parts.orbGeo && parts.orbMat ? <mesh ref={orb} geometry={parts.orbGeo} material={parts.orbMat} renderOrder={1} /> : null}
      {parts.glowMat ? <mesh geometry={parts.quad} material={parts.glowMat} scale={ORB_R * 1.25} renderOrder={2} frustumCulled={false} /> : null}
      <points geometry={parts.moteGeo} material={parts.moteMat} renderOrder={3} frustumCulled={false} />
    </>
  )
}
