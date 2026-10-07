/**
 * Constellation input on the stage element (pointer, wheel, touch, keyboard). Orbit by dragging empty sky, pan with
 * the right button / Shift / two fingers, zoom with the wheel / pinch / + −, click a star to open it, drag one star
 * onto another to link them (touch: long-press first). Every input asks the scheduler for interaction frames; nothing
 * renders while the user is idle (07 D4).
 *
 * attachInput() returns the detach function; the page owns it.
 */
import { currentScheduler } from '../host/schedulerRef'
import { clampCamera, pickStar } from './layout.logic'
import { fitView, getState, setDrag, setHover, setSelected, view } from './model'

export interface InputCallbacks {
  /** Mouse click on a star. */
  open(index: number): void
  /** Touch tap on a star (phones select first; the card offers Open). */
  select(index: number): void
  link(from: number, to: number): void
}

const DRAG_SLOP = 5
const LONG_PRESS_MS = 450
const ORBIT_SPEED = 0.0055

interface Pointer {
  id: number
  x: number
  y: number
  sx: number
  sy: number
  type: string
  button: number
}

export function attachInput(el: HTMLElement, cb: InputCallbacks): () => void {
  const pointers = new Map<number, Pointer>()
  let mode: 'none' | 'orbit' | 'pan' | 'link' | 'pinch' = 'none'
  let downStar = -1
  let moved = false
  let longPress: number | null = null
  let pinchDist = 0
  let pinchMid = { x: 0, y: 0 }

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const nudge = (ms = 450): void => {
    view.lastInput = performance.now()
    currentScheduler()?.interact(ms)
  }
  const pick = (x: number, y: number, touch: boolean): number => pickStar(view.projected, getState().nodes.length, x, y, touch ? 14 : 6)
  const cursor = (c: string): void => {
    el.style.cursor = c
  }
  const clearLong = (): void => {
    if (longPress !== null) window.clearTimeout(longPress)
    longPress = null
  }

  const pan = (dx: number, dy: number): void => {
    const g = view.goal
    // Screen → world on the camera's right/up vectors, scaled to the distance.
    const k = (g.dist * 0.0016) / Math.max(0.4, view.height / 900)
    const cy = Math.cos(g.yaw)
    const sy = Math.sin(g.yaw)
    const sp = Math.sin(g.pitch)
    const cp = Math.cos(g.pitch)
    const rx = cy
    const rz = -sy
    const ux = -sy * sp
    const uy = cp
    const uz = -cy * sp
    view.goal = { ...g, tx: g.tx - (dx * rx - dy * ux) * k, ty: g.ty + dy * uy * k, tz: g.tz - (dx * rz - dy * uz) * k }
  }

  const zoom = (factor: number): void => {
    view.goal = clampCamera({ ...view.goal, dist: view.goal.dist * factor }, getState().radius)
    nudge()
  }

  const onDown = (e: PointerEvent): void => {
    if (e.button > 2) return
    const p = local(e)
    pointers.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType, button: e.button })
    el.setPointerCapture?.(e.pointerId)
    nudge()
    if (pointers.size === 2) {
      clearLong()
      if (mode === 'link') setDrag(null)
      const [a, b] = [...pointers.values()]
      mode = 'pinch'
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      return
    }
    moved = false
    downStar = pick(p.x, p.y, e.pointerType !== 'mouse')
    mode = 'none'
    if (downStar >= 0 && e.pointerType !== 'mouse') {
      // Touch: hold a star to start a link drag.
      longPress = window.setTimeout(() => {
        longPress = null
        mode = 'link'
        setDrag({ from: downStar, x: p.x, y: p.y, over: -1 })
        navigator.vibrate?.(12)
      }, LONG_PRESS_MS)
    }
  }

  const onMove = (e: PointerEvent): void => {
    const p = local(e)
    const ptr = pointers.get(e.pointerId)
    if (!ptr) {
      // Hover (mouse, no buttons).
      if (e.pointerType === 'mouse') {
        const i = pick(p.x, p.y, false)
        setHover(i)
        cursor(i >= 0 ? 'pointer' : 'grab')
      }
      return
    }
    const dx = p.x - ptr.x
    const dy = p.y - ptr.y
    ptr.x = p.x
    ptr.y = p.y
    nudge()
    if (mode === 'pinch') {
      const [a, b] = [...pointers.values()]
      if (!a || !b) return
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (pinchDist > 0 && d > 0) view.goal = clampCamera({ ...view.goal, dist: view.goal.dist * (pinchDist / d) }, getState().radius)
      pan(mid.x - pinchMid.x, mid.y - pinchMid.y)
      pinchDist = d
      pinchMid = mid
      return
    }
    if (!moved && Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > DRAG_SLOP) {
      moved = true
      clearLong()
      if (mode !== 'link') {
        if (downStar >= 0 && ptr.type === 'mouse' && ptr.button === 0 && !e.shiftKey) {
          mode = 'link'
          setDrag({ from: downStar, x: p.x, y: p.y, over: -1 })
        } else {
          mode = ptr.button === 2 || e.shiftKey ? 'pan' : 'orbit'
        }
      }
    }
    if (mode === 'link') {
      const over = pick(p.x, p.y, ptr.type !== 'mouse')
      const d = getState().drag
      setDrag({ from: d?.from ?? downStar, x: p.x, y: p.y, over: over === (d?.from ?? downStar) ? -1 : over })
      cursor(over >= 0 ? 'copy' : 'crosshair')
    } else if (mode === 'orbit') {
      view.goal = { ...view.goal, yaw: view.goal.yaw - dx * ORBIT_SPEED, pitch: view.goal.pitch + dy * ORBIT_SPEED }
      view.goal = clampCamera(view.goal, getState().radius)
      cursor('grabbing')
    } else if (mode === 'pan') {
      pan(dx, dy)
      cursor('move')
    }
  }

  const onUp = (e: PointerEvent): void => {
    const ptr = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    clearLong()
    if (!ptr) return
    nudge()
    if (mode === 'pinch') {
      if (pointers.size === 0) mode = 'none'
      return
    }
    if (mode === 'link') {
      const d = getState().drag
      setDrag(null)
      if (d && d.over >= 0 && d.over !== d.from && e.type === 'pointerup') cb.link(d.from, d.over)
    } else if (!moved && e.type === 'pointerup') {
      if (downStar >= 0) {
        if (ptr.type === 'mouse' && ptr.button === 0) cb.open(downStar)
        else if (ptr.type !== 'mouse') cb.select(downStar)
      } else if (ptr.button === 0) {
        setSelected(-1)
      }
    }
    mode = 'none'
    downStar = -1
    cursor('grab')
  }

  const onLeave = (): void => {
    if (pointers.size === 0) setHover(-1)
  }

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    zoom(Math.exp(Math.max(-60, Math.min(60, delta)) * 0.0022))
  }

  const onDbl = (e: MouseEvent): void => {
    const p = local(e)
    if (pick(p.x, p.y, false) >= 0) return
    fitView(true, true)
    nudge(900)
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.target !== el) return
    const step = e.shiftKey ? 0.35 : 0.12
    let handled = true
    switch (e.key) {
      case 'ArrowLeft':
        view.goal = { ...view.goal, yaw: view.goal.yaw + step }
        break
      case 'ArrowRight':
        view.goal = { ...view.goal, yaw: view.goal.yaw - step }
        break
      case 'ArrowUp':
        view.goal = clampCamera({ ...view.goal, pitch: view.goal.pitch + step }, getState().radius)
        break
      case 'ArrowDown':
        view.goal = clampCamera({ ...view.goal, pitch: view.goal.pitch - step }, getState().radius)
        break
      case '+':
      case '=':
        zoom(0.85)
        break
      case '-':
      case '_':
        zoom(1 / 0.85)
        break
      case '0':
      case 'Home':
        fitView(true, true)
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      nudge(900)
    }
  }

  const onContext = (e: Event): void => e.preventDefault()

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  el.addEventListener('pointerleave', onLeave)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('dblclick', onDbl)
  el.addEventListener('keydown', onKey)
  el.addEventListener('contextmenu', onContext)
  cursor('grab')

  return () => {
    clearLong()
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    el.removeEventListener('pointerleave', onLeave)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('dblclick', onDbl)
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('contextmenu', onContext)
    pointers.clear()
  }
}
