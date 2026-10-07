/**
 * The `minimal2d` Star (07 D5/D8: phone default): CSS gradients and the brand's four-point glint, no WebGL. The same look vector and
 * audio levels as the 3D Star drive a handful of CSS custom properties, written once per scheduled frame — so it
 * obeys the same frame budget (rest at 0 fps, nothing while hidden) and the same flash limits (07 D9).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createLevels, getAudioEngine, getMicCapture } from '../../../lib/audio'
import type { StarState } from '../../../lib/store/presence'
import { audioBrightness, createLook, PulseLimiter, stepLook, stepSpring, throbBrightness, type Rgb, type StarPalette } from '../visual.logic'
import type { FrameInfo, FrameScheduler } from './scheduler'
import { easeStage, FULL_STAGE, stageLook } from './stageLook'

export interface Minimal2dStarProps {
  scheduler: FrameScheduler
  active: boolean
  palette: StarPalette
  reducedMotion: boolean
  stateRef: { current: StarState }
  /** The chat backdrop (v11): the CSS star's peak is ~white, so its opacity is the luminance cap. */
  backdrop?: boolean
}

const rgb = (c: Rgb): string => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`

export function Minimal2dStar({ scheduler, active, palette, reducedMotion, stateRef, backdrop = false }: Minimal2dStarProps): ReactNode {
  const el = useRef<HTMLDivElement>(null)
  const rm = useRef(reducedMotion)
  rm.current = reducedMotion
  const bd = useRef(backdrop)
  bd.current = backdrop

  useEffect(() => {
    const node = el.current
    if (!node) return
    node.style.setProperty('--m2d-core', rgb(palette.core))
    node.style.setProperty('--m2d-body', rgb(palette.body))
    node.style.setProperty('--m2d-corona', rgb(palette.corona))
    node.style.setProperty('--m2d-mic', rgb(palette.mic))
    scheduler.requestFrame()
  }, [palette, scheduler])

  useEffect(() => {
    if (!active) return
    const look = createLook(stateRef.current)
    const out = createLevels()
    const mic = createLevels()
    const pulse = new PulseLimiter()
    const spring = { x: 1, v: 0 }
    let env = 0
    let micEnv = 0
    let spin = 0
    const stage = { ...(bd.current ? stageLook() : FULL_STAGE) }
    // Apply the cap right away: a surface that rests at 0 fps must not wait for a frame to be legible.
    if (el.current) el.current.style.opacity = stage.cap >= 0.999 ? '' : stage.cap.toFixed(3)
    const render = (f: FrameInfo): void => {
      const node = el.current
      if (!node) return
      const reduced = rm.current
      if (stepLook(look, stateRef.current, f.dt)) scheduler.kick(50)
      if (f.poll) {
        getAudioEngine().output.read(out)
        getMicCapture().input.read(mic)
      } else {
        out.rms *= Math.exp(-f.dt / 0.25)
        out.onset = 0
        mic.rms *= Math.exp(-f.dt / 0.25)
      }
      env += (out.rms - env) * (1 - Math.exp(-f.dt / (reduced ? 0.35 : 0.06)))
      micEnv += (mic.rms - micEnv) * (1 - Math.exp(-f.dt / 0.1))
      const p = reduced ? 0 : pulse.step(out.onset * look.voice, f.now, f.dt)
      const breath = reduced ? 0 : 0.03 * Math.sin((f.now / 1000) * Math.PI * 2 * 0.2) * (1 - look.voice)
      stepSpring(spring, 1 + (reduced ? 0 : (0.1 * env + 0.04 * p) * look.voice + 0.04 * micEnv * look.ring) + breath, f.dt)
      if (!reduced) spin += f.dt * (4 + 26 * look.swirl)
      const bright = audioBrightness(env * look.voice + micEnv * look.ring * 0.5, p * look.voice) * (reduced ? 1 : throbBrightness(f.now / 1000, look.throb))
      const s = node.style
      s.setProperty('--m2d-scale', spring.x.toFixed(4))
      s.setProperty('--m2d-bright', (look.energy * bright).toFixed(4))
      s.setProperty('--m2d-sat', look.saturation.toFixed(3))
      s.setProperty('--m2d-ring', (look.ring * (0.3 + 0.7 * micEnv)).toFixed(3))
      s.setProperty('--m2d-ring-scale', (1 + 0.18 * micEnv).toFixed(4))
      s.setProperty('--m2d-gather', look.gather.toFixed(3))
      s.setProperty('--m2d-spin', `${(spin % 360).toFixed(2)}deg`)
      s.setProperty('--m2d-error', look.error.toFixed(3))
      if (easeStage(stage, bd.current ? stageLook() : FULL_STAGE, f.dt)) scheduler.kick(50)
      s.opacity = stage.cap >= 0.999 ? '' : stage.cap.toFixed(3)
    }
    scheduler.setRenderer(render)
    return () => scheduler.releaseRenderer(render)
  }, [active, scheduler, stateRef])

  return (
    <div ref={el} className="m2d" aria-hidden="true">
      <span className="m2d__corona" />
      <span className="m2d__ring" />
      <span className="m2d__halo" />
      <span className="m2d__rays">
        <span className="m2d__ray" />
        <span className="m2d__ray m2d__ray--v" />
      </span>
      <span className="m2d__core" />
    </div>
  )
}
