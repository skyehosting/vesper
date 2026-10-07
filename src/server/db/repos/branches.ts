/**
 * Branches, variants and path selection (07 C3).
 *
 * - The active path is a chain of segments: [branch b0 from seq 1) [b1 from f1) … [tip from fk). Branch messages are
 *   contiguous from the branch's fork_seq (appends go to the tip at lastSeq + 1).
 * - Parent rule: a fork at seq s gets parent_branch = the branch owning s − 1 on the current path (NULL at s = 1).
 * - Variants at s = the parent's children forked at s, plus the parent's own message at s; ordered by creation
 *   (message id = global timeline order).
 * - `branch_choices (parent, fork_seq) → branch` remembers the last selection, so switching back restores the whole
 *   chain below it. A switch flips `on_path` in one transaction and recomputes `message_count` from the delta.
 */
import { VesperError } from '@shared/errors'
import type { Variant } from '@shared/types/domain'
import { id, type Db } from '../sqlite'
import type { Repos } from '../repos'
import { atomic, big, n, str, type SqlRow } from './util'

const TOP = 0n // branch_choices.parent_branch for top-level forks (seq 1)

interface Segment {
  branch: bigint
  from: number
}

export interface BranchesExtra {
  /** Seqs in [lo, hi] where a fork exists (candidates for the ‹ n/m › arrows on a page). */
  forkSeqsInRange(sessionId: bigint, lo: number, hi: number): number[]
}

export function createBranchesRepo(db: Db): Repos['branches'] & BranchesExtra {
  const session = db.prepare('SELECT last_seq FROM sessions WHERE id = ?')
  const ownerAt = db.prepare('SELECT branch_id FROM messages WHERE session_id = ? AND on_path = 1 AND seq = ?')
  const insertBranch = db.prepare('INSERT INTO branches (session_id, parent_branch, fork_seq, created_utc, reason) VALUES (?, ?, ?, ?, ?)')
  const upsertChoice = db.prepare(
    `INSERT INTO branch_choices (session_id, parent_branch, fork_seq, branch_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, parent_branch, fork_seq) DO UPDATE SET branch_id = excluded.branch_id`
  )
  const getChoice = db.prepare('SELECT branch_id FROM branch_choices WHERE session_id = ? AND parent_branch = ? AND fork_seq = ?')
  const tailVisible = db.prepare('SELECT count(*) AS c FROM messages WHERE session_id = ? AND on_path = 1 AND seq >= ? AND deleted = 0 AND hidden = 0')
  const dropTail = db.prepare('UPDATE messages SET on_path = 0 WHERE session_id = ? AND on_path = 1 AND seq >= ?')
  const tailIds = db.prepare('SELECT id FROM messages WHERE session_id = ? AND on_path = 1 AND seq >= ?')
  const afterFork = db.prepare('UPDATE sessions SET active_branch = ?, last_seq = ?, message_count = MAX(0, message_count - ?) WHERE id = ?')
  const children = db.prepare('SELECT id, reason FROM branches WHERE session_id = ? AND parent_branch = ? AND fork_seq = ?')
  const topLevel = db.prepare('SELECT id, reason FROM branches WHERE session_id = ? AND parent_branch IS NULL AND fork_seq = 1')
  const branchRow = db.prepare('SELECT * FROM branches WHERE id = ?')
  const msgAt = db.prepare('SELECT id, body, ts_utc, on_path, deleted FROM messages WHERE session_id = ? AND branch_id = ? AND seq = ?')
  const forksAfter = db.prepare('SELECT DISTINCT fork_seq FROM branches WHERE session_id = ? AND parent_branch = ? AND fork_seq > ? ORDER BY fork_seq')
  const newestChild = db.prepare('SELECT id FROM branches WHERE session_id = ? AND parent_branch = ? AND fork_seq = ? ORDER BY id DESC LIMIT 1')
  const segIds = db.prepare('SELECT id, seq, deleted, hidden FROM messages WHERE session_id = ? AND branch_id = ? AND seq >= ? AND seq < ?')
  const setOnPath = db.prepare('UPDATE messages SET on_path = 1 WHERE session_id = ? AND branch_id = ? AND seq >= ? AND seq < ?')
  const afterSelect = db.prepare('UPDATE sessions SET active_branch = ?, last_seq = ?, message_count = MAX(0, message_count + ?) WHERE id = ?')
  const msgLoc = db.prepare('SELECT session_id, branch_id, seq, on_path FROM messages WHERE id = ?')
  const forksIn = db.prepare(
    "SELECT DISTINCT fork_seq FROM branches WHERE session_id = ? AND fork_seq BETWEEN ? AND ? AND reason <> 'root' ORDER BY fork_seq"
  )

  const MAX_SEQ = BigInt(Number.MAX_SAFE_INTEGER)

  function ownerOnPath(sid: bigint, seq: number): bigint | null {
    const r = ownerAt.get(sid, BigInt(seq)) as SqlRow | undefined
    return r ? big(r.branch_id) : null
  }

  /** The parent for a fork / variant lookup at seq s, or `undefined` when s − 1 is not on the path. */
  function parentAt(sid: bigint, seq: number): bigint | null | undefined {
    if (seq <= 1) return null
    const p = ownerOnPath(sid, seq - 1)
    return p === null ? undefined : p
  }

  function hasMessageAt(sid: bigint, branch: bigint, seq: number): boolean {
    return msgAt.get(sid, branch, BigInt(seq)) !== undefined
  }

  /** Resolve the chain below (start, from), restoring the remembered choice at every later fork point. */
  function resolve(sid: bigint, start: bigint, from: number): Segment[] {
    const segs: Segment[] = []
    let cur = start
    let f = from
    for (;;) {
      segs.push({ branch: cur, from: f })
      let next: bigint | null = null
      for (const r of forksAfter.all(sid, cur, BigInt(f)) as SqlRow[]) {
        const t = n(r.fork_seq)
        const c = getChoice.get(sid, cur, BigInt(t)) as SqlRow | undefined
        let pick: bigint | null = c ? big(c.branch_id) : null
        if (pick === null && !hasMessageAt(sid, cur, t)) {
          const nc = newestChild.get(sid, cur, BigInt(t)) as SqlRow | undefined
          pick = nc ? big(nc.id) : null
        }
        if (pick !== null && pick !== cur) {
          next = pick
          f = t
          break
        }
      }
      if (next === null) return segs
      cur = next
    }
  }

  function variantsAt(sid: bigint, seq: number): Variant[] {
    const parent = parentAt(sid, seq)
    if (parent === undefined) return []
    const cands: { branch: bigint; reason: Variant['reason'] }[] = []
    if (parent === null) {
      for (const r of topLevel.all(sid) as SqlRow[]) cands.push({ branch: big(r.id), reason: str(r.reason) as Variant['reason'] })
    } else {
      // The parent's own continuation is the original version at this seq.
      cands.push({ branch: parent, reason: 'root' })
      for (const r of children.all(sid, parent, BigInt(seq)) as SqlRow[]) cands.push({ branch: big(r.id), reason: str(r.reason) as Variant['reason'] })
    }
    const found: { mid: bigint; v: Omit<Variant, 'index'> }[] = []
    for (const c of cands) {
      const m = msgAt.get(sid, c.branch, BigInt(seq)) as SqlRow | undefined
      if (!m) continue
      const deleted = n(m.deleted) !== 0
      found.push({
        mid: big(m.id),
        v: {
          branchId: Number(c.branch),
          createdUtc: n(m.ts_utc),
          preview: deleted ? '' : str(m.body).slice(0, 160),
          reason: c.reason,
          active: n(m.on_path) !== 0
        }
      })
    }
    found.sort((a, b) => (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0))
    return found.map((f, i) => ({ ...f.v, index: i + 1 }))
  }

  return {
    fork(sessionId, forkSeq, reason, now) {
      const sid = id(sessionId)
      return atomic(db, () => {
        const s = session.get(sid) as SqlRow | undefined
        if (!s) throw new VesperError('not_found')
        const lastSeq = n(s.last_seq)
        if (forkSeq < 1 || forkSeq > lastSeq) throw new VesperError('validation', { message: `Cannot fork at seq ${forkSeq}` })
        const parent = parentAt(sid, forkSeq)
        if (parent === undefined) throw new VesperError('conflict')
        const b = big(insertBranch.run(sid, parent, BigInt(forkSeq), now, reason).lastInsertRowid)
        upsertChoice.run(sid, parent ?? TOP, BigInt(forkSeq), b)
        const dropped = n((tailVisible.get(sid, BigInt(forkSeq)) as SqlRow).c)
        dropTail.run(sid, BigInt(forkSeq))
        afterFork.run(b, BigInt(forkSeq - 1), dropped, sid)
        return b
      })
    },
    variants(sessionId, seq) {
      return variantsAt(id(sessionId), seq)
    },
    select(sessionId, seq, branchId) {
      const sid = id(sessionId)
      const bid = id(branchId)
      return atomic(db, () => {
        const parent = parentAt(sid, seq)
        if (parent === undefined) throw new VesperError('not_found')
        let valid = false
        if (parent !== null && bid === parent) valid = hasMessageAt(sid, bid, seq)
        else {
          const b = branchRow.get(bid) as SqlRow | undefined
          valid =
            !!b &&
            big(b.session_id) === sid &&
            n(b.fork_seq) === seq &&
            (parent === null ? b.parent_branch === null : b.parent_branch !== null && big(b.parent_branch) === parent) &&
            hasMessageAt(sid, bid, seq)
        }
        if (!valid) throw new VesperError('not_found', { message: 'That version does not exist.' })
        upsertChoice.run(sid, parent ?? TOP, BigInt(seq), bid)

        const segs = resolve(sid, bid, seq)
        const oldIds = new Set((tailIds.all(sid, BigInt(seq)) as SqlRow[]).map((r) => big(r.id)))
        const oldVisible = n((tailVisible.get(sid, BigInt(seq)) as SqlRow).c)
        const newIds = new Set<bigint>()
        let newVisible = 0
        let lastSeq = seq - 1
        segs.forEach((sg, i) => {
          const to = i + 1 < segs.length ? BigInt(segs[i + 1].from) : MAX_SEQ
          for (const r of segIds.all(sid, sg.branch, BigInt(sg.from), to) as SqlRow[]) {
            newIds.add(big(r.id))
            if (n(r.deleted) === 0 && n(r.hidden) === 0) newVisible++
            lastSeq = Math.max(lastSeq, n(r.seq))
          }
        })
        dropTail.run(sid, BigInt(seq))
        segs.forEach((sg, i) => {
          const to = i + 1 < segs.length ? BigInt(segs[i + 1].from) : MAX_SEQ
          setOnPath.run(sid, sg.branch, BigInt(sg.from), to)
        })
        afterSelect.run(segs[segs.length - 1].branch, BigInt(lastSeq), newVisible - oldVisible, sid)
        const changed: bigint[] = []
        for (const x of oldIds) if (!newIds.has(x)) changed.push(x)
        for (const x of newIds) if (!oldIds.has(x)) changed.push(x)
        return { lastSeq, changed }
      })
    },
    locate(messageId) {
      const m = msgLoc.get(id(messageId)) as SqlRow | undefined
      if (!m) throw new VesperError('not_found')
      const sid = big(m.session_id)
      const seq = n(m.seq)
      // Ancestors of the message's branch, top-level first.
      const chain: { id: bigint; fork: number }[] = []
      let cur: bigint | null = big(m.branch_id)
      while (cur !== null) {
        const b = branchRow.get(cur) as SqlRow | undefined
        if (!b) break
        chain.unshift({ id: cur, fork: n(b.fork_seq) })
        cur = b.parent_branch === null ? null : big(b.parent_branch)
      }
      const path: { forkSeq: number; branchId: number }[] = []
      chain.forEach((b, i) => {
        path.push({ forkSeq: b.fork, branchId: Number(b.id) })
        // Stay inside this branch at its own fork points until the next link of the chain (or the message itself).
        const until = i + 1 < chain.length ? chain[i + 1].fork - 1 : seq
        for (const r of forksAfter.all(sid, b.id, BigInt(b.fork)) as SqlRow[]) {
          const t = n(r.fork_seq)
          if (t > until) break
          path.push({ forkSeq: t, branchId: Number(b.id) })
        }
      })
      path.sort((a, b) => a.forkSeq - b.forkSeq)
      return { seq, onPath: n(m.on_path) !== 0, branchPath: path }
    },
    forkSeqsInRange(sessionId, lo, hi) {
      return (forksIn.all(id(sessionId), BigInt(lo), BigInt(hi)) as SqlRow[]).map((r) => n(r.fork_seq))
    }
  }
}
