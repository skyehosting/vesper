/** The simple tables: prompts, facts, attachments, devices, auth log, kv, embed queue. */
import { VesperError } from '@shared/errors'
import type { AttachmentRef, Fact, Prompt } from '@shared/types/domain'
import { id, type Db } from '../sqlite'
import type { Repos } from '../repos'
import { bool, n, nOrNull, str, strOrNull, type SqlRow } from './util'

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message)

function promptFromRow(r: SqlRow): Prompt {
  return { id: n(r.id), name: str(r.name), body: str(r.body), createdUtc: n(r.created_utc), updatedUtc: n(r.updated_utc) }
}

export function createPromptsRepo(db: Db): Repos['prompts'] {
  const get = (pid: number): Prompt => {
    const r = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id(pid)) as SqlRow | undefined
    if (!r) throw new VesperError('not_found')
    return promptFromRow(r)
  }
  return {
    list: () => (db.prepare('SELECT * FROM prompts ORDER BY name COLLATE NOCASE').all() as SqlRow[]).map(promptFromRow),
    create(name, body, now) {
      try {
        const res = db.prepare('INSERT INTO prompts (name, body, created_utc, updated_utc) VALUES (?, ?, ?, ?)').run(name, body, now, now)
        return get(Number(res.lastInsertRowid))
      } catch (e) {
        if (isUnique(e)) throw new VesperError('conflict', { message: 'A prompt with that name already exists.' })
        throw e
      }
    },
    update(pid, p, now) {
      const cur = get(pid)
      try {
        db.prepare('UPDATE prompts SET name = ?, body = ?, updated_utc = ? WHERE id = ?').run(p.name ?? cur.name, p.body ?? cur.body, now, id(pid))
      } catch (e) {
        if (isUnique(e)) throw new VesperError('conflict', { message: 'A prompt with that name already exists.' })
        throw e
      }
      return get(pid)
    },
    delete(pid) {
      db.prepare('DELETE FROM prompts WHERE id = ?').run(id(pid))
    }
  }
}

export function createFactsRepo(db: Db): Repos['facts'] {
  const from = (r: SqlRow): Fact => ({ id: n(r.id), text: str(r.text), createdUtc: n(r.created_utc), updatedUtc: n(r.updated_utc) })
  const get = (fid: number): Fact => {
    const r = db.prepare('SELECT * FROM facts WHERE id = ?').get(id(fid)) as SqlRow | undefined
    if (!r) throw new VesperError('not_found')
    return from(r)
  }
  return {
    list: () => (db.prepare('SELECT * FROM facts ORDER BY id').all() as SqlRow[]).map(from),
    create(text, now) {
      const res = db.prepare('INSERT INTO facts (text, created_utc, updated_utc) VALUES (?, ?, ?)').run(text, now, now)
      return get(Number(res.lastInsertRowid))
    },
    update(fid, text, now) {
      get(fid)
      db.prepare('UPDATE facts SET text = ?, updated_utc = ? WHERE id = ?').run(text, now, id(fid))
      return get(fid)
    },
    delete(fid) {
      db.prepare('DELETE FROM facts WHERE id = ?').run(id(fid))
    }
  }
}

export function createAttachmentsRepo(db: Db): Repos['attachments'] {
  return {
    upsert(a) {
      // Content-addressed: the first metadata wins (same bytes = same attachment).
      db.prepare(
        `INSERT INTO attachments (sha, name, mime, size, kind, width, height, text_chars, created_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sha) DO UPDATE SET text_chars = COALESCE(excluded.text_chars, attachments.text_chars)`
      ).run(a.sha, a.name, a.mime, a.size, a.kind, a.width ?? null, a.height ?? null, a.textChars ?? null, a.createdUtc)
    },
    get(sha) {
      const r = db.prepare('SELECT * FROM attachments WHERE sha = ?').get(sha) as SqlRow | undefined
      if (!r) return null
      const out: AttachmentRef & { createdUtc: number } = {
        sha: str(r.sha),
        name: str(r.name),
        mime: str(r.mime),
        size: n(r.size),
        kind: str(r.kind) as AttachmentRef['kind'],
        createdUtc: n(r.created_utc)
      }
      const w = nOrNull(r.width)
      const h = nOrNull(r.height)
      const tc = nOrNull(r.text_chars)
      if (w !== null) out.width = w
      if (h !== null) out.height = h
      if (tc !== null) out.textChars = tc
      return out
    },
    setText(sha, extractor, text) {
      db.prepare(
        `INSERT INTO attachment_text (sha, extractor, text, chars) VALUES (?, ?, ?, ?)
         ON CONFLICT (sha) DO UPDATE SET extractor = excluded.extractor, text = excluded.text, chars = excluded.chars`
      ).run(sha, extractor, text, text.length)
      db.prepare('UPDATE attachments SET text_chars = ? WHERE sha = ?').run(text.length, sha)
    },
    text(sha) {
      const r = db.prepare('SELECT text, chars, extractor FROM attachment_text WHERE sha = ?').get(sha) as SqlRow | undefined
      return r ? { text: str(r.text), chars: n(r.chars), extractor: str(r.extractor) } : null
    }
  }
}

type DeviceKind = 'desktop' | 'browser' | 'paired'
type ListenerName = 'loopback' | 'lan' | 'tailnet'

export function createDevicesRepo(db: Db): Repos['devices'] {
  return {
    create(d) {
      db.prepare(
        `INSERT INTO devices (id, name, kind, listener, pending, token_hash, created_utc, last_seen_utc, last_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(d.id, d.name, d.kind, d.listener, d.pending ? 1 : 0, d.tokenHash, d.now, d.now, d.ip, d.userAgent)
    },
    byId(id) {
      const r = db.prepare('SELECT id, name, kind, listener, pending, revoked_utc FROM devices WHERE id = ?').get(id) as SqlRow | undefined
      if (!r) return null
      return { id: str(r.id), name: str(r.name), kind: str(r.kind) as DeviceKind, listener: str(r.listener) as ListenerName, pending: bool(r.pending), revokedUtc: nOrNull(r.revoked_utc) }
    },
    byTokenHash(hash) {
      const r = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash) as SqlRow | undefined
      if (!r) return null
      return {
        id: str(r.id),
        name: str(r.name),
        kind: str(r.kind) as DeviceKind,
        listener: str(r.listener) as ListenerName,
        pending: bool(r.pending),
        revokedUtc: nOrNull(r.revoked_utc),
        createdUtc: n(r.created_utc),
        lastSeenUtc: nOrNull(r.last_seen_utc),
        sudoUntilUtc: nOrNull(r.sudo_until_utc)
      }
    },
    list() {
      return (db.prepare('SELECT * FROM devices ORDER BY created_utc').all() as SqlRow[]).map((r) => ({
        id: str(r.id),
        name: str(r.name),
        kind: str(r.kind) as DeviceKind,
        listener: str(r.listener) as ListenerName,
        createdUtc: n(r.created_utc),
        lastSeenUtc: nOrNull(r.last_seen_utc),
        lastIp: strOrNull(r.last_ip),
        userAgent: strOrNull(r.user_agent),
        pending: bool(r.pending),
        revokedUtc: nOrNull(r.revoked_utc)
      }))
    },
    touch(did, now, ip) {
      db.prepare('UPDATE devices SET last_seen_utc = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?').run(now, ip, did)
    },
    setSudo(did, untilUtc) {
      db.prepare('UPDATE devices SET sudo_until_utc = ? WHERE id = ?').run(untilUtc, did)
    },
    approve(did) {
      db.prepare('UPDATE devices SET pending = 0 WHERE id = ?').run(did)
    },
    revoke(did, now) {
      db.prepare('UPDATE devices SET revoked_utc = ? WHERE id = ? AND revoked_utc IS NULL').run(now, did)
    },
    revokeKind(kind, now) {
      db.prepare('UPDATE devices SET revoked_utc = ? WHERE kind = ? AND revoked_utc IS NULL').run(now, kind)
    },
    revokeAllExcept(did, now) {
      db.prepare('UPDATE devices SET revoked_utc = ? WHERE id <> ? AND revoked_utc IS NULL').run(now, did)
    }
  }
}

export function createAuthLogRepo(db: Db): Repos['authLog'] {
  return {
    add(e) {
      db.prepare('INSERT INTO auth_log (ts_utc, event, ip, detail) VALUES (?, ?, ?, ?)').run(e.now, e.event, e.ip, e.detail)
    },
    list(limit) {
      return (db.prepare('SELECT * FROM auth_log ORDER BY id DESC LIMIT ?').all(BigInt(Math.max(1, limit))) as SqlRow[]).map((r) => ({
        tsUtc: n(r.ts_utc),
        event: str(r.event),
        ip: strOrNull(r.ip),
        detail: strOrNull(r.detail)
      }))
    },
    prune(keep) {
      const r = db.prepare('DELETE FROM auth_log WHERE id <= (SELECT id FROM auth_log ORDER BY id DESC LIMIT 1 OFFSET ?)').run(BigInt(Math.max(0, keep)))
      return Number(r.changes)
    }
  }
}

export function createKvRepo(db: Db): Repos['kv'] {
  return {
    get<T = unknown>(k: string): T | null {
      const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as SqlRow | undefined
      if (!r) return null
      try {
        return JSON.parse(str(r.v)) as T
      } catch {
        return null
      }
    },
    set(k, v) {
      db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v ?? null))
    },
    delete(k) {
      db.prepare('DELETE FROM kv WHERE k = ?').run(k)
    }
  }
}

export function createEmbedQueueRepo(db: Db): Repos['embedQueue'] {
  const stmt = db.prepare('INSERT OR IGNORE INTO embed_queue (message_id) VALUES (?)')
  return {
    enqueue(messageId) {
      stmt.run(id(messageId))
    }
  }
}

export function createMemoryInjectionsRepo(db: Db): Repos['memoryInjections'] {
  const insert = db.prepare('INSERT INTO memory_injections (session_id, message_id, turn_message_id) VALUES (?, ?, ?)')
  return {
    add(sessionId, messageId, turnMessageId) {
      insert.run(id(sessionId), id(messageId), id(turnMessageId))
    }
  }
}
