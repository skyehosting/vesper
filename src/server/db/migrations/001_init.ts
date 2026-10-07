/**
 * Migration 1: every table of 03 §1 as amended by 07 (B2 devices, B9 no `temporary` column — temporary chats never
 * touch SQLite, C1/C4/C5 epochs, C3 branch paging, C8 attachment text, C10 vector generations, A3 no `tone`).
 *
 * FTS rules (07 C3, B9): only rows with `deleted = 0 AND hidden = 0` are in `messages_fts`; the triggers fire on INSERT,
 * DELETE and `UPDATE OF body, deleted` only — never on `on_path`, which flips in bulk on a variant switch. An
 * external-content FTS5 table must be told the exact old values on delete, so the index condition is repeated in
 * every trigger.
 */
import type { Db, Migration } from '../sqlite'

const SQL = /* sql */ `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  short_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  title_auto INTEGER NOT NULL DEFAULT 1,
  created_utc INTEGER NOT NULL,
  updated_utc INTEGER NOT NULL,
  last_message_utc INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_utc INTEGER,
  private INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT 'inherit' CHECK (memory IN ('inherit','on','off')),
  memory_scope TEXT NOT NULL DEFAULT 'inherit' CHECK (memory_scope IN ('inherit','this','linked','all')),
  system_prompt TEXT NOT NULL DEFAULT '',
  prompt_id INTEGER,
  llm_profile TEXT,
  model TEXT,
  voice TEXT,
  tool_mode TEXT CHECK (tool_mode IS NULL OR tool_mode IN ('native','text')),
  active_branch INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  summary_utc INTEGER,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX sessions_recent ON sessions (updated_utc, id);

-- Directional: "from may recall to" (links are not transitive, 07 C18).
CREATE TABLE session_links (
  from_session INTEGER NOT NULL,
  to_session INTEGER NOT NULL,
  created_utc INTEGER NOT NULL,
  PRIMARY KEY (from_session, to_session)
) WITHOUT ROWID;
CREATE INDEX session_links_to ON session_links (to_session, from_session);

-- A branch = a session's messages from fork_seq onward (07 C3). parent_branch = the branch owning fork_seq - 1 on the
-- path the fork was made from; NULL only for top-level branches (fork_seq 1).
CREATE TABLE branches (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  parent_branch INTEGER,
  fork_seq INTEGER NOT NULL,
  created_utc INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('root','edit','regenerate'))
);
CREATE INDEX branches_parent ON branches (session_id, parent_branch, fork_seq);

-- The last-selected variant per fork point (replaces branches.active_child). parent_branch 0 = top level.
CREATE TABLE branch_choices (
  session_id INTEGER NOT NULL,
  parent_branch INTEGER NOT NULL,
  fork_seq INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  PRIMARY KEY (session_id, parent_branch, fork_seq)
) WITHOUT ROWID;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,                     -- global timeline order
  uid TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  tag TEXT NOT NULL CHECK (tag IN ('user response','ai response')),
  body TEXT NOT NULL,
  ts_utc INTEGER NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  tz_name TEXT,
  device TEXT,
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','streaming','stopped','error')),
  error TEXT,
  provider TEXT,
  model TEXT,
  usage TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  on_path INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  spoken_chars INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE (session_id, branch_id, seq)
);
-- Active-path pages are plain keyset scans on this partial index (07 C3). UNIQUE also guards the invariant that the
-- path has exactly one message per seq.
CREATE UNIQUE INDEX messages_path ON messages (session_id, seq) WHERE on_path = 1;
CREATE INDEX messages_time ON messages (ts_utc);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  body, content = 'messages', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO messages_fts (messages_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.deleted = 0 AND new.hidden = 0 BEGIN
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.deleted = 0 AND old.hidden = 0 BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF body, deleted ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) SELECT 'delete', old.id, old.body WHERE old.deleted = 0 AND old.hidden = 0;
  INSERT INTO messages_fts (rowid, body) SELECT new.id, new.body WHERE new.deleted = 0 AND new.hidden = 0;
END;

-- The wire log, replayed byte-for-byte (03 §1.2). Never exported, searched, embedded or logged (07 A3).
CREATE TABLE transcript (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  part INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  blocks TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  created_utc INTEGER NOT NULL,
  UNIQUE (message_id, part)
);
CREATE INDEX transcript_session ON transcript (session_id, id);

-- 07 C1/C4/C5. start_message_id 0 = from the first message (the epoch made at session creation).
CREATE TABLE epochs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  start_message_id INTEGER NOT NULL,
  system_json TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '[]',
  protocols_hash TEXT NOT NULL,
  tools_version INTEGER NOT NULL,
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('native','text')),
  recap TEXT,
  recap_draft TEXT,
  thinking_strip_before INTEGER,
  created_utc INTEGER NOT NULL
);
CREATE INDEX epochs_session ON epochs (session_id, id);

-- Memory (07 C9/C10): written by db.worker only, except INSERT into embed_queue from the main connection.
CREATE TABLE memory_generations (
  gen INTEGER PRIMARY KEY,
  family TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_utc INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building','active','retired'))
);
CREATE TABLE vectors (
  message_id INTEGER NOT NULL,
  chunk INTEGER NOT NULL,
  gen INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  v BLOB NOT NULL,
  PRIMARY KEY (message_id, chunk, gen)
) WITHOUT ROWID;
CREATE TABLE vector_bits (
  message_id INTEGER NOT NULL,
  chunk INTEGER NOT NULL,
  gen INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  ts_utc INTEGER NOT NULL,
  bits BLOB NOT NULL,
  PRIMARY KEY (message_id, chunk, gen)
) WITHOUT ROWID;
CREATE INDEX vector_bits_gen ON vector_bits (gen, message_id);
CREATE TABLE embed_queue (
  message_id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_utc INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE memory_injections (
  session_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  turn_message_id INTEGER NOT NULL
);
CREATE INDEX memory_injections_turn ON memory_injections (turn_message_id);
CREATE INDEX memory_injections_message ON memory_injections (message_id);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  created_utc INTEGER NOT NULL,
  updated_utc INTEGER NOT NULL
);

-- Pinned facts, "About you" (07 A4).
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  created_utc INTEGER NOT NULL,
  updated_utc INTEGER NOT NULL
);

CREATE TABLE attachments (
  sha TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','pdf','docx','text','other')),
  width INTEGER,
  height INTEGER,
  text_chars INTEGER,
  created_utc INTEGER NOT NULL
);
-- Extracted text written once at ingestion (07 C8). An INTEGER PRIMARY KEY keeps rowids stable for the FTS table
-- (implicit rowids may be renumbered by VACUUM).
CREATE TABLE attachment_text (
  id INTEGER PRIMARY KEY,
  sha TEXT NOT NULL UNIQUE,
  extractor TEXT NOT NULL,
  text TEXT NOT NULL,
  chars INTEGER NOT NULL
);
CREATE VIRTUAL TABLE attachment_fts USING fts5 (
  text, content = 'attachment_text', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO attachment_fts (attachment_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER attachment_fts_ai AFTER INSERT ON attachment_text BEGIN
  INSERT INTO attachment_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER attachment_fts_ad AFTER DELETE ON attachment_text BEGIN
  INSERT INTO attachment_fts (attachment_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER attachment_fts_au AFTER UPDATE OF text ON attachment_text BEGIN
  INSERT INTO attachment_fts (attachment_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO attachment_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Auth sessions (07 B2/B11/B16). Only SHA-256(token) is stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop','browser','paired')),
  listener TEXT NOT NULL CHECK (listener IN ('loopback','lan','tailnet')),
  scopes TEXT NOT NULL DEFAULT '[]',
  pending INTEGER NOT NULL DEFAULT 0,
  sudo_until_utc INTEGER,
  token_hash TEXT NOT NULL UNIQUE,
  created_utc INTEGER NOT NULL,
  last_seen_utc INTEGER,
  last_ip TEXT,
  user_agent TEXT,
  revoked_utc INTEGER
);

CREATE TABLE auth_log (
  id INTEGER PRIMARY KEY,
  ts_utc INTEGER NOT NULL,
  event TEXT NOT NULL,
  ip TEXT,
  detail TEXT
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
`

export const m001Init: Migration = {
  version: 1,
  name: 'init',
  up(db: Db) {
    db.exec(SQL)
  }
}
