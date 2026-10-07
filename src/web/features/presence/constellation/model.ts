/**
 * Constellation runtime model: the page (input, list, cards, data) and the scene (inside the one canvas) share this
 * module-level state. Coarse changes (data, hover, selection, search, drag) notify subscribers; per-frame data (camera
 * easing, projected screen positions) is mutated in place and announced to projection listeners only — React never
 * re-renders per frame.
 */
import type { SessionSummary } from '@shared/types/domain'
import { carryPulses, fitCamera, layoutConstellation, matchesQuery, type Layout, type OrbitCamera } from './layout.logic'

export type ManifestSession = SessionSummary & { links: string[]; linkedFrom: string[] }

export interface CNode {
  s: ManifestSession
  x: number
  y: number
  z: number
  size: number
  bright: number
  hue: number
}

export interface DragState {
  from: number
  x: number
  y: number
  over: number
}

export interface ConstellationState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: unknown
  nodes: CNode[]
  edges: Layout['edges']
  radius: number
  fitRadius: number
  byShort: Map<string, number>
  byUid: Map<string, number>
  /** Bumps when nodes/edges change (the scene rebuilds its buffers). */
  version: number
  hover: number
  selected: number
  query: string
  /** 1 = matches the search (null when no search). */
  matches: Uint8Array | null
  matchCount: number
  drag: DragState | null
  /** node index → pulse start (performance.now ms). */
  pulses: Map<number, number>
  /** The session whose reply is recalling right now (glows). */
  replying: number
}

/** Pulse length: three soft rings ≤ 1 per second (well under 3 flashes/s, 07 D9). */
export const PULSE_MS = 3000

function initial(): ConstellationState {
  return {
    status: 'idle',
    error: null,
    nodes: [],
    edges: [],
    radius: 1,
    fitRadius: 1,
    byShort: new Map(),
    byUid: new Map(),
    version: 0,
    hover: -1,
    selected: -1,
    query: '',
    matches: null,
    matchCount: 0,
    drag: null,
    pulses: new Map(),
    replying: -1
  }
}

let state: ConstellationState = initial()
const listeners = new Set<() => void>()

/** Per-frame data (not part of the React-visible state). */
export const view = {
  camera: fitCamera(10, 50, 16 / 9) as OrbitCamera,
  goal: fitCamera(10, 50, 16 / 9) as OrbitCamera,
  /** 4 floats per node: screen x, y (CSS px, relative to the stage), NDC depth, radius px. */
  projected: new Float32Array(0),
  width: 1,
  height: 1,
  /** The camera was fitted to the current data at least once. */
  fitted: false,
  fov: 50,
  /** performance.now() of the last pointer/keyboard input (the idle drift waits after it). */
  lastInput: 0,
  /** CSS px covered by panels on the right (the list) and top (the toolbar): the map centres in the rest. */
  insetRight: 0,
  insetTop: 0
}

const projListeners = new Set<() => void>()

export function getState(): ConstellationState {
  return state
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function onProjected(cb: () => void): () => void {
  projListeners.add(cb)
  return () => void projListeners.delete(cb)
}

export function projected(): void {
  for (const l of [...projListeners]) l()
}

function set(patch: Partial<ConstellationState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function setLoading(): void {
  set({ status: state.status === 'ready' ? 'ready' : 'loading', error: null })
}

export function setError(error: unknown): void {
  set({ status: 'error', error })
}

export function setData(sessions: readonly ManifestSession[], now: number): void {
  // Keep hover/selection on the same sessions across refreshes.
  const prevSel = state.selected >= 0 ? state.nodes[state.selected]?.s.uid : null
  const prevHover = state.hover >= 0 ? state.nodes[state.hover]?.s.uid : null
  const layout = layoutConstellation(
    sessions.map((s) => ({
      uid: s.uid,
      shortId: s.shortId,
      createdUtc: s.createdUtc,
      lastUtc: s.lastMessageUtc ?? s.updatedUtc ?? s.createdUtc,
      count: s.messageCount,
      private: s.private,
      links: s.links
    })),
    now
  )
  const nodes: CNode[] = sessions.map((s, i) => ({ s, ...layout.nodes[i] }))
  const byShort = new Map<string, number>()
  const byUid = new Map<string, number>()
  nodes.forEach((n, i) => {
    byShort.set(n.s.shortId, i)
    byUid.set(n.s.uid, i)
  })
  // Recall pulses still running survive a refresh (a session.updated during the reply reloads the map) on the same
  // sessions, whose indices may have moved; finished ones go.
  const pulses = carryPulses(state.pulses, (i) => state.nodes[i]?.s.uid, byUid, performance.now(), PULSE_MS)
  if (view.projected.length !== nodes.length * 4) view.projected = new Float32Array(nodes.length * 4).fill(2)
  const first = !view.fitted || Math.abs(layout.radius - state.radius) > state.radius * 0.25
  set({
    status: 'ready',
    error: null,
    nodes,
    edges: layout.edges,
    radius: layout.radius,
    fitRadius: layout.fitRadius,
    byShort,
    byUid,
    version: state.version + 1,
    selected: prevSel ? (byUid.get(prevSel) ?? -1) : -1,
    hover: prevHover ? (byUid.get(prevHover) ?? -1) : -1,
    pulses,
    ...searchPatch(state.query, nodes)
  })
  if (first) fitView(false)
}

function searchPatch(query: string, nodes: readonly CNode[]): Pick<ConstellationState, 'query' | 'matches' | 'matchCount'> {
  if (!query.trim()) return { query, matches: null, matchCount: 0 }
  const matches = new Uint8Array(nodes.length)
  let matchCount = 0
  nodes.forEach((n, i) => {
    if (matchesQuery(query, n.s)) {
      matches[i] = 1
      matchCount++
    }
  })
  return { query, matches, matchCount }
}

export function setQuery(query: string): void {
  set(searchPatch(query, state.nodes))
}

export function setHover(i: number): void {
  if (i !== state.hover) set({ hover: i })
}

export function setSelected(i: number): void {
  if (i !== state.selected) set({ selected: i })
}

export function setDrag(d: DragState | null): void {
  set({ drag: d })
}

export function setReplying(i: number): void {
  if (i !== state.replying) set({ replying: i })
}

export function pulse(indices: readonly number[], now: number): void {
  if (!indices.length) return
  const pulses = new Map(state.pulses)
  for (const i of indices) pulses.set(i, now)
  set({ pulses })
}

/** Frame the map: most stars (the opening view) or every star (`all`, the toolbar's "Fit all stars"). */
export function fitView(animate = true, all = false): void {
  const aspect = Math.max(1, view.width - view.insetRight) / Math.max(1, view.height - view.insetTop)
  const fit = fitCamera(all ? state.radius : state.fitRadius, view.fov, aspect)
  view.goal = { ...fit, yaw: view.fitted ? view.goal.yaw : fit.yaw }
  if (!animate || !view.fitted) view.camera = { ...view.goal, dist: view.goal.dist * (view.fitted ? 1 : 1.35) }
  view.fitted = true
}

/** Ease the camera to centre a star. */
export function focusNode(i: number): void {
  const n = state.nodes[i]
  if (!n) return
  view.goal = { ...view.goal, tx: n.x, ty: n.y, tz: n.z, dist: Math.min(view.goal.dist, 6 + n.size * 10) }
}

export function resetModel(): void {
  state = initial()
  view.fitted = false
  view.projected = new Float32Array(0)
  for (const l of [...listeners]) l()
}

export function modelStats(): { listeners: number; projListeners: number; nodes: number } {
  return { listeners: listeners.size, projListeners: projListeners.size, nodes: state.nodes.length }
}
