/**
 * Slider value math: clamping, snapping to the step grid (anchored at `min`, free of float noise), pointer position →
 * value, and the APG slider keys. The silence-wait slider (07 C17: 300–5000 ms, step 100) is the reference case.
 */

export interface SliderRange {
  min: number
  max: number
  step: number
  /** PageUp/PageDown step; default max(step, a tenth of the range snapped to the grid). */
  largeStep?: number
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Decimal places of a number as written (0.25 → 2, 100 → 0, 1e-7 → 7). */
export function decimals(n: number): number {
  if (!Number.isFinite(n)) return 0
  const s = String(n)
  const e = /e-(\d+)$/.exec(s)
  if (e) return Number(e[1]) + (s.split('e')[0].split('.')[1]?.length ?? 0)
  return s.split('.')[1]?.length ?? 0
}

/** Nearest value on the grid min + k·step inside [min, max]; the top end is reachable even off-grid. */
export function snap(v: number, r: SliderRange): number {
  if (!Number.isFinite(v)) return r.min
  if (v >= r.max) return r.max
  if (v <= r.min) return r.min
  if (!(r.step > 0)) return v
  const k = Math.round((v - r.min) / r.step)
  const places = Math.max(decimals(r.step), decimals(r.min))
  const snapped = Number((r.min + k * r.step).toFixed(places))
  return clamp(snapped, r.min, r.max)
}

/** Position of `v` along the track, 0–1. */
export function ratioOf(v: number, r: Pick<SliderRange, 'min' | 'max'>): number {
  if (r.max === r.min) return 0
  return clamp((v - r.min) / (r.max - r.min), 0, 1)
}

/** Value at a track ratio (pointer x / track width), snapped. */
export function valueAtRatio(ratio: number, r: SliderRange): number {
  return snap(r.min + clamp(ratio, 0, 1) * (r.max - r.min), r)
}

export function largeStepOf(r: SliderRange): number {
  if (r.largeStep && r.largeStep > 0) return r.largeStep
  const tenth = (r.max - r.min) / 10
  if (!(r.step > 0)) return tenth
  return Math.max(r.step, Math.round(tenth / r.step) * r.step)
}

/** New value for a slider key (APG), or null if the key is not a slider key. RTL is not mirrored (Vesper is LTR). */
export function keyValue(value: number, key: string, r: SliderRange): number | null {
  const s = r.step > 0 ? r.step : (r.max - r.min) / 100
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return snap(value + s, r)
    case 'ArrowLeft':
    case 'ArrowDown':
      return snap(value - s, r)
    case 'PageUp':
      return snap(value + largeStepOf(r), r)
    case 'PageDown':
      return snap(value - largeStepOf(r), r)
    case 'Home':
      return r.min
    case 'End':
      return r.max
    default:
      return null
  }
}

/** "1.2 s" style formatting for millisecond sliders (silence wait). */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}
