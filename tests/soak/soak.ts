/**
 * Soak / leak gates (07 D14, research LEAK-1 in docs/critique/performance-ux.md): shared measurement for the long runs.
 *
 *   renderer  CDP HeapProfiler.collectGarbage (twice) → Runtime.getHeapUsage (used) + Memory.getDOMCounters (nodes,
 *             jsEventListeners, documents); a getContext wrapper (WebGL contexts) and a createObjectURL/revokeObjectURL
 *             wrapper (blob URLs outstanding), installed before any app code;
 *   server    GET /api/test/leaks: heap after a full GC, active handles by type, hub / engine / speech / STT map sizes;
 *   end       WAL file ≤ 64 MB and no ERROR-level line in the server's log (`finish()`).
 *
 * A gate passes when the end value is within its threshold of the post-warm-up value AND the trend over the second
 * half of the run is flat (projected growth over that half ≤ half the threshold). Every run writes its numbers to
 * test-results/soak-results/<name>.json (outside PW_OUT, which Playwright empties) and prints a table; the release
 * numbers are recorded in docs/05-TESTING.md §Soak.
 *
 * SOAK_SCALE (default 1 = the full LEAK-1 table) scales every cycle count and duration, e.g. 0.05 for a smoke run.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type CDPSession, type Page } from '@playwright/test'
import type { Api, TestServer } from '../e2e/launch'
import { ROOT, sameOriginHeaders } from '../e2e/launch'
import { rawRequest } from '../e2e/http'

export const SCALE = Math.max(0.001, Number(process.env.SOAK_SCALE ?? '1') || 1)

/** A cycle count from the table, scaled (at least `min`). */
export function cycles(n: number, min = 5): number {
  return Math.max(min, Math.round(n * SCALE))
}

export const RESULTS_DIR = path.join(ROOT, 'test-results', 'soak-results')

// ── renderer ────────────────────────────────────────────────────────────────────────────────

/** Counters installed before the app loads: WebGL contexts (07 D5) and blob URLs outstanding (LEAK-1). */
export async function installPageCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __soak?: { gl: number; glCanvases: WeakSet<HTMLCanvasElement>; blobs: Set<string>; blobsMade: number } }
    const box = { gl: 0, glCanvases: new WeakSet<HTMLCanvasElement>(), blobs: new Set<string>(), blobsMade: 0 }
    w.__soak = box
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest)
      if (ctx && /webgl/.test(type) && !box.glCanvases.has(this)) {
        box.glCanvases.add(this)
        box.gl++
      }
      return ctx
    } as typeof getContext
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (o: Blob | MediaSource): string => {
      const u = create(o)
      box.blobs.add(u)
      box.blobsMade++
      return u
    }
    URL.revokeObjectURL = (u: string): void => {
      box.blobs.delete(u)
      revoke(u)
    }
  })
}

export interface PageCounters {
  /** Canvases that ever obtained a WebGL context. */
  glContexts: number
  /** Blob URLs created and not revoked. */
  blobs: number
  blobsMade: number
}

export async function pageCounters(page: Page): Promise<PageCounters> {
  return page.evaluate(() => {
    const b = (window as unknown as { __soak?: { gl: number; blobs: Set<string>; blobsMade: number } }).__soak
    return { glContexts: b?.gl ?? -1, blobs: b?.blobs.size ?? -1, blobsMade: b?.blobsMade ?? -1 }
  })
}

export interface RendererSample {
  heapMB: number
  nodes: number
  listeners: number
  documents: number
}

const cdps = new WeakMap<Page, CDPSession>()

async function cdpOf(page: Page): Promise<CDPSession> {
  let c = cdps.get(page)
  if (!c) {
    c = await page.context().newCDPSession(page)
    cdps.set(page, c)
  }
  return c
}

/** Renderer heap and DOM counters after two full GCs (CDP). */
export async function renderer(page: Page): Promise<RendererSample> {
  const c = await cdpOf(page)
  await c.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(50)
  await c.send('HeapProfiler.collectGarbage')
  const heap = await c.send('Runtime.getHeapUsage')
  const dom = (await c.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
  return { heapMB: round(heap.usedSize / 1048576), nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents }
}

// ── server ──────────────────────────────────────────────────────────────────────────────────

export interface ServerLeaks {
  gc: boolean
  heapUsedMB: number
  externalMB: number
  arrayBuffersMB: number
  rssMB: number
  resources: Record<string, number>
  hub: { clients: number; subscriptions: number; rings: number } | null
  engine: { active: number; starting: number; background: number; controllers: number; timers: number; linkedListeners: number; sinkWatchers: number; temporaryChats: number } | null
  speech: { jobs: number; listsInFlight: number; prewarming: number; recent: number; samples: number } | null
  auth: { limiterBuckets: number; pairingCodes: number; scryptQueue: number } | null
  wintts: { running: boolean; pid: number | undefined; pending: number; spawned: number; idleTimer: boolean } | null
  stt: { mics: number; byMic: number; earlyFrames: number; cloudJobs: number; alive: boolean; process: { sessions: number; vads: number; bufferedSamples: number; rssMB: number; loaded: string | null } | null } | null
}

export async function server(url: string): Promise<ServerLeaks> {
  const r = await rawRequest(url, { method: 'GET', path: '/api/test/leaks', headers: sameOriginHeaders(url, ''), timeoutMs: 60_000 })
  expect(r.status, r.text).toBe(200)
  const j = r.json as ServerLeaks
  expect(j.gc, 'the server could not run a full GC').toBe(true)
  return j
}

/** Active handles that matter for leaks (sockets, timers, file handles), summed. */
export function handles(l: ServerLeaks): number {
  return Object.entries(l.resources)
    .filter(([k]) => k !== 'TTYWrap')
    .reduce((n, [, v]) => n + v, 0)
}

// ── gates ───────────────────────────────────────────────────────────────────────────────────

export interface Series {
  name: string
  unit: string
  /** One value per sample, in order; index 0 is the post-warm-up baseline. */
  values: number[]
  /** Allowed growth of the end value over the baseline. */
  threshold: number
}

export interface GateResult {
  name: string
  unit: string
  base: number
  end: number
  max: number
  growth: number
  /** Least-squares growth projected over the second half of the run. */
  trend: number
  threshold: number
  pass: boolean
}

export function gate(s: Series): GateResult {
  const v = s.values
  const base = v[0]
  const end = v[v.length - 1]
  const half = v.slice(Math.floor(v.length / 2))
  let trend = 0
  if (half.length >= 3) {
    const n = half.length
    const mx = (n - 1) / 2
    const my = half.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    half.forEach((y, x) => {
      num += (x - mx) * (y - my)
      den += (x - mx) ** 2
    })
    trend = den ? (num / den) * (n - 1) : 0
  }
  const growth = end - base
  return { name: s.name, unit: s.unit, base: round(base), end: round(end), max: round(Math.max(...v)), growth: round(growth), trend: round(trend), threshold: s.threshold, pass: growth <= s.threshold && trend <= s.threshold / 2 }
}

export interface SoakReport {
  scenario: string
  scale: number
  startedAt: string
  durationSec: number
  cycles: Record<string, number>
  gates: GateResult[]
  /** Exact-value checks (counters back to baseline / zero): name → { value, limit }. */
  checks: Record<string, { value: number; limit: number; pass: boolean; atLeast?: boolean }>
  notes: string[]
}

export class Recorder {
  readonly report: SoakReport
  private readonly t0 = Date.now()
  constructor(scenario: string) {
    this.report = { scenario, scale: SCALE, startedAt: new Date().toISOString(), durationSec: 0, cycles: {}, gates: [], checks: {}, notes: [] }
  }

  cycles(name: string, n: number): void {
    this.report.cycles[name] = n
  }

  gate(s: Series): GateResult {
    const g = gate(s)
    this.report.gates.push(g)
    return g
  }

  /** value ≤ limit. */
  check(name: string, value: number, limit: number): void {
    this.report.checks[name] = { value, limit, pass: value <= limit }
  }

  /** value ≥ min (the scenario really ran). */
  atLeast(name: string, value: number, min: number): void {
    this.report.checks[name] = { value, limit: min, pass: value >= min, atLeast: true }
  }

  note(text: string): void {
    this.report.notes.push(text)
  }

  /** Write the report, print it, then fail on any gate or check that did not pass. */
  done(): void {
    this.report.durationSec = Math.round((Date.now() - this.t0) / 1000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    fs.writeFileSync(path.join(RESULTS_DIR, `${this.report.scenario}.json`), JSON.stringify(this.report, null, 2))
    const lines = [`── soak: ${this.report.scenario} (scale ${SCALE}, ${this.report.durationSec} s) ${JSON.stringify(this.report.cycles)}`]
    for (const g of this.report.gates)
      lines.push(`${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(34)} base ${g.base} → end ${g.end} ${g.unit} (growth ${g.growth}, trend ${g.trend}, max ${g.max}; limit +${g.threshold})`)
    for (const [k, c] of Object.entries(this.report.checks)) lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${k.padEnd(34)} ${c.value} (${c.atLeast ? '≥' : '≤'} ${c.limit})`)
    for (const n of this.report.notes) lines.push(`note  ${n}`)
    console.log(lines.join('\n'))
    const failed = [...this.report.gates.filter((g) => !g.pass).map((g) => `${g.name}: +${g.growth} ${g.unit} (trend ${g.trend}) > +${g.threshold}`), ...Object.entries(this.report.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.value} ${c.atLeast ? '<' : '>'} ${c.limit}`)]
    expect(failed, failed.join('\n')).toEqual([])
  }
}

// ── end of every soak ───────────────────────────────────────────────────────────────────────

/** WAL ≤ 64 MB; no ERROR-level line in the server log (LEAK-1 "End of every soak"). */
export async function finish(rec: Recorder, s: { dataDir: string; localDir: string; browser?: Browser }, o: { allowErrors?: RegExp[] } = {}): Promise<void> {
  const walMB = (): number => {
    let wal = 0
    for (const f of walk(s.dataDir)) if (f.endsWith('-wal')) wal = Math.max(wal, fs.statSync(f).size)
    return round(wal / 1048576)
  }
  let wal = walMB()
  if (wal > 64 && s.browser) {
    // By design (07 C9, data/checkpoint.ts) a WAL over 64 MB is truncated once nobody is looking at Vesper (the
    // watcher looks every minute): leave, like the owner eventually does, and give it two looks.
    const inUse = wal
    for (const c of s.browser.contexts()) for (const p of c.pages()) await p.close().catch(() => undefined)
    const deadline = Date.now() + 150_000
    while (wal > 64 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000))
      wal = walMB()
    }
    rec.note(`WAL while the soak was looking: ${inUse} MB; after the page closed (idle): ${wal} MB`)
  }
  rec.check('WAL file (MB, once idle)', wal, 64)
  const allow = o.allowErrors ?? []
  const errors: string[] = []
  for (const f of walk(s.localDir).filter((x) => /vesper(\.\d+)?\.log$/.test(x))) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"level":"error"')) continue
      if (!allow.some((re) => re.test(line))) errors.push(line.slice(0, 300))
    }
  }
  if (errors.length) rec.note(`ERROR log lines:\n${errors.slice(0, 10).join('\n')}`)
  rec.check('ERROR-level log lines', errors.length, 0)
}

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * Private working set (Task Manager's "Memory") per pid, in MB, from the Windows performance counters (a read-only
 * CIM query). Empty when unavailable (not Windows, counters disabled).
 */
export function privateWorkingSets(pids: number[]): Record<number, number> {
  if (process.platform !== 'win32' || !pids.length) return {}
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { @(${pids.join(',')}) -contains $_.IDProcess } | ForEach-Object { "$($_.IDProcess) $($_.WorkingSetPrivate)" }`],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    )
    const r: Record<number, number> = {}
    for (const line of out.trim().split(String.fromCharCode(10))) {
      const [pid, bytes] = line.trim().split(' ')
      if (pid && bytes) r[Number(pid)] = Number(bytes) / 1048576
    }
    return r
  } catch {
    return {}
  }
}

export function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Settle: wait until the page reports ready (no request in flight, nothing loading). */
export async function settle(s: Pick<TestServer, 'waitReady' | 'page'>, ms = 300): Promise<void> {
  await s.waitReady()
  await s.page.waitForTimeout(ms)
}

/**
 * Pin game mode off (07 D3 `performance.gameMode`): with 'auto', a fullscreen game on this PC would make the Star
 * static, unload voice models and hold work mid-soak, so the numbers would depend on what the owner is doing.
 * Needs a desktop device's Api.
 */
export async function steady(api: Api): Promise<void> {
  const r = await api('PATCH', '/api/settings', { performance: { gameMode: 'off' } })
  expect(r.status, r.text).toBe(200)
}
