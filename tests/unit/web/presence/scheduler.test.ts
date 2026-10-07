/**
 * FrameScheduler keeps exactly ONE requestAnimationFrame chain (07 D4, review F44) @R15 @R17
 *
 * Renderers call kick()/interact()/pulse()/requestFrame() from inside a drawn frame (the Star's look crossfade, the
 * 2D star, the Constellation). Each of those used to start a second rAF chain while tick() had `raf = 0`, and tick()
 * then overwrote the handle, so callbacks grew by one chain per drawn frame until a 'rest' budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Cb = (t: number) => void
let queue = new Map<number, Cb>()
let nextId = 1
let clock = 0
const saved: Record<string, unknown> = {}

function installGlobals(): void {
  const g = globalThis as Record<string, unknown>
  for (const k of ['requestAnimationFrame', 'cancelAnimationFrame', 'document', 'window']) saved[k] = g[k]
  queue = new Map()
  nextId = 1
  clock = 1000
  g.requestAnimationFrame = (cb: Cb): number => {
    const id = nextId++
    queue.set(id, cb)
    return id
  }
  g.cancelAnimationFrame = (id: number): void => void queue.delete(id)
  const noop = (): void => undefined
  g.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener: noop, removeEventListener: noop }
  g.window = { addEventListener: noop, removeEventListener: noop }
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
}

function restoreGlobals(): void {
  const g = globalThis as Record<string, unknown>
  for (const [k, v] of Object.entries(saved)) g[k] = v
  vi.restoreAllMocks()
}

/** One display refresh: run every callback queued before it (like the browser), at 60 Hz. */
function step(): number {
  clock += 1000 / 60
  const due = [...queue.entries()]
  queue.clear()
  for (const [, cb] of due) cb(clock)
  return due.length
}

beforeEach(installGlobals)
afterEach(restoreGlobals)

/** The slice of FrameScheduler these tests drive (the module is a DOM file: loaded at run time, typed here). */
interface Sched {
  watchPace: boolean
  stats: { frames: number; callbacks: number }
  update(p: Record<string, unknown>): void
  observe(el: unknown): void
  setRenderer(r: (() => void) | null): void
  kick(ms: number): void
  interact(ms?: number): void
  pulse(ms: number): void
  requestFrame(): void
  current(): { fps: number }
  dispose(): void
}
const SCHEDULER = '../../../../src/web/features/presence/host/scheduler'

async function makeScheduler(): Promise<Sched> {
  const { FrameScheduler } = (await import(/* @vite-ignore */ SCHEDULER)) as { FrameScheduler: new () => Sched }
  const s = new FrameScheduler()
  s.watchPace = false
  s.update({ mode: 'star', state: 'speaking', canDraw: true, style: 'orb' })
  s.observe({}) // no IntersectionObserver in node → on screen
  return s
}

describe('FrameScheduler re-entrancy', () => {
  it('kick() from inside the renderer never forks a second rAF chain', async () => {
    const s = await makeScheduler()
    let drawn = 0
    s.setRenderer(() => {
      drawn++
      if (drawn <= 60) s.kick(50) // the look crossfade reports movement for a second
    })
    const pending: number[] = []
    for (let i = 0; i < 120; i++) {
      step()
      pending.push(queue.size)
    }
    expect(Math.max(...pending)).toBe(1)
    expect(s.stats.callbacks).toBe(120)
    expect(s.stats.frames).toBeGreaterThan(100)
    s.dispose()
    expect(queue.size).toBe(0)
  })

  it('interact(), pulse() and requestFrame() inside a frame keep one chain (constellation)', async () => {
    const s = await makeScheduler()
    s.update({ mode: 'constellation' })
    let n = 0
    s.setRenderer(() => {
      n++
      s.interact(120)
      s.pulse(200)
      if (n % 3 === 0) s.requestFrame()
    })
    for (let i = 0; i < 90; i++) {
      step()
      expect(queue.size).toBeLessThanOrEqual(1)
    }
    s.dispose()
  })

  it('a frame requested inside the last frame before rest is still drawn (no lost request)', async () => {
    const s = await makeScheduler()
    s.update({ state: 'idle' })
    // Let the idle window and crossfades expire → rest.
    let drawn = 0
    let askAgain = false
    s.setRenderer(() => {
      drawn++
      if (askAgain) {
        askAgain = false
        s.requestFrame()
      }
    })
    clock += 60_000
    for (let i = 0; i < 5; i++) step()
    expect(s.current().fps).toBe(0)
    expect(queue.size).toBe(0)
    const before = drawn
    askAgain = true
    s.requestFrame()
    for (let i = 0; i < 5; i++) step()
    expect(drawn).toBe(before + 2)
    expect(queue.size).toBe(0)
    s.dispose()
  })
})
