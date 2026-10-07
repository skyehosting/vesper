import { describe, expect, it } from 'vitest'
import {
  ARMILLA_ASPECT,
  backdropBox,
  columnHalf,
  MAX_SCALE,
  backdropAvailable,
  backdropGeometry,
  backdropLook,
  CAP,
  CAP_MAX,
  type BackdropLookInput
} from '../../../../src/web/features/presence/backdrop.logic'

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const hex = (h: string): number => {
  const n = parseInt(h.slice(1), 16)
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255)
}
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

describe('chat backdrop layout (v11)', () => {
  it('is shown with a style and "behind the chat" on, on phones too; collapsed keeps the toggle', () => {
    const base = { phone: false, showInChat: true, style: 'orb' as const, collapsed: false }
    expect(backdropAvailable(base)).toEqual({ shown: true, toggle: true })
    expect(backdropAvailable({ ...base, phone: true, style: 'minimal2d' })).toEqual({ shown: true, toggle: true })
    expect(backdropAvailable({ ...base, collapsed: true })).toEqual({ shown: false, toggle: true })
    expect(backdropAvailable({ ...base, style: 'off' })).toEqual({ shown: false, toggle: false })
    expect(backdropAvailable({ ...base, showInChat: false })).toEqual({ shown: false, toggle: false })
  })

  const look = (p: Partial<BackdropLookInput>) =>
    backdropLook({ mode: 'conversation', state: 'idle', reading: false, gameMode: false, reducedMotion: false, theme: 'dark', ...p })

  it('sizes from the visible chat area: big and soft in a conversation, smaller hero over the greeting', () => {
    // 1440×900 with the sidebar: chat body 1168×781.
    const desk = backdropGeometry(1168, 781, false)
    expect(desk).toEqual({ width: 1168, conversation: 515, hero: 328, cx: 584, cy: 375 })
    // The box per mode is sized for the largest (speaking) scale, so CSS only shrinks it; Armilla is 1.7× as wide
    // (its horizon runs across the column), never wider than the area; the hero renders a hero-sized box.
    expect(backdropBox(desk, 'conversation', ARMILLA_ASPECT)).toEqual({ w: 937, h: 551 })
    expect(backdropBox(desk, 'hero', ARMILLA_ASPECT)).toEqual({ w: 592, h: 348 })
    expect(backdropBox(backdropGeometry(390, 700, true), 'conversation', ARMILLA_ASPECT)).toEqual({ w: 390, h: 292 })
    expect(MAX_SCALE.conversation).toBeGreaterThanOrEqual(look({ state: 'speaking' }).scale)
    expect(MAX_SCALE.hero).toBeGreaterThanOrEqual(look({ mode: 'hero', state: 'speaking' }).scale)
    // The cap's column: --col 760 (808 less the 24 px gutters) inside the area.
    expect(columnHalf(1168)).toBe(380)
    expect(columnHalf(390)).toBe(171)
    // The owner's 1138×608: chat body 866×489.
    const owner = backdropGeometry(866, 489, false)
    expect(owner.conversation).toBe(323)
    expect(owner.hero).toBe(205)
    // Phone 390×844: body ≈ 390×700; the column is the width.
    const phone = backdropGeometry(390, 700, true)
    expect(phone.conversation).toBe(273)
    expect(phone.hero).toBe(218)
    // Never smaller than legible, never larger than the column.
    expect(backdropGeometry(300, 200, false).conversation).toBe(180)
    expect(backdropGeometry(4000, 3000, false).conversation).toBe(600)
  })

  it('sits back in a conversation, comes forward while speaking, calms while reading', () => {
    const idle = look({})
    const speaking = look({ state: 'speaking' })
    const reading = look({ reading: true })
    expect(speaking.opacity).toBeGreaterThan(idle.opacity)
    expect(speaking.scale).toBeGreaterThan(1)
    expect(reading.opacity).toBeLessThan(idle.opacity)
    expect(look({ state: 'speaking', reading: true }).opacity).toBeLessThan(speaking.opacity)
    // The cap does not move with the state: legibility never depends on what the avatar is doing.
    expect(speaking.cap).toBe(idle.cap)
    // Outside the message column (no text there) the cap is higher; behind text = 1 in a conversation, 0 as the hero.
    expect(speaking.capOut).toBeGreaterThan(speaking.cap)
    expect([speaking.behind, look({ mode: 'hero' }).behind]).toEqual([1, 0])
    // Phones: full strength while speaking (the cap still bounds it).
    expect(look({ state: 'speaking', phone: true }).opacity).toBeGreaterThan(look({ state: 'speaking' }).opacity)
  })

  it('game mode and reduced motion never scale; the hero has no cap in the dark theme', () => {
    expect(look({ state: 'speaking', gameMode: true }).scale).toBe(1)
    expect(look({ state: 'speaking', reducedMotion: true }).scale).toBe(1)
    expect(look({ mode: 'hero' }).cap).toBe(1)
    expect(look({ mode: 'hero', theme: 'light' }).cap).toBeLessThan(1)
  })

  it('the conversation caps keep the token inks legible over the brightest possible pixel (bound, not a frame)', () => {
    // Dark: the avatar adds light ≤ cap × opacity (max channel) to --bg-0 #07070d; worst case = all channels lit.
    // The strongest a conversation gets: a phone speaking (opacity 1).
    const op = Math.max(look({ state: 'speaking' }).opacity, look({ state: 'speaking', phone: true }).opacity)
    const lit = CAP.dark.conversation * op + 13 / 255
    const bg = lin(lit)
    expect(ratio(hex('#f3f1fb'), bg)).toBeGreaterThanOrEqual(7) // --text-0
    expect(ratio(hex('#c5c1d8'), bg)).toBeGreaterThanOrEqual(4.5) // --text-1
    expect(ratio(hex('#b3aecb'), bg)).toBeGreaterThanOrEqual(4.5) // --text-2 over the backdrop
    // Light: ink darkens the page #f7f6fb by ≤ cap × opacity (multiply).
    const lightOp = look({ state: 'speaking', theme: 'light', phone: true }).opacity
    const page = lin((0xf6 / 255) * (1 - CAP.light.conversation * lightOp))
    expect(ratio(hex('#16141f'), page)).toBeGreaterThanOrEqual(7)
    expect(ratio(hex('#45405a'), page)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(hex('#57526e'), page)).toBeGreaterThanOrEqual(4.5)
  })

  it('v1.1.3 "Avatar visibility": 100 % is the 1.1 look; the column cap never lets message text fall below 4.5:1', () => {
    const states = ['idle', 'thinking', 'listening', 'speaking', 'muted'] as const
    // 100 % changes nothing.
    for (const theme of ['dark', 'light'] as const)
      for (const mode of ['conversation', 'hero'] as const)
        for (const state of states) expect(look({ theme, mode, state, visibility: 1 })).toEqual(look({ theme, mode, state }))
    // Subtle below, stronger above (opacity and cap), the state order kept.
    expect(look({ visibility: 0.5 }).opacity).toBeLessThan(look({}).opacity)
    expect(look({ visibility: 0.5 }).cap).toBeLessThan(look({}).cap)
    expect(look({ visibility: 2 }).opacity).toBeGreaterThan(look({}).opacity)
    expect(look({ visibility: 2 }).cap).toBeGreaterThan(look({}).cap)
    expect(look({ visibility: 2, state: 'speaking' }).opacity).toBeGreaterThan(look({ visibility: 2 }).opacity)
    // The clamp is the most legibility allows: recomputed from the tokens over the brightest possible pixel (every
    // channel at the cap, opacity 1) — message text (--text-0) ≥ 4.5:1.
    const most = (ok: (x: number) => boolean): number => {
      let lo = 0
      let hi = 1
      for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2
        if (ok(m)) lo = m
        else hi = m
      }
      return lo
    }
    const darkMax = most((x) => ratio(hex('#f3f1fb'), lin(x + 13 / 255)) >= 4.5)
    const lightMax = most((x) => ratio(hex('#16141f'), lin((0xf6 / 255) * (1 - x))) >= 4.5)
    expect(darkMax).toBeCloseTo(0.384, 3)
    expect(lightMax).toBeCloseTo(0.487, 3)
    expect(CAP_MAX.dark).toBeLessThanOrEqual(darkMax)
    expect(CAP_MAX.dark).toBeGreaterThan(darkMax - 0.01)
    expect(CAP_MAX.light).toBeLessThanOrEqual(lightMax)
    expect(CAP_MAX.light).toBeGreaterThan(lightMax - 0.01)
    // The top of the range reaches exactly the clamp, in both themes.
    expect(look({ visibility: 2 }).cap).toBe(CAP_MAX.dark)
    expect(look({ visibility: 2, theme: 'light' }).cap).toBe(CAP_MAX.light)
    // Every visibility × state × device: body text ≥ 4.5:1 over the brightest pixel the cap and the opacity allow;
    // up to 100 % the 1.1 guarantees still hold (body ≥ 7:1, secondary ≥ 4.5:1).
    for (const v of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
      for (const state of states)
        for (const phone of [false, true]) {
          const d = look({ state, phone, visibility: v })
          const bg = lin(d.cap * d.opacity + 13 / 255)
          expect(ratio(hex('#f3f1fb'), bg)).toBeGreaterThanOrEqual(4.5)
          const l = look({ state, phone, visibility: v, theme: 'light' })
          const page = lin((0xf6 / 255) * (1 - l.cap * l.opacity))
          expect(ratio(hex('#16141f'), page)).toBeGreaterThanOrEqual(4.5)
          if (v <= 1) {
            expect(ratio(hex('#f3f1fb'), bg)).toBeGreaterThanOrEqual(7)
            expect(ratio(hex('#b3aecb'), bg)).toBeGreaterThanOrEqual(4.5)
            expect(ratio(hex('#57526e'), page)).toBeGreaterThanOrEqual(4.5)
          }
        }
    // The hero (no text over it) only gets subtler; the dark hero stays uncapped.
    expect(look({ mode: 'hero', visibility: 0.5 }).opacity).toBeLessThan(look({ mode: 'hero' }).opacity)
    expect(look({ mode: 'hero', visibility: 2 }).cap).toBe(1)
  })

  it('v1.1.3 "Avatar size" scales both modes (80–120 %), never smaller than legible nor taller than the area allows', () => {
    const base = backdropGeometry(1168, 781, false)
    expect(backdropGeometry(1168, 781, false, 1)).toEqual(base)
    expect(Math.abs(backdropGeometry(1168, 781, false, 0.8).conversation - base.conversation * 0.8)).toBeLessThanOrEqual(1)
    expect(Math.abs(backdropGeometry(1168, 781, false, 1.2).conversation - base.conversation * 1.2)).toBeLessThanOrEqual(1)
    expect(backdropGeometry(1168, 781, false, 1.2).hero).toBeLessThanOrEqual(Math.round(781 * 0.5))
    expect(backdropGeometry(1168, 781, false, 1.2).hero).toBeGreaterThan(base.hero)
    expect(backdropGeometry(300, 200, false, 1.2).conversation).toBe(180)
    expect(backdropGeometry(1168, 781, false, 9)).toEqual(backdropGeometry(1168, 781, false, 1.2))
  })
})
