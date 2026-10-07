/**
 * Where the main window opens and how small it may get (no Electron — unit-tested in
 * tests/unit/main/windowBounds.test.ts). Ported from Orrery, with Vesper's sizes.
 *
 * Sizes are DIP. A high-DPI screen has a small work area: the owner's 2560×1440 at 225 % leaves 1138×608 above the
 * taskbar, less than the 1440×900 default — Orrery's window used to open with its bottom below the screen edge. So
 * every size is clamped to the work area of the display the window is on, saved bounds are moved and shrunk to fit,
 * and a first run whose default size does not fit opens maximized. Vesper's layouts go down to phone width, so the
 * minimum is small (380×560) and only lowered further on a tiny work area.
 */

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export interface DisplayLike {
  id: number
  workArea: Rect
}

export interface PersistedPlacement {
  bounds?: Rect
  maximized?: boolean
}

export interface Placement {
  /** Normal (restored) bounds, inside the display's work area. */
  bounds: Rect
  /** Minimum window size for that display. */
  min: Size
  /** Open maximized (saved that way, or a first run on a screen the default size does not fit). */
  maximize: boolean
  displayId: number
}

export const DEFAULT_SIZE: Size = { width: 1440, height: 900 }
/** The narrowest layout (phone-like) the web client supports. */
export const MIN_SIZE: Size = { width: 380, height: 560 }
/** Lowered to the work area on tiny screens, but never below this. */
export const ABSOLUTE_MIN_SIZE: Size = { width: 320, height: 400 }
/**
 * A lowered minimum stays this much (DIP) below the work area: across monitors with different scaling Windows converts
 * the frame a DIP or two larger than asked, so a minimum equal to the work area pushes the bottom under the taskbar.
 */
export const MIN_SLACK = 8
/** Saved bounds count as on screen when at least this much of them is inside a work area. */
const MIN_VISIBLE: Size = { width: 120, height: 80 }

export function minimumSize(workArea: Size): Size {
  return {
    width: Math.min(MIN_SIZE.width, Math.max(ABSOLUTE_MIN_SIZE.width, Math.floor(workArea.width) - MIN_SLACK)),
    height: Math.min(MIN_SIZE.height, Math.max(ABSOLUTE_MIN_SIZE.height, Math.floor(workArea.height) - MIN_SLACK))
  }
}

export function fitsIn(size: Size, area: Size): boolean {
  return size.width <= area.width && size.height <= area.height
}

function clampPosition(v: number, lo: number, hi: number): number {
  // A window larger than the area (only below ABSOLUTE_MIN_SIZE) keeps its top-left corner (title bar) on screen.
  return hi < lo ? lo : Math.min(hi, Math.max(lo, v))
}

/**
 * `bounds` moved and shrunk so the whole window is inside `workArea`: size clamped to [min, work area], position so no
 * edge is outside it. Without a position the window is centred.
 */
export function fitBounds(bounds: Partial<Rect>, workArea: Rect, min: Size = minimumSize(workArea)): Rect {
  const width = Math.round(Math.max(min.width, Math.min(bounds.width ?? DEFAULT_SIZE.width, workArea.width)))
  const height = Math.round(Math.max(min.height, Math.min(bounds.height ?? DEFAULT_SIZE.height, workArea.height)))
  const x =
    bounds.x == null
      ? workArea.x + Math.max(0, Math.round((workArea.width - width) / 2))
      : clampPosition(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width)
  const y =
    bounds.y == null
      ? workArea.y + Math.max(0, Math.round((workArea.height - height) / 2))
      : clampPosition(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

function overlap(a: Rect, b: Rect): Size {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  }
}

/** The display showing most of `bounds`, or null when none shows at least a 120×80 piece (an unplugged monitor). */
export function displayFor<D extends DisplayLike>(displays: readonly D[], bounds: Rect): D | null {
  let best: D | null = null
  let bestArea = 0
  for (const d of displays) {
    const o = overlap(d.workArea, bounds)
    if (o.width < MIN_VISIBLE.width || o.height < MIN_VISIBLE.height) continue
    const area = o.width * o.height
    if (area > bestArea) {
      best = d
      bestArea = area
    }
  }
  return best
}

/**
 * Where the window opens. Saved bounds still on a display are fitted to that display's work area and keep their
 * maximized state. Otherwise (first run, or the saved display is gone) it opens centred on the primary display at
 * `requested` (VESPER_WINDOW_SIZE; clamped) or the default size, maximized when the default does not fit there.
 */
export function initialPlacement(opts: {
  persisted: PersistedPlacement | null
  displays: readonly DisplayLike[]
  primary: DisplayLike
  requested?: Size | null
}): Placement {
  const { persisted, displays, primary, requested } = opts
  const saved = !requested && persisted?.bounds ? displayFor(displays, persisted.bounds) : null
  if (saved && persisted?.bounds) {
    const min = minimumSize(saved.workArea)
    return { bounds: fitBounds(persisted.bounds, saved.workArea, min), min, maximize: !!persisted.maximized, displayId: saved.id }
  }
  const min = minimumSize(primary.workArea)
  return {
    bounds: fitBounds(requested ?? DEFAULT_SIZE, primary.workArea, min),
    min,
    maximize: requested ? false : !!persisted?.maximized || !fitsIn(DEFAULT_SIZE, primary.workArea),
    displayId: primary.id
  }
}

/**
 * After the displays changed or the window went to another display: its new minimum, and its normal bounds `current`
 * fitted to the display showing most of `on` (a maximized window: its maximized bounds) — or the primary when none
 * does. Bounds not on that display at all are centred on it.
 */
export function refitPlacement(
  current: Rect,
  displays: readonly DisplayLike[],
  primary: DisplayLike,
  on: Rect = current
): { bounds: Rect; min: Size; displayId: number } {
  const target = displayFor(displays, on) ?? primary
  const min = minimumSize(target.workArea)
  const bounds = displayFor([target], current)
    ? fitBounds(current, target.workArea, min)
    : fitBounds({ width: current.width, height: current.height }, target.workArea, min)
  return { bounds, min, displayId: target.id }
}

/** `window-state.json` as read from disk: anything that is not a usable rectangle / boolean is dropped. */
export function sanitizePlacement(raw: unknown): PersistedPlacement {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: PersistedPlacement = {}
  if (r.maximized === true) out.maximized = true
  const b = r.bounds as Record<string, unknown> | undefined
  if (b && typeof b === 'object') {
    const n = [b.x, b.y, b.width, b.height]
    if (n.every((v) => typeof v === 'number' && Number.isFinite(v)) && (b.width as number) > 0 && (b.height as number) > 0) {
      out.bounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
    }
  }
  return out
}

/** The largest distance (DIP) between matching edges of `a` and `b`. */
export function edgeError(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height))
  )
}

/** Equal within `tolerance` DIP on every edge (DIP ↔ pixel rounding moves an edge by up to a DIP). */
export function nearRect(a: Rect, b: Rect, tolerance = 1): boolean {
  return edgeError(a, b) <= tolerance
}

/**
 * The bounds to ask for next when asking for `requested` gave `actual` instead of `target`: across monitors with
 * different scaling Windows converts with a small, steady error, so asking for the target less that error lands on it.
 */
export function compensate(requested: Rect, target: Rect, actual: Rect): Rect {
  return {
    x: requested.x + (target.x - actual.x),
    y: requested.y + (target.y - actual.y),
    width: Math.max(1, requested.width + (target.width - actual.width)),
    height: Math.max(1, requested.height + (target.height - actual.height))
  }
}

/**
 * Test windows (VESPER_WINDOW_POS=corner): the bottom-right corner of the work area, never above or left of it. The
 * idle real cursor usually rests mid-screen; a window far from it rarely gets stray hover events.
 */
export function cornerPosition(size: Size, area: Rect): { x: number; y: number } {
  return { x: Math.max(area.x, area.x + area.width - size.width), y: Math.max(area.y, area.y + area.height - size.height) }
}
