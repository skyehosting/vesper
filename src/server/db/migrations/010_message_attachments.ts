/**
 * Migration 10 (Phase 4c, fix-memory-privacy F72): which messages reference which attachment, so text found in
 * `attachment_fts` (07 C8) leads back to the messages that carry the file — the search page and memory_search then
 * find words inside attachments, scope-clamped like message hits. `messages.attachments` is JSON, so without this
 * table finding the messages of a sha would scan every message (07 C9: main-thread statements stay O(page)).
 * Kept current by triggers on messages (insert, attachments update, delete); malformed JSON references nothing and
 * never fails a write. The backfill is a one-time scan at migration time (a pre-migration backup exists, 07 C20).
 * Idempotent.
 */
import type { Db, Migration } from '../sqlite'

/** `json_each` over a row's attachments, or over nothing when the JSON is malformed. */
const each = (row: 'new' | 'm') => `json_each(CASE WHEN json_valid(${row}.attachments) THEN ${row}.attachments ELSE '[]' END)`

export function backfillMessageAttachments(db: Db): void {
  db.exec(`
INSERT OR IGNORE INTO message_attachments (sha, message_id)
  SELECT json_extract(j.value, '$.sha'), m.id FROM messages m, ${each('m')} j
   WHERE m.attachments <> '[]' AND json_type(j.value, '$.sha') = 'text';`)
}

export const m010MessageAttachments: Migration = {
  version: 10,
  name: 'message_attachments',
  up(db: Db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS message_attachments (
  sha TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (sha, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments (message_id);
DROP TRIGGER IF EXISTS messages_attachments_ai;
DROP TRIGGER IF EXISTS messages_attachments_au;
DROP TRIGGER IF EXISTS messages_attachments_ad;
CREATE TRIGGER messages_attachments_ai AFTER INSERT ON messages WHEN new.attachments <> '[]' BEGIN
  INSERT OR IGNORE INTO message_attachments (sha, message_id)
    SELECT json_extract(j.value, '$.sha'), new.id FROM ${each('new')} j WHERE json_type(j.value, '$.sha') = 'text';
END;
CREATE TRIGGER messages_attachments_au AFTER UPDATE OF attachments ON messages WHEN new.attachments IS NOT old.attachments BEGIN
  DELETE FROM message_attachments WHERE message_id = old.id;
  INSERT OR IGNORE INTO message_attachments (sha, message_id)
    SELECT json_extract(j.value, '$.sha'), new.id FROM ${each('new')} j WHERE json_type(j.value, '$.sha') = 'text';
END;
CREATE TRIGGER messages_attachments_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_attachments WHERE message_id = old.id;
END;`)
    backfillMessageAttachments(db)
  }
}
