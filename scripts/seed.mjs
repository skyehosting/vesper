#!/usr/bin/env node
/**
 * Seed a large, realistic Vesper DB for performance work (BLD-13 memory gate: p95 search < 50 ms on 1M messages),
 * then optionally benchmark the memory search pipeline on it.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/seed.mjs --out <dir> [--messages 1000000] [--sessions 500]
 *       [--big 0.3] [--dim 1024] [--workers 16] [--bench 300] [--bench-only]
 *
 * - Sessions: one "big" session holding `--big` of all messages (the worst case), the rest in conversations of
 *   10–200 messages spread over the other sessions; alternating user/AI turns over ~3 years, New York time.
 * - Text: Zipf-distributed words (a real-word head plus a 20k pseudo-word tail), short user turns and long replies.
 * - Vectors: the mock Voyage embedding (tests/mocks/voyage.ts — the same function the mock server uses), int8 +
 *   sign bits in generation 1, computed on worker threads.
 * - Bench: the db.worker Engine in-process with a local query embedder (no network): index load time, then p50/p95
 *   of keyword-only and hybrid searches (no rerank) for scopes all / this (big session) / linked (4 sessions).
 * Run it on Electron's Node (node:sqlite parity with the app). Uses esbuild (bundled with electron-vite) to load the
 * TypeScript sources.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── shared deterministic text generator ────────────────────────────────────────────────────────
const HEAD = (
  'time year people way day man thing woman life child world school state family student group country problem hand part place case week ' +
  'company system program question work government number night point home water room mother area money story fact month lot right study book ' +
  'eye job word business issue side kind head house service friend father power hour game line end member law car city community name president ' +
  'team minute idea kid body information back parent face others level office door health person art war history party result change morning ' +
  'reason research girl guy moment air teacher force education foot boy age policy music market sense nation plan college interest death ' +
  'experience effect class control care field development role effort rate heart drug show leader light voice wife police mind price report ' +
  'decision son view relationship town road arm difference value building action model season society tax director position player record ' +
  'paper space ground form event official matter center couple site project activity star table need court oil situation cost industry ' +
  'figure street image phone data picture practice piece land product doctor wall patient worker news test movie north love support technology ' +
  'step baby computer type attention film tree source organization hair window evidence population site garden coffee river violin orbit ' +
  'lantern maple harbor comet pepper atlas velvet ember meadow quartz tide denver lisbon sourdough guitar concert trip mountain hiking recipe ' +
  'birthday sister brother dog cat vacation beach train flight hotel museum painting novel poem bread cheese wine tea soup salad pasta rice ' +
  'running yoga bike swim weather rain snow sun cloud winter spring summer autumn holiday budget salary rent apartment kitchen bedroom'
).split(/\s+/)
const SYL = ['ka', 'lo', 'mi', 'ren', 'tas', 'vo', 'qui', 'zel', 'dor', 'fen', 'gu', 'hal', 'jin', 'pra', 'sto', 'wex', 'yul', 'bri', 'cor', 'nev']

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeVocab() {
  const words = [...HEAD]
  const r = rng(12345)
  while (words.length < 20_000) {
    const n = 2 + Math.floor(r() * 3)
    let w = ''
    for (let i = 0; i < n; i++) w += SYL[Math.floor(r() * SYL.length)]
    words.push(w)
  }
  // Zipf (s = 1) cumulative distribution.
  const cdf = new Float64Array(words.length)
  let sum = 0
  for (let i = 0; i < words.length; i++) {
    sum += 1 / (i + 1)
    cdf[i] = sum
  }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= sum
  return { words, cdf }
}
const VOCAB = makeVocab()

function zipfWord(r) {
  const x = r()
  let lo = 0
  let hi = VOCAB.cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (VOCAB.cdf[mid] < x) lo = mid + 1
    else hi = mid
  }
  return VOCAB.words[lo]
}

/** Message i's text (role 1 = user, 0 = assistant). */
function textFor(i, user) {
  const r = rng((i * 2654435761) ^ 0x5bd1e995)
  const n = user ? 6 + Math.floor(r() * 25) : 30 + Math.floor(r() * 130)
  const out = []
  for (let k = 0; k < n; k++) {
    let w = zipfWord(r)
    if (k === 0 || (out.length && out[out.length - 1].endsWith('.'))) w = w[0].toUpperCase() + w.slice(1)
    if (r() < 0.08) w += '.'
    else if (r() < 0.05) w += ','
    out.push(w)
  }
  let s = out.join(' ')
  if (!/[.!?]$/.test(s)) s += user && r() < 0.4 ? '?' : '.'
  return s
}

// ── bundle the TypeScript bits we need ─────────────────────────────────────────────────────────
async function loadLib() {
  const { build } = require('esbuild')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-seed-'))
  const outfile = path.join(dir, 'seed-lib.cjs')
  await build({
    stdin: {
      contents: [
        "export { MIGRATIONS } from './src/server/db/migrations/index.ts'",
        "export { migrate } from './src/server/db/sqlite.ts'",
        "export { mockEmbedding, quantize } from './tests/mocks/voyage.ts'",
        "export { signBits } from './src/server/memory/engine/bitIndex.ts'",
        "export { Engine } from './src/server/memory/engine/engine.ts'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    define: { __VESPER_TEST__: 'true' },
    alias: { '@shared': path.join(root, 'src/shared'), '@server': path.join(root, 'src/server') },
    logLevel: 'silent'
  })
  return { lib: require(outfile), dir }
}

// ── worker: embeddings for chunks of messages ─────────────────────────────────────────────────
if (!isMainThread) {
  const lib = require(workerData.libFile)
  const roles = new Uint8Array(workerData.roles)
  const dim = workerData.dim
  parentPort.on('message', ({ start, end }) => {
    const n = end - start
    const vecs = new Int8Array(n * dim)
    const bits = new Uint8Array((n * dim) / 8)
    for (let i = start; i < end; i++) {
      const user = roles[i] === 1
      const text = `${user ? 'user response' : 'ai response'}: ${textFor(i, user)}`
      const q = lib.quantize(lib.mockEmbedding(text, dim), 'int8')
      vecs.set(q, (i - start) * dim)
      bits.set(lib.signBits(q), ((i - start) * dim) / 8)
    }
    parentPort.postMessage({ start, end, vecs, bits }, [vecs.buffer, bits.buffer])
  })
} else {
  await main()
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

async function main() {
  const out = arg('out', null)
  if (!out || out === true) {
    console.error('usage: seed.mjs --out <dir> [--messages N] [--sessions N] [--big 0.3] [--dim 1024] [--workers N] [--bench N] [--bench-only]')
    process.exit(2)
  }
  const N = Number(arg('messages', 1_000_000))
  const S = Number(arg('sessions', 500))
  const big = Number(arg('big', 0.3))
  const dim = Number(arg('dim', 1024))
  const workers = Number(arg('workers', Math.max(2, Math.min(16, os.cpus().length - 2))))
  const bench = Number(arg('bench', 0))
  const benchOnly = arg('bench-only', false) === true
  const { lib, dir: libDir } = await loadLib()
  const file = path.join(path.resolve(out), 'vesper.db')
  try {
    if (!benchOnly) await seed({ lib, file, N, S, big, dim, workers, libFile: path.join(libDir, 'seed-lib.cjs') })
    if (bench) await runBench({ lib, file, dim, runs: bench })
  } finally {
    fs.rmSync(libDir, { recursive: true, force: true })
  }
}

async function seed({ lib, file, N, S, big, dim, workers, libFile }) {
  const { DatabaseSync } = require('node:sqlite')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  const t0 = performance.now()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = OFF')
  db.exec('PRAGMA cache_size = -262144')
  lib.migrate(db, lib.MIGRATIONS)

  // Timeline: who says what, when, in which session.
  const sessionOf = new Int32Array(N)
  const seqOf = new Int32Array(N)
  const rolesBuf = new SharedArrayBuffer(N)
  const roles = new Uint8Array(rolesBuf)
  const nextSeq = new Int32Array(S + 1)
  const r = rng(99)
  let cur = 2
  let left = 0
  for (let i = 0; i < N; i++) {
    let s
    if (r() < big) s = 1
    else {
      if (left <= 0) {
        cur = 2 + Math.floor(r() * Math.max(1, S - 1))
        left = 10 + Math.floor(r() * 190)
      }
      s = cur
      left--
    }
    const seq = ++nextSeq[s]
    sessionOf[i] = s
    seqOf[i] = seq
    roles[i] = seq % 2 === 1 ? 1 : 0
  }
  const start = Date.UTC(2023, 9, 1)
  const span = 3 * 365 * 86_400_000
  const tsOf = (i) => start + Math.floor((i * span) / N)

  const now = Date.now()
  db.exec('BEGIN')
  const insS = db.prepare(
    "INSERT INTO sessions (id, uid, short_id, title, title_auto, created_utc, updated_utc, last_message_utc, active_branch, message_count, last_seq) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)"
  )
  const insB = db.prepare("INSERT INTO branches (id, session_id, parent_branch, fork_seq, created_utc, reason) VALUES (?, ?, NULL, 1, ?, 'root')")
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  for (let s = 1; s <= S; s++) {
    let short = ''
    let x = s * 7919 + 104729
    for (let k = 0; k < 6; k++) {
      short += ALPHA[x % 32]
      x = Math.floor(x / 32) + k * 13
    }
    insB.run(BigInt(s), BigInt(s), start)
    insS.run(BigInt(s), `seed-${s}`, short, s === 1 ? 'The big one' : `Seeded conversation ${s}`, start, now, start + span, BigInt(s), nextSeq[s], nextSeq[s])
  }
  db.exec(
    `INSERT INTO memory_generations (gen, family, model, dim, created_utc, state) VALUES (1, 'voyage-4', 'voyage-4-lite', ${dim}, ${start}, 'active')`
  )
  db.exec('COMMIT')

  const insM = db.prepare(
    `INSERT INTO messages (id, uid, session_id, branch_id, seq, role, tag, body, ts_utc, tz_offset_min, tz_name, device, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, -240, 'America/New_York', 'seed', 'complete')`
  )
  const insV = db.prepare('INSERT INTO vectors (message_id, chunk, gen, model, dim, v) VALUES (?, 0, 1, ?, ?, ?)')
  const insBits = db.prepare('INSERT INTO vector_bits (message_id, chunk, gen, session_id, ts_utc, bits) VALUES (?, 0, 1, ?, ?, ?)')

  const CHUNK = 10_000
  const pool = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url), { workerData: { libFile, roles: rolesBuf, dim } }))
  const done = new Map()
  let nextChunk = 0
  let written = 0
  const tasks = []
  for (let s = 0; s < N; s += CHUNK) tasks.push({ start: s, end: Math.min(N, s + CHUNK) })
  let ti = 0
  await new Promise((resolve, reject) => {
    const feed = (w) => {
      if (ti < tasks.length) w.postMessage(tasks[ti++])
    }
    for (const w of pool) {
      w.on('error', reject)
      w.on('message', (res) => {
        done.set(res.start, res)
        feed(w)
        while (done.has(nextChunk)) {
          const c = done.get(nextChunk)
          done.delete(nextChunk)
          db.exec('BEGIN')
          for (let i = c.start; i < c.end; i++) {
            const id = BigInt(i + 1)
            const user = roles[i] === 1
            const ts = tsOf(i)
            insM.run(id, `seed-m-${i + 1}`, BigInt(sessionOf[i]), BigInt(sessionOf[i]), BigInt(seqOf[i]), user ? 'user' : 'assistant', user ? 'user response' : 'ai response', textFor(i, user), ts)
            const o = (i - c.start) * dim
            insV.run(id, 'voyage-4-lite', BigInt(dim), new Uint8Array(c.vecs.buffer, o, dim))
            insBits.run(id, BigInt(sessionOf[i]), ts, c.bits.subarray(o / 8, (o + dim) / 8))
          }
          db.exec('COMMIT')
          written = c.end
          nextChunk = c.end
          if (written % 100_000 === 0 || written === N) process.stdout.write(`seeded ${written} / ${N} (${Math.round((performance.now() - t0) / 1000)} s)\n`)
          if (written === N) resolve()
        }
      })
      feed(w)
    }
  })
  await Promise.all(pool.map((w) => w.terminate()))
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('PRAGMA optimize')
  db.close()
  const size = fs.statSync(file).size
  console.log(JSON.stringify({ seeded: { messages: N, sessions: S, dim, seconds: Math.round((performance.now() - t0) / 100) / 10, fileMB: Math.round(size / 1048576) } }))
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100
}

async function runBench({ lib, file, dim, runs }) {
  const { DatabaseSync } = require('node:sqlite')
  const ro = new DatabaseSync(file, { readOnly: true })
  const sessionIds = ro.prepare('SELECT id FROM sessions WHERE deleted_utc IS NULL AND private = 0').all().map((r) => Number(r.id))
  const counts = ro.prepare('SELECT count(*) AS c FROM messages').get()
  ro.close()
  const posted = []
  const client = () => ({
    embed: async (r) => ({ vectors: r.input.map((t) => Float32Array.from(lib.mockEmbedding(t, r.dim))), tokens: 1 }),
    rerank: async (r) => ({ results: r.documents.map((_, index) => ({ index, score: 0.5 })), tokens: 1 })
  })
  const engine = new lib.Engine((m) => posted.push(m), { client })
  engine.handle({ t: 'init', dbFile: file, config: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', key: 'local', embedModel: 'voyage-4-lite', rerankModel: 'none', dim, tier: 'tier3' } })
  const tl = performance.now()
  await engine.loadIndex()
  const loadMs = Math.round(performance.now() - tl)
  // Bits shards + parallel arrays, as the index accounts them (engine.stats is the worker's own leak counter).
  const indexMB = Math.round(engine.stats(false).sizes.indexBytes / 1048576)
  const indexed = engine.status().indexed
  const r = rng(4242)
  const pick = () => {
    const n = 2 + Math.floor(r() * 2)
    const ws = []
    for (let k = 0; k < n; k++) ws.push(VOCAB.words[20 + Math.floor(r() * 3000)])
    return ws.join(' ')
  }
  const linked = [2, 3, 4, 5].filter((s) => sessionIds.includes(s))
  const scopes = { all: sessionIds, this: [1], linked }
  const results = {}
  for (const [name, ids] of Object.entries(scopes)) {
    for (const voyage of [false, true]) {
      const times = []
      const kw = []
      const vec = []
      const scan = []
      for (let i = 0; i < runs; i++) {
        const t = performance.now()
        const res = await engine.search({ query: pick(), sessionIds: ids, after: null, before: null, voyage, rerank: false, deadline: Date.now() + 5000, limit: 32 })
        times.push(performance.now() - t)
        kw.push(res.timings.keyword ?? 0)
        if (res.timings.vector !== undefined) vec.push(res.timings.vector)
        if (res.timings.scan !== undefined) scan.push(res.timings.scan)
      }
      results[`${name}/${voyage ? 'hybrid' : 'keyword'}`] = {
        p50: pct(times, 50),
        p95: pct(times, 95),
        max: pct(times, 100),
        keywordP95: pct(kw, 95),
        ...(vec.length ? { vectorP95: pct(vec, 95), scanP95: pct(scan, 95) } : {})
      }
    }
  }
  // The UI search box (GET /api/search): newest-first pages and bm25 relevance over every session.
  for (const order of ['recent', 'relevance']) {
    const times = []
    for (let i = 0; i < runs; i++) {
      const t = performance.now()
      engine.fts({ query: pick(), sessionIds, beforeId: null, order, limit: 30, includeOffPath: true })
      times.push(performance.now() - t)
    }
    results[`ui/${order}`] = { p50: pct(times, 50), p95: pct(times, 95), max: pct(times, 100) }
  }
  await engine.close()
  console.log(
    JSON.stringify(
      {
        bench: {
          messages: Number(counts.c),
          dim,
          runs,
          indexLoadMs: loadMs,
          indexed,
          indexMB,
          note: 'search = keyword leg (+ local query embedding + bit scan + int8 rescore for hybrid) + fusion; no network, no rerank',
          results
        }
      },
      null,
      2
    )
  )
}
