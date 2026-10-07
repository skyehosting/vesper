import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '@server/db/sqlite'
import { MIGRATIONS } from '@server/db/migrations'
import { createRepos, type ReposImpl } from '@server/db/repos/index'
import type { NewMessage, SessionRow } from '@server/db/repos'

let db: Db
let repos: ReposImpl
let now = 1_760_000_000_000

function fresh(): void {
  db = openDb(':memory:')
  migrate(db, MIGRATIONS)
  repos = createRepos(db)
}

function msg(s: SessionRow, role: 'user' | 'assistant', body: string, extra: Partial<NewMessage> = {}) {
  now += 1000
  return repos.messages.append({ sessionId: s.id, role, body, tsUtc: now, tzOffsetMin: 120, tzName: 'Europe/Berlin', device: 'test', ...extra })
}

function conversation(s: SessionRow, n: number) {
  const out = []
  for (let i = 1; i <= n; i++) out.push(msg(s, i % 2 ? 'user' : 'assistant', `message ${i}`))
  return out
}

const fts = (q: string): number[] =>
  (db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid').all(q) as { rowid: number }[]).map((r) => Number(r.rowid))

beforeEach(fresh)

describe('migration 1', () => {
  it('creates every table and is idempotent', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    for (const t of [
      'sessions',
      'session_links',
      'branches',
      'branch_choices',
      'messages',
      'messages_fts',
      'transcript',
      'epochs',
      'vectors',
      'vector_bits',
      'memory_generations',
      'embed_queue',
      'memory_injections',
      'prompts',
      'facts',
      'attachments',
      'attachment_text',
      'attachment_fts',
      'devices',
      'auth_log',
      'kv'
    ])
      expect(names).toContain(t)
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('tone')
    expect(cols).toEqual(expect.arrayContaining(['hidden', 'spoken_chars', 'interrupted', 'meta', 'on_path']))
    expect((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)).not.toContain('temporary')
    expect(migrate(db, MIGRATIONS)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)))
  })

  it('binds ids and seqs as integers', () => {
    const s = repos.sessions.create({ now })
    msg(s, 'user', 'hi')
    expect(db.prepare('SELECT typeof(seq) t, typeof(session_id) u, typeof(branch_id) b FROM messages').get()).toEqual({ t: 'integer', u: 'integer', b: 'integer' })
  })
})

describe('sessions', () => {
  it('creates with a root branch, short id and lists newest first with a cursor', () => {
    const a = repos.sessions.create({ title: 'Alpha', now: now++ })
    const b = repos.sessions.create({ title: 'Beta', now: now++ })
    const c = repos.sessions.create({ title: 'Gamma', now: now++ })
    expect(a.shortId).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(a.activeBranch).not.toBeNull()
    expect(a.titleAuto).toBe(false)
    const p1 = repos.sessions.list({ limit: 2 })
    expect(p1.items.map((x) => x.title)).toEqual(['Gamma', 'Beta'])
    const p2 = repos.sessions.list({ limit: 2, cursor: p1.next! })
    expect(p2.items.map((x) => x.title)).toEqual(['Alpha'])
    expect(p2.next).toBeNull()
    expect(repos.sessions.list({ limit: 10, q: 'amm' }).items.map((x) => x.uid)).toEqual([c.uid])
    expect(repos.sessions.list({ limit: 10, q: `#${b.shortId.toLowerCase()}` }).items.map((x) => x.uid)).toEqual([b.uid])
    repos.sessions.softDelete(b.id, now)
    expect(repos.sessions.list({ limit: 10 }).items).toHaveLength(2)
    expect(repos.sessions.list({ limit: 10, filter: 'trash' }).items.map((x) => x.uid)).toEqual([b.uid])
  })

  it('accessibleIds: this / linked / all, private and deleted excluded', () => {
    const me = repos.sessions.create({ now })
    const linked = repos.sessions.create({ now })
    const linkedPrivate = repos.sessions.create({ now, private: true })
    const linkedDeleted = repos.sessions.create({ now })
    const other = repos.sessions.create({ now })
    const otherPrivate = repos.sessions.create({ now, private: true })
    for (const t of [linked, linkedPrivate, linkedDeleted]) repos.sessions.addLink(me.id, t.id, now)
    repos.sessions.softDelete(linkedDeleted.id, now)
    const set = (ids: bigint[]) => new Set(ids.map(String))
    expect(set(repos.sessions.accessibleIds(me.id, 'this'))).toEqual(set([me.id]))
    expect(set(repos.sessions.accessibleIds(me.id, 'linked'))).toEqual(set([me.id, linked.id]))
    expect(set(repos.sessions.accessibleIds(me.id, 'all'))).toEqual(set([me.id, linked.id, other.id]))
    // A private session still searches itself.
    expect(set(repos.sessions.accessibleIds(otherPrivate.id, 'all'))).toEqual(set([otherPrivate.id, me.id, linked.id, other.id]))
    expect(repos.sessions.accessibleIds(linkedDeleted.id, 'this')).toEqual([])
    expect(repos.sessions.links(me.id).map((s) => s.uid).sort()).toEqual([linked.uid, linkedPrivate.uid].sort())
    expect(repos.sessions.linkedFrom(linked.id).map((s) => s.uid)).toEqual([me.uid])
  })
})

describe('messages paging', () => {
  it('pages latest / before / after / around with tombstones', () => {
    const s = repos.sessions.create({ now })
    const all = conversation(s, 25)
    repos.messages.softDelete(all[9].id) // seq 10 becomes a tombstone
    expect(repos.sessions.byId(s.id)!.messageCount).toBe(24)

    const latest = repos.messages.page(s.id, { mode: 'latest', limit: 10 })
    expect(latest.items.map((m) => m.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
    expect(latest).toMatchObject({ loSeq: 16, hiSeq: 25, lastSeq: 25, hasBefore: true, hasAfter: false })

    const before = repos.messages.page(s.id, { mode: 'before', seq: 16, limit: 10 })
    expect(before.items.map((m) => m.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(before.items.find((m) => m.seq === 10)!.deleted).toBe(true)

    const first = repos.messages.page(s.id, { mode: 'before', seq: 6, limit: 10 })
    expect(first.items.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(first.hasBefore).toBe(false)

    const after = repos.messages.page(s.id, { mode: 'after', seq: 20, limit: 10 })
    expect(after.items.map((m) => m.seq)).toEqual([21, 22, 23, 24, 25])
    expect(after.hasAfter).toBe(false)

    const around = repos.messages.page(s.id, { mode: 'around', seq: 10, limit: 6 })
    expect(around.items.map((m) => m.seq)).toEqual([7, 8, 9, 10, 11, 12])
    expect(around).toMatchObject({ hasBefore: true, hasAfter: true })

    const empty = repos.messages.page(repos.sessions.create({ now }).id, { mode: 'latest', limit: 10 })
    expect(empty).toMatchObject({ items: [], lastSeq: 0, hasBefore: false, hasAfter: false })
  })

  it('keeps deleted messages out of FTS and restores them', () => {
    const s = repos.sessions.create({ now })
    const [a, b] = [msg(s, 'user', 'the quick zebra'), msg(s, 'assistant', 'a zebra answer')]
    expect(fts('zebra')).toEqual([Number(a.id), Number(b.id)])
    repos.messages.softDelete(a.id)
    expect(fts('zebra')).toEqual([Number(b.id)])
    repos.messages.restore(a.id)
    expect(fts('zebra')).toEqual([Number(a.id), Number(b.id)])
    repos.messages.update(b.id, { body: 'now about giraffes' })
    expect(fts('zebra')).toEqual([Number(a.id)])
    expect(fts('giraffes')).toEqual([Number(b.id)])
    const h = msg(s, 'user', 'hidden zebra opener', { hidden: true })
    expect(fts('zebra')).not.toContain(Number(h.id))
    expect(repos.sessions.byId(s.id)!.messageCount).toBe(2)
  })

  it('timeline samples span the whole path', () => {
    const s = repos.sessions.create({ now })
    conversation(s, 100)
    const t = repos.messages.timeline(s.id, 5)
    expect(t.map((x) => x.seq)).toEqual([1, 26, 51, 75, 100])
    expect(t.every((x, i) => i === 0 || x.tsUtc > t[i - 1].tsUtc)).toBe(true)
    expect(repos.messages.timeline(s.id, 500)).toHaveLength(100)
    expect(repos.messages.timeline(repos.sessions.create({ now }).id, 10)).toEqual([])
  })

  it('tail, range and previousOnPath follow the path', () => {
    const s = repos.sessions.create({ now })
    conversation(s, 10)
    expect(repos.messages.tail(s.id, 3).map((m) => m.seq)).toEqual([8, 9, 10])
    expect(repos.messages.tail(s.id, 3, { beforeSeq: 5 }).map((m) => m.seq)).toEqual([2, 3, 4])
    expect(repos.messages.range(s.id, 9, 10).map((m) => m.seq)).toEqual([9, 10])
    expect(repos.messages.previousOnPath(s.id, 4)!.seq).toBe(3)
    expect(repos.messages.previousOnPath(s.id, 1)).toBeNull()
  })
})

describe('branches (07 C3)', () => {
  it('regenerate creates variants; select flips the path and restores choices', () => {
    const s = repos.sessions.create({ now })
    const [u1, a1, u2, a2] = conversation(s, 4)
    void u1
    void a1
    void u2
    // Regenerate the reply at seq 4.
    const b = repos.branches.fork(s.id, 4, 'regenerate', now)
    expect(repos.sessions.byId(s.id)).toMatchObject({ lastSeq: 3, messageCount: 3, activeBranch: b })
    const a2b = msg(s, 'assistant', 'second answer')
    expect(a2b.seq).toBe(4)
    expect(repos.messages.byId(a2.id)!.onPath).toBe(false)
    let v = repos.branches.variants(s.id, 4)
    expect(v.map((x) => [x.index, x.reason, x.active])).toEqual([
      [1, 'root', false],
      [2, 'regenerate', true]
    ])
    // Continue on the new branch, then switch back to the original reply.
    msg(s, 'user', 'follow up')
    msg(s, 'assistant', 'follow up answer')
    expect(repos.sessions.byId(s.id)!.lastSeq).toBe(6)
    const r = repos.branches.select(s.id, 4, BigInt(v[0].branchId))
    expect(r.lastSeq).toBe(4)
    expect(r.changed).toHaveLength(4) // a2 on; a2b, seq5, seq6 off
    expect(repos.sessions.byId(s.id)).toMatchObject({ lastSeq: 4, messageCount: 4 })
    expect(repos.messages.page(s.id, { mode: 'latest', limit: 10 }).items.map((m) => m.body)).toEqual(['message 1', 'message 2', 'message 3', 'message 4'])
    // Switching to the regenerated variant restores its whole continuation.
    v = repos.branches.variants(s.id, 4)
    expect(repos.branches.select(s.id, 4, BigInt(v[1].branchId)).lastSeq).toBe(6)
    expect(repos.messages.page(s.id, { mode: 'latest', limit: 10 }).items.map((m) => m.body).slice(3)).toEqual([
      'second answer',
      'follow up',
      'follow up answer'
    ])
    expect(repos.sessions.byId(s.id)!.messageCount).toBe(6)
    expect(() => repos.branches.select(s.id, 4, 999n)).toThrow()
  })

  it('edits of the first message are top-level variants; nested choices are remembered', () => {
    const s = repos.sessions.create({ now })
    conversation(s, 4)
    const root = repos.sessions.byId(s.id)!.activeBranch!
    // Edit message 1 → a new top-level branch.
    const e = repos.branches.fork(s.id, 1, 'edit', now)
    msg(s, 'user', 'edited first')
    msg(s, 'assistant', 'edited reply')
    // Inside the edit branch regenerate seq 2 twice.
    const r1 = repos.branches.fork(s.id, 2, 'regenerate', now)
    msg(s, 'assistant', 'regen 1')
    const r2 = repos.branches.fork(s.id, 2, 'regenerate', now)
    msg(s, 'assistant', 'regen 2')
    const top = repos.branches.variants(s.id, 1)
    expect(top.map((x) => [x.branchId, x.reason])).toEqual([
      [Number(root), 'root'],
      [Number(e), 'edit']
    ])
    expect(repos.branches.variants(s.id, 2).map((x) => [x.branchId, x.active])).toEqual([
      [Number(e), false],
      [Number(r1), false],
      [Number(r2), true]
    ])
    // Back to the original first message, then to the edit: the nested choice (r2) comes back.
    expect(repos.branches.select(s.id, 1, root).lastSeq).toBe(4)
    expect(repos.branches.select(s.id, 1, e).lastSeq).toBe(2)
    expect(repos.messages.page(s.id, { mode: 'latest', limit: 5 }).items.map((m) => m.body)).toEqual(['edited first', 'regen 2'])

    // locate a message on the original branch → the choices that put it back on the path.
    const orig3 = db.prepare('SELECT id FROM messages WHERE branch_id = ? AND seq = 3').get(root) as { id: number }
    const loc = repos.branches.locate(BigInt(orig3.id))
    expect(loc).toMatchObject({ seq: 3, onPath: false, branchPath: [{ forkSeq: 1, branchId: Number(root) }] })
    for (const step of loc.branchPath) repos.branches.select(s.id, step.forkSeq, BigInt(step.branchId))
    expect(repos.messages.byId(BigInt(orig3.id))!.onPath).toBe(true)

    // locate regen 1 (nested): select edit at 1, then r1 at 2.
    const regen1 = db.prepare("SELECT id FROM messages WHERE body = 'regen 1'").get() as { id: number }
    const loc2 = repos.branches.locate(BigInt(regen1.id))
    expect(loc2.branchPath).toEqual([
      { forkSeq: 1, branchId: Number(e) },
      { forkSeq: 2, branchId: Number(r1) }
    ])
    for (const step of loc2.branchPath) repos.branches.select(s.id, step.forkSeq, BigInt(step.branchId))
    expect(repos.messages.byId(BigInt(regen1.id))!.onPath).toBe(true)
    expect(repos.sessions.byId(s.id)!.lastSeq).toBe(2)
  })

  it('1,000 regenerations: the page query still uses the partial index and stays < 2 ms', () => {
    const s = repos.sessions.create({ now })
    conversation(s, 400)
    for (let i = 0; i < 1000; i++) {
      repos.branches.fork(s.id, 400, 'regenerate', now)
      msg(s, 'assistant', `regenerated ${i}`)
    }
    expect(repos.branches.variants(s.id, 400)).toHaveLength(1001)
    const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE session_id = ? AND on_path = 1 AND seq < ? ORDER BY seq DESC LIMIT ?').all(s.id, 401n, 100n) as {
      detail: string
    }[])
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toMatch(/USING INDEX messages_path/)
    const times: number[] = []
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      const p = repos.messages.page(s.id, { mode: 'latest', limit: 100 })
      times.push(performance.now() - t0)
      expect(p.items).toHaveLength(100)
      expect(p.items[99].body).toBe('regenerated 999')
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(2)
  })
})

describe('transcript and epochs', () => {
  it('stores blocks deterministically and replays the epoch on the active path', () => {
    const s = repos.sessions.create({ now })
    const [u1, a1] = conversation(s, 2)
    repos.transcript.append({ sessionId: s.id, messageId: u1.id, part: 0, role: 'user', blocks: [{ t: 'text', text: '[Now: x]\nhi' }], provider: null, model: null, createdUtc: now })
    repos.transcript.append({ sessionId: s.id, messageId: a1.id, part: 0, role: 'assistant', blocks: [{ text: 'yo', t: 'text' }], provider: 'p', model: 'm', createdUtc: now })
    const stored = db.prepare('SELECT blocks, bytes FROM transcript WHERE message_id = ?').get(a1.id) as { blocks: string; bytes: number }
    expect(stored.blocks).toBe('[{"t":"text","text":"yo"}]')
    expect(stored.bytes).toBe(stored.blocks.length)
    const e0 = repos.epochs.create({
      sessionId: s.id,
      branchId: s.activeBranch!,
      startMessageId: 0n,
      systemJson: '[]',
      toolsJson: '[]',
      protocolsHash: 'h',
      toolsVersion: 1,
      toolMode: 'native',
      recap: null,
      thinkingStripBefore: null,
      now
    })
    expect(repos.epochs.current(s.id)!.id).toBe(e0.id)
    expect(repos.transcript.forEpoch(e0).map((t) => t.messageId)).toEqual([u1.id, a1.id])
    // An epoch starting at a message that is later switched off the path stops being current.
    const [u2] = [msg(s, 'user', 'q2')]
    const e1 = repos.epochs.create({ ...e0, startMessageId: u2.id, recap: 'r', now })
    expect(repos.epochs.current(s.id)!.id).toBe(e1.id)
    repos.branches.fork(s.id, 3, 'edit', now)
    expect(repos.epochs.current(s.id)!.id).toBe(e0.id)
    expect(repos.epochs.update(e1.id, { recapDraft: 'draft' }).recapDraft).toBe('draft')
  })
})

describe('devices, kv, prompts', () => {
  it('round-trips the small tables', () => {
    repos.devices.create({ id: 'd1', name: 'Desk', kind: 'desktop', listener: 'loopback', tokenHash: 'h1', pending: false, now, ip: null, userAgent: null })
    repos.devices.create({ id: 'd2', name: 'Desk2', kind: 'desktop', listener: 'loopback', tokenHash: 'h2', pending: false, now, ip: null, userAgent: null })
    repos.devices.revokeKind('desktop', now)
    expect(repos.devices.byTokenHash('h1')!.revokedUtc).toBe(now)
    repos.kv.set('a', { x: 1 })
    expect(repos.kv.get<{ x: number }>('a')).toEqual({ x: 1 })
    repos.prompts.create('One', 'body', now)
    expect(() => repos.prompts.create('One', 'other', now)).toThrow(/already exists/)
  })
})
