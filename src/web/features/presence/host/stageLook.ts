/**
 * What the layout asks of the renderer while the surface is the chat backdrop (backdrop.logic.ts): the luminance cap
 * (over the message column and outside it), how far forward the avatar is, and whether it sits behind text. Written
 * by <ChatBackdrop> when its inputs change (never per frame); read by the renderers once per drawn frame and eased
 * there (so a change is a crossfade, 07 D4 "transition" frames). Outside the backdrop the renderers ignore it.
 */
import { currentScheduler } from './schedulerRef'

export interface StageLook {
  /** Max output channel over the message column, sRGB-encoded; 1 = no cap. */
  cap: number
  /** The same outside the column (where no text sits). */
  capOut: number
  /** 0 = sitting back … 1 = forward. */
  presence: number
  /** 0 = full strength (hero, Talk mode) … 1 = behind the chat's text (hairlines, no fine band, ink bead outline). */
  behind: number
  /** The column's half-width and its soft edge, as fractions of the canvas width (not eased). */
  colHalf: number
  colEdge: number
}

export const FULL_STAGE: Readonly<StageLook> = Object.freeze({ cap: 1, capOut: 1, presence: 1, behind: 0, colHalf: 0.5, colEdge: 0 })

let target: StageLook = { ...FULL_STAGE }
const listeners = new Set<() => void>()

const KEYS = ['cap', 'capOut', 'presence', 'behind', 'colHalf', 'colEdge'] as const

export function setStageLook(look: StageLook | null): void {
  const next = look ?? FULL_STAGE
  if (KEYS.every((k) => next[k] === target[k])) return
  target = { ...next }
  currentScheduler()?.kick(700)
  for (const l of [...listeners]) l()
}

export function stageLook(): Readonly<StageLook> {
  return target
}

export function subscribeStageLook(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Ease `cur` toward `to` (frame-rate independent, ~450 ms); the column geometry follows at once. True while moving. */
export function easeStage(cur: StageLook, to: Readonly<StageLook>, dt: number, tau = 0.15): boolean {
  const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau)
  let moving = false
  for (const key of ['cap', 'capOut', 'presence', 'behind'] as const) {
    const d = to[key] - cur[key]
    if (Math.abs(d) > 0.001) moving = true
    cur[key] = Math.abs(d) < 1e-4 ? to[key] : cur[key] + d * k
  }
  cur.colHalf = to.colHalf
  cur.colEdge = to.colEdge
  return moving
}
