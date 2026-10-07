/** Which state the Star shows, its visual language, and the per-device appearance (07 D4/D8/D9, research 07 §2.4) @R15 */
import { describe, expect, it } from 'vitest'
import { parsePresencePrefs } from '../../../../src/web/lib/store/presence.logic'
import { DEFAULT_STAR, drawsIn2d, isGlStyle, resolveStar } from '../../../../src/web/features/presence/prefs.logic'
import { deriveStarState, ERROR_HOLD_MS, STAR_STATE_TEXT, type StarInputs } from '../../../../src/web/features/presence/state.logic'
import {
  audioBrightness,
  createLook,
  desaturate,
  LOOK_KEYS,
  MAX_AUDIO_BRIGHTNESS,
  MIN_PULSE_GAP_MS,
  paletteFor,
  PALETTES,
  PulseLimiter,
  STATE_LOOK,
  stepLook,
  stepSpring,
  throbBrightness
} from '../../../../src/web/features/presence/visual.logic'

const base: StarInputs = { offline: false, speaking: false, stt: 'idle', muted: false, replies: [], errorAt: null, now: 1_000_000 }
const star = (p: Partial<StarInputs>): string => deriveStarState({ ...base, ...p })

describe('deriveStarState', () => {
  it('idle by default', () => {
    expect(star({})).toBe('idle')
  })

  it('a reply in progress thinks; preparing voice gathers', () => {
    expect(star({ replies: ['queued'] })).toBe('thinking')
    expect(star({ replies: ['writing'] })).toBe('thinking')
    expect(star({ replies: ['recalling', 'preparing-voice'] })).toBe('preparing-voice')
  })

  it('finished replies count for nothing', () => {
    expect(star({ replies: ['done', 'stopped', 'error'] })).toBe('idle')
  })

  it('speaking wins over everything but a lost connection', () => {
    expect(star({ speaking: true, stt: 'listening', replies: ['thinking'], muted: true })).toBe('speaking')
    expect(star({ speaking: true, offline: true })).toBe('offline')
  })

  it('the mic: warming up, listening, transcribing — unless muted', () => {
    expect(star({ stt: 'warming-up' })).toBe('warming-up')
    expect(star({ stt: 'listening' })).toBe('listening')
    expect(star({ stt: 'transcribing' })).toBe('transcribing')
    expect(star({ stt: 'listening', muted: true })).toBe('muted')
    expect(star({ stt: 'listening', replies: ['thinking'] })).toBe('listening')
  })

  it('a failed reply tints the Star for a few seconds', () => {
    expect(star({ errorAt: base.now - 100 })).toBe('error')
    expect(star({ errorAt: base.now - ERROR_HOLD_MS })).toBe('idle')
  })

  it('every state has words (the canvas is aria-hidden)', () => {
    for (const s of Object.keys(STATE_LOOK)) expect(STAR_STATE_TEXT[s as keyof typeof STAR_STATE_TEXT]).toBeTruthy()
  })
})

describe('resolveStar (DevicePrefs, 07 D8)', () => {
  const desk = { phone: false, osReducedMotion: false, appReducedMotion: false }
  const phone = { phone: true, osReducedMotion: false, appReducedMotion: false }

  it('desktop follows Settings', () => {
    expect(resolveStar({ style: 'nebula', quality: 'medium', maxFps: 30 }, {}, desk)).toMatchObject({
      style: 'nebula',
      quality: 'medium',
      maxFps: 30,
      reducedMotion: false,
      dprCap: 2
    })
  })

  it('v1.1: Armilla is the default; phones keep it (drawn in 2D), the 1.0 WebGL styles fall back to minimal2d there', () => {
    expect(DEFAULT_STAR.style).toBe('armilla')
    expect(resolveStar(DEFAULT_STAR, {}, phone)).toMatchObject({ style: 'armilla', showInChat: true, quality: 'medium', dprCap: 1.5 })
    expect(resolveStar({ style: 'orb' }, {}, phone).style).toBe('minimal2d')
    expect(resolveStar({ style: 'orb' }, {}, desk).style).toBe('orb')
    // Armilla draws as SVG on phones and without WebGL; the orb only without WebGL; minimal2d always.
    expect([drawsIn2d('armilla', true, true), drawsIn2d('armilla', false, true), drawsIn2d('armilla', false, false)]).toEqual([true, false, true])
    expect([drawsIn2d('orb', true, true), drawsIn2d('orb', false, false), drawsIn2d('minimal2d', false, true), drawsIn2d('off', true, false)]).toEqual([false, true, true, false])
  })

  it('a preference on this device wins', () => {
    expect(resolveStar(DEFAULT_STAR, { style: 'orb', showInChat: true }, phone)).toMatchObject({ style: 'orb', showInChat: true })
  })

  it('reduced motion: the OS, the app setting, or a device override', () => {
    expect(resolveStar(null, {}, { ...desk, osReducedMotion: true }).reducedMotion).toBe(true)
    expect(resolveStar(null, {}, { ...desk, appReducedMotion: true }).reducedMotion).toBe(true)
    expect(resolveStar(null, { motion: 'full' }, { ...desk, osReducedMotion: true }).reducedMotion).toBe(false)
    expect(resolveStar(null, { motion: 'reduced' }, desk).reducedMotion).toBe(true)
  })

  it('clamps maxFps and low quality caps the DPR at 1', () => {
    expect(resolveStar({ maxFps: 500 }, {}, desk).maxFps).toBe(120)
    expect(resolveStar({ maxFps: Number.NaN }, {}, desk).maxFps).toBe(60)
    expect(resolveStar({ quality: 'low' }, {}, desk).dprCap).toBe(1)
  })

  it('Armilla, orb and nebula use WebGL', () => {
    expect([isGlStyle('armilla'), isGlStyle('orb'), isGlStyle('nebula'), isGlStyle('minimal2d'), isGlStyle('off')]).toEqual([true, true, true, false, false])
  })

  it('stored prefs are parsed defensively', () => {
    expect(parsePresencePrefs({ style: 'nebula', quality: 'ultra', showInChat: 'yes', motion: 'reduced', extra: 1 })).toEqual({
      style: 'nebula',
      motion: 'reduced'
    })
    expect(parsePresencePrefs(null)).toEqual({})
    expect(parsePresencePrefs('orb')).toEqual({})
  })
})

describe('visual language', () => {
  it('every accent has a full palette; unknown accents fall back to gold', () => {
    for (const p of Object.values(PALETTES)) for (const c of [p.core, p.body, p.corona, p.rim, p.mic]) expect(c).toHaveLength(3)
    expect(paletteFor('nope')).toBe(PALETTES.gold)
    expect(paletteFor(null)).toBe(PALETTES.gold)
  })

  it('crossfades ease in 300–600 ms, frame-rate independent', () => {
    const at60 = createLook('idle')
    const at20 = createLook('idle')
    for (let i = 0; i < 27; i++) stepLook(at60, 'thinking', 1 / 60)
    for (let i = 0; i < 9; i++) stepLook(at20, 'thinking', 1 / 20)
    for (const k of LOOK_KEYS) expect(at60[k]).toBeCloseTo(at20[k], 1)
    // ~95 % there after 450 ms.
    const span = STATE_LOOK.thinking.swirl - STATE_LOOK.idle.swirl
    expect((at60.swirl - STATE_LOOK.idle.swirl) / span).toBeGreaterThan(0.9)
    let moving = true
    for (let i = 0; i < 120 && moving; i++) moving = stepLook(at60, 'thinking', 1 / 60)
    expect(moving).toBe(false)
  })

  it('audio never moves brightness more than 15 % (WCAG 2.3.1 / 07 D9)', () => {
    expect(audioBrightness(0, 0)).toBe(1)
    expect(audioBrightness(10, 10)).toBeCloseTo(1 + MAX_AUDIO_BRIGHTNESS)
    expect(MAX_AUDIO_BRIGHTNESS).toBeLessThanOrEqual(0.15)
    for (let t = 0; t < 3; t += 0.01) expect(Math.abs(throbBrightness(t, 1) - 1)).toBeLessThanOrEqual(0.06 + 1e-9)
  })

  it('onset pulses fire at most 3 times a second, however busy the audio', () => {
    const p = new PulseLimiter()
    // An onset every frame at 60 fps for 2 s (a worst case the analyser itself never produces).
    let on = 0
    for (let f = 0; f < 120; f++) {
      on = on > 0.5 ? 0 : 1
      p.step(on, (f * 1000) / 60, 1 / 60)
    }
    expect(p.fired).toBeLessThanOrEqual(6)
    expect(MIN_PULSE_GAP_MS).toBeGreaterThanOrEqual(1000 / 3)
  })

  it('pulses decay to nothing', () => {
    const p = new PulseLimiter()
    p.step(1, 0, 1 / 60)
    let v = 1
    for (let i = 1; i < 60; i++) v = p.step(0, i * 16, 1 / 60)
    expect(v).toBeLessThan(0.01)
  })

  it('the spring settles without overshoot and survives a long frame', () => {
    const s = { x: 1, v: 0 }
    let max = 0
    for (let i = 0; i < 120; i++) {
      stepSpring(s, 1.2, 1 / 60)
      max = Math.max(max, s.x)
    }
    expect(max).toBeLessThanOrEqual(1.2 + 1e-6)
    expect(s.x).toBeCloseTo(1.2, 2)
    stepSpring(s, 1, 30)
    expect(Number.isFinite(s.x)).toBe(true)
  })

  it('desaturate keeps luminance', () => {
    const out: [number, number, number] = [0, 0, 0]
    desaturate([1, 0.5, 0], 0, out)
    expect(out[0]).toBeCloseTo(out[1])
    expect(out[1]).toBeCloseTo(out[2])
  })
})
