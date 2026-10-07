/**
 * The chat backdrop (presence v2 layout, owner feedback 1.0.0: "the ai would be in the center of the chat area behind
 * the text, not up top in its own bar"). Pure: where the one presence surface sits behind the message list, how big it
 * is, and how far forward it comes per state — and the legibility guard (the luminance cap) the renderer must honour.
 *
 * Composition (desktop):
 *   - the surface is a box centred on the visible chat area (square for the 1.0 Star; Armilla, the v1.1 default, is
 *     ARMILLA_ASPECT wide so its horizon line runs across the message column) (the chat body: between the top bar and the
 *     composer), horizontally on the message column, vertically at 48 % (optical centre, a little above the middle);
 *   - the message list scrolls OVER it; the box never scrolls and never remounts (07 D5: one canvas, moved);
 *   - an empty chat makes it the hero: it moves up onto the greeting's anchor, full strength, no cap (no text over it);
 *   - in a conversation it sits back: larger, dimmer, capped — the text is what you read;
 *   - speaking / listening bring it forward a little (scale, opacity) — never past the cap.
 *
 * Intensity and scale are CSS (opacity / transform on the box: compositor only, zero WebGL frames for a state change);
 * the cap is the one thing the renderer does (a final pass: no pixel brighter than `cap`, sRGB max channel). Since the
 * avatar adds light (dark theme) or ink (light theme) on top of the page, the worst-case background behind any text is
 * page ⊕ cap × opacity — so legibility is guaranteed by these numbers, not by luck of the frame.
 */
import type { StarState, StarStyle } from '../../lib/store/presence.logic'
import { isAudioState, isBusyState } from './state.logic'

/** The message column (chat.css: --col 760 + 2 × 24 px gutter). */
export const COLUMN_PX = 808

export type BackdropMode = 'hero' | 'conversation'

export interface BackdropAvailability {
  phone: boolean
  /** Effective "Show Vesper behind the chat" (device pref over the synced setting). */
  showInChat: boolean
  style: StarStyle
  /** Hidden on this device from the top bar. */
  collapsed: boolean
}

export interface BackdropAvailable {
  shown: boolean
  /** Offer the show/hide toggle in the top bar. */
  toggle: boolean
}

export function backdropAvailable(i: BackdropAvailability): BackdropAvailable {
  const available = i.showInChat && i.style !== 'off'
  return { shown: available && !i.collapsed, toggle: available }
}

const clamp = (lo: number, v: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Armilla's box: its horizon (radius 1.25 + glow) is 1.7× as wide as the gimbals are tall (ArmillaScene FIT_W/FIT_H). */
export const ARMILLA_ASPECT = 1.7

export interface BackdropGeometry {
  /** The chat area's width (CSS px). */
  width: number
  /** Shown size in a conversation and as the empty chat's hero. */
  conversation: number
  hero: number
  /** Default centre inside the chat body (px from its top-left). */
  cx: number
  cy: number
}

/**
 * Sizes from the visible chat area (the chat body's box). Desktop at 1440×900 (body ≈ 1168×781 with the sidebar):
 * conversation 515 px tall, hero 328 (Armilla's boxes, backdropBox: 937×551 and 592×348); the owner's 1138×608 (body
 * ≈ 866×489): conversation 323, hero 205; phone 390×844 (body ≈ 390×700): conversation 273, hero 218 (Armilla: the
 * full 390 px width).
 */
export function backdropGeometry(width: number, height: number, phone: boolean, size = 1): BackdropGeometry {
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  const col = Math.min(w, COLUMN_PX)
  // v1.1.3 "Avatar size" (0.8–1.2): scales both, never taller than the area leaves room for.
  const k = clamp(0.8, Number.isFinite(size) ? size : 1, 1.2)
  const conv0 = phone ? clamp(150, Math.min(0.42 * h, 0.7 * w), 320) : clamp(180, Math.min(0.66 * h, 0.8 * col), 600)
  const hero0 = phone ? clamp(140, Math.min(0.34 * h, 0.56 * w), 280) : clamp(150, Math.min(0.42 * h, 0.56 * col), 400)
  const conversation = Math.round(k > 1 ? Math.min(conv0 * k, Math.max(conv0, (phone ? 0.5 : 0.86) * h)) : conv0 * k)
  const hero = Math.round(k > 1 ? Math.min(hero0 * k, Math.max(hero0, 0.5 * h)) : hero0 * k)
  return { width: Math.round(w), conversation, hero, cx: Math.round(w / 2), cy: Math.round(h * 0.48) }
}

/** The largest scale each mode is shown at (speaking): the box is sized for it, so CSS only ever shrinks the canvas. */
export const MAX_SCALE: Record<BackdropMode, number> = { hero: 1.06, conversation: 1.07 }

/**
 * The surface's box (CSS px) in a mode: its size × the mode's largest scale, × the avatar's aspect (Armilla 1.7),
 * never wider than the chat area. The canvas renders at this size × DPR — the hero no longer renders a
 * conversation-sized buffer shrunk to 0.6.
 */
export function backdropBox(g: BackdropGeometry, mode: BackdropMode, aspect = 1): { w: number; h: number } {
  const h = Math.round((mode === 'hero' ? g.hero : g.conversation) * MAX_SCALE[mode])
  return { w: Math.min(g.width, Math.round(h * aspect)), h }
}

/**
 * The cap's curve (the GL LumaCap pass's twin, starShaders.ts): untouched below 0.6 × cap, an exponential shoulder
 * above that never exceeds the cap. The 2D avatar applies it per element (opacity) so its lines keep their contrast
 * against each other behind text instead of all being scaled down by the cap.
 */
export function capCurve(m: number, cap: number): number {
  if (cap >= 0.999) return m
  const knee = 0.6 * cap
  if (m <= knee) return m
  const room = cap - knee
  return knee + room * (1 - Math.exp(-(m - knee) / Math.max(room, 1e-4)))
}

/** The message column's half-width (CSS px): the column (--col 760) inside the chat area, less the 24 px gutters. */
export function columnHalf(width: number): number {
  return Math.max(0, (Math.min(width, COLUMN_PX) - 48) / 2)
}

export interface BackdropLookInput {
  mode: BackdropMode
  state: StarState
  /** The reader is scrolling or selecting text (eased off ~1.2 s after the last scroll). */
  reading: boolean
  gameMode: boolean
  reducedMotion: boolean
  theme: 'dark' | 'light'
  /** Phones: full strength while speaking (the 2D avatar is small; the cap still bounds it). */
  phone?: boolean
  /** v1.1.3 "Avatar visibility" (0.5–2; 1 = the 1.1 look): opacity and the caps, the column cap ≤ CAP_MAX. */
  visibility?: number
}

export interface BackdropLook {
  /** Transform scale on top of the mode's size (1 = the mode's size). */
  scale: number
  /** CSS opacity of the box: the avatar's overall strength. */
  opacity: number
  /**
   * The renderer's luminance cap: no output pixel's max channel (sRGB-encoded, the canvas is `flat linear`) above this.
   * 1 = no cap. In the light theme the host turns light into ink (invert + multiply), so the same cap bounds how much
   * darker than the page any pixel gets.
   */
  cap: number
  /** The cap outside the message column (where no text sits): the horizon's ends may glow brighter there. */
  capOut: number
  /** 0 = sitting back … 1 = forward (speaking, hero): avatars may raise detail / motion amplitude with it. */
  presence: number
  /** 1 = behind text (a conversation): hairlines, no fine band, an ink bead outline; 0 = the hero. */
  behind: number
}

/**
 * Caps measured against the tokens (see the v11-layout report): with the cap and the opacity below, the worst pixel
 * behind any message text keeps body text ≥ 7:1 and secondary/meta text ≥ 4.5:1 in both themes (meta text over the
 * backdrop uses the stage inks in backdrop.css).
 */
export const CAP = {
  dark: { hero: 1, conversation: 0.22, outside: 0.4 },
  light: { hero: 0.5, conversation: 0.18, outside: 0.33 }
} as const

/**
 * Phones speak at full strength — 0.99, the most the analytic bound allows (text-2 ≥ 4.5:1 over a pure-white pixel at
 * the dark cap; backdrop.test.ts).
 */
export const PHONE_SPEAKING_OPACITY = 0.99

/**
 * The most the cap over the message column may reach at any visibility (v1.1.3): with the brightest possible pixel
 * behind text — every channel at the cap, opacity 1 — message text (--text-0) keeps ≥ 4.5:1. From the tokens: dark
 * 0.384 (light added to #07070d under #f3f1fb), light 0.487 (ink on #f7f6fb under #16141f); rounded down
 * (backdrop.test.ts recomputes both). Secondary text (--text-1/--text-2) keeps its 4.5:1 up to 100 % and loses some
 * above it — the setting's hint says so.
 */
export const CAP_MAX = { dark: 0.38, light: 0.48 } as const
export const VISIBILITY_MIN = 0.5
export const VISIBILITY_MAX = 2

/**
 * A cap at visibility v: below 1 it scales down (subtle); above 1 it moves linearly to `max` at the top of the range
 * (so 200 % is exactly the most legibility allows).
 */
export function visibleCap(base: number, max: number, v: number): number {
  const x = clamp(VISIBILITY_MIN, Number.isFinite(v) ? v : 1, VISIBILITY_MAX)
  if (x <= 1) return base * x
  return Math.min(Math.max(base, max), base + (max - base) * ((x - 1) / (VISIBILITY_MAX - 1)))
}

/** An opacity at visibility v: scaled down below 1, and above 1 most of the way to 1 (the state order stays). */
export function visibleOpacity(op: number, v: number): number {
  const x = clamp(VISIBILITY_MIN, Number.isFinite(v) ? v : 1, VISIBILITY_MAX)
  if (x <= 1) return op * x
  return op + (1 - op) * 0.8 * ((x - 1) / (VISIBILITY_MAX - 1))
}

export function backdropLook(i: BackdropLookInput): BackdropLook {
  const audio = isAudioState(i.state)
  const busy = isBusyState(i.state)
  const calm = i.state === 'muted' || i.state === 'offline' || i.state === 'error'
  const still = i.gameMode || i.reducedMotion
  const speaking = i.state === 'speaking'
  const v = i.visibility ?? 1
  if (i.mode === 'hero') {
    // No text is drawn over the hero: it is already full strength; visibility only makes it subtler (and the light
    // theme's ink a little denser above 100 %).
    const heroCap = CAP[i.theme].hero
    const cap = heroCap >= 1 ? 1 : visibleCap(heroCap, 0.8, v)
    return {
      scale: still ? 1 : speaking ? MAX_SCALE.hero : audio ? 1.03 : 1,
      opacity: (calm ? 0.7 : 1) * Math.min(1, v),
      cap,
      capOut: cap,
      presence: 1,
      behind: 0
    }
  }
  let opacity = speaking ? (i.phone ? PHONE_SPEAKING_OPACITY : 0.92) : audio ? 0.86 : busy ? 0.74 : calm ? 0.48 : 0.64
  if (i.reading) opacity = Math.max(0.3, opacity * 0.55)
  const cap = Math.min(CAP_MAX[i.theme], visibleCap(CAP[i.theme].conversation, CAP_MAX[i.theme], v))
  return {
    scale: still ? 1 : speaking ? MAX_SCALE.conversation : audio ? 1.035 : 1,
    opacity: visibleOpacity(opacity, v),
    cap,
    // Outside the column no text sits: it follows the visibility up to 0.85.
    capOut: Math.max(cap, visibleCap(CAP[i.theme].outside, 0.85, v)),
    presence: speaking ? 1 : audio ? 0.8 : busy ? 0.45 : 0.2,
    behind: 1
  }
}
