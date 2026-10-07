/**
 * Constellation layout (07 A4; pure, deterministic). Sessions become stars in a slow two-armed spiral: the newest near
 * the bright centre, older conversations drifting outward along the arms — time reads as distance. Linked sessions
 * are then pulled toward each other and crowded stars pushed apart (a few relaxation passes over a spatial hash, so
 * thousands of sessions lay out in milliseconds). Size = message count (log), brightness = recency.
 */

export interface LayoutInput {
  uid: string
  shortId: string
  createdUtc: number
  /** Last activity (last message, else update/creation). */
  lastUtc: number
  count: number
  private: boolean
  /** Outgoing links (short ids): this session may recall those. */
  links: readonly string[]
}

export interface LayoutNode {
  x: number
  y: number
  z: number
  /** World-space radius of the star. */
  size: number
  /** 0.32 (long ago) … 1 (today). */
  bright: number
  /** 0 … 1: colour variation (cool → warm), deterministic per session. */
  hue: number
}

export interface LayoutEdge {
  a: number
  b: number
  /** Both sessions may recall each other. */
  both: boolean
}

export interface Layout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  /** Bounding radius (camera limits). */
  radius: number
  /** Radius holding most stars (85th percentile + margin): the opening view frames this, not the odd outlier. */
  fitRadius: number
}

const DAY = 86_400_000

/** FNV-1a: a stable 0..1 per string. */
export function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

export function starSize(count: number): number {
  return Math.min(0.42, 0.075 + 0.042 * Math.log2(1 + Math.max(0, count)))
}

/** Recency → brightness: today 1, a month ago ~0.55, a year ago the floor. */
export function starBrightness(lastUtc: number, now: number): number {
  const days = Math.max(0, (now - lastUtc) / DAY)
  return 0.32 + 0.68 * Math.exp(-days / 45)
}

export function buildEdges(items: readonly LayoutInput[]): LayoutEdge[] {
  const index = new Map<string, number>()
  items.forEach((s, i) => index.set(s.shortId, i))
  const seen = new Map<string, LayoutEdge>()
  items.forEach((s, a) => {
    for (const to of s.links) {
      const b = index.get(to)
      if (b === undefined || b === a) continue
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const prev = seen.get(key)
      if (prev) {
        // The reverse direction was already there: one line, marked mutual.
        if (prev.a !== a) prev.both = true
      } else {
        seen.set(key, { a, b, both: false })
      }
    }
  })
  return [...seen.values()]
}

export function layoutConstellation(items: readonly LayoutInput[], now: number, opts: { iterations?: number } = {}): Layout {
  const n = items.length
  const order = items.map((_, i) => i).sort((p, q) => items[p].createdUtc - items[q].createdUtc || (items[p].uid < items[q].uid ? -1 : 1))
  const nodes: LayoutNode[] = new Array(n)
  const arms = 2
  const rMax = 1.6 + 1.15 * Math.sqrt(Math.max(1, n))
  order.forEach((idx, rank) => {
    const s = items[idx]
    const h = hash01(s.uid)
    const h2 = hash01(s.uid + '#')
    const h3 = hash01(s.uid + '%')
    // age 0 = newest … 1 = oldest
    const age = n <= 1 ? 0 : 1 - rank / (n - 1)
    const arm = Math.floor(h * arms)
    const r = 0.9 + (rMax - 0.9) * Math.pow(age, 0.85) + (h2 - 0.5) * 0.9
    const theta = arm * ((Math.PI * 2) / arms) + age * Math.PI * 2.4 + (h3 - 0.5) * 0.55
    const thickness = 0.35 + 0.65 * (1 - age)
    nodes[idx] = {
      x: Math.cos(theta) * r,
      y: (h3 - 0.5) * 1.4 * thickness + (h2 - 0.5) * 0.4,
      z: Math.sin(theta) * r,
      size: starSize(s.count),
      bright: starBrightness(s.lastUtc || s.createdUtc, now),
      hue: 0.25 + 0.5 * (1 - age) * 0.6 + 0.4 * h2
    }
  })
  const edges = buildEdges(items)
  relax(nodes, edges, opts.iterations ?? 28)
  let radius = 1
  const dists = nodes.map((p) => Math.hypot(p.x, p.y, p.z) + p.size)
  for (const d of dists) radius = Math.max(radius, d)
  dists.sort((a, b) => a - b)
  const p85 = dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.85))] : 1
  return { nodes, edges, radius, fitRadius: Math.min(radius, p85 * 1.12 + 0.5) }
}

/** Pull linked stars together, push crowded ones apart (spatial hash, O(n) per pass). */
function relax(nodes: LayoutNode[], edges: readonly LayoutEdge[], iterations: number): void {
  const n = nodes.length
  if (n < 2) return
  const cell = 0.9
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  const dz = new Float64Array(n)
  for (let it = 0; it < iterations; it++) {
    dx.fill(0)
    dy.fill(0)
    dz.fill(0)
    const cool = 1 - it / iterations
    // Springs toward a comfortable link length.
    for (const e of edges) {
      const a = nodes[e.a]
      const b = nodes[e.b]
      const vx = b.x - a.x
      const vy = b.y - a.y
      const vz = b.z - a.z
      const d = Math.hypot(vx, vy, vz) || 1e-6
      const rest = 1.4 + a.size + b.size
      const f = ((d - rest) / d) * 0.12 * cool
      dx[e.a] += vx * f
      dy[e.a] += vy * f
      dz[e.a] += vz * f
      dx[e.b] -= vx * f
      dy[e.b] -= vy * f
      dz[e.b] -= vz * f
    }
    // Local repulsion within neighbouring cells.
    const grid = new Map<string, number[]>()
    const key = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
    nodes.forEach((p, i) => {
      const k = key(p.x, p.y, p.z)
      const list = grid.get(k)
      if (list) list.push(i)
      else grid.set(k, [i])
    })
    for (let i = 0; i < n; i++) {
      const p = nodes[i]
      const cx = Math.floor(p.x / cell)
      const cy = Math.floor(p.y / cell)
      const cz = Math.floor(p.z / cell)
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) {
            const list = grid.get(`${cx + ox},${cy + oy},${cz + oz}`)
            if (!list) continue
            for (const j of list) {
              if (j <= i) continue
              const q = nodes[j]
              const vx = q.x - p.x
              const vy = q.y - p.y
              const vz = q.z - p.z
              const d = Math.hypot(vx, vy, vz) || 1e-3
              const min = 0.38 + p.size + q.size
              if (d >= min) continue
              const f = ((min - d) / d) * 0.5
              dx[i] -= vx * f
              dy[i] -= vy * f
              dz[i] -= vz * f
              dx[j] += vx * f
              dy[j] += vy * f
              dz[j] += vz * f
            }
          }
    }
    for (let i = 0; i < n; i++) {
      // Cap each step so nothing jumps across the map.
      const len = Math.hypot(dx[i], dy[i], dz[i])
      const k = len > 0.5 ? 0.5 / len : 1
      nodes[i].x += dx[i] * k
      nodes[i].y += dy[i] * k * 0.6
      nodes[i].z += dz[i] * k
    }
  }
}

// ── picking & camera (pure helpers for the page) ─────────────────────────────────────────────

/**
 * Nearest projected star under a pointer. `projected` holds 4 floats per node: screen x, y (CSS px), depth (NDC z,
 * < 1 visible) and radius in px. Returns -1 when nothing is within reach.
 */
export function pickStar(projected: Float32Array, count: number, x: number, y: number, slopPx = 8): number {
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < count; i++) {
    const o = i * 4
    const z = projected[o + 2]
    if (!(z > -1 && z < 1)) continue
    const d = Math.hypot(projected[o] - x, projected[o + 1] - y)
    const reach = Math.max(10, projected[o + 3]) + slopPx
    if (d > reach) continue
    // Prefer the closest to the pointer, then the nearer star.
    const score = d / reach + z * 0.05
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

export interface OrbitCamera {
  yaw: number
  pitch: number
  dist: number
  tx: number
  ty: number
  tz: number
}

export const PITCH_LIMIT = 1.35

export function clampCamera(c: OrbitCamera, radius: number): OrbitCamera {
  return {
    ...c,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, c.pitch)),
    dist: Math.max(2.5, Math.min(radius * 4 + 10, c.dist))
  }
}

/** A camera that frames a sphere of `radius` at the origin (fov in degrees, aspect = width/height). */
export function fitCamera(radius: number, fovDeg: number, aspect: number): OrbitCamera {
  const half = (fovDeg * Math.PI) / 360
  const fit = Math.min(Math.tan(half), Math.tan(half) * Math.max(0.3, aspect))
  // A sky of one or two stars still gets some room around it. Tall (phone) stages look down on the disc more steeply,
  // so it fills the height instead of lying as a thin band across the middle.
  const portrait = aspect < 0.85
  return { yaw: 0.6, pitch: portrait ? 0.95 : 0.42, dist: (Math.max(radius, 3.5) * (portrait ? 0.92 : 1.02)) / fit, tx: 0, ty: 0, tz: 0 }
}

/** Ease `cur` toward `goal` in place; returns true while still moving. */
export function easeCamera(cur: OrbitCamera, goal: OrbitCamera, dt: number, tau = 0.12): boolean {
  const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau)
  let moving = false
  for (const key of ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz'] as const) {
    const d = goal[key] - cur[key]
    const eps = key === 'dist' ? 0.002 : 0.0004
    if (Math.abs(d) > eps) {
      cur[key] += d * k
      moving = true
    } else cur[key] = goal[key]
  }
  return moving
}

/** Camera position for an orbit state. */
export function orbitPosition(c: OrbitCamera): [number, number, number] {
  const cp = Math.cos(c.pitch)
  return [c.tx + c.dist * cp * Math.sin(c.yaw), c.ty + c.dist * Math.sin(c.pitch), c.tz + c.dist * cp * Math.cos(c.yaw)]
}

/** Case-insensitive match on title, short id (with or without '#') or summary. */
export function matchesQuery(q: string, s: { title: string; shortId: string; summary?: string | null }): boolean {
  const t = q.trim().toLowerCase().replace(/^#/, '')
  if (!t) return false
  return s.title.toLowerCase().includes(t) || s.shortId.toLowerCase().startsWith(t) || (s.summary ?? '').toLowerCase().includes(t)
}

/**
 * Recall pulses across a map refresh (a `session.updated` during the reply reloads the map): a pulse still running
 * (started less than `durationMs` before `now`) follows its session to its new index; finished ones and sessions that
 * are gone are dropped. `prevUid(i)` is the uid at old index i, `byUid` the new indices.
 */
export function carryPulses(
  pulses: ReadonlyMap<number, number>,
  prevUid: (i: number) => string | undefined,
  byUid: ReadonlyMap<string, number>,
  now: number,
  durationMs: number
): Map<number, number> {
  const out = new Map<number, number>()
  for (const [i, at] of pulses) {
    const uid = prevUid(i)
    const j = uid === undefined ? undefined : byUid.get(uid)
    if (j !== undefined && now - at < durationMs) out.set(j, at)
  }
  return out
}
