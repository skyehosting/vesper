# 03 — Data model, REST API and WebSocket protocol

Authoritative for every agent. TypeScript sources of truth: `src/shared/types/*.ts`, `src/shared/api.ts`,
`src/shared/ws.ts`. Change them only through the orchestrator (or additively, with a note in 07-AMENDMENTS).

## 1. SQLite schema (`vesper.db`, migration 1)
Conventions: times are UTC epoch **ms** (`*_utc`); ids used in comparisons are bound as **BigInt**; JSON columns are
TEXT validated in code; soft deletes keep rows for undo (purged after 30 days).

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,                 -- uuid v4 (external id in URLs/API)
  short_id TEXT NOT NULL UNIQUE,            -- 'K7Q2MX': 6 chars Crockford base32 (no I L O U), shown as #K7Q2MX
  title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
  created_utc INTEGER NOT NULL, updated_utc INTEGER NOT NULL, last_message_utc INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, deleted_utc INTEGER,
  temporary INTEGER NOT NULL DEFAULT 0,     -- incognito: never embedded, never recalled, deleted when closed
  private INTEGER NOT NULL DEFAULT 0,       -- never recalled from other sessions
  memory TEXT NOT NULL DEFAULT 'inherit',   -- inherit | on | off
  memory_scope TEXT NOT NULL DEFAULT 'inherit', -- inherit | this | linked | all
  system_prompt TEXT NOT NULL DEFAULT '', prompt_id INTEGER,
  llm_profile TEXT, model TEXT,             -- overrides (null = settings default)
  voice TEXT,                               -- JSON {provider, voiceId, model?} override
  tool_mode TEXT,                           -- frozen at first request: native | text
  active_branch INTEGER,                    -- tip branch of the active path
  message_count INTEGER NOT NULL DEFAULT 0, -- messages on the active path
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE session_links (from_session INTEGER NOT NULL, to_session INTEGER NOT NULL, created_utc INTEGER NOT NULL,
  PRIMARY KEY (from_session, to_session));            -- directional: "from may recall to"

CREATE TABLE branches (                    -- a branch = messages from fork_seq onward; root branch fork_seq = 1
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, parent_branch INTEGER, fork_seq INTEGER NOT NULL,
  created_utc INTEGER NOT NULL, active_child INTEGER, -- last-selected child branch (to restore a path)
  reason TEXT NOT NULL                      -- root | edit | regenerate
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,                   -- global timeline order (memory "timeline")
  uid TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  tag TEXT NOT NULL CHECK (tag IN ('user response','ai response')),
  body TEXT NOT NULL,                       -- clean text shown in the UI and indexed (no hidden tags)
  ts_utc INTEGER NOT NULL, tz_offset_min INTEGER NOT NULL, tz_name TEXT, device TEXT,  -- sender's clock (R7)
  status TEXT NOT NULL DEFAULT 'complete',  -- complete | streaming | stopped | error
  error TEXT, tone TEXT,                    -- tone is kept for "speak again" only; never indexed
  provider TEXT, model TEXT, usage TEXT,    -- JSON {in, out, cacheRead, cacheWrite, reasoning}
  attachments TEXT NOT NULL DEFAULT '[]',   -- JSON [{sha, name, mime, size, kind}]
  on_path INTEGER NOT NULL DEFAULT 1,       -- 1 while on the session's active path (memory searches only these by default)
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, branch_id, seq)
);
CREATE INDEX messages_page ON messages (session_id, branch_id, seq);
CREATE INDEX messages_time ON messages (ts_utc);
CREATE VIRTUAL TABLE messages_fts USING fts5 (body, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');            -- + insert/update/delete triggers; secure-delete=1
CREATE TABLE transcript (                  -- the wire log: exactly what was sent/received, replayed byte-for-byte
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, message_id INTEGER NOT NULL, -- owning UI message
  part INTEGER NOT NULL,                    -- order within the message's reply (assistant/tool/assistant…)
  role TEXT NOT NULL,                       -- user | assistant | tool | system
  blocks TEXT NOT NULL,                     -- canonical JSON (shared/types/wire.ts), serialized deterministically
  provider TEXT, model TEXT, created_utc INTEGER NOT NULL,
  UNIQUE (message_id, part)
);
CREATE TABLE epochs (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, start_message_id INTEGER NOT NULL,
  recap TEXT NOT NULL, thinking_stripped INTEGER NOT NULL DEFAULT 0, created_utc INTEGER NOT NULL);
CREATE TABLE vectors (message_id INTEGER NOT NULL, chunk INTEGER NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
  v BLOB NOT NULL, PRIMARY KEY (message_id, chunk));    -- int8[dim]
CREATE TABLE embed_queue (message_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  next_try_utc INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE memory_injections (session_id INTEGER NOT NULL, message_id INTEGER NOT NULL, turn_message_id INTEGER NOT NULL);
CREATE TABLE prompts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
  created_utc INTEGER NOT NULL, updated_utc INTEGER NOT NULL);
CREATE TABLE attachments (sha TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  kind TEXT NOT NULL, width INTEGER, height INTEGER, text_chars INTEGER, created_utc INTEGER NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,   -- desktop | browser | paired
  token_hash TEXT NOT NULL, created_utc INTEGER NOT NULL, last_seen_utc INTEGER, last_ip TEXT, user_agent TEXT,
  revoked_utc INTEGER);
CREATE TABLE auth_log (id INTEGER PRIMARY KEY, ts_utc INTEGER NOT NULL, event TEXT NOT NULL, ip TEXT, detail TEXT);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

### 1.1 Branches (edit, regenerate, variants)
- A session starts with a root branch (fork_seq 1). The **active path** is the chain root → … → `active_branch`;
  segment *i* of the chain contributes its messages with `fork_seq(i) ≤ seq < fork_seq(i+1)`.
- **Regenerate** the assistant message at seq *s*: new branch (reason regenerate, fork_seq *s*) under the branch
  owning *s*; the new reply gets seq *s*. **Edit** user message at seq *s*: new branch (reason edit, fork_seq *s*),
  the edited text gets seq *s*, then a new reply. Old messages stay (`on_path=0`), viewable via variant arrows
  `‹ 2/3 ›` shown on any message whose seq is a fork point. Switching a variant re-selects the chain (restoring each
  branch's `active_child`) and updates `on_path`.
- Paging the active path: `WHERE session_id=? AND ((branch_id=b0 AND seq<f1) OR (branch_id=b1 AND seq>=f1 AND seq<f2)
  …) AND seq < ? ORDER BY seq DESC LIMIT ?` — chains are short; index `messages_page`.

### 1.2 Wire transcript (canonical blocks — `src/shared/types/wire.ts`)
```ts
type WireBlock =
  | { t: 'text'; text: string }
  | { t: 'image'; sha: string; mime: string }                 // bytes frozen at ingestion
  | { t: 'document'; sha: string; mime: 'application/pdf'; name: string }
  | { t: 'file_text'; name: string; text: string }            // extracted text (non-PDF, or provider without PDF)
  | { t: 'tool_call'; id: string; name: 'memory_search' | 'memory_recall'; input: Record<string, unknown> }
  | { t: 'tool_result'; id: string; text: string; isError?: boolean }
  | { t: 'reasoning'; provider: string; model: string; payload: unknown } // opaque, echoed only to same provider+model
  | { t: 'memory_result'; text: string }                     // text-mode results / auto-recall block
  | { t: 'system_note'; text: string }                       // appended instruction updates (R11)
```
Serialized with a deterministic JSON writer (fixed key order). Adapters render canonical → provider format purely
(same input → same bytes). The user turn's first text block starts with its timestamp prefix
`[Mon 5 Oct 2026 14:03]` (plus `· N days since the previous message` when > 6 h), written once at send time.

## 2. Settings (`%APPDATA%\Vesper\settings.json`, schema-validated, versioned)
```ts
interface Settings {
  version: 1
  profile: { userName: string; assistantName: string; clock: '24h' | '12h' }
  llm: { profiles: LlmProfile[]; defaultProfile: string | null }
  chat: { pageSize: number /*100, 20–500*/; sendOnEnter: boolean; fontSize: number; autoTitle: boolean;
          showReasoning: boolean; contextFill: number /*0.6*/; maxToolCalls: number /*3*/; streamMarkdown: boolean }
  memory: { enabled: boolean; scopeDefault: 'this' | 'linked' | 'all' /*linked*/; autoRecall: boolean;
            autoRecallMinScore: number; maxRecallRounds: number /*8*/; maxRecallTokens: number /*1500*/;
            voyage: { baseUrl: string; embedModel: string; rerankModel: string | 'none'; dim: 1024 | 512 | 256 } }
  voice: {
    tts: { enabled: boolean; provider: TtsProviderId; voiceId: string | null; model: string | null;
           reveal: 'synced' | 'text-first'; toneMode: 'off' | 'conversation' | 'reply' /*conversation; was tone: boolean, 07 H-v11-tone*/; tonePlacement: 'start' | 'end'; speed: number;
           volume: number; autoSpeak: boolean; perDevice: 'sender' | 'all' }
    stt: { enabled: boolean; provider: SttProviderId; model: string; mode: 'dictate' | 'ptt' | 'conversation';
           silenceMs: number /*1500, 500–5000*/; language: string /*auto*/; bargeIn: 'off' | 'tap' | 'voice';
           autoSendDictation: boolean }
  }
  appearance: { theme: 'dark' | 'light' | 'system'; accent: AccentId; reduceMotion: boolean;
                star: { style: 'orb' | 'nebula'; quality: 'low' | 'medium' | 'high'; showInChat: boolean } }
  access: { mode: 'local' | 'lan' | 'tailscale'; port: number /*41730*/; lanAddress: string | null;
            lanPort: number /*41731*/; funnel: boolean }
  desktop: { closeToTray: boolean; startWithWindows: boolean; startInBackground: boolean }
  privacy: { acknowledged: Record<string, number /*utc*/> }
  wizard: { completed: boolean; step: string | null }
}
interface LlmProfile { id: string; label: string; preset: PresetId; adapter: 'openai' | 'anthropic'; baseUrl: string;
  model: string; authHeader?: string; options: { maxTokens: number; temperature?: number; effort?: Effort;
  reasoningDisplay?: 'hidden' | 'summarized' }; capabilities: { tools?: boolean; vision?: boolean; pdf?: boolean;
  contextWindow?: number } }
```
Secrets (`secrets.json`, safeStorage ciphertext; write-only API): `llm:<profileId>`, `voyage`, `tts:elevenlabs`,
`tts:openai`, `tts:azure`, `stt:openai`, `stt:groq`, `stt:deepgram`, `stt:elevenlabs`. Password hash lives in
`auth.json` (scrypt, salt, params).

Files in `%APPDATA%\Vesper`: `settings.json`, `secrets.json`, `auth.json`, `vesper.db` (+wal/shm), `protocols.md`
(user-editable; `protocols.default.md` shipped in the app), `attachments/`, `models/` (STT/local TTS),
`tls/` (LAN cert + key), `logs/`, `exports/`, `manifest.json` (on export).

## 3. REST API (`/api`, JSON; mutating requests need `X-Vesper: 1`; errors `{error:{code,message}}`)
| Method & path | Body / query → result |
| --- | --- |
| GET `/api/bootstrap` | → `{version, device:{id,kind,name}, desktop:boolean, settings: PublicSettings, secretsSet: string[], wizard, network: NetworkStatus, features}` |
| POST `/api/auth/login` | `{password, deviceName}` → sets cookie; 401 / 429 (lockout `retryAfter`) |
| POST `/api/auth/logout` · GET `/api/auth/devices` · DELETE `/api/auth/devices/:id` · GET `/api/auth/log` | device management |
| POST `/api/auth/password` | `{current?, next}` → set/change password |
| POST `/api/auth/pair` · POST `/api/auth/pair/redeem` | create one-time pairing code (+QR data) · redeem `{code, deviceName}` |
| GET `/api/sessions?q=&cursor=&filter=pinned\|archived\|trash` | → `{items: SessionSummary[], next}` (grouped client-side) |
| POST `/api/sessions` | `{title?, systemPrompt?, links?: string[], continueFrom?: string, temporary?}` → `Session` |
| GET/PATCH/DELETE `/api/sessions/:uid` | patch: title, pinned, archived, private, memory, memoryScope, systemPrompt, llmProfile, model, voice |
| POST `/api/sessions/:uid/restore` | undo delete |
| GET/PUT/DELETE `/api/sessions/:uid/links[/:shortId]` | links (by short id) |
| GET `/api/sessions/:uid/messages?before=&after=&around=&limit=` | active path page → `{items: Message[], hasBefore, hasAfter, total}` (`around` = message uid, centers the window) |
| GET `/api/sessions/:uid/variants/:seq` · POST `/api/sessions/:uid/variants/:seq` | list alternatives at a fork · `{branchId}` select |
| DELETE `/api/messages/:uid` | soft delete (hides; excluded from memory) |
| GET `/api/search?q=&scope=all\|session&session=&mode=keyword\|semantic` | → hits `{message, session, snippet}` |
| GET `/api/memory/status` · POST `/api/memory/reindex` · GET `/api/memory/manifest` · POST `/api/memory/recall` | queue size, model, counts · full re-embed · manifest JSON · `{query, sessionUid}` manual recall |
| GET/POST/PATCH/DELETE `/api/prompts[/:id]` | prompt library |
| POST `/api/attachments` (multipart) · GET `/api/attachments/:sha[?thumb=1]` | upload (limits: 25 MB/file) → `AttachmentRef` |
| GET/PATCH `/api/settings` · GET/PUT `/api/protocols` · POST `/api/protocols/reset` | settings · protocols.md |
| PUT/DELETE `/api/secrets/:name` | `{value}` write-only; never readable |
| GET `/api/providers/presets` · POST `/api/providers/llm/test` · GET `/api/providers/llm/models?profile=` | wizard |
| POST `/api/providers/voyage/test` · POST `/api/providers/tts/test` · GET `/api/tts/voices?provider=` · POST `/api/tts/preview` | voice/memory setup |
| GET `/api/stt/models` · POST `/api/stt/models/:id/download` · DELETE `/api/stt/models/:id` · POST `/api/providers/stt/test` | local STT models |
| GET/PUT `/api/network` · POST `/api/network/firewall/allow` · GET `/api/network/tailscale` · POST `/api/network/tailscale/serve` | access modes |
| GET `/api/export?session=&format=md\|json` · POST `/api/import` | export / import |

## 4. WebSocket `/ws` (one per client; JSON text frames + binary audio frames)
Envelope `{t: string, id?: string, ...}`. Binary frames: 1-byte kind + 4-byte BE header length + JSON header + payload
(kind 1 = TTS audio chunk, kind 2 = mic PCM frame).

Client → server
| `t` | Fields |
| --- | --- |
| `hello` | `{device, tz, tzOffset, visible}` |
| `subscribe` / `unsubscribe` | `{sessionUid}` — receive live events for that session |
| `chat.send` | `{sessionUid, text, attachments: string[], client:{ts, tzOffset, tzName}, speak:boolean, temporaryRecall?}` |
| `chat.stop` | `{sessionUid}` |
| `chat.regenerate` | `{sessionUid, messageUid}` |
| `chat.edit` | `{sessionUid, messageUid, text, attachments}` |
| `speech.replay` | `{messageUid}` — speak again |
| `speech.played` | `{replyId, chunk}` — playback progress (for barge-in bookkeeping) |
| `speech.cancel` | `{replyId}` — barge-in / stop speaking |
| `stt.start` | `{mode, sessionUid, sampleRate:16000}` then binary kind-2 frames |
| `stt.stop` / `stt.cancel` | end / abort utterance |

Server → client
| `t` | Fields |
| --- | --- |
| `ready` | `{device}` |
| `message.created` | `{sessionUid, message: Message}` (user and assistant placeholder) |
| `reply.status` | `{replyId, sessionUid, state: 'thinking'\|'recalling'\|'writing'\|'preparing-voice'\|'speaking'\|'done'\|'stopped'\|'error', detail?}` |
| `reply.delta` | `{replyId, text}` (text mode; not sent to the speaking client in synced-reveal mode) |
| `reply.reasoning` | `{replyId, text}` (when showReasoning) |
| `reply.memory` | `{replyId, kind:'search'\|'recall'\|'auto', query, count}` — the "remembering…" indicator |
| `reply.done` | `{replyId, message: Message}` (final clean text, usage) |
| `reply.error` | `{replyId, code, message, retryable}` |
| `speech.chunk` | binary kind 1: header `{replyId, index, text, start, timeline:{chars, startsMs[], endsMs[]} \| null, mime, final}` + audio bytes |
| `speech.end` | `{replyId}` |
| `stt.state` / `stt.partial` / `stt.final` | `{state}` / `{text}` / `{text, autoSend}` |
| `session.updated` | `{session: SessionSummary}` · `sessions.changed` `{}` |
| `memory.progress` | `{queued, indexed, errors}` |
| `settings.changed` | `{settings: PublicSettings}` |
| `toast` | `{tone, text}` |

## 5. Commands (parsed in the client, executed via REST/WS; `/help` lists them)
`/new [title]` · `/continue <#id>` · `/link <#id>` · `/unlink <#id>` · `/links` · `/prompt <text>` ·
`/prompt use <name>` · `/prompt save <name>` · `/prompt clear` · `/memory on|off|status` · `/recall <query>` ·
`/private on|off` · `/voice on|off|<name>` · `/model <id>` · `/title <text>` · `/id` · `/export [md|json]` ·
`/temp` (temporary chat) · `/help`. Unknown `/word` is sent as normal text.

`/continue #K7Q2MX`: creates a session linked to K7Q2MX whose first transcript turn carries a recap of K7Q2MX
(generated by the LLM from its last epoch + recent messages) as a `memory_result`, then the AI greets with continuity
("Picking up from our conversation on 12 Sep about…").
