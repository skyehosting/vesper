/** Constellation layout, picking and camera (07 A4) @R7 @R8 @R15 */
import { describe, expect, it } from 'vitest'
import {
  buildEdges,
  clampCamera,
  easeCamera,
  fitCamera,
  hash01,
  layoutConstellation,
  matchesQuery,
  orbitPosition,
  pickStar,
  PITCH_LIMIT,
  starBrightness,
  starSize,
  type LayoutInput
} from '../../../../src/web/features/presence/constellation/layout.logic'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 5, 12)

function sessions(n: number, links: Record<number, number[]> = {}): LayoutInput[] {
  return Array.from({ length: n }, (_, i) => ({
    uid: `uid-${i}`,
    shortId: `S${String(i).padStart(5, '0')}`,
    createdUtc: NOW - (n - i) * DAY,
    lastUtc: NOW - (n - i) * DAY + 3_600_000,
    count: (i * 7) % 90,
    private: i % 9 === 0,
    links: (links[i] ?? []).map((j) => `S${String(j).padStart(5, '0')}`)
  }))
}

describe('layoutConstellation', () => {
  it('is deterministic', () => {
    const a = layoutConstellation(sessions(40, { 1: [2] }), NOW)
    const b = layoutConstellation(sessions(40, { 1: [2] }), NOW)
    expect(a).toEqual(b)
  })

  it('places the newest near the centre and the oldest outward', () => {
    const l = layoutConstellation(sessions(60), NOW)
    const r = (i: number): number => Math.hypot(l.nodes[i].x, l.nodes[i].z)
    const newest = [57, 58, 59].map(r).reduce((x, y) => x + y) / 3
    const oldest = [0, 1, 2].map(r).reduce((x, y) => x + y) / 3
    expect(newest).toBeLessThan(oldest / 2)
  })

  it('keeps stars apart', () => {
    const l = layoutConstellation(sessions(200), NOW)
    let close = 0
    for (let i = 0; i < l.nodes.length; i++)
      for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i]
        const b = l.nodes[j]
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.2) close++
      }
    expect(close).toBeLessThan(4)
  })

  it('pulls linked sessions closer than they would be', () => {
    const free = layoutConstellation(sessions(80), NOW)
    const linked = layoutConstellation(sessions(80, { 5: [70] }), NOW)
    const d = (l: typeof free): number => Math.hypot(l.nodes[5].x - l.nodes[70].x, l.nodes[5].y - l.nodes[70].y, l.nodes[5].z - l.nodes[70].z)
    expect(d(linked)).toBeLessThan(d(free))
  })

  it('lays out thousands of sessions quickly', () => {
    const t = performance.now()
    const l = layoutConstellation(sessions(3000, { 1: [2], 3: [4] }), NOW)
    expect(l.nodes).toHaveLength(3000)
    expect(performance.now() - t).toBeLessThan(1500)
    for (const p of l.nodes) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true)
  })

  it('handles an empty or single-star sky', () => {
    expect(layoutConstellation([], NOW).nodes).toEqual([])
    expect(layoutConstellation(sessions(1), NOW).nodes).toHaveLength(1)
  })
})

describe('edges', () => {
  it('one line per pair, mutual links marked, unknown and self links dropped', () => {
    const s = sessions(4, { 0: [1, 3, 0], 1: [0], 2: [99 as number] })
    s[2].links = ['NOPE00']
    const e = buildEdges(s)
    expect(e).toEqual(
      expect.arrayContaining([
        { a: 0, b: 1, both: true },
        { a: 0, b: 3, both: false }
      ])
    )
    expect(e).toHaveLength(2)
  })
})

describe('size and brightness', () => {
  it('size grows with messages (log) and is capped', () => {
    expect(starSize(0)).toBeLessThan(starSize(10))
    expect(starSize(10)).toBeLessThan(starSize(1000))
    expect(starSize(10_000_000)).toBeLessThanOrEqual(0.42)
  })
  it('brightness falls with time since the last message, never to nothing', () => {
    expect(starBrightness(NOW, NOW)).toBeCloseTo(1)
    expect(starBrightness(NOW - 30 * DAY, NOW)).toBeGreaterThan(starBrightness(NOW - 300 * DAY, NOW))
    expect(starBrightness(NOW - 3000 * DAY, NOW)).toBeGreaterThanOrEqual(0.32)
  })
})

describe('picking', () => {
  it('picks the nearest star in reach, ignoring stars behind the camera', () => {
    const p = new Float32Array([100, 100, 0.5, 6, 140, 100, 0.5, 6, 100, 100, 1.5, 30])
    expect(pickStar(p, 3, 103, 101)).toBe(0)
    expect(pickStar(p, 3, 138, 99)).toBe(1)
    expect(pickStar(p, 3, 300, 300)).toBe(-1)
  })
})

describe('camera', () => {
  it('fits the sky and clamps the pitch and distance', () => {
    const c = fitCamera(10, 50, 16 / 9)
    expect(c.dist).toBeGreaterThan(10)
    const cl = clampCamera({ ...c, pitch: 3, dist: 0.1 }, 10)
    expect(cl.pitch).toBe(PITCH_LIMIT)
    expect(cl.dist).toBeGreaterThanOrEqual(2.5)
  })
  it('eases toward the goal and stops', () => {
    const cur = fitCamera(5, 50, 1)
    const goal = { ...cur, yaw: cur.yaw + 1 }
    let moving = true
    let frames = 0
    while (moving && frames < 600) {
      moving = easeCamera(cur, goal, 1 / 60)
      frames++
    }
    expect(moving).toBe(false)
    expect(cur.yaw).toBe(goal.yaw)
  })
  it('orbits around the target', () => {
    const [x, y, z] = orbitPosition({ yaw: 0, pitch: 0, dist: 10, tx: 1, ty: 2, tz: 3 })
    expect([x, y, z]).toEqual([1, 2, 13])
  })
})

describe('search', () => {
  const s = { title: 'Learning the cello', shortId: 'K7Q2MX', summary: 'Bach suites and bow technique' }
  it('matches titles, short ids (with or without #) and summaries', () => {
    expect(matchesQuery('cello', s)).toBe(true)
    expect(matchesQuery('#k7q', s)).toBe(true)
    expect(matchesQuery('bach', s)).toBe(true)
    expect(matchesQuery('violin', s)).toBe(false)
    expect(matchesQuery('  ', s)).toBe(false)
  })
  it('hash01 is stable and in [0, 1)', () => {
    expect(hash01('abc')).toBe(hash01('abc'))
    for (const k of ['a', 'b', 'uid-1', '']) {
      expect(hash01(k)).toBeGreaterThanOrEqual(0)
      expect(hash01(k)).toBeLessThan(1)
    }
  })
})
