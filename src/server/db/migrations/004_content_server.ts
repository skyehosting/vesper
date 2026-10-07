/**
 * Migration 4 (content-server): the extraction outcome of an attachment (07 B6/C8). `text_state` is 'ok', 'truncated'
 * or 'failed' (NULL for images and files that have no text); `text_error` is the error code of a failed extraction
 * (timeout, crashed, archive_refused, …). A crash or timeout marks the attachment, never the server.
 * Idempotent: columns are added only when missing, so a re-run after a partial restore is harmless.
 */
import type { Db, Migration } from '../sqlite'

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
}

export const m004ContentServer: Migration = {
  version: 4,
  name: 'content_server',
  up(db: Db) {
    if (!hasColumn(db, 'attachments', 'text_state')) db.exec('ALTER TABLE attachments ADD COLUMN text_state TEXT')
    if (!hasColumn(db, 'attachments', 'text_error')) db.exec('ALTER TABLE attachments ADD COLUMN text_error TEXT')
  }
}
