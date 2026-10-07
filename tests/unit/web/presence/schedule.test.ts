/** The Star's frame budget (07 D4, D3, D9) @R15 */
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_FPS,
  BUSY_FPS,
  degradeQuality,
  frameBudget,
  GAME_MODE_FPS,
  IDLE_FPS,
  IDLE_REST_AFTER_MS,
  PaceWatch,
  REDUCED_FPS,
  shouldDraw,
  type ScheduleInput
} from '../../../../src/web/features/presence/schedule.logic'

function input(patch: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    style: 'orb',
    mode: 'star',
    state: 'idle',
    visible: true,
    onScreen: true,
    focused: true,
    pauseWhenUnfocused: true,
    gameMode: false,
    paused: false,
    reducedMotion: false,
    maxFps: 60,
    canDraw: true,
    now: 100_000,
    calmSince: 100_000,
    transitionUntil: 0,
    interactUntil: 0,
    pulseUntil: 0,
    ...patch
  }
}

describe('frameBudget — star', () => {
  it('speaking and listening draw at up to 60 fps and poll the analysers', () => {
    expect(frameBudget(input({ state: 'speaking' }))).toEqual({ fps: ACTIVE_FPS, poll: true, reason: 'audio' })
    expect(frameBudget(input({ state: 'listening' }))).toMatchObject({ fps: ACTIVE_FPS, poll: true })
  })

  it('thinking-like states draw at ≤ 30 fps without polling', () => {
    for (const state of ['thinking', 'preparing-voice', 'transcribing', 'warming-up'] as const) {
      expect(frameBudget(input({ state }))).toEqual({ fps: BUSY_FPS, poll: false, reason: 'busy' })
    }
  })

  it('idle draws at ≤ 20 fps for 20 s, then rests at 0', () => {
    expect(frameBudget(input({ now: 100_000 + IDLE_REST_AFTER_MS - 1 })).fps).toBe(IDLE_FPS)
    expect(frameBudget(input({ now: 100_000 + IDLE_REST_AFTER_MS }))).toEqual({ fps: 0, poll: false, reason: 'rest' })
  })

  it('a crossfade runs at 60 even from idle', () => {
    expect(frameBudget(input({ now: 200_000, transitionUntil: 200_500 })).fps).toBe(ACTIVE_FPS)
  })

  it('hidden, off-screen, no surface, no context or style off → 0 and no polling', () => {
    for (const p of [{ visible: false }, { onScreen: false }, { mode: 'none' as const }, { canDraw: false }, { style: 'off' as const }]) {
      const b = frameBudget(input({ state: 'speaking', ...p }))
      expect(b.fps).toBe(0)
      expect(b.poll).toBe(false)
    }
  })

  it('unfocused: idle → 0, speaking → 30, thinking → 15 (pauseWhenUnfocused)', () => {
    expect(frameBudget(input({ focused: false })).fps).toBe(0)
    expect(frameBudget(input({ focused: false, state: 'speaking' })).fps).toBe(30)
    expect(frameBudget(input({ focused: false, state: 'thinking' })).fps).toBe(15)
    // The setting off: unfocused behaves like focused.
    expect(frameBudget(input({ focused: false, pauseWhenUnfocused: false })).fps).toBe(IDLE_FPS)
  })

  it('game mode: static, ≤ 10 fps only while speaking/listening (07 D3)', () => {
    expect(frameBudget(input({ gameMode: true })).fps).toBe(0)
    expect(frameBudget(input({ gameMode: true, state: 'thinking', transitionUntil: Infinity })).fps).toBe(0)
    expect(frameBudget(input({ gameMode: true, state: 'speaking' }))).toMatchObject({ fps: GAME_MODE_FPS, poll: true })
  })

  it('the user pause stops everything (07 D9)', () => {
    expect(frameBudget(input({ paused: true, state: 'speaking' })).fps).toBe(0)
  })

  it('reduced motion: ≤ 20 fps while audio plays, slow busy glow, rest otherwise', () => {
    expect(frameBudget(input({ reducedMotion: true, state: 'speaking' }))).toMatchObject({ fps: REDUCED_FPS, poll: true })
    expect(frameBudget(input({ reducedMotion: true, state: 'thinking' })).fps).toBe(10)
    expect(frameBudget(input({ reducedMotion: true })).fps).toBe(0)
  })

  it('maxFps caps every budget', () => {
    expect(frameBudget(input({ state: 'speaking', maxFps: 24 })).fps).toBe(24)
    expect(frameBudget(input({ maxFps: 15 })).fps).toBe(15)
  })
})

describe('frameBudget — constellation', () => {
  const c = (p: Partial<ScheduleInput> = {}): ScheduleInput => input({ mode: 'constellation', style: 'off', ...p })

  it('interaction draws at 60 even with the Star style off or paused', () => {
    expect(frameBudget(c({ interactUntil: 100_500 })).fps).toBe(ACTIVE_FPS)
    expect(frameBudget(c({ interactUntil: 100_500, paused: true })).fps).toBe(ACTIVE_FPS)
  })

  it('drifts at ≤ 20 for 20 s after the last input, then rests', () => {
    expect(frameBudget(c()).fps).toBe(IDLE_FPS)
    expect(frameBudget(c({ now: 100_000 + IDLE_REST_AFTER_MS })).fps).toBe(0)
  })

  it('recall pulses animate at ≤ 30; unfocused, game mode, paused and reduced motion rest', () => {
    expect(frameBudget(c({ now: 500_000, pulseUntil: 501_000 })).fps).toBe(BUSY_FPS)
    expect(frameBudget(c({ focused: false })).fps).toBe(0)
    expect(frameBudget(c({ gameMode: true })).fps).toBe(0)
    expect(frameBudget(c({ paused: true })).fps).toBe(0)
    expect(frameBudget(c({ reducedMotion: true })).fps).toBe(0)
  })

  it('never polls audio', () => {
    expect(frameBudget(c({ state: 'speaking' })).poll).toBe(false)
  })
})

describe('shouldDraw', () => {
  it('draws at the requested cadence without drift', () => {
    let last = 0
    let drawn = 0
    // A 144 Hz display asked for 20 fps.
    for (let t = 0; t <= 1000; t += 1000 / 144) {
      const next = shouldDraw(t, last, 20)
      if (next !== null) {
        last = next
        drawn++
      }
    }
    expect(drawn).toBeGreaterThanOrEqual(19)
    expect(drawn).toBeLessThanOrEqual(21)
  })

  it('a 60 Hz display really gets 60', () => {
    let last = 0
    let drawn = 0
    for (let t = 1000 / 60; t <= 1000; t += 1000 / 60) {
      const next = shouldDraw(t, last, 60)
      if (next !== null) {
        last = next
        drawn++
      }
    }
    expect(drawn).toBeGreaterThanOrEqual(59)
  })

  it('0 fps never draws', () => {
    expect(shouldDraw(10_000, 0, 0)).toBeNull()
  })
})

describe('adaptive quality (PaceWatch)', () => {
  it('a GPU that keeps up is left alone', () => {
    const w = new PaceWatch()
    let hit = false
    for (let i = 0; i < 600; i++) hit ||= w.sample(16.7 + (i % 2 ? 2 : -2), 60)
    expect(hit).toBe(false)
  })

  it('reports once after ~2 s of frames well under the target, then starts over', () => {
    const w = new PaceWatch()
    const hits: number[] = []
    for (let i = 0; i < 300; i++) if (w.sample(40, 60)) hits.push(i)
    expect(hits[0]).toBeGreaterThanOrEqual(119)
    expect(hits[0]).toBeLessThan(130)
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(120)
  })

  it('ignores low budgets and stalls (a tab coming back)', () => {
    const w = new PaceWatch()
    let hit = false
    for (let i = 0; i < 400; i++) hit ||= w.sample(60, 30) || w.sample(2000, 60)
    expect(hit).toBe(false)
  })

  it('degrades high → medium → low and stops there', () => {
    expect([0, 1, 2, 3].map((n) => degradeQuality('high', n))).toEqual(['high', 'medium', 'low', 'low'])
    expect(degradeQuality('low', 1)).toBe('low')
  })
})
