/**
 * Migration 9 (Phase 4 integration, int-server): per-session token totals for `Session.tokens` (the session panel's
 * info section) — the sum of `messages.usage` of the session's AI replies, every variant included (those tokens were
 * spent). Summing on every GET would scan the whole session (07 C9: main statements are O(page)), so the totals live
 * on the session row and two triggers keep them current: a reply's usage is written once when it finishes (UPDATE),
 * imports insert rows that already carry usage (INSERT). Malformed usage JSON counts as zero (never fails a write).
 * The backfill is a one-time scan at migration time (a pre-migration backup exists, 07 C20). Idempotent.
 */
import type { Db, Migration } from '../sqlite'

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
}

/** `usage.<key>` of a row as an integer, 0 when absent or not valid JSON. */
const part = (row: 'new' | 'old' | 'm', key: string) => `(CASE WHEN json_valid(${row}.usage) THEN coalesce(json_extract(${row}.usage, '$.${key}'), 0) ELSE 0 END)`

export const m009SessionTokens: Migration = {
  version: 9,
  name: 'session_tokens',
  up(db: Db) {
    for (const c of ['tokens_in', 'tokens_out', 'tokens_cache_read']) {
      if (!hasColumn(db, 'sessions', c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`)
    }
    db.exec(`
UPDATE sessions SET
  tokens_in = (SELECT coalesce(sum(${part('m', 'in')}), 0) FROM messages m WHERE m.session_id = sessions.id AND m.usage IS NOT NULL),
  tokens_out = (SELECT coalesce(sum(${part('m', 'out')}), 0) FROM messages m WHERE m.session_id = sessions.id AND m.usage IS NOT NULL),
  tokens_cache_read = (SELECT coalesce(sum(${part('m', 'cacheRead')}), 0) FROM messages m WHERE m.session_id = sessions.id AND m.usage IS NOT NULL);
DROP TRIGGER IF EXISTS messages_usage_ai;
DROP TRIGGER IF EXISTS messages_usage_au;
CREATE TRIGGER messages_usage_ai AFTER INSERT ON messages WHEN new.usage IS NOT NULL BEGIN
  UPDATE sessions SET
    tokens_in = tokens_in + ${part('new', 'in')},
    tokens_out = tokens_out + ${part('new', 'out')},
    tokens_cache_read = tokens_cache_read + ${part('new', 'cacheRead')}
  WHERE id = new.session_id;
END;
CREATE TRIGGER messages_usage_au AFTER UPDATE OF usage ON messages WHEN new.usage IS NOT old.usage BEGIN
  UPDATE sessions SET
    tokens_in = tokens_in + ${part('new', 'in')} - ${part('old', 'in')},
    tokens_out = tokens_out + ${part('new', 'out')} - ${part('old', 'out')},
    tokens_cache_read = tokens_cache_read + ${part('new', 'cacheRead')} - ${part('old', 'cacheRead')}
  WHERE id = new.session_id;
END;
`)
  }
}
