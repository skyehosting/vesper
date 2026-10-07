/**
 * The Constellation inside the one canvas (07 A4, D5): sessions as stars (one Points draw call), links as lines (one
 * LineSegments draw call), a faint far starfield and a soft galactic core. Each drawn frame eases the orbit camera,
 * then projects every star to stage pixels for the page's picking, labels and cards (model.view.projected).
 *
 * Buffers are rebuilt only when the data version changes; highlight state is re-uploaded on coarse changes and while
 * pulses run. Everything created here is disposed on unmount (back to the Star) — the leak gate checks renderer.info.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { FrameInfo, FrameScheduler } from '../host/scheduler'
import type { StarPalette } from '../visual.logic'
import { clampCamera, easeCamera, orbitPosition } from './layout.logic'
import { getState, projected, PULSE_MS, subscribe, view, type ConstellationState } from './model'

export interface ConstellationSceneProps {
  scheduler: FrameScheduler
  frame: FrameInfo
  reducedMotion: boolean
  palette: StarPalette
}

const STAR_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aBright;
attribute float aHue;
attribute vec4 aState;   // x private, y dimmed (search), z emphasis 0..1, w pulse phase (-1 none)
uniform float uPx;
uniform float uTime;
varying float vBright;
varying float vHue;
varying vec4 vState;
varying float vSpike;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.1);
  float sprite = aSize * 5.0 * (1.0 + 0.35 * aState.z) * (aState.w >= 0.0 ? 1.6 : 1.0);
  gl_PointSize = clamp(uPx * sprite / depth, 3.0, 220.0);
  vBright = aBright;
  vHue = aHue;
  vState = aState;
  vSpike = smoothstep(0.12, 0.3, aSize) * aBright;
}
`

const STAR_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uBody;
uniform vec3 uCorona;
uniform vec3 uMic;
varying float vBright;
varying float vHue;
varying vec4 vState;
varying float vSpike;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (d > 1.0) discard;
  float scale = vState.w >= 0.0 ? 1.6 : 1.0;   // the sprite grows during a pulse; keep the star the same size
  float dd = d * scale;
  float core = smoothstep(0.2, 0.0, dd);
  float glow = exp(-dd * dd * 9.0) * 0.75;
  float spikes = (exp(-abs(uv.x) * scale * 34.0) + exp(-abs(uv.y) * scale * 34.0)) * exp(-dd * 2.6) * vSpike * 0.7;
  vec3 tint = mix(uCorona, uBody, vHue);
  vec3 col = tint * glow + mix(tint, uCore, 0.75) * core * 1.2 + uCore * spikes;
  float b = vBright;
  // Private sessions: dimmed and cooled (never recalled elsewhere).
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l) * vec3(0.8, 0.85, 1.0), vState.x * 0.75);
  b *= mix(1.0, 0.4, vState.x);
  b *= mix(1.0, 0.18, vState.y);
  // Hover / selection / drag target: a crisp ring.
  float ring = exp(-pow((dd - 0.62) / 0.05, 2.0)) * vState.z;
  col += uCore * ring * 0.9;
  b = max(b, vState.z * 0.9);
  // Recall pulse: three expanding rings over the pulse, fading out.
  if (vState.w >= 0.0) {
    float ph = fract(vState.w * 3.0);
    float pr = 0.25 + ph * 0.72;
    float pulse = exp(-pow((d - pr) / 0.05, 2.0)) * (1.0 - ph) * (1.0 - vState.w * 0.5);
    col += uMic * pulse * 1.3;
    b = max(b, 0.85);
  }
  gl_FragColor = vec4(col * b, 0.0);
}
`

const SKY_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aBright;
uniform float uPx;
varying float vBright;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPx * aSize / max(-mv.z, 0.1), 1.0, 3.0);
  vBright = aBright;
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTint;
varying float vBright;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float a = smoothstep(1.0, 0.0, d);
  gl_FragColor = vec4(mix(vec3(0.85, 0.87, 1.0), uTint, 0.25) * a * vBright, 0.0);
}
`

const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uTint2;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float g = exp(-r * r * 5.0) * 0.16 + exp(-r * r * 40.0) * 0.12;
  gl_FragColor = vec4(mix(uTint2, uTint, exp(-r * 3.0)) * g * smoothstep(1.0, 0.7, r), 0.0);
}
`

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
}
`

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

function useModel(): ConstellationState {
  return useSyncExternalStore(subscribe, getState)
}

/** Light adds up (ONE, ONE), alpha untouched: the glow lights the night backdrop behind the canvas. */
function additive<M extends THREE.Material>(m: M): M {
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

const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()

export default function ConstellationScene({ scheduler, frame, reducedMotion, palette }: ConstellationSceneProps): ReactNode {
  const model = useModel()
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)

  const colors = useMemo(
    () => ({
      uCore: { value: new THREE.Color(...palette.core) },
      uBody: { value: new THREE.Color(...palette.body) },
      uCorona: { value: new THREE.Color(...palette.corona) },
      uMic: { value: new THREE.Color(...palette.mic) }
    }),
    [palette]
  )
  const px = useMemo(() => ({ value: 600 }), [])

  // ── static sky + galactic core (created once) ──
  const sky = useMemo(() => {
    const rnd = mulberry32(42)
    const n = 1100
    const pos = new Float32Array(n * 3)
    const sizes = new Float32Array(n)
    const bright = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      const r = 90 + rnd() * 60
      const s = Math.sqrt(1 - u * u)
      pos[i * 3] = r * s * Math.cos(th)
      pos[i * 3 + 1] = r * u
      pos[i * 3 + 2] = r * s * Math.sin(th)
      sizes[i] = 0.5 + rnd() * 1.4
      bright[i] = 0.12 + Math.pow(rnd(), 3) * 0.5
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1))
    const mat = additive(new THREE.ShaderMaterial({ uniforms: { uPx: px, uTint: colors.uCorona }, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT }))
    const quad = new THREE.PlaneGeometry(2, 2)
    const coreMat = additive(
      new THREE.ShaderMaterial({
        uniforms: { uTint: colors.uBody, uTint2: colors.uCorona },
        vertexShader: QUAD_VERTEX,
        fragmentShader: CORE_FRAGMENT,
        depthTest: false
      })
    )
    return { geo, mat, quad, coreMat }
  }, [px, colors])

  useEffect(
    () => () => {
      sky.geo.dispose()
      sky.mat.dispose()
      sky.quad.dispose()
      sky.coreMat.dispose()
    },
    [sky]
  )

  // ── session stars + links (rebuilt per data version) ──
  const stars = useMemo(() => {
    const n = model.nodes.length
    const pos = new Float32Array(Math.max(1, n) * 3)
    const sizeA = new Float32Array(Math.max(1, n))
    const brightA = new Float32Array(Math.max(1, n))
    const hueA = new Float32Array(Math.max(1, n))
    const stateA = new Float32Array(Math.max(1, n) * 4)
    model.nodes.forEach((p, i) => {
      pos[i * 3] = p.x
      pos[i * 3 + 1] = p.y
      pos[i * 3 + 2] = p.z
      sizeA[i] = p.size
      brightA[i] = p.bright
      hueA[i] = p.hue
      stateA[i * 4 + 3] = -1
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeA, 1))
    geo.setAttribute('aBright', new THREE.BufferAttribute(brightA, 1))
    geo.setAttribute('aHue', new THREE.BufferAttribute(hueA, 1))
    const stateAttr = new THREE.BufferAttribute(stateA, 4)
    stateAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aState', stateAttr)
    geo.setDrawRange(0, n)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), model.radius + 2)
    const mat = additive(
      new THREE.ShaderMaterial({ uniforms: { uPx: px, uTime: { value: 0 }, ...colors }, vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT })
    )
    const m = model.edges.length
    const lpos = new Float32Array(Math.max(1, m) * 6)
    const lcol = new Float32Array(Math.max(1, m) * 6)
    model.edges.forEach((e, i) => {
      const a = model.nodes[e.a]
      const b = model.nodes[e.b]
      lpos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })
    const lgeo = new THREE.BufferGeometry()
    lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3))
    const colAttr = new THREE.BufferAttribute(lcol, 3)
    colAttr.setUsage(THREE.DynamicDrawUsage)
    lgeo.setAttribute('color', colAttr)
    lgeo.setDrawRange(0, m * 2)
    lgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), model.radius + 2)
    const lmat = additive(new THREE.LineBasicMaterial({ vertexColors: true }))
    return { geo, mat, stateAttr, lgeo, lmat, colAttr }
    // Rebuild on data (version) and palette only; highlight state is written below.
  }, [model.version, px, colors])

  useEffect(
    () => () => {
      stars.geo.dispose()
      stars.mat.dispose()
      stars.lgeo.dispose()
      stars.lmat.dispose()
    },
    [stars]
  )

  // Highlight state → attributes (coarse changes).
  const writeState = useRef<(now: number) => boolean>(() => false)
  writeState.current = (now: number): boolean => {
    const st = getState()
    const a = stars.stateAttr.array as Float32Array
    const emph = new Set<number>([st.hover, st.selected, st.drag?.from ?? -1, st.drag?.over ?? -1, st.replying].filter((i) => i >= 0))
    let pulsing = false
    st.nodes.forEach((n, i) => {
      a[i * 4] = n.s.private ? 1 : 0
      a[i * 4 + 1] = st.matches ? (st.matches[i] ? 0 : 1) : 0
      a[i * 4 + 2] = emph.has(i) ? 1 : 0
      const p = st.pulses.get(i)
      const ph = p === undefined ? -1 : (now - p) / PULSE_MS
      if (ph >= 0 && ph < 1) pulsing = true
      a[i * 4 + 3] = ph >= 0 && ph < 1 && !reducedMotion ? ph : -1
    })
    stars.stateAttr.needsUpdate = true
    // Links: base glow; brighter where they touch the hovered/selected star; mutual links a little brighter.
    const c = stars.colAttr.array as Float32Array
    const accent = palette.body
    const base = palette.corona
    st.edges.forEach((e, i) => {
      const hot = emph.has(e.a) || emph.has(e.b)
      const dim = st.matches && !(st.matches[e.a] || st.matches[e.b]) ? 0.35 : 1
      const k = (hot ? 0.85 : e.both ? 0.3 : 0.2) * dim
      const col = hot ? accent : base
      for (let v = 0; v < 2; v++) {
        const node = st.nodes[v === 0 ? e.a : e.b]
        const kk = k * (0.55 + 0.45 * (node?.bright ?? 0.5))
        c[i * 6 + v * 3] = col[0] * kk
        c[i * 6 + v * 3 + 1] = col[1] * kk
        c[i * 6 + v * 3 + 2] = col[2] * kk
      }
    })
    stars.colAttr.needsUpdate = true
    return pulsing
  }

  useEffect(() => {
    writeState.current(performance.now())
    scheduler.requestFrame()
    return subscribe(() => {
      // Only pulses still running keep the pulse frame rate (finished ones stay in the map until the next refresh).
      if (writeState.current(performance.now())) scheduler.pulse(PULSE_MS)
      scheduler.requestFrame()
    })
  }, [stars, scheduler])

  // Camera setup for the map. The shared camera goes back to the Star's setup on unmount.
  useEffect(() => {
    camera.fov = view.fov
    camera.near = 0.1
    camera.far = 400
    camera.zoom = 1
    view.width = size.width
    view.height = size.height
    px.value = (size.height * dpr) / (2 * Math.tan((camera.fov * Math.PI) / 360))
    scheduler.requestFrame()
  }, [camera, size.width, size.height, dpr, px, scheduler])
  useEffect(
    () => () => {
      camera.clearViewOffset()
      camera.updateProjectionMatrix()
    },
    [camera]
  )
  const insets = useRef({ r: -1, t: -1, w: 0, h: 0 })

  useFrame(() => {
    const dt = frame.dt
    const st = getState()
    // Idle drift: turn camera and goal together (no easing, so the drift never counts as interaction).
    if (!reducedMotion && frame.now - view.lastInput > 2500) {
      view.goal.yaw += dt * 0.025
      view.camera.yaw += dt * 0.025
    }
    view.goal = clampCamera(view.goal, st.radius)
    if (easeCamera(view.camera, view.goal, dt, reducedMotion ? 0.05 : 0.14)) scheduler.interact(120)
    const [x, y, z] = orbitPosition(view.camera)
    camera.position.set(x, y, z)
    camera.lookAt(view.camera.tx, view.camera.ty, view.camera.tz)
    // Centre the map in the part of the stage not covered by panels (a view offset keeps the projection exact).
    const ins = insets.current
    if (ins.r !== view.insetRight || ins.t !== view.insetTop || ins.w !== size.width || ins.h !== size.height) {
      ins.r = view.insetRight
      ins.t = view.insetTop
      ins.w = size.width
      ins.h = size.height
      const sx = view.insetRight
      const sy = view.insetTop
      if (sx || sy) camera.setViewOffset(size.width + sx, size.height + sy, sx, 0, size.width, size.height)
      else camera.clearViewOffset()
      camera.updateProjectionMatrix()
    }
    camera.updateMatrixWorld()
    // Pulses animate only while they run.
    if (st.pulses.size && writeState.current(frame.now)) scheduler.pulse(200)
    // Project every star for the page (CSS px relative to the stage).
    const out = view.projected
    const w = size.width
    const h = size.height
    const k = h / (2 * Math.tan((camera.fov * Math.PI) / 360))
    st.nodes.forEach((n, i) => {
      tmp.set(n.x, n.y, n.z).project(camera)
      const o = i * 4
      out[o] = (tmp.x * 0.5 + 0.5) * w
      out[o + 1] = (-tmp.y * 0.5 + 0.5) * h
      out[o + 2] = tmp.z
      const dist = camera.position.distanceTo(tmp2.set(n.x, n.y, n.z))
      out[o + 3] = (n.size * k) / Math.max(dist, 0.1)
    })
    projected()
  })

  return (
    <>
      <points geometry={sky.geo} material={sky.mat} frustumCulled={false} renderOrder={0} />
      <mesh geometry={sky.quad} material={sky.coreMat} scale={Math.min(14, Math.max(5, model.radius * 0.9))} frustumCulled={false} renderOrder={1} />
      <lineSegments geometry={stars.lgeo} material={stars.lmat} frustumCulled={false} renderOrder={2} />
      <points geometry={stars.geo} material={stars.mat} frustumCulled={false} renderOrder={3} />
    </>
  )
}
