import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIZE,
  MIN_SIZE,
  compensate,
  cornerPosition,
  displayFor,
  fitBounds,
  initialPlacement,
  minimumSize,
  nearRect,
  refitPlacement,
  sanitizePlacement,
  type DisplayLike,
  type Rect
} from '../../../src/main/windowBounds'

/** The owner's primary: 2560×1440 at 225 % → 1138×608 DIP above the taskbar. */
const OWNER_PRIMARY: DisplayLike = { id: 1, workArea: { x: 0, y: 0, width: 1138, height: 608 } }
/** A 1920×1080 at 150 % secondary to the right. */
const SECONDARY: DisplayLike = { id: 2, workArea: { x: 1138, y: 0, width: 1280, height: 672 } }
const BIG: DisplayLike = { id: 3, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }

const inside = (b: Rect, wa: Rect): boolean => b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height

describe('minimumSize', () => {
  it('is the phone-like minimum on normal screens', () => {
    expect(minimumSize(OWNER_PRIMARY.workArea)).toEqual(MIN_SIZE)
    expect(MIN_SIZE).toEqual({ width: 380, height: 560 })
  })
  it('stays below a tiny work area', () => {
    expect(minimumSize({ width: 360, height: 500 })).toEqual({ width: 352, height: 492 })
    expect(minimumSize({ width: 100, height: 100 })).toEqual({ width: 320, height: 400 })
  })
})

describe('initialPlacement', () => {
  it('opens maximized on the owner primary, where the default does not fit, with bounds inside the work area', () => {
    const p = initialPlacement({ persisted: null, displays: [OWNER_PRIMARY, SECONDARY], primary: OWNER_PRIMARY })
    expect(p.maximize).toBe(true)
    expect(inside(p.bounds, OWNER_PRIMARY.workArea)).toBe(true)
    expect(p.bounds).toEqual({ x: 0, y: 0, width: 1138, height: 608 })
  })
  it('opens centred at the default size where it fits', () => {
    const p = initialPlacement({ persisted: null, displays: [BIG], primary: BIG })
    expect(p.maximize).toBe(false)
    expect(p.bounds).toEqual({ x: 560, y: 250, ...DEFAULT_SIZE })
  })
  it('restores saved bounds on their display, fitted and keeping maximized', () => {
    const saved = { bounds: { x: 1200, y: 40, width: 1600, height: 900 }, maximized: true }
    const p = initialPlacement({ persisted: saved, displays: [OWNER_PRIMARY, SECONDARY], primary: OWNER_PRIMARY })
    expect(p.displayId).toBe(2)
    expect(p.maximize).toBe(true)
    expect(inside(p.bounds, SECONDARY.workArea)).toBe(true)
  })
  it('falls back to the primary when the saved display is gone', () => {
    const saved = { bounds: { x: 5000, y: 0, width: 800, height: 600 } }
    const p = initialPlacement({ persisted: saved, displays: [OWNER_PRIMARY], primary: OWNER_PRIMARY })
    expect(p.displayId).toBe(1)
    expect(inside(p.bounds, OWNER_PRIMARY.workArea)).toBe(true)
  })
  it('uses a requested (test) size unmaximized, clamped', () => {
    const p = initialPlacement({ persisted: null, displays: [OWNER_PRIMARY], primary: OWNER_PRIMARY, requested: { width: 390, height: 844 } })
    expect(p.maximize).toBe(false)
    expect(p.bounds.width).toBe(390)
    expect(p.bounds.height).toBe(608)
  })
})

describe('fitBounds / refitPlacement / displayFor', () => {
  it('moves and shrinks bounds into the work area, keeping the minimum', () => {
    const b = fitBounds({ x: -100, y: 500, width: 200, height: 2000 }, OWNER_PRIMARY.workArea)
    expect(b).toEqual({ x: 0, y: 0, width: 380, height: 608 })
  })
  it('picks the display showing most of the window, null when barely visible', () => {
    expect(displayFor([OWNER_PRIMARY, SECONDARY], { x: 1000, y: 0, width: 800, height: 600 })?.id).toBe(2)
    expect(displayFor([OWNER_PRIMARY], { x: 1100, y: 0, width: 800, height: 600 })).toBeNull()
  })
  it('refits to the primary after a monitor is unplugged', () => {
    const r = refitPlacement({ x: 1300, y: 20, width: 1200, height: 650 }, [OWNER_PRIMARY], OWNER_PRIMARY)
    expect(r.displayId).toBe(1)
    expect(inside(r.bounds, OWNER_PRIMARY.workArea)).toBe(true)
  })
})

describe('sanitizePlacement', () => {
  it('drops anything that is not a usable rectangle', () => {
    expect(sanitizePlacement(null)).toEqual({})
    expect(sanitizePlacement({ maximized: 'yes', bounds: { x: 1, y: 2, width: -5, height: 3 } })).toEqual({})
    expect(sanitizePlacement({ bounds: { x: 1, y: 2, width: Number.NaN, height: 3 } })).toEqual({})
    expect(sanitizePlacement({ maximized: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ maximized: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })
  })
})

describe('compensate / nearRect / cornerPosition', () => {
  it('asks for the target less the measured error', () => {
    const target = { x: 100, y: 100, width: 1280, height: 688 }
    const actual = { x: 99, y: 100, width: 1286, height: 691 }
    expect(compensate(target, target, actual)).toEqual({ x: 101, y: 100, width: 1274, height: 685 })
    expect(nearRect(target, { ...target, x: 101 })).toBe(true)
    expect(nearRect(target, actual)).toBe(false)
  })
  it('puts test windows in the bottom-right corner, never off the work area', () => {
    expect(cornerPosition({ width: 400, height: 300 }, OWNER_PRIMARY.workArea)).toEqual({ x: 738, y: 308 })
    expect(cornerPosition({ width: 1440, height: 900 }, OWNER_PRIMARY.workArea)).toEqual({ x: 0, y: 0 })
  })
})
