/**
 * In-memory coarse vector index (07 C10, research 02 §5.3 / 03 §3.5): one sign bit per dimension per vector,
 * plus parallel arrays (message id, session id, ts, flags) for filtering. Bits live in fixed-size shards (64K entries,
 * 8 MiB at 1024 dims) so growth never copies the whole index and no buffer gets near Electron's ~2 GiB cap.
 *
 * Search is two-stage: Hamming distance over the first 256 bits (a Matryoshka prefix: the sign bits of a prefix are
 * the prefix's sign bits) for every live entry, a histogram picks the threshold for the best `coarseK`, those get the
 * full-width distance, and the best `k` slots go to int8 rescoring (done by the caller, from SQLite).
 * Deletes only set a flag; `compact()` rebuilds the arrays once more than 10 % are dead.
 */

export const FLAG_DEAD = 1
export const FLAG_OFF_PATH = 2

const SHARD_BITS = 16
const SHARD = 1 << SHARD_BITS
const SHARD_MASK = SHARD - 1
/** Words (32 bits) used by the coarse pass: 256 bits. */
const COARSE_WORDS = 8

export interface ScanFilter {
  /** allowed[sessionId] !== 0 → the session may be searched; null = all sessions. */
  allowed: Uint8Array | null
  after: number | null
  before: number | null
}

/** Bits set in every 16-bit value (64 KiB, built once). */
const POP16 = (() => {
  const t = new Uint8Array(65536)
  for (let i = 1; i < 65536; i++) t[i] = (i & 1) + t[i >> 1]
  return t
})()

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

/** Pack int8 sign bits (bit = v > 0), byte j bit (7 − b) = dimension 8j + b — the vector_bits BLOB layout. */
export function signBits(v: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(v.length / 8))
  for (let i = 0; i < v.length; i++) if (v[i] > 0) out[i >> 3] |= 0x80 >> (i & 7)
  return out
}

export class BitIndex {
  readonly words: number
  private shards: Uint32Array[] = []
  private cap = 0
  private n = 0
  private deadCount = 0
  msgIds = new Float64Array(0)
  sessionIds = new Int32Array(0)
  ts = new Float64Array(0)
  flags = new Uint8Array(0)
  /** Scratch for a scan (reused between scans; sized to `n`): candidate slots and their coarse distances. */
  private cand = new Int32Array(0)
  private dist = new Uint16Array(0)
  /** Largest session id seen (the allowed-sessions bitmap must cover it). */
  private maxSid = 0

  constructor(readonly dim: number) {
    if (dim % 32 !== 0) throw new Error('dim must be a multiple of 32')
    this.words = dim / 32
  }

  get size(): number {
    return this.n
  }

  get live(): number {
    return this.n - this.deadCount
  }

  get dead(): number {
    return this.deadCount
  }

  /** Approximate bytes held (status / leak tests). */
  get bytes(): number {
    return this.shards.length * SHARD * this.words * 4 + this.cap * (8 + 4 + 8 + 1) + this.dist.byteLength + this.cand.byteLength
  }

  private grow(min: number): void {
    if (min <= this.cap) return
    const cap = Math.max(1024, this.cap * 2, min)
    const m = new Float64Array(cap)
    m.set(this.msgIds.subarray(0, this.n))
    const s = new Int32Array(cap)
    s.set(this.sessionIds.subarray(0, this.n))
    const t = new Float64Array(cap)
    t.set(this.ts.subarray(0, this.n))
    const f = new Uint8Array(cap)
    f.set(this.flags.subarray(0, this.n))
    this.msgIds = m
    this.sessionIds = s
    this.ts = t
    this.flags = f
    this.cap = cap
  }

  /** Append one vector's bits (`bytes.length` must be dim / 8). */
  add(messageId: number, sessionId: number, tsUtc: number, bits: Uint8Array, flags = 0): number {
    if (bits.length !== this.words * 4) throw new Error(`bits length ${bits.length} ≠ ${this.words * 4}`)
    const i = this.n
    this.grow(i + 1)
    const shard = i >>> SHARD_BITS
    while (this.shards.length <= shard) this.shards.push(new Uint32Array(SHARD * this.words))
    const sh = this.shards[shard]
    new Uint8Array(sh.buffer, sh.byteOffset + (i & SHARD_MASK) * this.words * 4, this.words * 4).set(bits)
    this.msgIds[i] = messageId
    this.sessionIds[i] = sessionId
    this.ts[i] = tsUtc
    this.flags[i] = flags
    if (sessionId > this.maxSid) this.maxSid = sessionId
    if (flags & FLAG_DEAD) this.deadCount++
    this.n = i + 1
    return i
  }

  /** Set or clear `flag` on every entry of these messages. Returns how many entries changed. */
  flagMessages(ids: ReadonlySet<number>, flag: number, on: boolean): number {
    if (!ids.size) return 0
    let changed = 0
    for (let i = 0; i < this.n; i++) {
      if (!ids.has(this.msgIds[i])) continue
      const before = this.flags[i]
      const after = on ? before | flag : before & ~flag
      if (before === after) continue
      if (flag & FLAG_DEAD) this.deadCount += on ? 1 : -1
      this.flags[i] = after
      changed++
    }
    return changed
  }

  /** Mark every entry of a session dead (its vectors were deleted). */
  killSession(sessionId: number): number {
    let changed = 0
    for (let i = 0; i < this.n; i++) {
      if (this.sessionIds[i] !== sessionId || this.flags[i] & FLAG_DEAD) continue
      this.flags[i] |= FLAG_DEAD
      this.deadCount++
      changed++
    }
    return changed
  }

  /** Message ids indexed for a session (live entries). */
  messagesOfSession(sessionId: number): number[] {
    const out: number[] = []
    for (let i = 0; i < this.n; i++) if (this.sessionIds[i] === sessionId && !(this.flags[i] & FLAG_DEAD)) out.push(this.msgIds[i])
    return out
  }

  /** Does a live entry exist for this message? (O(n); used by tests and rare paths only.) */
  has(messageId: number): boolean {
    for (let i = 0; i < this.n; i++) if (this.msgIds[i] === messageId && !(this.flags[i] & FLAG_DEAD)) return true
    return false
  }

  /** Rebuild without dead entries when more than `ratio` of the slots are dead (07 C10 tombstone compaction). */
  compactIfNeeded(ratio = 0.1): boolean {
    if (this.n === 0 || this.deadCount / this.n <= ratio) return false
    this.compact()
    return true
  }

  compact(): void {
    const keep: number[] = []
    for (let i = 0; i < this.n; i++) if (!(this.flags[i] & FLAG_DEAD)) keep.push(i)
    const next = new BitIndex(this.dim)
    next.grow(keep.length)
    const bytes = this.words * 4
    for (const i of keep) {
      const sh = this.shards[i >>> SHARD_BITS]
      const bits = new Uint8Array(sh.buffer, sh.byteOffset + (i & SHARD_MASK) * bytes, bytes)
      next.add(this.msgIds[i], this.sessionIds[i], this.ts[i], bits, this.flags[i])
    }
    this.shards = next.shards
    this.cap = next.cap
    this.n = next.n
    this.deadCount = 0
    this.msgIds = next.msgIds
    this.sessionIds = next.sessionIds
    this.ts = next.ts
    this.flags = next.flags
    this.maxSid = next.maxSid
    this.dist = new Uint16Array(0)
    this.cand = new Int32Array(0)
  }

  clear(): void {
    this.shards = []
    this.cap = 0
    this.n = 0
    this.deadCount = 0
    this.msgIds = new Float64Array(0)
    this.sessionIds = new Int32Array(0)
    this.ts = new Float64Array(0)
    this.flags = new Uint8Array(0)
    this.dist = new Uint16Array(0)
    this.cand = new Int32Array(0)
    this.maxSid = 0
  }

  /**
   * Best `k` slots by Hamming distance to `q` (query sign bits as bytes, same layout as `add`), among live, on-path
   * entries that pass the filter. Returns slot indexes, nearest first.
   *
   * Tuned on 1M entries (this PC): a branchless filter pass into a candidate list, then an unrolled 16-bit-table
   * popcount over the candidates — ~13–15 ms whatever the scope, where a branchy single loop took 15–26 ms.
   */
  scan(qBytes: Uint8Array, filter: ScanFilter, k: number, coarseK = Math.max(2000, k * 5)): number[] {
    const W = this.words
    if (qBytes.length !== W * 4) throw new Error('query bits have the wrong length')
    const q = new Uint32Array(W)
    new Uint8Array(q.buffer).set(qBytes)
    const n = this.n
    if (this.cand.length < n) {
      this.cand = new Int32Array(Math.max(n, 1024))
      this.dist = new Uint16Array(Math.max(n, 1024))
    }
    const cand = this.cand
    const dist = this.dist
    const flags = this.flags
    const sids = this.sessionIds
    const ts = this.ts
    const lo = filter.after ?? -Infinity
    const hi = filter.before ?? Infinity
    // 1. Filter (branchless: the session test is unpredictable, mispredictions cost more than the extra stores).
    let m = 0
    let allowed = filter.allowed
    if (allowed !== null && allowed.length <= this.maxSid) {
      const grown = new Uint8Array(this.maxSid + 1)
      grown.set(allowed)
      allowed = grown
    }
    if (allowed !== null) {
      for (let i = 0; i < n; i++) {
        cand[m] = i
        const t = ts[i]
        m += allowed[sids[i]] & ((flags[i] - 1) >>> 31) & (t >= lo ? 1 : 0) & (t < hi ? 1 : 0)
      }
    } else {
      for (let i = 0; i < n; i++) {
        cand[m] = i
        const t = ts[i]
        m += ((flags[i] - 1) >>> 31) & (t >= lo ? 1 : 0) & (t < hi ? 1 : 0)
      }
    }
    if (m === 0) return []
    // 2. Coarse distance over the first 256 bits (or all of them for smaller dims).
    const cw = Math.min(COARSE_WORDS, W)
    const hist = new Uint32Array(cw * 32 + 1)
    const P = POP16
    if (cw === COARSE_WORDS) {
      const [q0, q1, q2, q3, q4, q5, q6, q7] = q
      for (let j = 0; j < m; j++) {
        const i = cand[j]
        const sh = this.shards[i >>> SHARD_BITS]
        const o = (i & SHARD_MASK) * W
        let x = sh[o] ^ q0
        let d = P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 1] ^ q1
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 2] ^ q2
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 3] ^ q3
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 4] ^ q4
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 5] ^ q5
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 6] ^ q6
        d += P[x & 0xffff] + P[x >>> 16]
        x = sh[o + 7] ^ q7
        d += P[x & 0xffff] + P[x >>> 16]
        dist[j] = d
        hist[d]++
      }
    } else {
      for (let j = 0; j < m; j++) {
        const i = cand[j]
        const sh = this.shards[i >>> SHARD_BITS]
        const o = (i & SHARD_MASK) * W
        let d = 0
        for (let w = 0; w < cw; w++) d += popcount(sh[o + w] ^ q[w])
        dist[j] = d
        hist[d]++
      }
    }
    // 3. Threshold: the smallest distance T such that at least coarseK entries are ≤ T.
    let T = hist.length - 1
    let cum = 0
    for (let d = 0; d < hist.length; d++) {
      cum += hist[d]
      if (cum >= coarseK) {
        T = d
        break
      }
    }
    // 4. Full-width distance for the pool; ties at the threshold are capped so a flat distribution can't blow it up.
    const pool: number[] = []
    const fullD: number[] = []
    let atT = 0
    const tieCap = Math.max(coarseK, coarseK * 2 - (cum - hist[T]))
    for (let j = 0; j < m; j++) {
      const d = dist[j]
      if (d > T) continue
      if (d === T && ++atT > tieCap) continue
      const i = cand[j]
      let full = d
      if (W > cw) {
        const sh = this.shards[i >>> SHARD_BITS]
        const o = (i & SHARD_MASK) * W
        for (let w = cw; w < W; w++) full += popcount(sh[o + w] ^ q[w])
      }
      pool.push(i)
      fullD.push(full)
    }
    const order = pool.map((_, j) => j)
    order.sort((a, b) => fullD[a] - fullD[b] || pool[b] - pool[a])
    return order.slice(0, k).map((j) => pool[j])
  }
}
