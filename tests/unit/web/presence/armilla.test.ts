/** Armilla (the v1.1 default avatar): pure logic — look crossfades, gimbal poses, the voice oscilloscope, ink colours. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARM_LOOK,
  armColors,
  createRingFrame,
  horizonWave,
  JEWEL_GLOW,
  ringFrame,
  SPEAK_RATE,
  createArmLook,
  createGimbals,
  gimbalRadius,
  gimbalTargets,
  inkOf,
  nearestHalfTurn,
  R_GIMBAL,
  Scope,
  SCOPE_MARGIN_S,
  SCOPE_MAX_DELAY_S,
  SCOPE_N,
  SCOPE_SEARCH_S,
  SCOPE_TAPER,
  SCOPE_WINDOW_S,
  scopeFrame,
  scopeTaper,
  stepArmLook,
  stepGimbals,
  WAVE_AMP,
  WAVE_FLOOR
} from '../../../../src/web/features/presence/gl/avatars/armilla/armilla.logic'
import { scopeFftSize } from '../../../../src/web/lib/audio/levels.logic'
import { PALETTES } from '../../../../src/web/features/presence/visual.logic'

const lum = (c: readonly number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

describe('Armilla look', () => {
  it('crossfades to every state within ~3 s (the gimbal pose is the slowest) and then reports rest', () => {
    for (const state of Object.keys(ARM_LOOK) as Array<keyof typeof ARM_LOOK>) {
      const look = createArmLook('idle')
      let moving = true
      for (let i = 0; i < 180; i++) moving = stepArmLook(look, state, 1 / 60)
      expect(moving).toBe(false)
      expect(look).toEqual(ARM_LOOK[state])
    }
  })
})

describe('Armilla gimbals', () => {
  it('listening turns every ring to face the viewer (a multiple of a half turn)', () => {
    const g = createGimbals()
    const look = createArmLook('listening')
    for (let i = 0; i < 240; i++) stepGimbals(g, look, 1 / 60, 1)
    for (const a of [g.a0, g.a1, g.a2]) expect(Math.abs(a - nearestHalfTurn(a))).toBeLessThan(0.01)
  })

  it('thinking spins the gimbals, and they home back to the resting pose afterwards', () => {
    const g = createGimbals()
    const think = createArmLook('thinking')
    for (let i = 0; i < 60 * 7; i++) stepGimbals(g, think, 1 / 60, 1)
    expect(Math.abs(g.p1) + Math.abs(g.p2)).toBeGreaterThan(1)
    const idle = createArmLook('thinking')
    let moving = true
    for (let i = 0; i < 60 * 8; i++) {
      stepArmLook(idle, 'idle', 1 / 60)
      moving = stepGimbals(g, idle, 1 / 60, 1)
    }
    expect(moving).toBe(false)
    expect(Math.abs(g.p1 - nearestHalfTurn(g.p1))).toBeLessThan(1e-3)
    expect(Math.abs(g.p2 - nearestHalfTurn(g.p2))).toBeLessThan(1e-3)
    const [, t1, t2] = gimbalTargets(g, idle, 0)
    expect(Math.abs(g.a1 - t1)).toBeLessThan(0.02)
    expect(Math.abs(g.a2 - t2)).toBeLessThan(0.02)
  })

  it('reduced motion never rotates: the pose snaps and nothing integrates', () => {
    const g = createGimbals()
    const look = createArmLook('thinking')
    const p0 = g.p0
    expect(stepGimbals(g, look, 1 / 20, 0)).toBe(false)
    expect(g.p0).toBe(p0)
    expect(g.v0 + g.v1 + g.v2).toBe(0)
  })
})

describe('Armilla voice oscilloscope (v1.1.5: the real audio, standing still across the horizon)', () => {
  const RATE = 48000
  const TD = scopeFftSize(RATE)
  /** An analyser frame of `fn` (t in seconds): TD samples, the newest at `tEnd`. */
  const frameOf = (fn: (t: number) => number, tEnd = TD / RATE, n = TD): Float32Array => {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = fn(tEnd - (n - 1 - i) / RATE)
    return a
  }
  const corr = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let ab = 0
    let aa = 0
    let bb = 0
    for (let i = 0; i < a.length; i++) {
      ab += a[i] * b[i]
      aa += a[i] * a[i]
      bb += b[i] * b[i]
    }
    return ab / Math.sqrt(aa * bb + 1e-12)
  }
  const lp = new Float32Array(TD)
  const trig = new Float32Array(TD)
  const cut = (fn: (t: number) => number, tEnd: number): Float32Array => {
    const out = new Float32Array(SCOPE_N)
    scopeFrame(frameOf(fn, tEnd), RATE, lp, trig, out)
    return out
  }
  /** The drawn front, left end (u → 0) … right end (u → 1). */
  const front = (sc: Scope, n = 240): number[] => {
    const out: number[] = []
    for (let k = 1; k < n; k++) out.push(horizonWave(sc, Math.acos((2 * k) / n - 1), WAVE_AMP))
    return out
  }
  const swing = (sc: Scope): number => Math.max(...front(sc).map(Math.abs))
  /** Frames of a continuous signal at a fixed rate: frame i ends at t0 + i·dt. */
  const run = (sc: Scope, fn: ((t: number) => number) | null, frames: number, o: { dt?: number; t0?: number; who?: 0 | 1; delay?: number; weight?: number } = {}): void => {
    const dt = o.dt ?? 1 / 60
    for (let i = 0; i < frames; i++) sc.step(dt, fn ? frameOf(fn, (o.t0 ?? 1) + i * dt) : null, RATE, o.weight ?? 1, o.who ?? 0, o.delay ?? 0)
  }
  const tone = (f: number, a = 0.4) => (t: number): number => a * Math.sin(2 * Math.PI * f * t)

  it('sizes: a window of a few pitch periods, enough points for a smooth curve, and an analyser that holds window + search', () => {
    expect(SCOPE_WINDOW_S).toBeGreaterThanOrEqual(0.025)
    expect(SCOPE_WINDOW_S).toBeLessThanOrEqual(0.045)
    expect(SCOPE_N).toBeGreaterThanOrEqual(96)
    expect(SCOPE_N).toBeLessThanOrEqual(160)
    for (const r of [16000, 22050, 24000, 44100, 48000, 96000, 192000]) expect(scopeFftSize(r) / r).toBeGreaterThan(SCOPE_WINDOW_S + SCOPE_SEARCH_S + 0.002)
    expect(scopeFftSize(48000)).toBe(4096)
  })

  it('triggers on a rising zero crossing: a sine draws the same, phase-aligned shape whenever the frame was taken', () => {
    const f0 = 180
    const ref = cut(tone(f0), 0.2)
    // The truth: the sine from a rising zero crossing, across the window, tapered.
    const truth = Array.from({ length: SCOPE_N }, (_, j) => scopeTaper(j / (SCOPE_N - 1)) * Math.sin((2 * Math.PI * f0 * j * SCOPE_WINDOW_S) / (SCOPE_N - 1)))
    expect(corr(ref, truth)).toBeGreaterThan(0.999)
    for (const tEnd of [0.20123, 0.2171, 0.25, 0.5337, 1.9999]) {
      const o = cut(tone(f0), tEnd)
      for (let j = 0; j < SCOPE_N; j++) expect(Math.abs(o[j] - ref[j])).toBeLessThan(2e-3)
    }
  })

  it('draws the true shape of the voice (a real waveform, not a sine), lightly smoothed', () => {
    // A voice-like wave: 150 Hz with a strong, phase-shifted 2nd and 3rd harmonic (asymmetric, like a glottal pulse).
    const f0 = 150
    const shape = (t: number): number => 0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(4 * Math.PI * f0 * t + 1) + 0.12 * Math.sin(6 * Math.PI * f0 * t + 2.2)
    const out = new Float32Array(SCOPE_N)
    const peak = scopeFrame(frameOf(shape, 0.3123), RATE, lp, trig, out)
    expect(peak).toBeGreaterThan(0.3)
    expect(peak).toBeLessThan(0.65)
    // Best match over a period's phases: the true shape matches, a pure sine does not.
    const best = (fn: (t: number) => number): number => {
      let m = -1
      for (let k = 0; k < 200; k++) {
        const ph = k / 200 / f0
        const ref = Array.from({ length: SCOPE_N }, (_, j) => scopeTaper(j / (SCOPE_N - 1)) * fn(ph + (j * SCOPE_WINDOW_S) / (SCOPE_N - 1)))
        m = Math.max(m, corr(out, ref))
      }
      return m
    }
    const truth = best(shape)
    expect(truth).toBeGreaterThan(0.97)
    expect(best((t) => Math.sin(2 * Math.PI * f0 * t))).toBeLessThan(truth - 0.05)
  })

  it('silence draws a calm flat ring; the curve tapers to zero at both ends and the back half stays still', () => {
    const out = new Float32Array(SCOPE_N)
    expect(scopeFrame(new Float32Array(TD), RATE, lp, trig, out)).toBe(0)
    expect([...out].every((v) => v === 0)).toBe(true)
    const quiet = new Scope()
    run(quiet, null, 30)
    expect(quiet.flat()).toBe(true)
    expect(quiet.busy).toBe(false)
    expect(swing(quiet)).toBe(0)
    // A loud tone: zero at the ends, inside the taper near them, and nothing on the back half.
    const loud = cut(tone(200, 0.8), 0.4)
    expect(Math.abs(loud[0])).toBe(0)
    expect(Math.abs(loud[SCOPE_N - 1])).toBe(0)
    const pk = Math.max(...loud.map(Math.abs))
    for (let j = 0; j < SCOPE_N; j++) expect(Math.abs(loud[j])).toBeLessThanOrEqual(scopeTaper(j / (SCOPE_N - 1)) * pk * 1.02 + 1e-6)
    const sc = new Scope()
    run(sc, tone(200, 0.8), 40)
    expect(swing(sc)).toBeGreaterThan(WAVE_AMP * 0.8)
    expect(horizonWave(sc, 0, WAVE_AMP)).toBe(0)
    expect(Math.abs(horizonWave(sc, Math.PI, WAVE_AMP))).toBeLessThan(1e-12)
    for (const u of [0.003, 0.01, 0.99, 0.997]) expect(Math.abs(horizonWave(sc, Math.acos(2 * u - 1), WAVE_AMP))).toBeLessThan(WAVE_AMP * 0.02)
    for (let a = 1; a < 180; a++) expect(horizonWave(sc, Math.PI + (a / 180) * Math.PI, WAVE_AMP)).toBe(0)
    // When the voice stops the line settles flat (and its brightness), and the renderer may rest.
    run(sc, null, 6)
    expect(sc.flat()).toBe(true)
    run(sc, null, 84)
    expect(sc.flat()).toBe(true)
    expect(sc.busy).toBe(false)
  })

  it('no sideways motion: consecutive frames of a steady tone draw the same curve, centred on the front', () => {
    for (const [f0, dt] of [
      [140, 1 / 60],
      [215, 1 / 60],
      [180, 1 / 47]
    ] as const) {
      const sc = new Scope()
      run(sc, tone(f0, 0.5), 60, { dt })
      let prev = front(sc)
      for (let i = 0; i < 12; i++) {
        run(sc, tone(f0, 0.5), 1, { dt, t0: 1 + (60 + i) * dt })
        const cur = front(sc)
        for (let k = 0; k < cur.length; k++) expect(Math.abs(cur[k] - prev[k])).toBeLessThanOrEqual((1.01 / 127) * WAVE_AMP)
        prev = cur
      }
      // Its weight sits in the middle of the front (it is not entering from one side).
      let m = 0
      let mu = 0
      prev.forEach((h, k) => {
        m += Math.abs(h)
        mu += Math.abs(h) * ((k + 1) / (prev.length + 1))
      })
      expect(Math.abs(mu / m - 0.5)).toBeLessThan(0.03)
    }
  })

  it('normalises sensibly: loud and soft speech both read as curves; near-silence stays small; silence is flat', () => {
    const at = (amp: number): number => {
      const sc = new Scope()
      run(sc, tone(160, amp), 60)
      return swing(sc)
    }
    const loud = at(0.6)
    const soft = at(0.12)
    expect(loud).toBeGreaterThan(WAVE_AMP * 0.8)
    expect(soft).toBeGreaterThan(loud * 0.8)
    expect(at(0.003)).toBeLessThan(loud * 0.3)
    expect(at(0)).toBe(0)
    expect(WAVE_FLOOR).toBeGreaterThan(0.01)
  })

  it("the AI's frame is the one the speakers play now (its audio is the output latency old); the owner's is live", () => {
    // A frame's own lag: its window centre sits the margin + half a window (+ the trigger's offset) behind the newest sample.
    const at = { lag: 0 }
    scopeFrame(frameOf(tone(170), 1), RATE, lp, trig, new Float32Array(SCOPE_N), at)
    expect(at.lag).toBeGreaterThanOrEqual(SCOPE_MARGIN_S + SCOPE_WINDOW_S / 2 - 1e-9)
    expect(at.lag).toBeLessThanOrEqual(SCOPE_MARGIN_S + SCOPE_WINDOW_S / 2 + SCOPE_SEARCH_S + 1e-9)
    // Which frame: each frame carries its own pitch; the one drawn is the frame whose audio is `latency` old (taken
    // that long ago less its own lag), whatever the frame rate — to within half a frame.
    for (const [fps, latency] of [
      [60, 0.05],
      [60, 0.09],
      [120, 0.05],
      [47, 0.07]
    ] as const) {
      const sc = new Scope()
      const cuts: Float32Array[] = []
      const lags: number[] = []
      for (let i = 0; i < 40; i++) {
        const fn = tone(130 + 4 * i, 0.5)
        const c = new Float32Array(SCOPE_N)
        scopeFrame(frameOf(fn, 1 + i / fps), RATE, lp, trig, c, at)
        cuts.push(c)
        lags.push(at.lag)
        sc.step(1 / fps, frameOf(fn, 1 + i / fps), RATE, 1, 0, latency)
        if (i < 20) continue
        let want = 0
        let wd = Infinity
        for (let k = 0; k <= i; k++) {
          const d = Math.abs(k / fps + lags[i - k] - latency)
          if (d <= wd + 1e-9) [wd, want] = [d, k]
        }
        expect(sc.delayS).toBeCloseTo(latency, 9)
        expect(sc.drawnAge).toBeCloseTo(want / fps + lags[i - want], 9)
        expect(Math.abs(sc.drawnAge - latency)).toBeLessThanOrEqual(0.5 / fps + 0.0045)
        expect(want).toBeGreaterThan(0)
        if (fps !== 60) continue
        // … and the curve drawn is that frame's.
        let bestK = -1
        let bestC = -2
        for (let k = 0; k <= 9; k++) {
          const c = corr(sc.shape, cuts[i - k])
          if (c > bestC) [bestC, bestK] = [c, k]
        }
        expect(bestK).toBe(want)
      }
    }
    /** The first frame index at which the line moves, for a tone that starts at frame 10 (dt 1/60). */
    const firstMoving = (delay: number, who: 0 | 1): number => {
      const sc = new Scope()
      for (let i = 0; i < 40; i++) {
        sc.step(1 / 60, i >= 10 ? frameOf(tone(170), 1 + i / 60) : null, RATE, 1, who, delay)
        if (!sc.flat()) return i
      }
      return -1
    }
    expect(firstMoving(0, 0)).toBe(10)
    const late = firstMoving(0.05, 0)
    expect(late).toBeGreaterThan(10)
    expect(firstMoving(0.11, 0) - late).toBeGreaterThanOrEqual(3)
    // Unknown latency: no delay. The owner's voice (the mic) is never delayed.
    expect(firstMoving(Number.NaN, 0)).toBe(10)
    expect(firstMoving(0.05, 1)).toBe(10)
    // After the audio stops the voice is still drawn for the latency (it is still being heard), then the line is flat.
    const sc = new Scope()
    run(sc, tone(170), 30, { delay: 0.05 })
    run(sc, null, 2, { delay: 0.05 })
    expect(sc.flat()).toBe(false)
    expect(sc.busy).toBe(true)
    run(sc, null, 20, { delay: 0.05 })
    expect(sc.flat()).toBe(true)
    // The delay honoured is bounded.
    const far = new Scope()
    run(far, tone(170), 5, { delay: 3 })
    expect(far.delayS).toBe(SCOPE_MAX_DELAY_S)
  })

  it('a long gap (rest, hidden tab) clears the frames: nothing stale is drawn', () => {
    const sc = new Scope()
    run(sc, tone(200), 30, { delay: 0.05 })
    expect(sc.flat()).toBe(false)
    sc.step(2, frameOf(tone(200), 5), RATE, 1, 0, 0.05)
    expect(sc.flat()).toBe(true)
    // … and the new voice follows after the latency.
    expect(sc.busy).toBe(true)
  })

  it('horizonWave is the shader: a JS port of the GLSL horizonY (linear, clamped texture read) agrees everywhere', () => {
    // The GLSL, transliterated: texture2D(uScope, ((clamp(u)·(N − 1) + 0.5) / N)) with LINEAR filtering + CLAMP.
    const tex = (sc: Scope, u: number): number => {
      const x = Math.min(1, Math.max(0, u)) * (SCOPE_N - 1)
      const i0 = Math.floor(x)
      const f = x - i0
      const i1 = Math.min(SCOPE_N - 1, i0 + 1)
      const v = (sc.data[i0 * 4] / 255) * (1 - f) + (sc.data[i1 * 4] / 255) * f
      return (v * 255 - 128) / 127
    }
    const smooth = (a: number, b: number, x: number): number => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    const taper = (u: number): number => smooth(0, SCOPE_TAPER, u) * smooth(0, SCOPE_TAPER, 1 - u)
    const glsl = (sc: Scope, th: number, amp: number): [number, number, number] => {
      const u = 0.5 + 0.5 * Math.cos(th)
      const fr = Math.sin(th) < 0 ? 0 : 1
      const live = Math.min(1, Math.max(0, sc.level * 1.4)) * taper(u) * fr
      return [tex(sc, u) * amp * fr, sc.who, live]
    }
    const ai = new Scope()
    run(ai, (t) => 0.4 * Math.sin(2 * Math.PI * 150 * t) + 0.1 * Math.sin(6 * Math.PI * 150 * t), 50, { delay: 0.05 })
    const owner = new Scope()
    run(owner, tone(110), 50, { who: 1, weight: 0.8 })
    const mixed = new Scope()
    run(mixed, tone(160), 20, { dt: 1 / 47 })
    run(mixed, tone(120), 6, { dt: 1 / 47, who: 1, t0: 2 })
    const info: [number, number] = [0, 0]
    for (const sc of [ai, owner, mixed, new Scope()])
      for (const th of [0, 0.05, 0.3, 0.9, Math.PI / 2 - 0.2, Math.PI / 2, 2.4, Math.PI, 4, 5.5, 2 * Math.PI]) {
        const [y, who, live] = glsl(sc, th, 0.05)
        expect(horizonWave(sc, th, 0.05, info)).toBeCloseTo(y, 10)
        expect(info[0]).toBeCloseTo(who, 10)
        expect(info[1]).toBeCloseTo(live, 10)
      }
    expect(owner.who).toBeGreaterThan(0.95)
    expect(ai.who).toBe(0)
    // The GLSL module is built from the same constants (one source of truth), and reads the oscilloscope's texture.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/web/features/presence/gl/avatars/armilla/shaders.ts'), 'utf8')
    for (const name of ['SCOPE_N', 'SCOPE_TAPER', 'scopeAt', 'scopeTaper', 'uScope', 'uScopeLevel', 'uScopeWho']) expect(src).toContain(name)
    // Nothing of the scrolling trace is left (no history read by age, no travelling ping).
    expect(src).not.toMatch(/HORIZON_K|waveAt|uWavePos|uSpan|uTrace|uPingU|waveEnter/)
  })
})

describe('H-v11-presence: only the main ring shows the voice (owner, v1.1)', () => {
  /** The horizon's largest swing over its whole ring. */
  const horizonSwing = (t: Scope): number => {
    let m = 0
    for (let a = 0; a <= 720; a++) m = Math.max(m, Math.abs(horizonWave(t, (a / 720) * Math.PI * 2, WAVE_AMP)))
    return m
  }
  it('the inner rings get no audio displacement at any level, in any state; the horizon swings while speaking', () => {
    // The gimbals' shape has no audio input at all (look, clock, motion): the same rings whatever the voice does.
    expect(gimbalRadius.length).toBe(4)
    for (const level of [0, 0.25, 0.6, 1]) {
      // The main ring: the AI's voice fed to the oscilloscope (as both renderers do) swings the horizon.
      const speak = new Scope()
      const td = new Float32Array(4096)
      for (let i = 0; i < td.length; i++) td[i] = level * 0.5 * Math.sin((2 * Math.PI * 160 * i) / 48000)
      for (let i = 0; i < 120; i++) speak.step(1 / 60, td, 48000, 1, 0, 0.05)
      if (level === 0) expect(horizonSwing(speak)).toBe(0)
      else expect(horizonSwing(speak)).toBeGreaterThan(WAVE_AMP * 0.5)
    }
    for (const state of Object.keys(ARM_LOOK) as Array<keyof typeof ARM_LOOK>) {
      const look = createArmLook(state)
      for (const i of [0, 1, 2] as const) {
        const circle = R_GIMBAL[i] * (1 - 0.1 * look.gather)
        // While the AI speaks or the owner is heard: a still circle, 0 displacement; otherwise only the 0.2 Hz breath
        // (a clock, not audio), faded out as the voice weights come in.
        const slack = 0.012 * R_GIMBAL[i] * (1 - look.voice) * (1 - look.ring)
        if (state === 'speaking' || state === 'listening') expect(slack).toBe(0)
        for (let k = 0; k < 40; k++) expect(Math.abs(gimbalRadius(i, look, k * 0.13, 1) - circle)).toBeLessThanOrEqual(slack + 1e-12)
      }
    }
    // The GL shader has no audio term for the gimbals: after the horizon's branch, only the radius and the matrix.
    // (Read as text: the shader module is web-only code, outside the unit tests' project.)
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/web/features/presence/gl/avatars/armilla/shaders.ts'), 'utf8')
    const RING_VERTEX = src.slice(src.indexOf('export const RING_VERTEX'), src.indexOf('export const RING_FRAGMENT'))
    const fn = RING_VERTEX.slice(RING_VERTEX.indexOf('vec3 ringPoint('), RING_VERTEX.indexOf('void main()'))
    const gimbals = fn.slice(fn.indexOf('}', fn.indexOf('horizonY(th, who, live)')))
    expect(gimbals).toContain('uRadius[ring]')
    expect(gimbals).not.toMatch(/uStand|uTrace|traceAt|waveAt|uWavePos|uSpan|uAmp|uWaveT|horizonY|uSwell|uTime|uScope|scopeAt|scopeTaper/)
  })

  it('the inner rings get no brightness, gain or jewel change from the voice: any level, with or without onsets', () => {
    for (const state of ['speaking', 'listening', 'idle', 'thinking'] as const) {
      const look = createArmLook(state)
      for (const behind of [0, 1]) {
        const ref = ringFrame(createRingFrame(), look, 0, 0, 0, 1, behind)
        for (const env of [0, 0.3, 1])
          for (const pulse of [0, 1]) {
            const f = ringFrame(createRingFrame(), look, env, env, pulse, 1, behind)
            expect(f.brightGimbal).toBe(ref.brightGimbal)
            expect(f.gains.slice(1)).toEqual(ref.gains.slice(1))
          }
        // The horizon (only) does answer the voice while speaking.
        if (state === 'speaking') expect(ringFrame(createRingFrame(), look, 1, 0, 1, 1, behind).brightHorizon).toBeGreaterThan(ref.brightHorizon)
      }
    }
    // The jewels are the gimbals' pins: a constant glow (no onset ping, no mic glow).
    expect(typeof JEWEL_GLOW).toBe('number')
    const scene = fs.readFileSync(path.resolve(__dirname, '../../../../src/web/features/presence/gl/avatars/armilla/ArmillaScene.tsx'), 'utf8')
    expect(scene).not.toMatch(/ping \* 0\.6|delayed\(|micLift/)
    expect(scene).toContain('ju.uBright.value = rf.brightGimbal')
  })

  it('the horizon leads: behind text the gimbals sit back, and while speaking the horizon (only) rises 25 %', () => {
    const speak = ringFrame(createRingFrame(), createArmLook('speaking'), 0, 0, 0, 1, 1)
    const idle = ringFrame(createRingFrame(), createArmLook('idle'), 0, 0, 0, 1, 1)
    expect(idle.gains).toEqual([1, 0.55, 0.5, 0.45])
    expect(speak.gains[0]).toBeCloseTo(1.25)
    expect(speak.gains.slice(1)).toEqual(idle.gains.slice(1))
  })

  it('the inner rings keep turning against each other while the AI speaks, at rates that do not depend on the level, and home after', () => {
    const g = createGimbals()
    const look = createArmLook('speaking')
    const [a0, a1, a2] = [g.a0, g.a1, g.a2]
    for (let i = 0; i < 60 * 10; i++) stepGimbals(g, look, 1 / 60, 1)
    // Over 10 s every gimbal turns, each relative to the one holding it (the angles are chained: Ry(a0)·Rx(a1)·Ry(a2)).
    expect(Math.abs(g.a0 - a0)).toBeGreaterThan(0.4)
    expect(Math.abs(g.a1 - a1)).toBeGreaterThan(0.6)
    expect(Math.abs(g.a2 - a2)).toBeGreaterThan(1)
    expect(Math.abs(g.p1)).toBeCloseTo(SPEAK_RATE.r1 * 10, 1)
    expect(Math.abs(g.p2)).toBeCloseTo(Math.abs(SPEAK_RATE.r2) * 10, 1)
    // No audio input exists: the step takes the gimbals, the look (the state), the clock and motion (and the nod).
    expect(stepGimbals.length).toBe(4)
    // After speech: home to the resting pose (a half turn is the same pose).
    const idle = createArmLook('speaking')
    for (let i = 0; i < 60 * 8; i++) {
      stepArmLook(idle, 'idle', 1 / 60)
      stepGimbals(g, idle, 1 / 60, 1)
    }
    expect(Math.abs(g.p1 - nearestHalfTurn(g.p1))).toBeLessThan(1e-3)
    expect(Math.abs(g.p2 - nearestHalfTurn(g.p2))).toBeLessThan(1e-3)
  })
})

describe('Armilla colours', () => {
  it('light-theme inks keep the hue and are dark enough to read on the light page', () => {
    for (const p of Object.values(PALETTES)) {
      const c = armColors(p)
      // Deep ink on the light page (#f7f6fb, luminance ≈ 0.92): bronze lines, not a beige haze (1.0's inks: 1.8:1).
      for (const ink of [c.inkRing, c.inkHorizon, c.inkMic]) expect((0.92 + 0.05) / (lum(ink) + 0.05)).toBeGreaterThan(2)
      const [r, g, b] = inkOf(p.body)
      const [R, G, B] = p.body
      // Same dominant channel as the accent.
      expect([r, g, b].indexOf(Math.max(r, g, b))).toBe([R, G, B].indexOf(Math.max(R, G, B)))
    }
  })
})
