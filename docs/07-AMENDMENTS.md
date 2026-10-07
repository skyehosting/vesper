# 07 — Amendments (AUTHORITATIVE — overrides 01–06 wherever they disagree)

Source: the five plan critiques in `docs/critique/` (REQ, SEC, ARC, HIST/REVEAL/LEAK/MEM/GPU/VOICE/…, BLD findings).
Every blocker and major finding is accepted unless marked otherwise. IDs in brackets point to the critique.
Implementation sources of truth: `src/shared/**` types written in Phase 1 from this document + 03.

---
## A. Owner-facing decisions and deviations
A1 **OWNER-NOTES.md** (Phase 5 deliverable, also linked from Settings → About → "Design notes"): one row per
   deviation — Voyage stores nothing (memory is local); the "$5" Voyage belief corrected (payment method + Admin toggle;
   paying alone doesn't opt out; not retroactive; may void free tokens; undo only via legal@voyageai.com); tone tag at
   the start by default; native tools vs bracket functions; Windows voices are the classic OneCore ones; "outside the
   network" = Tailscale; trivial messages not embedded; the history window keeps 3 pages; a "verify with your keys"
   checklist (ElevenLabs v4 alignment, Voyage free-tier limits, real-mic STT, echo cancellation, Anthropic replay).
   [REQ-1]
A2 **Tone (R13)**: default `voice.tts.tonePlacement = 'start'` (protocols say "start your reply with the tag"); help
   text explains why ("the voice can't start in the right tone if the tone arrives at the end"). `'end'` is supported:
   replies ≤ 600 visible chars wait for the stream to finish; longer replies speak early chunks in the session's last
   tone and apply a new tag from the chunk where it lands. If no tag has appeared after the first 40 visible chars, use
   the last/neutral tone — never wait. Semantics: **a tag applies from its chunk until the next tag**. Setting
   `voice.tts.waitForTone` (default false) forces waiting for the full reply. Protocols use `{{tone_instruction}}`.
   [REQ-2, ARC-13, VOICE-1] *Amended by H-v11-tone: `voice.tts.toneMode` off | conversation (default) | reply.*
A3 **Tone storage**: no `messages.tone`. The raw tag exists only in `transcript.blocks` (byte-exact replay needs it).
   `transcript` is never exported, searched, embedded or logged. "Speak again" re-runs the TagFilter over the
   transcript. Test: no `[tone=` in `messages`, embed inputs, exports, logs. [REQ-2, ARC-19]
A4 **Extra features adopted** (the owner said "add features you think I'd like"):
   - **Constellation** — a 3D memory map: sessions as stars (size = messages, brightness = recency), links as lines,
     private sessions dimmed; drag star→star to link, click to open; recalled sources pulse during a reply. Same R3F
     stack, rendered in the single app canvas (G4). Phase 3 presence agent.
   - **"Remembered" chip** on AI replies (from `reply.tool`/`memory_injections`): expands to the recalled rounds with
     session, date, "N days ago", Jump to, Forget.
   - **Game mode** (D3) + opt-in global push-to-talk toggle hotkey (D6).
   - **Import past chats**: ChatGPT `conversations.json` and Claude exports become sessions with original timestamps
     (`device:'import'`), so memory and time awareness work from day one. content-server.
   - **Pinned facts** ("About you"): `/remember <fact>` and a message action; stored in `facts` table; delivered as a
     `system_note` at epoch start and when changed; editable in the memory viewer.
   - **Wizard finale**: the Star wakes and greets the owner by name in the chosen voice (first synced reveal); offers to
     pair a phone.

## B. Security & privacy
B1 **Secrets bound to destinations** [SEC-1]: `secrets.json` entries `{ciphertext, origin}` (scheme+host+port at entry
   time). Provider clients send a key only when the request origin equals the bound origin (else `key_origin_mismatch`).
   Changing a base URL to another origin clears its key atomically unless a new key is supplied in the same request.
   Base-URL rules (zod): `https:` unless loopback (or a desktop-only "allow plain HTTP to this host" tick); no
   userinfo, no query; Voyage hosts restricted to `api.voyageai.com`, `ai.mongodb.com`, `eu.ai.mongodb.com`,
   `us.ai.mongodb.com` unless "custom endpoint" (desktop). Provider fetches: `redirect:'manual'`, timeouts, response
   size caps. Custom header *values* are secrets. Errors to clients are Vesper's own codes (+`upstreamStatus`), never
   upstream bodies.
B2 **Authorization model** [SEC-2]: every route declares `auth: 'public' | 'device' | 'sudo' | 'desktop'` (Fastify route
   option, enforced in one preHandler; a unit test fails if a route lacks it).
   - public: static assets, `GET /api/auth/state` → `{passwordSet, pairingAvailable, version, setupComplete}`,
     `POST /api/auth/login`, `POST /api/auth/pair/redeem`.
   - device: chat, sessions, messages, search, memory recall/status, prompts, attachments, TTS voices/preview, STT
     stream, own logout, per-session settings (choosing among existing profiles).
   - sudo (password within 10 min; desktop counts as sudo): export all, import, delete memory/re-index, revoke other
     devices, audit log, change password (`current` required off-desktop).
   - desktop only (desktop device on Listener A): secrets, base URLs/presets/custom headers, protocols edit/reset,
     access mode/ports/interfaces/Funnel, firewall allow, Tailscale serve, pairing-code creation, model downloads and
     deletes, the "remote clients may change settings" toggle, password reset without `current`.
   - `devices` gains `listener ('loopback'|'lan'|'tailnet')`, `scopes`. `PublicSettings` omits all secret material,
     header values, TLS paths. "Remote clients may change settings" (default off) only widens appearance/voice/chat
     defaults, never secrets/URLs/access/protocols.
B3 **Listener C** for Tailscale [SEC-3]: `http://127.0.0.1:<tailnetPort>` exists only in Tailscale mode and is the only
   `tailscale serve` target; everything on C is classified `tailnet`; no desktop session on C; Host allow-list
   `<machine>.<tailnet>.ts.net` only. Listener A refuses ts.net Host (421).
B4 **`vesper.localhost`** for local browsers [SEC-4]: "Open in browser" and local pairing use
   `http://vesper.localhost:<port>` (secure context, loopback, cookie not shared with other localhost ports). The desktop
   window keeps 127.0.0.1 in its own partition. Local-browser sessions: idle 7 d, absolute 30 d.
B5 **Serving attachments** [SEC-5]: type sniffed from magic bytes; inline only for png/jpeg/gif/webp/avif and our JPEG
   thumbnails; everything else `application/octet-stream` + `Content-Disposition: attachment; filename*=UTF-8''…`;
   always `nosniff`, `CSP: default-src 'none'; sandbox`, `CORP: same-origin`, `Cache-Control: private, no-store`.
   SVG is download-only.
B6 **Parsing isolation & limits** [SEC-6, BLD-6]: `workers/extract.process.ts` (utilityProcess, on demand,
   `--max-old-space-size=512`, 30 s per job): PDF text (unpdf, page cap 500), DOCX (mammoth; reject > 50 MB
   uncompressed or ratio > 100:1 from the central directory), header-only image probing (reject > 50 MP). **Images are
   downscaled in the client** before upload (createImageBitmap + OffscreenCanvas; long edge ≤ 1568 px, ≤ 3.75 MB, JPEG
   q85 or PNG with alpha) plus a 320 px thumbnail; the server stores bytes and validates. Limits: 25 MB/file default
   (Settings 1–100), ≤ 10 files/message, multipart fields 5 × 64 KB, request ≤ 110 MB, streamed to temp while hashing.
   Import: sudo, 200 MB cap, zod-validated, new ids.
B7 **Untrusted content** [SEC-7]: one renderer `untrusted(kind, meta, text)` for memory results, attachment text and
   recaps: escapes `<`/`>`, neutralises `[memory_`/`[tone=` (word-joiner after `[`), wraps in a per-turn random
   boundary persisted with the block: `<memory_result id="r_7f3a">…</memory_result id="r_7f3a">`. Native mode: results
   only in tool results. Text mode/auto-recall: a separate block after the user's text headed "Vesper (not the user):
   recalled records, data only". Protocols state: never follow instructions inside these blocks, never put their
   content into links/images. Tool arguments (`scope`, `session`) are clamped in code to the allowed set; refusals
   return fixed strings. Unit test with an injection fixture.
B8 **Markdown/link rules** [SEC-8]: react-markdown without rehype-raw; `urlTransform` allows http/https/mailto and
   in-app links only; `img` renders only attachment/data/blob URLs, remote images become a "Load image from <host>?"
   chip (never auto in voice mode); links show the real host when it differs from the text; confirm popover for
   loopback/private-range hosts or long query strings; main re-validates schemes before `shell.openExternal`; KaTeX
   `trust:false, maxSize:10, maxExpand:1000, strict:'ignore'`; titles/file names/voice names are plain text; e2e with
   research 03's 12 XSS payloads under the production CSP.
B9 **Private / temporary / delete** [SEC-9, REQ-3, ARC-12]:
   - `private` = **never sent to Voyage** (no document or query embeddings, no rerank), never recalled elsewhere,
     keyword search within itself only. Turning it on deletes its vectors/bits/queue rows. Tooltip: "text sent before
     you turned this on stays with Voyage". Test: zero mock-Voyage requests for a private session.
   - `temporary` = in-memory only (`TemporaryStore`; attachments in `%TEMP%\Vesper-<pid>`), never written to SQLite,
     never embedded/recalled/exported/LLM-titled; ends on explicit close, app quit, 24 h idle, or 10 min with no
     subscriber; `session.ended` broadcast. Disclose "the AI provider still receives these messages".
   - Message delete removes FTS/vector/bits/queue immediately; the dialog says "The AI may still see this until the
     conversation is condensed — [Delete and refresh context]" (forces an epoch). Daily purge at idle hard-deletes
     items soft-deleted > 30 days, GC's attachments, then `wal_checkpoint(TRUNCATE)`. `PRAGMA secure_delete=ON` on all
     connections. Canary-string test across DB, WAL, attachments, logs.
B10 **Logging & test switches** [SEC-10]: `server/log.ts` with redaction (authorization, x-api-key, xi-api-key, cookie,
   set-cookie, key-shaped strings `/(sk|pa|al|gsk|xai)-[A-Za-z0-9_-]{8,}/`), no bodies, no message text unless
   "Diagnostic logging" (desktop toggle, auto-off 24 h); rotate 5 MB × 3 in `%LOCALAPPDATA%\Vesper\logs`. No crash
   uploads. LAN TLS key stored as safeStorage ciphertext. **All test hooks, `/api/test/*` and every `VESPER_*` switch
   exist only when the build constant `__VESPER_TEST__` is true** (Vite/esbuild `define`; the packaged release build
   sets it false). Packaged smoke asserts `/api/test/ping` 404 and `window.__vesperTest` undefined.
B11 **Electron hardening** [SEC-11]: `app.enableSandbox()`; webPreferences sandbox/contextIsolation/no
   nodeIntegration/no webview/`navigateOnDragDrop:false`; deny `will-attach-webview`; `will-navigate`/`will-redirect`
   only to our loopback origin; `setWindowOpenHandler` → deny + validated openExternal; permission handlers on
   `persist:vesper`: allow only `media` (audio only), `clipboard-sanitized-write`, `fullscreen`, only for our origin;
   `setDevicePermissionHandler` false; `certificate-error` deny; preload exposes window controls + `openExternal`
   only; fuses as Orrery + `GrantFileProtocolExtraPrivileges` off; desktop cookie session-only, earlier desktop device
   rows revoked at launch.
B12 **Model downloads** [SEC-12]: `src/shared/models.ts` catalogue `{id, files:[{url,size,sha256}], license,
   attribution, unpackedSize, kind}`; URLs only GitHub release assets / Hugging Face `resolve/<40-hex commit>`; we pin
   our own SHA-256 where upstream gives none; HTTPS only, redirects only to known CDN hosts, `.part` resume, verify
   size+hash before extraction; archive listing checked (no absolute paths, `..`, drive letters, links); extract to
   temp then rename. Downloads are desktop-only.
B13 **Privacy texts** [REQ-4, SEC-13]: research 08 (LLM providers, verified) + one source `src/shared/privacy.ts`:
   per service `{id, version, sends, retention, training, optOutHow, sources[], verified}` consumed by the wizard
   (just-in-time at preset/feature selection), Settings → Privacy dashboard (connected services, what leaves the PC,
   links, disconnect, delete memory index, export), and "leaves this PC" badges on the model/memory/voice chips.
   Acknowledgements keyed `<id>@<version>`. Welcome text: "Your chats are stored on this PC. To answer, Vesper sends
   them to the AI service you choose; optional memory and voice services receive text too." Voyage text adds that
   searches may send up to 40 earlier messages for ranking.
B14 **Tailscale lifecycle** [SEC-14]: mode/port change, quit (unless "keep remote access while closed"), and uninstall
   run `tailscale serve … off` / `funnel … off` for Vesper's mapping; startup reconciles `serve status --json`. Funnel:
   strong password required, persistent "Public" badge, auto-off timer (default 8 h). Lockout in Funnel suspends
   password login on C; desktop-minted pairing still works.
B15 **Auth rules** [SEC-15]: header `X-Vesper: 1`; password 15–1024 chars, NFKC, checked against a bundled
   common-password list; required before LAN/Tailscale; change needs `current` (except desktop) and revokes other
   sessions + closes sockets; per-IP 5/min + global ladder (10 → backoff 1–60 s; 50/h → remote login suspended); one
   scrypt at a time (queue 4, else 429); constant-time path.
B16 **Pairing approval** [SEC-16]: redeeming a code creates a *pending* device; the desktop shows "Pair '<device>'?
   Allow/Deny"; new devices/logins notify the desktop with one-click Revoke.
B17 **Ambient privacy** [SEC-17]: `perDevice:'sender'`; notifications show no message text unless "Show previews";
   desktop mic stops when the window is hidden; tray shows a red dot while any device streams mic audio.

B18 **Provider privacy behaviours** (research 08): OpenRouter profiles send `provider: {data_collection: 'deny'}` by
   default (profile option `options.openrouterNoTraining`, default true) and `zdr: true` when the profile option
   `options.openrouterZdr` is on (default false; note that many `:free` models then 404 — show that error clearly);
   Deepgram STT always sends `mip_opt_out=true`; an Ollama model whose name ends in `cloud` shows the
   `llm.ollama-cloud` disclosure and a "leaves this PC" badge; LLM disclosures are chosen by `llmDisclosureId()`
   and shown just-in-time when a preset is selected. Disclosures carry `verified` dates — re-verify before each
   release.

## C. Architecture & correctness
C1 **Frozen system and tools per epoch** [ARC-1]: `epochs` stores `system_json`, `tools_json` (or `'[]'`),
   `protocols_hash`, `tools_version`; context assembly reads them only from the active epoch, never re-renders. Session
   creation = epoch 0. Protocol placeholders allowed: `{{assistant_name}} {{user_name}} {{session_id}} {{tones}}
   {{tone_instruction}}` and mode blocks `{{#native_mode}}…{{/native_mode}}` / `{{#text_mode}}…{{/text_mode}}`. No
   clock in system. Memory/voice state changes, prompt edits, link changes and pinned-fact changes arrive as appended
   `system_note` blocks. Native tools are always declared (memory off → tool returns "memory is disabled"); tool
   definitions are compile-time constants in `shared/memoryFunctions.ts` with `TOOLS_VERSION`, generating both the
   JSON schemas and the protocols' function docs. Protocols edits, renames and app-update protocol changes apply to new
   epochs; Settings offers "Apply to this session now" (starts a new epoch). Mock-LLM **prefix-invariance test** across
   /memory off, /voice on, /prompt, protocols edit, rename, /model, tool loop, stop, restart.
C2 **One persisted header per user turn** [ARC-2, ARC-20, REQ-6]: each user turn's first text block starts with
   `[Now: Mon 5 Oct 2026 14:03 (UTC−04:00, America/New_York) · 23 days since the previous message]` (gap clause only
   > 6 h), rendered once at send time from `ts_utc` in the sender's zone, never again. Nothing is added transiently.
   User-turn block order: `[header+text] [image/document/file_text…] [memory_result (auto-recall)]`. Regenerate/retry
   > 10 min after the user turn: persist a turn-scoped `system_note "[Now: …]"` as part 0 of the new assistant reply.
   **Timestamps**: `ts_utc` of every message = the PC's clock (receive time for user messages, completion time for AI);
   `tz_offset_min`/`tz_name` = the sender device's zone (AI replies inherit); client ts kept in `meta.clientTs` only if
   it differs by > 120 s. One display format everywhere: `Mon 5 Oct 2026 14:03 (UTC−04:00)`; the TagFilter also strips a
   leading imitated stamp from assistant text (display, speech, memory only).
C3 **Branch paging** [ARC-3, HIST-1]: partial index `messages_path ON messages(session_id, seq) WHERE on_path=1`;
   pages are plain keyset on it. Deleted messages stay on the path as tombstones (`deleted=1`, body cleared from FTS).
   FTS triggers fire only `AFTER UPDATE OF body, deleted` (never on `on_path`). Fork parent rule: a new branch at seq
   *s* has `parent_branch` = the branch owning *s−1* on the current path; variants at *s* are siblings
   (`parent_branch=P AND fork_seq=s`) plus P's own message at *s*; order by `created_utc`; `active_child` per
   (parent, fork_seq) in `branch_choices`. A variant switch flips `on_path` in one transaction, recomputes
   `message_count`, emits `session.path_changed`, tells the memory worker `pathChanged`. Search shows off-path hits as
   "earlier version"; jumping selects that chain first. Memory searches only on-path rows.
C4 **Epochs** [ARC-4, CHAT-1, REQ-17]: effective epoch = newest whose `start_message_id` is on the active path
   (`branch_id` stored). Recap runs **in the background** when fill ≥ 0.75 × budget: input = previous recap + messages
   since, chunked ≤ 60k tokens (map-reduce), on the utility model; stored as a draft; switch at the next turn. If over
   budget with no draft: send on the current epoch if it still fits the hard window, else `reply.status 'summarizing'`.
   Budget = max(token estimate, request bytes) with adapter hard limits (Anthropic 30 MB / pages). A model switch that
   overflows forces a rollover first. Timeline shows an epoch marker "From here the AI saw a summary of earlier
   messages · view summary"; WS `epoch.created`.
C5 **Thinking-strip watermark** [ARC-5]: `epochs.thinking_strip_before INTEGER` (transcript id); strip only blocks
   before it. First strategy where accepted: `block_binding.prefix_mismatch_behavior:'drop_block'` beta; log
   `input_transformations`. Test a 400 mid tool loop.
C6 **Reply finalization** [ARC-6]: persist only complete blocks (drop unsigned thinking, incomplete tool_use); a
   complete tool_use without result gets a synthetic `tool_result{isError:true,"cancelled by user"}`; stopped replies
   keep partial text (`status 'stopped'`); errored replies with no complete block write no transcript rows (Retry =
   regenerate); checkpoint streaming text to `messages.body` every ~2 s; at startup convert `streaming` → `stopped` /
   `error`. Test: abort at every SSE event index of a recorded thinking+tool stream; next request valid.
C7 **Provider extras & switching** [ARC-7]: `extra?` on `text` and `tool_call` blocks; `reasoning.payload` opaque and
   ordered; presets declare `echoKey` (`anthropic:<model>`, `deepseek`, `openrouter:<model>`, `gemini`, …) and extras
   are echoed when it matches. `system_note` renders as a mid-conversation system message where supported, else a user
   text block (both adapters). `tool_mode` frozen **per epoch**; native→text targets render tool calls as bracket text
   and results as `memory_result` deterministically; a `/model` switch to a different tool capability starts a new
   epoch. Mistral tool ids remapped `base62(sha256(id))[0..9]` in the adapter. Mock validators for provider echo rules.
C8 **Attachment replay** [ARC-8, REQ-8]: `attachment_text(sha PK, extractor, text, chars)` written once at ingestion
   (+ FTS table `attachment_fts` for search). Canonical turns record `document` plus a `file_text` reference;
   adapters: document → native if `caps.pdf` else stored text; image → native if `caps.vision` else
   `[image: <name>, <w>×<h>]` (+ one-time toast). Accepted types: images, PDF, DOCX, txt/md/code/csv/json. Pasting
   > 4,000 chars becomes a "Pasted text" chip. "Copy as Markdown / plain text" on every message.
C9 **DB ownership** [ARC-9, MAIN-1, BLD-15]: main connection = sessions, branches, messages, transcript, epochs, links,
   prompts, facts, attachments, devices, kv, `INSERT` into embed_queue; every main statement O(page), p99 < 5 ms,
   `busy_timeout` 250 ms with async retry (never spin). **`db.worker`** (renamed from memory.worker) = vectors,
   vector_bits, embed_queue updates/deletes, FTS merge/optimize at idle, **and bulk jobs**: export (streams to
   `exports/`), import, bulk delete/purge, backup, re-index — in transactions ≤ 500 rows / ≤ 20 ms with yields; no read
   transaction > 1 s (chunks of 50k). `wal_autocheckpoint` off; worker checkpoints PASSIVE at idle, TRUNCATE when WAL
   > 64 MB and on shutdown. `monitorEventLoopDelay` gate p99 ≤ 20 ms during export / 1M delete / re-index.
C10 **Memory index lifecycle** [ARC-10, MEM-2]: `vector_bits(message_id, chunk, gen, bits BLOB)` written with the int8
   row; startup (lazy: first memory use or 30 s idle) streams bits + parallel arrays (messageId, sessionId, tsUtc,
   flags: deleted|offPath|private|temporary); until ready `memory.status='loading'`, searches keyword-only. Target
   ≤ 1.5 s per 1M. `memory_generations(gen, family, model, dim, created_utc, state building|active|retired)`; re-index
   builds a new gen and swaps at 100 %; voyage-4 family model changes keep the gen. Worker messages: `vectorsAdded`,
   `messagesFlagged`, `sessionFlagged`, `pathChanged`, `purge`, `search`, `status`, `reindex`, replies `progress`,
   `error`; tombstone compaction > 10 % dead.
C11 **VoyageScheduler** [ARC-11]: in db.worker, owns all Voyage calls; foreground lane (queries/reranks) never waits
   beyond its budget (auto-recall 400 ms, search 1.2 s → else keyword-only), background lane (embedding) keeps a 1-RPM
   reserve; batch = min(1,000 inputs, 0.8 × TPM per request; free trial ≤ 8K tokens); tier from Settings ("auto":
   start at free-trial limits, step up after 10 min without 429); free trial → rerank off, ≤ 1 memory_search per reply.
   `memory.status {tier, rpmUsed, queueEtaSec}`.
C12 **Backfill consent** [REQ-15]: enabling Voyage with un-embedded history asks: "Index N messages from M sessions?
   ~X tokens, ~$Y (likely within free tokens), ~Z at your rate limit. Private/temporary excluded." Index all / only new
   / choose sessions; stored per session `meta.backfill`.
C13 **Manifest for the AI** [REQ-5]: at epoch start and on link changes, a `system_note` lists accessible sessions
   (`#ID · title · created · last active · count · one-line summary`, ≤ 30). New function `memory_sessions(query)`.
   `sessions.summary`, `summary_utc` refreshed at idle after ≥ 20 new messages (utility model; never for private).
C14 **Speech document** [REQ-11, ARC-13, BLD-5, REVEAL-1]: the segmenter works on remark's mdast of the filtered text;
   chunk boundaries only between top-level blocks or between sentences inside a paragraph/list item; first chunk closes
   at the first `.!?` or `,;:` after ≥ 40 chars, or at 150 chars. Each `speech.chunk` header:
   `{replyId, index, src:[start,end) into the final clean markdown, spoken, timeline:{startsMs[], endsMs[]} over spoken
   chars (relative to the chunk's audio start) | null, durationMs, mime, final}`; `mime ∈ audio/mpeg | audio/wav |
   audio/L16;rate=<n>`. Spoken rules: code fences, tables, math, images → not spoken (zero-duration instant chunks);
   link text spoken, bare URLs → "link"; inline code as-is; list/heading/emphasis markers dropped.
   `shared/revealMap.ts` (`buildRevealMap(renderedText, spoken, timeline) → startMs per rendered char`, fuzz-tested).
   **Reveal mechanism = CSS Custom Highlight API only**: one `unrevealed` highlight (`color:transparent`) + 3–4 trailing
   fade highlights (stepped alpha via color-mix); no per-glyph spans, no "2 px rise". `RevealController` (audio-core)
   binds to roots chat-ui registers (`registerRevealRoot/unregisterRevealRoot` on mount/unmount/eviction); highlights
   deleted on done/barge-in/unregister/session switch; `user-select:none` + `aria-busy` while revealing; reduced motion
   → whole words, no fade; no Highlight API → sentence steps. Budget ≤ 0.3 ms/frame for 4,000 chars. **Failure**: a
   chunk not ready within 6 s or failed twice → reveal it and the rest as text-first, mark "voice unavailable", toast,
   continue as text; WS `speech.error {replyId, index, code}`.
C15 **Barge-in** [VOICE-2]: stop sources, abort synthesis, keep revealed text visible with a collapsed "— interrupted ·
   show rest"; persist full text, `messages.spoken_chars`, `interrupted=1`; the next turn carries a `system_note`
   "(The user interrupted your previous reply after: '<last ~80 spoken chars>'.)". `voice.stt.bargeIn` default `'tap'`;
   `'voice'` offered only after the echo self-test or "I use headphones".
C16 **WebSocket** [ARC-14, NET-1]: `hello {protocol:1, device, tz, tzOffset, client:{visible, focused,
   audioUnlocked}}` → `ready {protocol, serverTime}`; `client.state` on change. Every session event carries `evSeq`;
   per-session ring of 512 events; `subscribe {sessionUid, sinceEvSeq?}` → `subscribed {sessionUid, evSeq, inflight:
   [{replyId, messageUid, state, text, speakingDeviceId}]}` or `reply.snapshot`; gaps → resubscribe. One turn per
   session (engine mutex): busy → `reply.error{code:'session_busy'}` unless `interrupt:true`. Requests carry `id`,
   answered with `ack {id, replyId?, messageUid?}`. Audio per socket; `bufferedAmount` > 1 MiB → `speech.degraded` and
   text-first for that client. Speaker fixed at reply start (`sender` default, or all subscribed devices with voice
   on); `speech.cancel` from any device stops speech everywhere; speaker disconnect → others get text deltas. Ping every
   20 s, drop after 2 misses; close codes 4401/4409/4429; client backoff 0.5→10 s with a "Reconnecting…" banner.
C17 **STT process protocol** [ARC-15]: MessagePort with transferable buffers: `load{model, threads}` → `loaded |
   loadError`; `open{micId, mode, silenceMs, lang, ttsActive}`; `frames{micId, pcm}`; `ttsActive{micId, bool}`;
   `close{micId, reason}` → `partial`, `final{micId, text, durationMs, dropped?}`, `vad{micId, speaking}`,
   `error{micId?, code}`. One shared recognizer, one VAD per mic session. Two-stage endpointing: ~400 ms segments →
   partials; silence setting → final with a full re-decode. Guards: finals < 300 ms dropped; known hallucinations
   ("1.", "Thank you.") on near-silence dropped. Pre-roll 400 ms. Crash → restart with backoff, open sessions fail with
   `stt_crashed`. WS: `stt.vad`, `stt.model.progress`. **Default silence 1200 ms, range 300–5000.**
C18 **Recaps and `/continue`** [ARC-16, REQ-13]: `llm.utilityProfile` (default: main profile at `effort:'low'`) for
   titles, recaps, summaries. Recap input = stored epoch recap + last 40 on-path messages, ≤ 30k tokens, cached per
   (session, last message id). `POST /api/sessions {continueFrom}` returns immediately; the opening turn runs over WS
   (`reply.status 'recapping'` → 'writing'). It is a **hidden user message** (`messages.hidden=1`, not shown, not
   embedded) carrying the header + `memory_result` recap + "Greet the user and pick up where you left off." The new
   session copies system_prompt, prompt_id, llm_profile, model, voice, memory, memory_scope and the source's outgoing
   links, plus a link to the source; title "<source> (cont.)"; source gets `meta.continuedIn` and a "Continued in
   #NEW →" card. Links are **not transitive**. Session panel: "Add link" combobox (titles, summaries, IDs), direction
   shown, "link both ways", "sessions that can recall this one". `#K7Q2MX` in chat renders as a session chip.
   `/continue` from a private source → recap built locally from that session only; the new session inherits private.
   `/recall` shows a UI card only; "Use in next message" attaches it.
C19 **Failure modes** [ARC-17, ERR-1]: `src/shared/errors.ts` code catalogue (`unauthorized, forbidden, not_found,
   validation, conflict, session_busy, rate_limited, key_origin_mismatch, provider_auth, provider_quota,
   provider_rate, provider_overloaded, provider_context, provider_history, provider_refusal, provider_bad_request,
   network, disk_full, db_error, stt_unavailable, stt_model_missing, mic_denied, mic_os_blocked, insecure_context,
   tts_failed, tts_quota, memory_unavailable, voyage_backlog, secret_unreadable, port_unavailable, internal`), each
   with `retryable`, user message, UI action. Behaviours: auth/quota → banner + "Fix in Settings", no retry; rate →
   countdown; overloaded/network → one retry then button; context → forced rollover + one retry; disk < 200 MB →
   banner, pause downloads/embedding; `SQLITE_FULL` → keep reply in memory "not saved", retry every 30 s;
   `PRAGMA quick_check` at startup; corruption → read-only + restore dialog; secrets decrypted at startup, failures
   listed in bootstrap `secretsInvalid` (never plaintext fallback); child processes supervised (≤ 3 restarts / 5 min);
   port busy → try +1…+10 and persist; bind failure → native dialog, never a blank window.
C20 **Backups** [REQ-18]: `node:sqlite` `backup()` daily at idle and before every migration →
   `%APPDATA%\Vesper\backups\vesper-YYYYMMDD.db` (7 daily + 4 weekly, optional extra folder); Settings → Data: Back up
   now, Restore (swap + restart server), Export everything (JSON + attachments zip). Secrets never in backups. A failed
   migration restores the pre-migration backup automatically.
C21 **Contract completeness** [ARC-18, HIST-1]: Phase 1 writes all shared types; messages API =
   `GET /api/sessions/:uid/messages?mode=latest|before|after|around&seq=&limit=` → `{items, loSeq, hiSeq, lastSeq,
   hasBefore, hasAfter}` (tombstones included); `GET /api/sessions/:uid/timeline?samples=24` → `[{seq, tsUtc}]`;
   `GET /api/messages/:uid/locate` → `{sessionUid, branchPath, seq, onPath}`; `lastSeq` on SessionSummary and
   `message.created`; events `message.updated`, `message.deleted`, `session.deleted`, `session.path_changed`,
   `reply.tool`, `reply.timing`, `speech.error`, `speech.degraded`, `stt.vad`, `stt.model.progress`, `ack`,
   `subscribed`, `epoch.created`, `tts.voices`, `session.ended`, `notify`. `chat.send {id, sessionUid, text,
   attachments: sha[], client:{ts, tzOffset, tzName}, speak, interrupt?}` (device from the socket).
C22 **Voices on key save** [REQ-12]: `PUT /api/secrets/tts:*` validates (ElevenLabs `/v1/user/subscription`) and fetches
   voices + models (cached in kv 24 h), broadcasting `tts.voices {provider, voices, models, quota?}`; the dropdown
   fills with no click and auto-selects the first premade voice; Refresh button; 401/403 → "This key can't list voices;
   enable 'Voices: read'". `GET /api/tts/preview/:provider/:voiceId` proxies `preview_url` same-origin. Provider list
   order: ElevenLabs · OpenAI · Windows voices (classic, offline) · OpenAI-compatible (custom URL) · (Piper local if it
   ships). Show per-model price and remaining quota; default to the cheapest model with audio tags, verified via
   `/v1/models` at runtime, never hard-coded.

## D. Performance, resources, UX
D1 **History window (R5)** [REQ-7, HIST-1]: research 03 §4.4 steps 1–11 are the chat-ui contract. N =
   `chat.pageSize` (default 100, range 20–300; raise only after a perf gate); cap 3N; view state per device in
   IndexedDB `viewState[sessionUid] = {anchorSeq, offsetPx, pinned}`; scrubber via `timeline` samples, preview on drag,
   fetch on release/150 ms idle; one in-flight request per direction; never evict rows containing focus/selection or
   while the pointer is down; the live reply survives DOM eviction; Ctrl+F opens in-session search. Help text: "Vesper
   keeps about 3 pages in view and unloads the rest as you scroll". E2E: 1M session, scrubber to 10 %, 5 pages up and
   down, DOM ≤ 3N messages, anchor drift ≤ 2 px.
D2 **Resource lifecycle** [MEM-1]: renderer destroyed `desktop.keepWindowWarmSec` (30) after closing to tray (reopen
   ≤ 800 ms); STT utility spawned on first mic arm/Talk mode (prewarm on hover/focus), exits after
   `voice.stt.unloadAfterMin` (10) idle; Piper (if shipped) `voice.tts.localUnloadAfterMin` (5); wintts host on demand,
   exits after 10 min idle (and on stdin EOF); memory index lazy (C10); `--background` starts nothing until a client
   needs it. Budgets (`app.getAppMetrics` private working set): tray-only ≤ 250 MB; window idle ≤ 550 MB; + STT
   ≤ 850 MB. Settings → About "Resource use" panel with "Unload voice models now".
D3 **Game mode** [REQ-14]: `performance.gameMode: 'auto'|'on'|'off'` (auto) — on when a fullscreen/exclusive app is
   foreground (`SHQueryUserNotificationState` == QUNS_RUNNING_D3D_FULL_SCREEN / QUNS_BUSY, polled every 5 s via koffi
   or the PowerShell host): Star static (10 fps while speaking), voice models unload after the idle time, embedding
   backfill pauses, notifications held. Gate: idle CPU < 1 %, zero GPU frames over 60 s.
D4 **Star frame scheduler** [GPU-1]: `frameloop="never"` + one scheduler: speaking/listening/crossfade ≤ 60 fps,
   thinking ≤ 30, idle ≤ 20 for 20 s then **rest at 0 fps** (last frame kept; optional CSS opacity breath);
   `appearance.star.pauseWhenUnfocused` (default on): unfocused + idle → 0 fps; unfocused speaking/listening → ≤ 30;
   hidden/minimized/occluded/off-screen → 0 and no analyser polling; `powerPreference:'default'`; AudioContext created
   lazily, suspended after 30 s without audio. Gates: rest/unfocused/hidden = 0 frames; rest ≤ 0.5 % of a core;
   speaking ≤ 6 %.
D5 **One WebGL context** [GPU-2]: one persistent `<Canvas>` at the app root, moved/resized between the compact stage,
   Talk stage, Constellation and phone header via layout/portal targets; never remounted; message avatars are static
   SVG/CSS (the newest may mirror state via CSS); dispose + `forceContextLoss` only on real teardown or style Off;
   handle context lost/restored. Star styles: `orb | nebula | minimal2d | off`; `maxFps`. *Amended by H-v11-presence:
   + `armilla` (the default); in a chat the canvas lives behind the messages (no compact stage).*
D6 **Voice latency budget** [VOICE-1]: targets (p50, mocks at fixed latency): speech end → stt.final ≤ silence +
   250 ms; send → provider request ≤ 30 ms (memory off), ≤ 300 ms cap with auto-recall in Talk mode; first chunk rule
   (C14); first chunk → audio at client: WinRT ≤ 150 ms, ElevenLabs ≤ provider + 50 ms; WS+decode+schedule ≤ 40 ms.
   `reply.timing {replyId, marks}` WS event + dev overlay. Pre-warm STT/TTS when Talk mode opens or the mic is armed;
   undici keep-alive 60 s; start the Voyage query embedding on the first ≥ 4-word `stt.partial`. ElevenLabs "Fast voice
   in Talk mode" option (flash/turbo per `/v1/models`). Talk mode: one mic track open for the session; frames not sent
   while TTS plays unless bargeIn voice; re-arm 250 ms after the last audio; controls Talk/Interrupt, Mute, Hold, End;
   Esc/Space; states `warming-up`, `muted`; `voice.globalHotkey` (toggle, default null, opt-in with a warning).
D7 **Render pipeline** [HIST-2]: streaming = split into top-level blocks (marked.lexer), memoized per block, only the
   open block re-renders, ≤ 1 commit per animation frame; open code fences plain `<pre>`; shiki on closed fences **in a
   Web Worker**, LRU 500 by content hash; KaTeX lazy; incoming rows render plain, highlight in idle batches; anchor
   compensation before and after async height changes. Dynamic imports for three/R3F, shiki, KaTeX, wizard, settings,
   Constellation; the Star mounts after first paint + idle. Targets: cold launch → latest messages ≤ 1.5 s; session
   switch ≤ 150 ms; prepend with no long task > 50 ms; jump ≤ 200 ms; 10k-char stream p95 commit ≤ 4 ms; initial JS
   ≤ 350 KB gzip without the Star.
D8 **Mobile** [MOBILE-1]: 01 "Surfaces" corrected: installable on phones via Tailscale (trusted cert); on the LAN Vesper
   opens in the browser (mic works after accepting the certificate once; no install). Access page shows a capability
   matrix per mode. `DevicePrefs` (client-side per origin): star style/quality/showInChat/pauseWhenUnfocused, motion,
   font size, theme, autoSpeak, micDeviceId, sendOnEnter; phone defaults: `minimal2d`, no Star in chat,
   `sendOnEnter:false`. 04 "Phone layout": visualViewport/interactive-widget, safe areas, 44 px targets, hold-to-talk,
   Wake Lock in Talk mode, iOS audio session, AudioContext interruption, first-tap unlock. Stable LAN cert (regenerate
   only when SANs change; fingerprint on the pairing page).
D9 **Accessibility** [A11Y-1]: feed/article semantics with `aria-posinset=seq`, `aria-setsize=lastSeq`; streaming not
   in a live region; completed replies announced per `a11y.announceReplies` (`full` in text mode, `notice` with
   voice); scrubber `role=slider` with valuetext; Alt+↑/↓ between messages; focus never lost on eviction; Star canvas
   aria-hidden + state text + visible pause control (≤ 3 onsets/s, ≤ 15 % brightness change); reduced-motion table;
   `@axe-core/playwright` on every route/dialog (0 serious/critical) + keyboard-only e2e.
D10 **Glass** [GLASS-1]: backdrop-filter only on transient surfaces (menus, popovers, dialogs, toasts); persistent
   surfaces over the stage/list use opaque `--bg-2` at 92–96 %; honour `prefers-reduced-transparency`; none on phones.
D11 **Wizard** [REQ-9, WIZ-1]: **Quick start** (Welcome → AI provider with Test → Start chatting, ≤ 60 s) or **Guided**:
   0 Welcome + layered privacy → 1 AI provider (preset, URL, key, Test = `/models` + 1-token chat, mapped errors,
   model dropdown with capability badges; just-in-time provider privacy) → 2 You (name, assistant name, time zone
   shown/editable, 12/24 h) → 3 Memory (optional; "kept on this PC"; Voyage key; Test = 256-dim embed; models; privacy
   with the $5 correction and opt-out links; scope choice: linked-only default / all sessions) → 4 Voice out
   (optional; providers; key → voices auto-fill → Play sample; tone placement explained) → 5 Voice in (optional; mic
   permission, level meter, silence slider with a try-it area, model download with size/progress/SHA check in the
   background) → 6 Access (This PC default; password only for LAN/Remote) → 7 Look & presence (theme, accent, Star
   style incl. Off, desktop: start with Windows / close to tray — asked, default off) → 8 Summary with Edit links →
   **finale** (A4). Saves per step (`wizard.step`), skippable except 1, re-runnable; runs only on the desktop/loopback
   (remote clients see "Finish setup on your PC"); skipped steps feed the empty-state setup checklist; every Test has a
   10 s timeout.
D12 **Settings IA** [REQ-10]: General · AI providers (profiles, utility profile) · Chat · Memory (Voyage, scope,
   auto-recall, pinned facts, protocols editor, memory viewer, manifest) · Voice out · Voice in · Presence & appearance
   · Access & security (devices, audit log) · Privacy · Data (export/import/backups/paths) · Performance (game mode,
   resource use) · About (credits, licences, design notes). Each page has "Advanced". A unit test walks the zod schema
   and asserts every leaf maps to a UI control id.
D13 **Empty & error states** [ERR-1]: first run → the Star greeting, 3 suggestion chips, setup checklist; empty session;
   search with no results; memory off / keyword-only chip; offline banner; per error code UI actions.
D14 **Leak gates** [LEAK-1]: 05's soak row replaced by the gate table in the performance critique (LEAK-1) — CDP
   `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage` + `Memory.getDOMCounters`; server `--expose-gc`; counters
   for Web Audio nodes, WebGL contexts (getContext wrapper), blob URLs, hub maps, STT sessions; `npm run soak`
   mandatory before Phase 5.

## E. Build, process, tests
E1 **Registries** [BLD-1]: server route modules (`server/http/index.ts` imports a fixed list of per-owner modules,
   stubs answer 501), WS handler modules (`server/ws/handlers/{chat,speech,stt,session,system}.ts`) + binary handler
   map; shared contracts split per domain (`shared/api/*.ts`, `shared/ws/*.ts`, written complete in Phase 1);
   settings schema per section (`server/settings/schema/*.ts`) with `SettingsStore.get/patch/subscribe(path)`; web
   registries: routes, settings sections, wizard steps, commands (`registerCommand`), zustand slices, namespaced test
   hooks; mocks `tests/mocks/{llm,voyage,tts,stt,github-models}.ts` mounted by `tests/mocks/server.ts`. Agents never
   edit outside ownership; requests go to `docs/requests/<agent>.md`.
E2 **Service interfaces** [BLD-2]: `src/server/services.ts` — `ChatService`, `MemoryService`, `SpeechService` +
   `SpeechSink`, `SttService`, `ProviderTester`, `ServerContext {platform, db, repos, settings, secrets, hub, log,
   clock, services}`; fakes in `tests/fakes/`; Phase 1 acceptance: a fake chat turn (echo LLM) → fake speech → WS.
E3 **Dev topology** [BLD-3]: the window always loads `http://127.0.0.1:<port>/`; in dev (unpackaged with
   `ELECTRON_RENDERER_URL`), Fastify forwards non-`/api`/`/ws` requests and the HMR socket to the Vite dev server (own
   minimal proxy, no new deps); helmet dev CSP behind `!isPackaged`. Build entries: `main/index`, `db.worker`,
   `stt.process`, `extract.process`, `server-node` (plain Node, no electron import), preload, web → `out/web`.
   `scripts/serve.mjs` runs `out/main/server-node.js` with a NodePlatform (test-only plaintext secrets).
E4 **Client cores** [BLD-4, BLD-14]: Phase 1 freezes `web/lib/audio/types.ts` (AudioEngine, LevelSource/Levels,
   MicCapture, RevealController) and barrel stubs (`features/chat` `<ReplyView>`, `<Transcript>`; `features/voice`
   `<MicControl>`, `useVoiceState`; `features/presence` `<Star>`, `<StarHost>`); Phase 1 builds frozen-API kit
   primitives (Button, IconButton, Dialog, Toast, Tooltip, Spinner); Talk mode belongs to presence.
E5 **Spikes S1–S7** (Phase 1.5) [BLD-7]: packaged sherpa + utilityProcess under fuses; wintts host (extraResources,
   EOF exit, no orphans); @fastify/static from asar + bundled server; node:sqlite packaged (main + worker); dev topology;
   AudioWorklet under prod CSP + fake mic; pins/typecheck/Playwright. Pass notes appended here (section F).
E6 **Runtime parity** [BLD-8]: unit/integration tests and `serve.mjs` run on **Electron's Node**
   (`ELECTRON_RUN_AS_NODE=1 electron vitest.mjs`); a guard test asserts `process.versions.electron` and sqlite 3.53.4.
   Fallback if unreliable: pin a dev Node 24.21 and keep an Electron-as-Node suite for sqlite/crypto.
E7 **TTS scope** [BLD-9]: v1 = ElevenLabs, OpenAI (+ OpenAI-compatible), Windows (WinRT, SAPI fallback). **No Kokoro.**
   Piper via sherpa is a stretch goal (permissive voice licences only). Credits: `THIRD_PARTY_NOTICES.txt` generated
   by `scripts/licenses.mjs` + `resources/licenses/models.json` (Parakeet CC-BY-4.0 attribution, Moonshine MIT, Silero
   VAD MIT, sherpa-onnx Apache-2.0, ONNX Runtime MIT, **espeak-ng GPL-3.0 statically linked in sherpa-onnx**, fonts
   OFL); the owner is told that public redistribution brings GPL-3.0 obligations.
E8 **Packaging & paths** [BLD-10, REQ-20]: NSIS per-user is the supported build for LAN/Remote and start-with-Windows;
   the portable build hides LAN mode and start-with-Windows with a note (`PORTABLE_EXECUTABLE_FILE` set) and keeps
   `unpackDirName:false`. `%APPDATA%\Vesper`: settings, secrets, auth, DB, protocols, attachments, backups.
   `%LOCALAPPDATA%\Vesper`: models, logs, Chromium session data (`app.setPath('sessionData', …)`). Settings → Data
   shows both with "Open folder".
E9 **Pins** [BLD-11]: exact versions (package.json is the source; `deps:check` script rejects ranges except
   @types/node); Electron stays 44.4.5 for the build.
E10 **Key-less testing** [BLD-12]: mocks emit real WAV (sine bursts per word, exact alignment) + one raw PCM scenario;
   `VESPER_STT_FAKE=1` (real Silero VAD from `resources/models/`, scripted recognizer per fixture); SAPI-generated
   fixtures in `tests/fixtures/audio/` with `.txt`; `VESPER_FAKE_MIC=<wav>` appends the Chromium fake-media switches
   before ready; test mode mutes window audio; `npm run live-check` (owner's keys from env, never in `npm test`).
E11 **Agent table with acceptance criteria** [BLD-13]: 06 is rewritten from BLD-13 (Phase 2: llm-engine, memory,
   voice-out-server, voice-in-server, access-server, content-server, ui-kit, audio-core; Phase 3: chat-ui,
   voice-client, presence (+Talk mode, Constellation), settings-wizard (+memory viewer, privacy dashboard), access-ui).
   e2e runs use `VESPER_PORT=0` and temp data dirs.
E12 **Numbers** [BLD-16]: ports 41730 (A) / 41731 (B, LAN HTTPS) / 41732 (C, tailnet); silence 1200 ms (300–5000);
   page size 100 (20–300); all defaults only in `server/settings/defaults` (shared schema).
E13 **Traceability** [REQ-19]: 05 gets a "Requirement → tests" table; tests are tagged `@R<n>`;
   `scripts/req-coverage.mjs` fails when an R has no tagged test.

## F. Spike results (Phase 1.5)
(appended as spikes complete)
- **S2 wintts host — PASS** (2026-10-05). `resources/wintts.ps1` (shipped via extraResources, JSON lines over stdio):
  ready 604 ms; 3 OneCore voices (David, Zira, Mark); 200 sequential `speak` requests 200/200 with word cues, ~9 ms
  each; malformed request → error line (no hang); stdin EOF → exit 0; parent `taskkill /f` → host gone within 2.5 s
  (stdin closes, ReadLine returns null). Script: `.scratch/spikes/wintts/spike.cjs`.
- **S1 + S4 packaged sherpa + node:sqlite — PASS** (2026-10-05). electron-builder `--dir` with Vesper's fuses
  (runAsNode off, onlyLoadAppFromAsar, embedded asar integrity, NODE_OPTIONS/inspect off,
  grantFileProtocolExtraPrivileges off) and `asarUnpack` of both sherpa packages: node:sqlite 3.53.4 with WAL + FTS5
  in main and in a worker_thread whose script is inside app.asar; fs read/stat inside app.asar; `utilityProcess.fork`
  of a script inside app.asar loads `sherpa-onnx-node` (native files from app.asar.unpacked; `onnxruntime.dll` loaded
  from app.asar.unpacked, NOT System32), Silero VAD from `resources/`, and a Moonshine model from an external folder
  transcribed the fixture perfectly. Script: `.scratch/spikes/pack/`.
- **S6 AudioWorklet + fake mic — PASS** (2026-10-05). Electron 44 window (sandbox, contextIsolation, partition) on a
  loopback page served with the production CSP (`script-src 'self' 'wasm-unsafe-eval'`): `audioWorklet.addModule('/worklet.js')`
  loads; Chromium fake-media switches (`use-fake-device-for-media-stream`, `use-fake-ui-for-media-stream`,
  `use-file-for-fake-audio-capture=<wav>%noloop`) appended before ready deliver the WAV as "Fake Default Audio Input";
  the worklet downsamples 48 kHz → 16 kHz Int16 frames of 512 samples (123 frames in 4 s = real time); permission
  handlers allowing only audio `media` for the loopback origin work. Script: `.scratch/spikes/audio/`.
- **S3 static from asar + bundled server — PASS** (2026-10-05). Test-flavoured `electron-builder --dir` with the release
  fuses, launched `--background` (tray only): VESPER_READY in 461 ms; index.html, hashed /assets (correct MIME,
  immutable caching) and the SPA fallback for a deep link (/s/<uid>) all served by @fastify/static from inside
  app.asar; headless Chromium reaches the login page with test hooks ready. Found and fixed: relative asset URLs (G9)
  and missing favicon/manifest (now in src/web/public). Script: `.scratch/spikes/s3/run.cjs`.
- **S5 dev topology — PASS** (2026-10-05). `electron-vite dev -- --background`: the loopback server forwards pages and
  Vite's HMR socket to the Vite dev server (src/server/http/devProxy.ts); ready in 1.2 s; a deep link renders through
  the server origin; a CSS edit hot-swaps with no full reload; /api answers on the same origin; zero console errors.
  Script: `.scratch/spikes/s5/run.cjs`.
- **S7 Playwright ↔ Electron 44** — implicitly PASS: the Phase 1 e2e suite drives the built app through `_electron`.
- **S8 game-mode detection (07 D3) — PASS, read-only** (2026-10-05). Windows PowerShell 5.1 `Add-Type` P/Invoke:
  `SHQueryUserNotificationState` answers 5 (accepts notifications) on an idle desktop; Add-Type 140 ms once, then
  ~66 µs per call, so a persistent host polling every 5 s costs nothing. Borderless-fullscreen games often report 2
  (busy) or even 5, so the host also checks the foreground window: `GetForegroundWindow` + `GetWindowRect` vs
  `GetMonitorInfo(MonitorFromWindow)`; a maximized normal window (offsets −7) does NOT cover the monitor (taskbar).
  Rule for Phase 4: game mode = QUNS 3 (D3D fullscreen) or 2 (busy) or (foreground covers its monitor AND has no
  WS_CAPTION AND is not the shell/desktop/Vesper itself); debounce 2 polls. Script: `.scratch/spikes/gamemode/`.

## G. Phase 1 integration decisions (2026-10-05)
Made while merging server-core, main-desktop, web-shell and test-infra. Binding for Phase 2+.
- **G1 Targeted WS events are unsequenced.** `hub.emit(..., { only | except })` sends `evSeq: 0` and does not enter the
  session ring. Otherwise every socket that did not receive the event would see a gap and refetch. Clients deliver
  `evSeq 0` events without touching their counter (`SeqTracker.onEvent`). Only broadcast session events are resumable.
- **G2 `bootId` on `ready`.** The hub picks a random id per server start; when a reconnecting client sees a different
  `bootId` it resets every session's resume point (`SeqTracker.resetAll`) and refetches, since evSeq restarted at 1.
- **G3 Core access.** Listener and auth internals are reached through `coreOf(ctx)` (src/server/core.ts), not new
  fields on the frozen `ServerContext`.
- **G4 Chromium profile is roaming, caches are local.** `sessionData` = `%APPDATA%\Vesper` (its `Local State` holds the
  safeStorage key that decrypts secrets, so it must travel with settings.json); `disk-cache-dir` =
  `%LOCALAPPDATA%\Vesper\cache`. Supersedes the "Chromium profile local" line in E8.
- **G5 No `use-fake-ui-for-media-stream` in the app.** Mic permission goes through the permission handlers (B11);
  tests feed audio with `use-fake-device-for-media-stream` + `use-file-for-fake-audio-capture` only.
- **G6 `VESPER_FAKE_NOW` advances.** It sets the clock's starting point; time then moves at real speed (a frozen clock
  broke timers, rate limits and "N since the previous message").
- **G7 Variant indexes are 1-based** in the API and UI ("2 / 3").
- **G8 Plain-HTTP host setting is not implemented.** Listener A stays loopback-only; LAN is HTTPS (B) and outside access
  is the tailnet listener (C). Revisit only if a real need appears.
- **G9 Renderer assets are root-absolute.** electron-vite forces `base './'` for production renderers; a post plugin in
  electron.vite.config.ts restores `base '/'`, so deep links (`/s/<uid>`) load `/assets/*`. A `<base>` tag is not an
  option: the CSP has `base-uri 'none'`.
- **G10 Test readiness.** `__vesperTest.ready()` also requires the outlet for the current URL to be committed and no
  REST request in flight; `notReady()` says why. `waitForReady` needs `ready()` to hold for 150 ms (pages request new
  font faces a frame after commit).
- **G11 Echo engine until llm-engine.** Phase 1 turns are answered by src/server/chat/echo.ts and call no provider; the
  "mock LLM saw the turn" assertion moves to llm-engine's acceptance (docs/agents/phase2.md).
- **G12 `AuthState.signedIn` / `pendingApproval`.** `GET /api/auth/state` reports whether the request carried an
  approved device cookie; the client calls `/api/bootstrap` only when signed in, so a signed-out browser reaches the
  login page with zero failed requests. (One extra round trip on load, sub-millisecond on loopback.)
- **G13 Web client icons + manifest** in src/web/public (favicon.svg/32 px, apple-touch-icon, 192/512, a standalone
  web manifest), so phones can add Vesper to the home screen. Regenerate with `npx electron scripts/render-web-icons.cjs`.

## H. Phase 4 integration decisions (2026-10-05)
Made while fitting the Phase 3 seams together (int-server, int-chat-voice, int-shell-settings). Binding for Phase 5.
- **H1 C9 "busy_timeout 250 ms with async retry" — implemented (int-server).** The main connection opens with
  `busy_timeout = 250` (`MAIN_BUSY_TIMEOUT_MS`, src/server/db/sqlite.ts); db.worker keeps 5000 (blocking its own thread
  is harmless). SQLite's busy handler sleeps synchronously, so 250 ms is the longest the event loop can stall on a
  lock per statement. The hot write paths retry asynchronously with `retryBusy()` (10 → 250 ms backoff, 15 s cap): a
  turn's first rows (fork + user message + reply placeholder, now ONE `BEGIN IMMEDIATE` transaction — a busy attempt
  has written nothing, so the retry is safe), the user turn's transcript rows, every reply transcript row, the finished
  reply's update, and the embed-queue insert (deferred, never lost). Every other main statement that hits the lock for
  > 250 ms fails with a retryable `db_error` (HTTP 503, "Vesper is busy saving. Try again in a moment."). Why not
  everywhere: node:sqlite is synchronous and most statements sit inside synchronous call chains (repos, `tx()`,
  route handlers) that are not restartable as a whole; in practice db.worker holds the write lock ≤ 20 ms per slice
  (4 ms gaps), so only its idle-time TRUNCATE checkpoint can exceed 250 ms, and then the user is not using Vesper.
  The streaming checkpoint (every ~2 s) already tolerates failure. Test: tests/unit/server/busy.test.ts.
- **H2 Synced reveal with several speakers.** `Hub.emit` takes `except: string | ReadonlySet<string>` (additive). The
  engine excludes every speaking client when `voice.tts.reveal === 'synced'` (not only a lone speaker); each one that
  degrades, fails or barges in alone gets the targeted `reply.snapshot` and then deltas. An empty set is not
  "targeted" (the event stays sequenced).
- **H3 Hub ring lifecycle.** `Hub.dropSession?(uid)` (additive, optional): the uid is gone for good (temporary chat
  ended, trash purged) — its ring and every socket's subscription to it are removed. Unwatched rings are dropped after
  10 min idle (they used to keep their counter forever) and the map is LRU-capped at 2048 rings, never evicting a
  watched one. A ring created after any drop starts at the highest dropped evSeq (a per-boot high-water mark), so a
  client resuming with a stale `sinceEvSeq` always sees `head − since > replayed` (refetch) — evSeq values never repeat
  with different events in one boot. `subscribe` now creates the ring, so a subscriber's head is the base of what
  follows. Soft-deleted sessions keep their ring until it ages out (a restore must not lose subscribers).
- **H4 Unsent temporary uploads.** `POST /api/attachments?temporary=1` records the upload with its device
  (`TemporaryChats.noteUpload`). It is dropped when no live temporary chat of that device is left (immediately when
  its chat ends, after a 60 s grace otherwise — an upload may race the chat's creation) or after 1 h unsent; a file a
  live chat uses belongs to that chat. The sweep timer runs only while chats or pending uploads exist.
- **H5 Data jobs without db.worker.** When the worker is gone for good (07 C19 budget used) or no memory service
  exists, export, import and backup run the SAME job functions in the main process (their JobIO still yields every
  ≤ 15 ms slice) and log it; an export or backup the worker died under is re-run there (an import is not: its
  half-written sessions are unknown, the error is reported). Exports are written to `<file>.part` and renamed when
  complete; the next export removes stale `.part` files (bulk jobs are serialized), and a name already taken gets
  " (2)" — two exports within one second used to fail with EEXIST.
- **H6 `Session.tokens`.** Migration 9 adds `sessions.tokens_in/out/cache_read`, backfilled once, kept current by two
  triggers on `messages.usage` (INSERT, UPDATE OF usage: delta of new − old; malformed JSON counts 0, never fails a
  write). Every variant's usage counts (those tokens were spent). `null` when nothing was reported. O(1) per
  `GET /api/sessions/:uid` (summing on read would scan the session, against C9).
- **H7 Search filters.** `SearchQuery` gains optional `role`, `from`, `to` (UTC ms, `from` inclusive, `to`
  exclusive), applied in the FTS scan before paging (keyword) or to the hits (semantic). The search page's own
  client-side filtering keeps working unchanged; passing the parameters saves it pages.
- **H8 Packaging prep.** Every `electron-vite build` writes `THIRD_PARTY_NOTICES.txt` (scripts/licenses.mjs:
  production dependencies + the devDependencies the build bundles, transitively, with licence texts, plus
  resources/licenses/models.json) to `out/web` (served at `/THIRD_PARTY_NOTICES.txt`) and `out/` (electron-builder
  `extraFiles` → next to Vesper.exe). `resources/` (wintts.ps1, sysstate.ps1, Silero VAD, model licences) ships via
  `extraResources`; `out/test-workers` and `out/release-check` never do. `VESPER_OUT_DIR` builds elsewhere;
  `npm run release:check` builds the release flavour there and fails on any test hook, test route or `VESPER_*`
  switch left in a bundle (`VESPER_READY`, the headless server's stdout marker, is allowed).
- **H9 Key check on save is skippable** (the option exists; the AI-provider editor does NOT use it — see the note at
  the end of this item). `SecretPut.check?: boolean` (default true). The AI-provider editor (Settings
  and the wizard) sends `check: false` because it runs its own Test right after saving and shows the mapped result
  in place (07 D11, 10 s limit); other callers keep engine-int's save-time refusal of a definitely wrong key.
  *Merge note (Phase 4a):* the orchestrator kept int-shell-settings' behaviour instead — the editor saves WITHOUT
  `check: false`, so a key the provider refuses is never stored and shows in the key field ("OpenAI rejected this key
  (401)…"); the Test that follows fills the model list.
- **H-auth-net-1 Session lifetime on open sockets (Phase 4c, F01).** One rule set, `sessionExpired()` in
  src/server/auth/core.ts, serves REST (`resolve`) and every open WebSocket (`AuthCore.stillValid`, re-checked on each
  hub ping tick, 20 s): revoked, pending, idle (settings) or past the absolute limit → close 4401. Any client frame but
  the automatic `pong` (chat, subscribe, client.state, mic audio) counts as activity: `AuthCore.touch`, throttled to
  once a minute like `resolve`. A tab that only answers pings is idle. Like `resolve`, `touch` checks the session
  before writing: a frame that arrives after the session ended (e.g. a laptop waking past the idle limit before the
  next tick) is dropped, the socket is closed 4401 at once, and `last_seen_utc` is not refreshed.
- **H-auth-net-2 Local-browser lifetime by listener, not by kind (F07/F12).** Every non-desktop device created on
  Listener A — password login or "Open in browser"/local pairing — gets the 30-day absolute limit of 07 B4, and its
  cookie Max-Age matches the device's limit (30 d loopback, 180 d LAN/tailnet). Redeeming a pairing code from a
  browser that is already signed in revokes that browser's previous non-desktop device (as login does), so repeated
  "Open in browser" clicks no longer pile up live devices.
- **H-auth-net-3 B10 redaction regex widened (F06).** Key-shaped strings are `/\b(sk|pa|al|gsk|xai)[-_][A-Za-z0-9_-]{8,}/`
  (ElevenLabs `sk_…`, Groq `gsk_…`); auth schemes are `Bearer|Basic` (any case) plus `Token` (case-sensitive, ≥ 16
  characters: Deepgram) so prose such as "invalid token received" stays readable.
- **H-auth-net-4 Request caps (F02/F03).** `receiveUpload`'s request cap is `max(110 MB, file caps + 1 MiB)`:
  attachments keep 07 B6's 110 MB, imports get their 200 MB. `readZip` pushes the archive into fflate in 16 KiB slices,
  so at most ~16.5 MiB is inflated before the per-entry/total caps run. Cross-site reads (07 B15) are refused for any
  request whose matched route or decoded path is under /api, and for any non-public route (F05).
- **H-auth-net-5 Tailscale watcher (F08).** While Listener C runs, the access manager re-probes Tailscale: with
  backoff (5 s doubling to 60 s) while C has no ts.net name (tailscaled not Running yet at sign-in), then every 5 min to
  follow a rename or a stop. A change runs the one serialized reconcile (Host allow-list, Serve mapping, warnings).
- **H-auth-net-6 Uninstall cleanup (F74, completes 07 B14).** build/installer.nsh (`customUnInstall`, skipped on
  updates) runs `resources\uninstall-cleanup.ps1`, generated from src/server/net/uninstall.ts. It turns off the
  Tailscale mapping recorded in `%APPDATA%\Vesper\tailscale-mapping.json` (the app writes it next to the kv record) only
  while HTTPS 443 still proxies to that 127.0.0.1 port, and deletes the "Vesper (LAN)" rule of this installation's
  Vesper.exe with one UAC prompt, only when that rule exists and never in a silent uninstall. The script always exits
  0, so cleanup can never block an uninstall.
- **H-mem-1 Memory privacy and keyword memory (Phase 4c, fix-memory-privacy; findings F14–F16, F27, F29, F30, F37,
  F71, F72).**
  - *Keyword memory for the AI is always on (F37, F27; supersedes research 02 §5.7 "Memory off (global)").*
    `settings.memory.enabled` is the **Voyage switch** ("Remember with Voyage AI") and nothing else: it decides
    embedding, query embeddings and rerank. The AI's memory (memory functions, links, the C13 manifest, auto-recall)
    is on unless the chat's own switch is `off` — one definition in `chat/context.ts memoryOn`, `memory/scope.ts
    resolveScope` (no global refusal any more) and the web chip (`chips.logic memoryOn`); session `on` ≡ `inherit`.
    Without Voyage everything runs by keywords (FTS5) on this PC, as the Settings callout says. `MemoryStatus.state
    'disabled'` now means "Voyage off" (chip: "Keyword only"). MemoryService `search`/`sessions` return `refused`
    (additive) and the model reads the refusal text, never an empty "No matching records"; the manifest note skips a
    refusal. Before a session's first epoch exists, auto-recall excludes the message being answered (it is already
    FTS-indexed and was recalled back to the model).
  - *Private and memory-off text never reaches Voyage from the UI search (F14).* A semantic search over all chats runs
    Voyage (query + rerank) only over chats that are not private and not memory-off; the others are searched by
    keywords and merged by score. Defence in depth: `Engine.search` never puts a message of a private, memory-off or
    trashed chat into rerank documents, whatever ids it is given. Session-scoped semantic search on such a chat is
    keyword-only.
  - *Embedding context (F15).* The "In reply to:" / "Replying to:" neighbour must be `deleted = 0 AND hidden = 0`,
    else the message is embedded without context (never an older turn). Deleting/forgetting a message also deletes
    the next on-path message's vectors and re-queues it (only when it had vectors — consent, 07 C12).
  - *The B9 daily purge runs (F16).* `messages.softDelete(id, now?)` (additive) stamps `meta.deletedUtc`; restore
    removes it. The content server's idle maintenance tick calls `memory/purge.ts runDailyPurge` once per UTC day
    (kv `memory.purge.lastDay`) **before** the daily backup and GC: chats trashed > 30 days are hard-deleted; messages
    deleted > 30 days keep their tombstone (07 C3) but lose body, attachments (`'[]'`, so GC frees the files),
    vectors/bits/queue, `memory_injections` (as message or turn) and get `meta.purgedUtc`; their wire turns keep
    roles and tool-call ids with every text/attachment/result replaced by `(deleted)` and reasoning dropped (the
    transcript still pairs calls with results). `kv chat.recap:<sessionId>` (extractive recaps quote messages) is
    deleted for purged sessions and sessions with cleared messages, also by Empty trash. Deleted rows without a stamp
    (before 4c) start their 30 days at the first purge. Restoring a purged message answers 404. Job spec gains
    `nowUtc`, result `cleared` (both additive). The job ends with `wal_checkpoint(TRUNCATE)`; on the main connection
    when no worker is available. The Trash text says backups keep a copy until they rotate out (~5 weeks).
    *Recalled copies (second pass):* auto-recall, memory_search and memory_recall write records VERBATIM into the
    asking chat's wire transcript (the user row's `memory_result`, a tool row's `tool_result` / text-mode
    `memory_result`). Before any content goes, the purge job (cleared messages and every message of a purged chat,
    incl. Empty trash) scans every transcript row holding a memory/tool result and replaces each record of those
    messages — matched by its exact rendered body (neutralised, clipped at 1200, with its `[Attached file …]` line) —
    by `[<when> · <age> · <who>] (deleted)`; other records, the user's own words and tool-call ids stay
    (`memory/engine/redact.ts`). It does not depend on `memory_injections` (Forget removes those at once).
    *Maintenance order (B9):* purge → attachment GC (files + `attachment_text`/`attachment_fts`) →
    `wal_checkpoint(TRUNCATE)` (db.worker's checkpoint job, else the main connection) → the day's backup, so neither
    the database, its WAL nor that backup keeps a purged message's or trashed chat's file text.
    Not covered: an epoch recap or session summary written before the delete may still paraphrase the message until
    the next recap/summary replaces it; the AI's own replies that quoted it are messages of their own and stay.
  - *Access changes reach the AI (F29).* `CtxSnapshot.a` (optional; older snapshots lack it → no change assumed)
    hashes the effective scope and, below `all`, the reachable chat ids (`resolveScope` on the main store). A change
    — memory scope, Settings default, a linked chat turning private or memory-off — re-sends the manifest note.
  - *Recall refusals keep their reason (F30).* memory_recall returns MemoryService's fixed refusal (not linked + the
    `/link #X` hint, no such ID, private, memory off); the only variable is the normalised short ID (07 B7 holds).
    A target out of reach says why, and the `/link` hint is given only when a link would help: the target's own
    memory is off ("Memory is turned off for conversation #X, so it can't be recalled."), the asking chat's scope is
    `this` (narrowed or private: "…limited to itself… The user can widen it in this chat's memory settings."), or a
    temporary chat whose scope is below `all`; otherwise "not linked" + `/link #X`.
  - *Temporary chats' "Remembered" chip (F71).* A temporary reply's recalled messages are recorded in its own
    in-memory store's `memory_injections` (vesper.db message ids, temporary turn id) and served from there; ids never
    cross stores, and the rows vanish with the chat.
  - *Words inside attachments are searchable (F72).* Migration 10 `message_attachments(sha, message_id)` (triggers on
    messages insert / `attachments` update / delete, one-time backfill) links `attachment_fts` hits to the messages
    carrying the file. The keyword leg (memory_search, auto-recall, UI search in both orders and semantic mode) merges
    them with message hits, filtered the same way (scope, deleted, hidden, off-path). UI snippet `file.pdf: …«word»…`;
    the model's record and rerank documents append `[Attached file "file.pdf": …words…]` (neutralised like any
    record, 07 B7).
- **H-CE1 Control tags are tolerant (fix-chat-engine, F22/F38; A3, R13).** `shared/tags.ts` recognises a control tag
  whatever its casing (`[Tone=happy]`), with spaces/tabs inside the brackets (`[ tone=calm ]`), `-` for `_` in a
  function name, and `=` or `:` as separator (`[tone: warm]`, `[memory_search query: "x"]`); a bare value fills a
  function's main parameter (`[memory_search: lisbon]` → query). `[tone]`, `[toner=x]`, `[note: …]` stay text.
  `CONTROL_TAGS` = `tone` + every `MEMORY_FUNCTIONS` name (so `[memory_sessions …]` is hidden and run in text mode).
  `neutralizeControlTags` (used by both untrusted renderers) covers every accepted form.
- **H-CE2 Turn errors (F54/F61/F68; C19).** New codes `provider_error` (a 5xx that is not "busy": 500/501/…, OpenAI
  `server_error`, Anthropic `api_error`; message carries `(HTTP n)`, Try again + Fix in Settings, one automatic retry
  like overloaded) and `provider_empty` (see H-CE4). `provider_overloaded` = 502/503/529 or an overloaded/unavailable
  body. A turn's catch maps only adapter-stream failures with `mapProviderError`; everything else goes through
  `toApiError` (`disk_full`, retryable `db_error` for busy, `internal`). A provider payload that isn't valid JSON is
  `provider_bad_request` "sent a reply Vesper couldn't read", retryable. Catalogue texts describe the final state:
  rate → "Try again in a moment" (the button counts down `retryAfter`; no auto-retry), context → "too long for the
  model's context window… shorten it or choose a larger model" with Fix in Settings, history → "Try again".
- **H-CE3 A reply that can't be saved (F28/F58; C19 SQLITE_FULL).** The turn always ends: `reply.status 'error'`,
  `reply.error` (`disk_full` "isn't saved yet… tries again every 30 seconds", else `db_error`) and `reply.done` with the
  full text as an in-memory error row. The intended update is kept in memory and retried every 30 s (test option
  `VESPER_CHAT_SAVE_RETRY_MS`), after the next successful save and once on close; when it lands, `message.updated` +
  `session.updated` go out and the deferred memory hooks / title run. Unsaved on quit → the last checkpoint (C6).
- **H-CE4 Empty and cut-off answers (F63).** Adapters read the response type: an HTML page → `provider_bad_request`
  "answered with a web page, not the AI service's API"; a JSON body (server ignored `stream:true`) is read as the
  reply. A round with no visible text (empty stream, only thinking, output limit spent) → `provider_empty` (its
  transcript rows dropped, C6); `finish_reason length`/`max_tokens` with text completes with `Message.truncated`
  (additive) and the note "Cut off at the model's length limit".
- **H-CE5 Recap drafts follow the path; regenerate chooses its epoch (F24/F25/F26; C3/C4/C7, B9).**
  `epochs.recap_draft` holds JSON `{v:1, text, through, hash, force}`: the last seq and a hash of the message ids the
  recap read (on-path, not deleted/hidden/empty/streaming). A draft is used only while the path still holds exactly
  those messages (and ≤ 4 after them); otherwise it is dropped. `newEpoch` (delete-and-refresh, apply protocols)
  marks the epoch `force` synchronously, always recomputes, and no longer fails with `session_busy` while a reply
  streams (the next turn rolls over). A regenerate picks its epoch like a send: no effective epoch (imported
  history) → an epoch at the user turn with a recap of what came before; a tool-capability switch, a forced refresh,
  the hard window or a user turn without a wire row → rollover at the user turn, whose rows are (re)written into the
  new epoch; the context-overflow rollover + retry applies to regenerate too.
- **H-CE6 Utility tasks of local chats stay local (F69; C18, B13).** Titles, summaries, epoch and `/continue` recaps
  of a chat whose own profile is on this PC (`llm.local` disclosure) run on that profile (its model) whenever the
  utility profile is not on this PC. Other chats keep `llm.utilityProfile`.
- **H-CE7 `chat.send` is idempotent (F62; C16).** `chat.send.clientMsgId?` (additive): the server answers a repeat of
  a (session, clientMsgId) with the original ack (in memory 10 min, then the user row's `meta.clientMsgId`) and never
  makes a second turn. The client sends with `ws.request(…, {resend: true, timeoutMs: 60 s})`: a drop re-queues the
  same frame for the next `ready` instead of failing it; the composer gives text back only when the send failed or
  no connection came back in time, and sending that text again reuses its id.
- **H-CE8 A tag cut off by the end of the stream is swallowed (F22 second pass; research 04 §7.3).** At end of stream
  `TagFilter.end()` drops a held `[` + whole control-tag name + its separator (`[tone=warm`, `[Tone: warm`,
  `[memory_search query="lisb`) up to the end of its line; a bare `[`, `[to`, `[tone`, `[tone of voice` stay text.
- **H-CE9 `finish_reason: "error"` is `provider_error` (F54 second pass).** A stream that ends with stop reason `error`
  (OpenRouter/vLLM internal failure mid-generation) is `provider_error`, never "busy"; before any visible text it gets
  the same single automatic retry as a 5xx; after text the text is kept on the error row and nothing is retried.
- **H-CE10 An unsaved reply is served as reply.done showed it (F28 second pass; C19).** While a reply waits for its
  save retry, `GET /api/sessions/:uid/messages` returns the in-memory message (full text, status `error`, the
  `disk_full`/`db_error` "not saved" error) instead of the stale streaming checkpoint (`ChatService.unsavedReplies?`,
  additive); a reconnect replays reply.done or, after a gap, refetches that page. A pending save whose message was
  deleted or whose chat is gone (trash emptied) is dropped (logged at info); a chat in the trash is saved without
  memory indexing, title or summary.
- **H-CE11 Delete and refresh reaches the whole recap chain and survives a rollover in progress (F24 second pass;
  B9, C4).** A `refresh-context` draft carries `purge`: its recap (now, or at the forced rollover) is rebuilt without
  deleted messages from the newest on-path epoch that starts at or before the earliest deleted message before the
  current epoch (or from the session's start, map-reduced as usual), so text an earlier recap or "last messages"
  tail already held leaves the chain. Each request gets an `ask` id: a rollover that was already condensing when the
  refresh came carries `force`/`purge` onto the epoch it creates, so the next turn rolls over again. Repos: additive
  `epochs.onPath(sessionId)`.
- **H10 Temporary files after a crash (fix-platform, F04/F18/F64).** Every start removes `%TEMP%\Vesper-<pid>` folders
  of earlier runs (src/server/system/tempSweep.ts): only `Vesper-<digits>` directories (never a link), only Vesper's
  own (the `.vesper-temp` marker written at start, or — folders from before the marker — nothing but `attachments/`
  and `tts/`), and only when that pid is not running (EPERM counts as running). Windows ends sessions without
  will-quit, so the window's `session-end` (and powerMonitor `shutdown` elsewhere) also removes ours synchronously,
  best effort. "Temporary = gone after the app quits" now also holds after a crash, a kill or a Windows shutdown, at
  the latest at the next start. Test switch: `VESPER_TEMP_ROOT` (the release layout under a test root).
- **H11 Damaged settings.json (fix-platform, F59).** Writes are temp file + fsync + rename, and every write also
  refreshes `settings.json.bak`. A file that can't be used is never lost: its exact bytes are kept as
  `settings.json.bad-<YYYYMMDD-HHMMSS>` (5 newest; an identical copy is not made twice); unparsable or unreadable →
  `settings.json.bak` (written back) → defaults only without one; invalid values are still salvaged leaf by leaf
  (and the repaired file is written back too, so the owner is told once, not on every start).
  The outcome (`repaired` / `restored` / `reset`) is `Bootstrap.health.settingsRecovered`: a toast on the PC and a
  banner at the top of Settings (Open folder, plus Set up again for `reset`). With `reset` the desktop opens Settings
  instead of silently re-running the wizard.
- **H12 Damaged database (fix-platform, F60; amends C19 "corruption → read-only + restore dialog").** Before anything
  opens vesper.db for writing, a read-only connection of its own checks it. The full `PRAGMA quick_check` reads every
  page (measured: 246 MB → 0.4 s with a warm cache; a long-time user's file with FTS5 and vectors is GBs, so seconds
  from a cold disk), so it runs only when the last run did not leave the file at rest: RunningServer.close() writes
  `db-clean.json` (local dir: the file's size and mtime) after the database closed, and so does a Windows session end
  (`markDatabaseAtRest`: WAL checkpoint TRUNCATE, then the marker; the process is killed without close()). The start
  takes the marker (reads and deletes it); with no marker (crash, kill, power cut, first start of a build), a marker
  that does not match the file (size, mtime, a non-empty WAL — any write after it voids it), or a restore just
  applied, the full check runs; otherwise only the header and schema are read (3 ms; still stops "not a database").
  Damage that appears while running, or on disk while Vesper is not running without changing size/mtime, is met as
  SQLITE_CORRUPT when SQLite reads it, and the next start after a crash checks in full. Damage (or
  SQLITE_CORRUPT/NOTADB while opening) stops the start with `StartupDbError('DB_CORRUPT')`
  listing the newest backups that pass checkBackupFile. Instead of a read-only app mode (every start writes:
  migrations, device sessions), the damaged file is never written to and the desktop asks natively: "Restore the
  backup from <date>" / "Start fresh (keep the damaged file)" / "Quit". Either choice moves vesper.db, -wal and -shm to
  `backups/damaged-<stamp>/` (never deleted) and starts again; the standalone server prints the choices and takes
  `--restore-backup[=<file>]` / `--start-fresh`. openDb closes its handle when a PRAGMA fails. A failed migration is
  classified by cause: SQLITE_FULL / ENOSPC (also while writing the pre-migration copy) is `StartupDbError('DB_DISK_FULL')`
  — the dialog says to free space on the drive and offers Try again (ENOSPC or errcode 13 anywhere in the start gets
  the same dialog); an error from the PC (I/O, busy, locked, no memory, read-only, can't open) is rethrown as it is
  (the generic dialog with Try again); only the rest is `StartupDbError('DB_MIGRATION_FAILED')`: its dialog says the
  data was put back and offers Quit only (F67). Each migration keeps only the 2 newest pre-migration copies
  (`KEEP_PRE_MIGRATION`; the normal retention keeps 3) and never the copy it has just written (it counts as one of
  the 2 whatever the dates in older names say — a clock that was ahead must not make it look oldest).
- **H13 SystemHealth, low disk, failed backups (fix-platform, F66).** `Bootstrap.health?: SystemHealth`
  `{settingsRecovered, lowDisk, lastBackupError}` (additive), re-sent as `health.changed`. Free space of the roaming
  and local drives is checked at start, every 15 min and before each daily backup: below 200 MB (cleared above
  300 MB) daily backups are skipped, memory backfill pauses (`setBackgroundPaused('low-disk')`) and one PC
  notification says so; model downloads keep their own check. A failed backup (daily or manual) is recorded with its
  code (ENOSPC / SQLITE_FULL → `disk_full`) and shown on Settings → Data and as a toast; a failing daily backup
  notifies once per code and day (it is retried every tick); the next good backup clears it. Test switches:
  `VESPER_FAKE_FREE_BYTES`, `VESPER_HEALTH_INTERVAL_MS`.
- **H14 WAL checkpoints without db.worker (fix-platform, F65; extends H5).** When the worker is gone for good (or dies
  during the checkpoint job) or no memory service exists, WalWatch's checkpoint runs `PRAGMA wal_checkpoint(PASSIVE)`
  on the main connection (TRUNCATE only when WalWatch already decided so: over 64 MB and nobody looking).
- **H15 Reply notifications, diagnostic logging, tray mic dot (fix-platform, F21; 07 B10/B17).** A finished reply
  (complete, not hidden, not empty) notifies on the PC when `chat.notifyWhenHidden` is on and no desktop window is
  visible and focused. Without `chat.notificationPreviews` it reads "Vesper: A reply is ready."; with it, the chat's
  title and a plain one-line preview (180 chars) — never for a temporary chat (Windows keeps notifications). Game mode
  holds them (notifyGate). `data.diagnosticLogging`: while on, the text of user turns and finished replies (not
  temporary chats) goes to the log, still redacted; the time it was turned on is kv `diag.enabledUtc`, and it turns
  itself off 24 h later (timer and at start). The tray icon gets a red dot and a "microphone in use: <devices>"
  tooltip while any device streams mic audio (`SystemServer.onMicActivity`). Chat events are observed by wrapping
  `ctx.hub.emit` (src/server/system/replies.ts), the way notifyGate wraps `platform.notify`.
- **H-F31 Barge-in needs heard audio (fix-voice).** C15's barge-in (stop the turn, store `interrupted` +
  `spoken_chars`, the next turn's note) applies only once some of the reply's audio may have been heard. A
  `speech.cancel` before that — no audio sent to anyone yet, or the canceller says `beforeAudio: true` (additive
  field: nothing of the reply started playing there) and is the reply's only speaker — stops speech everywhere but is
  not a barge-in: the job ends `'cancelled'`, every speaker gets the targeted `reply.snapshot` + deltas (as for
  text-first), the LLM keeps streaming and the reply is stored complete. The client's tracker goes to the new
  `ReplySpeechState` `'cancelled'` (text, no "— interrupted", no toast). Typing or dictating right after sending no
  longer discards the answer; engine-int's "barge-in still stops the LLM stream" still holds for heard speech.
- **H-F32 The first-chunk 6 s clock starts when the voice is being made (fix-voice).** C14's "a chunk not ready
  within 6 s" is measured, for the first chunk, from the new targeted `speech.preparing {replyId, index:0}` event
  (additive), which the speech job sends each speaker when it dispatches chunk 0 for synthesis — not from the first
  streamed text — and at the latest from reply.done. Before that the server holds speech back on purpose (A2
  waitForTone / 'end' placement, a first sentence shorter than 40 chars, a memory tool round). Replays
  (`speech.replay`) get the same first-chunk deadline: their chunk 0 starts before the server acks the request, so
  the client remembers a `speech.preparing` for a reply it does not expect yet (bounded, used once) and starts the
  clock when it learns the replay's id from the ack.
- **H-F33 The reveal hides boxes, not only glyphs (fix-voice).** C14's highlight-only mechanism stays (no per-glyph
  spans), but highlights cannot paint list markers, borders, backgrounds or images. The RevealController therefore
  marks every element of a revealing (or frozen) root whose first visible char is still hidden with
  `data-unrevealed` (`visibility: hidden`, layout unchanged), and unmarks it in the same frame as that char starts to
  fade in; an element without text (rule, image) waits for the next char. Plain unclassed inline elements and the
  inside of code blocks are not marked; `[data-reveal-skip]` UI (code header, link host) shows with its nearest
  marked ancestor. All marks are removed on done/finish/unbind.
- **H-F34 Exact chunk boundaries inside a paragraph (fix-voice).** While a reply is held (synced reveal), the
  markdown renderer also wraps every positioned text run outside code, tables and math — blank ones between inline
  elements too — in `<span data-src-start data-src-end data-src-text>` (hast text-node offsets; the pieces of a text
  node split around a `#K7Q2MX` chip keep theirs); a chunk boundary inside a run that renders its source char for char
  maps exactly, and so does a boundary on a run's edge (a sentence ending right before `**bold**`, `code` or a link).
  Text an element owns directly on both sides of such runs forms one block for that element, never several
  fragments that each claim the whole element's source range. Where a run differs from its source (an escape, an entity) or a root
  is untagged, the boundary is aligned with the chunk's own source words (`SpeechChunkHeader.text`, minus link
  targets, list markers, task boxes, footnote refs and entities), never with its spoken words — the server's spoken
  rewrites ("~5" → "about 5", "e.g." → "for example", "vs" → "versus") used to pull the next sentence's first words
  into the chunk. C14's `buildRevealMap` still uses `spoken` for timing inside a chunk.
- **H-F35 Cloud transcription failures (fix-voice).** C19's "overloaded/network → one retry" now applies to cloud
  STT: a network error, 5xx or 429 on an utterance's upload is retried once after a short pause. If it still fails,
  the server ends that mic session with `stt.state 'error'` (no "listening" after it, no phantom session, idle unload
  armed) and the client also sends `stt.cancel`. Talk mode (a persistent session) treats a retryable error as a lost
  utterance — toast "… please say it again" — and opens a new STT session (bounded by the reopen guard) instead of
  ending; non-retryable errors (rejected key, quota) still end it with the error.
- **H-F36 Push-to-talk is heard while a reply speaks (fix-voice).** D6's "frames not sent while TTS plays unless
  bargeIn voice" is one shared rule, `micHeldForTts()` in src/shared/micGate.ts, applied by the client gate and the
  STT process alike, and it exempts push-to-talk: holding the key is an explicit "I am talking now". With barge-in
  'off' the reply keeps speaking and the held words are transcribed and sent (they used to be dropped silently by the
  process); a reply that ends mid-hold no longer discards what was said so far. Dictation and conversation still wait.
- **H-F20 OpenAI-compatible voice servers have their own privacy text (fix-voice).** B13's just-in-time text for
  voice out comes from one helper, `ttsDisclosure(provider, baseUrl)` in src/shared/privacy.ts, used by Voice
  settings, the wizard and Settings → Privacy. An OpenAI-compatible server is never shown OpenAI's terms: on a
  loopback address it "stays on this PC unless that server passes it on"; anywhere else Vesper "can't tell what this
  voice server does" (named by its host, no terms link). Loopback means one strict rule everywhere
  (src/shared/loopback.ts, also used by the base-URL check and the LLM privacy text): a 127.x.y.z literal, ::1,
  localhost or *.localhost — a DNS name that merely starts with "127." (127.voice-cloud.net) is remote.
- **H-F73 The global push-to-talk hotkey keeps the tray window loaded (fix-voice).** D2's warm-window destroy
  (`desktop.keepWindowWarmSec`) does not apply while `voice.globalHotkey` is registered: the window hidden in the
  tray stays loaded, so a press after 30 s in the tray still reaches a desktop client (it used to be dropped with
  only a log line). It is freed again when the hotkey is turned off. When the hotkey is registered and no window
  exists — a "Start with Windows" (`--background`) launch never opens one — the shell loads the window hidden in the
  tray right away (Open shows it as usual). A press that still finds no desktop client loads it the same way and is
  queued until the page has loaded and connected (retried for 10 s; a second press meanwhile cancels it, as the
  toggle would). Only if that fails does a native notification (at most once a minute) tell the owner.
  The setting's hint says so, and now describes the toggle correctly (press to talk, press again to send).
- **H-cs-1 Client privacy and link rules, Phase 4c (fix-client-sec).**
  - *B13 "on this PC" is decided by the address* (F19): `llmDisclosureId` uses the base URL host for every preset.
    Ollama/LM Studio at a loopback host (`localhost`, `*.localhost`, 127/8, `::1`) → `llm.local`; at any other host
    (LAN, tailnet, public, even this PC's own LAN address) → new `llm.self-hosted` (training `unknown`, leaves the PC).
    A loopback *custom* address → new `llm.local-custom`: research 08 §4.3a plus "unless that program forwards
    requests online" (§4.2's note), still "Stays on this PC". `llmStaysOnPc(id)` drives badges, the Privacy page and
    the model chip. Ollama `…cloud` models stay `llm.ollama-cloud` wherever Ollama runs.
  - *Disclosure sources* (F23) must be URLs the research lists (unit test); Voyage → `https://www.voyageai.com/tos`.
  - *B8 images* (F10): `<img>` renders `/api/attachments/<64 hex>` (optional `?thumb=1`) matched exactly on the raw
    string, plus `blob:` and `data:image/(png|jpeg|gif|webp|avif)`; anything else (dot-segments, `%2e`, `\`, other
    routes) is dropped.
  - *B8 links* (F11): the text names the destination only when a word of it parses (as a URL, or a domain) to the same
    host (lower-case ASCII/punycode, `www.` and a trailing dot ignored); prefixes and substrings never count, and text
    with userinfo never names its host. (F13) The confirm also runs on middle-click (auxclick), the remote-image
    "Open in browser" shows the same private-host/long-data warning, and "long data" also means a path > 200 chars, a
    fragment > 120 or a host label > 40; IPv4-mapped/unspecified IPv6 count as private.
  - *B9 temporary drafts* (F09/F17): a temporary chat's draft lives in memory only (this tab); drafts are removed on
    `session.deleted`/`session.ended` and drafts of chats that are gone or temporary are swept once per start (from
    the chat list, ordinary + archived; nothing is removed when the list can't be read). (F70) Whether a chat is
    temporary comes from its detail or its row and, once known, never changes for the open chat; while unknown, an
    upload asks the server first.
  - *B2 sudo prompts* (F49): opening a page never asks for the password; Settings → Data reads the (sudo-gated)
    backups list with `noSudoRetry` and offers "Show backups". A pending prompt closes (its retry is rejected) when
    the user leaves the page that asked.
- **H-cs-2 Client privacy, Phase 4c second pass (fix-client-sec).** Supersedes parts of H-cs-1.
  - *B13 a loopback custom address* (F19): `llm.local-custom` is still listed with what stays on this PC
    (`llmStaysOnPc`), but no absolute claim is made for it (new `llmMayForward(id)` / `llmPlace(id)` in
    src/shared/privacy.ts): the Privacy header says "Stays on this PC unless your local program forwards it" (not
    "Nothing leaves this PC"), its card and the provider editor say "On this PC, unless the program forwards it" /
    "On this PC, unless it forwards" (neutral, not the green "On this PC"), the "what stays on this PC" item is
    "A program on this PC", and the model chip's label and picker say the text goes to a program on this PC that may
    pass it on. Ollama/LM Studio at a loopback address keep the absolute wording.
  - *B9 drafts* (F09): a cleared draft stays cleared — after `session.deleted`/`session.ended` the open Composer's
    unmount save is ignored for that chat until a composer opens it again (e.g. restored from Trash). Every signed-out
    landing (sign-out, revoked, expired, or a browser that opens signed out) removes all drafts on that browser,
    storage and memory, before the app leaves the chat.
  - *B8 private hosts* (F13): a trailing root dot names the same host (`localhost.`, `router.lan.`, `nas.local.`).
- **H-ux1 CSS class ownership (fix-ux, F46).** Every stylesheet is global once loaded and lazy route chunks are never
  unloaded, so a BEM block (`.x`, `.x__y`, `.x--z`) belongs to exactly one area (a feature folder, app/, components/,
  styles/, lib/). tests/unit/web/css-scope.test.ts fails when two areas define the same block top-level, or when a
  feature styles another feature's block even from inside its own scope; the kit (components/), styles/ and the app
  shell may be restyled in context. Settings rows are `.set-row*` and its external link `.set-xlink` (the sidebar
  keeps `.srow*`).
- **H-ux2 Badge and accent inks (fix-ux, F48; 04, D9).** Tokens gain `--info` and state-text inks `--success-ink`,
  `--warning-ink`, `--danger-ink`, `--info-ink` (dark: equal to the tones; light: #166534, #7a4508, #a61b1b, #075985);
  badges use them on their 16 % tint. Light-theme `--accent-ink` is one step darker per accent (gold #7a4f00, violet
  #5b3cc4, rose #a82a42, aurora #0b6646, ice #075985) so accent text stays ≥ 4.5:1 on every surface and on the
  accent's own tint. kit-contrast.test.ts checks every badge tone × theme × accent × surface.
- **H-ux3 Device approval focus (fix-ux, F50; B16).** The approval dialog opens with focus on "Decide later" (it only
  hides the prompt), never on Allow: the prompt arrives over WebSocket while the owner may be typing. Allow needs a
  deliberate click or Tab.
- **H-ux4 One read-only notice (fix-ux, F55; B2).** The Settings shell no longer adds its own banner for
  `desktopOnly` sections; every page's `ReadOnlyNotice` (worded from the device's real write rights) is the only one.
- **H-ux5 "Reconnecting…" placement (fix-ux, F57; C16).** Inside the app shell the banner is an in-flow strip under
  the top bar (it pushes the page down, never covers it), one line on phones with a short label ("Reconnecting in
  4 s…"). Bare pages (setup, Talk mode) keep the floating pill, now never wider than the window.
- **H-ux6 Memory viewer entry points and previews (fix-ux, F52/F53; R7, R11).** The sidebar footer has labelled
  Memory and Prompts links, Ctrl+K offers "Memory viewer" (also found by "timeline") and "Prompt library", the
  Settings nav lists both under the sections, and the panel's memory section links to the viewer. Timeline previews of
  AI replies drop markdown markup (plain text, never HTML) but lose no word the chat shows: raw HTML such as
  `List<String>` stays literal text (as in chat, B8), an image reads `[image: alt]` (or `[image]`), task items keep
  their box and a list keeps one item per line. The owner's own messages stay as typed; Copy still copies the stored
  text.
- **H-presence-1 (fix-presence-soak, review F39) The chat view's Star stage.** 01-VISION's "Star (compact stage)" above
  the messages exists now: presence `<ChatStage>` (rendered by the shell on `/s/:uid`, desktop only) is a band across
  the chat column registered as stage target kind `band` (priority 15: above the top bar's 30 px `compact` slot,
  below a sized `<Star>` (20), Talk mode (30) and the Constellation (40)) — the same one canvas moves there (D5). The
  band is a fixed 84 px (a band that changed height moved the messages under the reader — the synced reveal's
  no-layout-jump gate caught a 92 px jump); the Star in it is 72 px and grows over the top of the messages to 168 px
  (112 px on windows under 560 px tall) while it is `speaking` or `listening`, then shrinks back; in game mode it
  never grows (D3). The state is written beside it (D9) and sized stages get the pause
  button. Phones keep the compact header (D8). "Show the Star above the chat" off (or style Off) removes the band —
  the setting now does what its label says. A top-bar toggle ("Hide/Show the Star above the chat") collapses it per
  device (`localStorage['vesper.chatStageCollapsed']`), sending the Star back to the 30 px slot. Talk mode has visible
  entries: a "Talk mode" button in the chat's top bar (desktop and phone) and "Talk instead" in an empty chat.
- **H-presence-2 (fix-presence-soak, review F51) Talk mode errors have a way out (D13).** `talkErrorWayOut(error)`
  (talk.logic.ts): a missing/damaged/refused speech model makes setup the big button ("Download the speech model" →
  Settings → Voice in; Space does the same) instead of a retry that fails the same way; recognizer errors keep "Try
  again" and add "Open Voice in settings"; every error offers "Type instead" (back to the chat). Talk mode's own mic
  error is cleared from the voice slice when Talk mode ends (it no longer shows on composer mics), and a mic control
  showing a problem is named "Voice input problem — show help" (it was "Dictate" next to an aria-hidden red dot).
- **H-presence-3 (fix-presence-soak, review F44) One rAF chain.** `FrameScheduler` ignores `ensureLoop()` while it
  runs the renderer (kick/interact/pulse/requestFrame from inside a frame used to start a second chain each time) and
  reschedules at the end of the tick from the budget as it is then, never overwriting a handle. Gate: callbacks per
  second ≤ the display's own rAF rate (unit test with a fake rAF queue; e2e after 6 state crossfades; soak during
  30 min of Talk mode).
- **H-presence-4 (fix-presence-soak, reviews F40/F45) Leak gates as built (D14).** `npm run soak` = tests/soak/**
  (playwright.soak.config.ts), SOAK_SCALE scales every count (1 = the LEAK-1 table). Measurement: CDP
  `HeapProfiler.collectGarbage` ×2 + `Runtime.getHeapUsage` + `Memory.getDOMCounters`; a `getContext` wrapper and a
  `createObjectURL`/`revokeObjectURL` wrapper installed before the app (test harness, not app code); the server's new
  `GET /api/test/leaks` (test builds + test mode only): heap after a full GC (`v8.setFlagsFromString('--expose-gc')`
  inside the test route, so the server needs no flag), `process.getActiveResourcesInfo()` by type, hub / engine /
  speech / STT / auth / Windows-voice-host stats. A gate passes when the end is within its threshold of the
  post-warm-up value and the second-half trend is ≤ half the threshold. Interpretations of the LEAK-1 rows:
  "CSS.highlights.size 0" → no Range left in the reveal's 4 shared highlights (C14 registers them once by design);
  reveal bindings live while their rows are mounted and must be 0 after leaving the chat; "scroll a 1M session top ↔
  bottom twice" → jump to each end and page 5 times inward, twice (scrolling 10,000 pages would take hours and tests
  nothing more), then 200 jumps; the Kokoro row does not apply (E7: no Kokoro); "+STT ≤ 850 MB" runs the scripted
  recognizer with the real Silero VAD (no test may download Parakeet's weights), so it bounds everything but the
  model. D2 budgets are measured as the private working set (Task Manager's "Memory", read from the Windows
  performance counters) as D2 states; the commit charge (`memory.privateBytes`, what Settings → Resource use shows)
  is recorded next to it and is higher (in the tray ~280–370 MB, most of it the GPU process, which Chromium keeps
  after the window is destroyed). Soak specs pin `performance.gameMode` to off so a fullscreen game on the PC cannot
  change the run. Results: docs/05-TESTING.md §12.
- **H-presence-5 (fix-presence-soak, soak finding) Windows voice host lifetime.** `WinTtsHost` ignored its 10-minute
  idle default whenever the caller passed `idleMs: undefined` (createTtsProviders always does): the host quit after
  every request, and the supervisor (C19: ≤ 3 starts per 5 minutes) then refused the 4th Windows-voice reply within
  5 minutes with "Windows voices keep failing". Undefined options now keep their defaults, and a host stopped on
  purpose (idle, game mode, "Unload voice models now", close) resets the crash budget — only crashes count.
- **H-presence-6 (fix-presence-soak, second pass, review NEW-1; amends H-presence-1) The Star grows inside the chat
  stage, never over the messages.** A Star grown past the 84 px band (to 168 px) covered the top ~90 px of the message
  list: in the light theme its night window hid the text, and the canvas took clicks, selection and message actions
  meant for the rows under it (and could hide a focused row — WCAG 2.4.11). The band is now a fixed height tall
  enough for the active size and clips to itself (`overflow: clip`): 132 px with the Star 76 → 120 px; 108 px with
  64 → 96 px on windows under 760 px tall; 84 px with 56 → 76 px under 560 px. The band still never changes height
  (no layout jump, D7), it is still collapsible from the top bar, and the e2e gate probes the 100 px under the band
  during speech in both themes: nothing of the stage may be hit there.
- **H-presence-7 (fix-presence-soak, second pass of review F51; amends H-presence-2) Talk mode knows where it runs, and
  its entries check voice input first.** `talkErrorWayOut(error, place)` / `primaryAction(state, place)` take the
  device: setup actions ("Download the speech model", "Open Voice in settings") exist only in the desktop app — on a
  phone or remote browser Settings → Voice in only says "Download on your PC" — so off the PC a missing/damaged/refused
  model keeps "Try again" as the big button (it works once the PC has the model) and the notice says to fix it in
  Vesper on the PC. A mic error's own action is the voice feature's `micHelp(code, place).action`, the same mapping
  the composer's help uses: `mic_os_blocked` in the desktop app on Windows adds "Open Windows settings"
  (`ms-settings:privacy-microphone`). With `voice.stt.enabled` off, Talk mode's entries (top-bar button, Ctrl+K,
  `/talk`) go through `openTalkMode()` (presence barrel) like the voice-reply toggle: a toast "Talk mode needs voice
  input." with "Set up voice input" in the desktop app, or where to turn it on elsewhere; the empty chat's "Talk
  instead" is shown only while voice input is on. A direct `/talk/:uid` link still opens and explains itself.
- **fix5-client-P01 (Phase 5b, P01/P16) The live memory and game-mode status is seeded only from a fetched bootstrap.**
  `installLive` re-seeded `ui.memoryStatus` / `ui.gameMode` whenever the store's bootstrap object changed — and local
  spread copies (a settings answer, a saved secret, a health change) carry the fetch-time status, so "Keyword only"
  came back over a live `memory.progress` 'ready' right after the wizard. A bootstrap counts as new when its `memory`
  object is new (`isFreshBootstrap`: a fetched one is parsed from JSON; copies keep the fetched object); after that only
  `memory.progress` and `gamemode.changed` change them.
- **fix5-client-P02 "Preparing voice…" after the text is done.** A reply this client speaks whose text is complete but
  whose first audio has not started (speech 'waiting' at `reply.done`, e.g. the 07 H-F32 holds) keeps the Star at
  'preparing-voice' until the audio starts, fails or is cancelled; its row shows "Preparing voice…" over a shimmer
  instead of an empty body, without the footer (time, model, actions) or the Remembered chip, and `aria-busy`; the
  composer keeps Stop, which cancels the pending voice (F31: the text arrives, not "interrupted").
- **fix5-client-P08 Inline math (amends 07 D7's "single-dollar math off").** The renderer also typesets `\(…\)`,
  `\[…\]` (display, also when written inside a paragraph) and `$…$` when it reads as a formula: no space just inside
  either dollar, no digit right after the closing one, and a TeX command, `^ _ = { } < > +` or a single letter inside.
  `\(…\)` / `\[…\]` need the same formula-like body (a single letter only in `\( \)`), so escaped brackets in prose
  ("References \[1\]", "\[sic\]") stay text; `\[` alone on its own line opens a display block whatever it holds.
  Prices ("$5 and $10", "$5-$10", "$20,000") stay text; code and `$$…$$` are untouched. Implemented as a same-length
  rewrite per block before parsing (math.logic.ts: the delimiters become single dollars, a non-math `$` a private-use
  placeholder restored in the tree), so every `data-src-*` offset and the speech segmenter's chunk boundaries (R14)
  are unchanged; the segmenter still reads the original text.
- **fix5-client-P17 A slash command leaves the draft before it runs.** A recognised command (`commands.resolve` +
  `available`) is cleared from the composer and from its chat's saved draft before it runs, because a command that opens
  another chat (/new, /temp, /continue, /talk…) unmounts the composer, which saves what it holds; it comes back only
  when the command throws.
- **fix5-client-P18 An interrupted reveal collapses (07 C15 "collapsed '— interrupted · show rest'").** On barge-in the
  RevealController keeps the frozen text laid out and hidden (no DOM change, as before) but also limits the root's
  height to the bottom of the line holding the last revealed character (+4 px; re-measured when the width changes;
  restored by "show rest"/unbind). The live state now looks like the stored cut after a reload. Typing over a speaking
  reply interrupts it after the input event is handled (it used to re-render the composer first and lose the first
  keystrokes).
- **fix5-client-P19 "That was in another chat" (amends 07 F30).** When memory_search finds nothing and the asking
  chat's own ceiling is below 'all' (stored, not private, not memory-off), the keyword index is asked which chats
  outside its reach mention the query; up to 3 are named to the model by short ID only (never private, memory-off,
  deleted or temporary chats; never any of their text, titles or summaries), with "/link #ID" (scope 'linked') or
  "widen it in this chat's memory settings" (scope 'this'). The model's own narrower `scope` request does not count:
  the hint is about the chat's ceiling. No hint once a link brings the chat in reach.
- **fix5-client-P22 The /continue opener is spoken.** `POST /api/sessions` takes `speak?: boolean` with `continueFrom`
  (sent when the device speaks replies, `speakRepliesNow()`) and `speakClientId` (the tab's own socket id, which the
  WebSocket `ready` now carries as `clientId`). The engine picks the sender before any await: the tab named by
  `speakClientId` when it is a live socket of the requesting device, else that device's tab subscribed to the source
  chat (focused first), else its focused, audio-unlocked tab, so `/continue #ID` typed in another chat and the
  sidebar's "Continue in a new chat" speak too. That sender always speaks the opener whatever `perDevice` is (with
  'all' it is joined by other audio-unlocked tabs already on the new chat), although it subscribes to the new chat
  only after the turn starts; the synced reveal works as for `chat.send`. The opener's zone stays the source
  conversation's. The client claims the new chat's first
  reply (`reply.status` or the `subscribed` in-flight list) as expected speech, so it is held from the start.
- **fix5-client-P23 The wizard's Microphone step turns voice input on when the model in use becomes ready** (downloaded
  or "Use this model" on that step), as Continue would; a model already ready when the step opened changes nothing.
- **fix5-client-voice-autopick No old-provider voice after a switch (07 C22).** While a provider switch sent from the
  voice page is unanswered, the page does not auto-pick a voice of the provider being left (its voices may arrive in
  that window and the pick would reach the server after the switch: ElevenLabs with a Windows voice id). Found as a
  flake of the Guided setup e2e.
- **H-fix5-ui-1 (fix5-ui, Phase 5b P07; amends H11/H13) A health notice is shown once.** On Settings the banners at the
  top already show every SystemHealth notice, so `HealthHost` toasts nothing while the route is `/settings…` (the
  notice counts as shown), and arriving on Settings closes a health toast still up. Elsewhere the toast carries the
  short `HealthNotice.brief` ("Vesper kept a copy of the old file. Details are in Settings.") — the full text with the
  kept file's name is on the banner. With `reset` the desktop opens on Settings, so that case is banner-only. Inside
  Settings the banners are `Callout`s (rounded, bordered, tinted over `--bg-2`, secondary buttons), and any kit
  `Banner` placed in a Settings page (read-only notice, Access warnings) takes the same shape (P10).
- **H-fix5-ui-2 (fix5-ui, P03/P06/P07) Toast placement and layout.** Toasts stack top right under the top bar
  (`top: var(--bar-h) + var(--conn-h) + 10px`, 380 px wide) on every page instead of bottom right, where they covered
  the composer's Send/Stop/mic; on phones they span the width just below the top bar. While the "Connection lost"
  strip (or, on bare pages, the floating pill) shows, ConnectionBanner publishes the room it takes as `--conn-h` on
  the root element, so toasts start below it and never cover "Retry now". A toast's action sits on its own line under
  the text (icon | text | close on the first row), so the text keeps the toast's width. The frozen Toast API (E4) is
  unchanged. Test builds expose `__vesperTest.toast.show/clear`.
- **H-fix5-ui-3 (fix5-ui, P35; B13) Deepgram's disclosure is `training: 'no'`, version 2.** Deepgram trains on audio by
  default, but Vesper sends `mip_opt_out=true` with every request, so for the owner it is "Not used for training"
  (success badge); the summary says Vesper always asks Deepgram not to keep or train on it. The version bump shows the
  changed wording again where acknowledgements are stored.
- **H-fix5-ui-4 (fix5-ui, P29) "Closing the window quits Vesper".** `desktop.closeToTray` stays off by default. When
  the access mode is Local network or Tailscale (Settings → Access: the current mode; the wizard's Access step: the
  chosen mode) and close-to-tray is off, a warning callout says other devices lose access when the window closes,
  with the keep-in-tray switch; once turned on there it confirms and disappears on the next visit. That switch, the
  This PC card's, General's and the wizard Look step's share one label, "Keep running in the tray when closed"
  (`CLOSE_TO_TRAY_LABEL`, also the Settings search entry): one setting, one name.
- **H-fix5-ui-5 (fix5-ui, P04/P05/P09/P11) Small UI rules.** A provider that lists exactly one model while none is
  chosen gets it picked and tested automatically (counts read "1 model"). In the chat header the title is what
  ellipsizes first (min 80 px); the header's steps are container queries on its own width (`.shead`, so the panel,
  sidebar and Game mode buttons count): below 600 px the memory chip goes icon-only, below 440 px the session ID goes,
  then the model chip narrows (never below 96 px: icon, the start of the name, caret) and below 290 px the chips
  leave; with a Private/Temporary pill the steps come at 700 and 540 px, the pill goes icon-only below 380 px (its
  label and tooltip keep the word) and the chips leave below 310 px. Nothing in the header ever slides under the top
  bar's buttons. The model chip shows the full model id as its tooltip. Settings sections share one header
  (SettingsGroup's 14 px title and muted line, no icons) and Voice in/out put their controls in the same cards. The
  wizard's Memory step uses the shared `.wiz-step` header with a "Memory · optional" eyebrow on the 640 px voice-step
  column.
- **fix5-docs-1 (phase 5a P27; amends 02-ARCHITECTURE "Advanced (documented only)" and research 06 D4)
  Port forwarding and tunnels are not supported, rather than "documented in Help".** No Help page was built, and a
  tunnel or port forward pointed at Vesper is refused anyway: every listener checks Host and Origin against the names
  Vesper set up itself (http/guards.ts, 421). README.md and the Design notes now say so and point to Tailscale; a
  how-to would only be honest after Vesper learns a tunnel's hostname (a new access mode, not a doc).
- **fix5-docs-2 (phase 5a P36) One name per concept in the owner's documents.** "Chat" (never
  "session"), "chat ID", "chat panel" (the panel titled "This chat"), the access modes as the mode picker names them
  (This PC only · Local network · Anywhere, with Tailscale) inside "Access & security", and "Remember with Voyage AI"
  for the memory switch (keyword memory is always on). UI strings that still use other names are listed for their
  owners in docs/requests/fix5-docs.md.
- **fix5-docs-3 (phase 5a P25–P37; amends 05 §8) The owner's documents are tested, and req-coverage is a
  gate.** `tests/unit/docs/owner-docs.test.ts` checks README.md and docs/OWNER-NOTES.md against the code: quoted labels
  must exist in the app's source (settings-search keywords don't count), "Settings → …" paths must start at a real
  section, retired names fail, and claims are tied to the code that decides them. It also runs
  `scripts/req-coverage.mjs`, so `npm test` fails while any of R1–R22 lacks a tagged test. The temporary-chat
  explanation is one string (`features/sessions/temporaryChat.logic.ts`) shown in Settings → Chat and Settings →
  Privacy and repeated in README; its numbers are tied to `NO_SUBSCRIBER_MS` / `MAX_IDLE_MS` (now exported).
- **H-v11-tone (v11-tone, owner feedback on 1.0.0; amends A2, A3, C1) Voice tones follow the conversation.** The owner
  found a tone per reply unnatural ("a tone per response, not per how the conversation is going") and had not found
  the 1.0.0 switch. `voice.tts.tone: boolean` is replaced by **`voice.tts.toneMode: 'off' | 'conversation' | 'reply'`**
  (default `'conversation'`; `tonePlacement` and `waitForTone` stay). Migration: `migrateSettingsInput`
  (src/shared/settings.ts) rewrites the old boolean in settings.json at load (`false` → `'off'`, `true` →
  `'conversation'`; no "repaired" notice) and in PATCH bodies from older clients (store.patch and the route); an
  explicit `toneMode` wins; the boolean is never written again. `toneMode` is remote-writable (B2), like `reveal`.
  - **Which voices** (src/shared/voiceTone.ts `toneSupport`): ElevenLabs (every model: audio tags on v3/v4,
    voice_settings on the others), OpenAI `gpt-4o*` (null model = gpt-4o-mini-tts), an OpenAI-compatible server only
    with a `gpt-4o*` model, Windows voices (prosody). Anything else can't. `effectiveToneMode(tts, chat voice)` = the
    mode, or `'off'` when voice replies are off in Settings or the voice in use (the chat's own voice first, R12)
    can't use a tone; `speakingToneMode` (same without the `enabled` check) is what a reply that IS spoken uses.
  - **Protocols** (`{{tone_instruction}}`, rendered at epoch start only): `'reply'` keeps 1.0.0's sentence byte for
    byte; `'conversation'` = the first spoken reply sets a tone, later replies write a tag only when the emotional
    tone of the conversation shifts, otherwise no tag and the current tone carries on; both now carry the suggested
    tones and "Tone tags are never shown or spoken." themselves, so the shipped protocols.md no longer has
    "Choose from these tones: {{tones}}" (`{{tones}}` stays available). `'off'` (incl. unsupported) = only "Do not
    write tone tags." — no tag syntax, no tone list (tokens).
  - **Mid-chat changes (C1)**: the context snapshot gains `t` (ToneKey `'off' | '<mode>:<placement>'`, toneKeyOf).
    When it differs from the baseline's — or, at an epoch's first turn or for snapshots written before v1.1, from what
    the frozen system says (`frozenToneKey` reads the instruction back from `system_json`; null for protocols without
    `{{tone_instruction}}`, then nothing is said) — one system_note says what to do from now on ("… turned voice tones
    off", "The voice now in use can't change its tone", "Voice replies are turned off in Settings", "Voice tones now
    follow the conversation: start your next spoken reply with one tone tag …", "Voice tones are set per reply now:
    …"). The frozen system is never re-rendered; prefix invariance is tested across a mode change.
  - **The chat's tone (A2/A3)**: in `'conversation'` most replies have no tag, so the tone before a reply's first tag
    is the chat's current tone: the in-memory map (as 1.0.0), else — after a restart — the latest tag on the active
    path in the chat's wire transcript before that reply (current and previous epoch, `transcriptTone`), then
    remembered in memory again. Nothing new is stored: the transcript already keeps raw tags (A3); messages, memory,
    exports and logs never see a tone. "Speak again" uses the reply's own tag, else the tone in force before it. No
    hysteresis: a tag is a deliberate shift.
  - **Off**: no instruction; a stray tag is still stripped by the TagFilter (never shown, spoken or stored in
    `messages`); the engine passes no tone to the speech job and providers get `tone: null`.
  - **UI**: Settings → Voice out → Voice section, right under the voice: "Voice tones" segmented control
    (Off · Follow the conversation · Every reply) with the chosen mode's sentence (`TONE_MODE_OPTIONS`), a line saying
    how (or that) the current voice uses a tone, then "Where the AI puts the tone" and "Always wait for the tone"
    (disabled while tones are off or unsupported). The separate "Tone" section and the "Speak with feeling" switch are
    gone. The wizard's voice step shows the same control. `/voice tone off|conversation|reply` (bare `/voice tone`
    shows the current mode) in both /voice registrations; search catalog entry `voice.tts.toneMode` ("Voice tones");
    control id `vs-tts-tone-mode`. Protocols editor help explains `{{tone_instruction}}` per mode.
  - **Tests**: tests/unit/shared/voiceTone.test.ts (support, effective mode, migration, store, command),
    tests/unit/chat/protocols.test.ts (text per mode, frozen key, notes), tests/unit/chat/tone-modes.test.ts (real
    engine + speech + mock ElevenLabs/OpenAI: continuity across replies and a restart, off strips and sends nothing,
    notes, unsupported voice), prefix.test.ts (mode change mid-epoch), e2e voice-chat "H-v11-tone" (switch in Settings,
    voiced conversation: the tone reaching ElevenLabs changes only when the conversation's does, never in Off) and
    voice-settings (Settings, wizard, unsupported server). The TTS mock records the tone each request carried.
- **H-v11-presence (v11-d3, owner feedback on 1.0.0 and on the Armilla prototype; amends D5, D8, D9, H-presence-1,
  H-presence-6) Armilla is the default avatar, and it lives behind the chat's text.** The owner wanted the AI "in the
  center of the chat area behind the text, not up top in its own bar", and of the Armilla prototype: "only the main
  ring should display the audio wave when it talks".
  - **Style**: `appearance.star.style` gains `'armilla'` (additive; **default `'armilla'`**; orb / nebula / minimal2d /
    off stay). Settings → Presence & appearance → "Star style" lists Armilla first with a "Default" badge; `/star
    armilla`, the wizard summary and the presence lab know it. A settings.json written by 1.0 (it still carries 1.0's
    `voice.tts.tone`; 1.0 saved every leaf) that kept 1.0's default `'orb'` moves to Armilla once at load
    (`migrateLegacyStarStyle`, src/shared/settings.ts; load path only); a later choice of the orb stays. The
    prototype's test-only avatar selector (`gl/avatars/registry.ts`, `presence.setAvatar`) is gone: the style decides.
  - **Ring rule** (and the design judges' refinement pass): only the horizon (the main, near-edge-on ring) shows the
    voice — the AI's outward, the owner's inward. The three gimbals are **audio-blind in every state**: no
    displacement (the standing waves and the mic-driven radius are gone; `gimbalRadius(i, look, t, motion)` has no
    audio input; the shader's gimbal branch reads only the radius and the gimbal matrix) and no brightness, gain or
    flicker from the voice — `ringFrame()` (armilla.logic.ts, both renderers) splits the old shared brightness into
    `uBrightHorizon` (energy × voice ≤ 15 % × throb) and `uBrightGimbal` (energy × throb); `uRingGain[1..3]` are
    constant per mode; the pivot jewels have a constant glow and the gimbal brightness (no onset ping, no mic glow).
    They keep turning while the AI speaks: `SPEAK_RATE` (middle +0.10, inner −0.16 rad/s) weighted by the speaking
    LOOK (the state, crossfaded — never the level); the homing that brings them back to the resting pose runs once
    the spin or the speaking turn winds down. The bead keeps its answer to the voice (liquid, halo). Pinned by
    armilla.test.ts "H-v11-presence" (gimbal displacement 0 per state; gimbal brightness, gains and jewel glow equal
    at env 0 / 0.3 / 1 with and without onsets; ≥ 0.6 / 1 rad of middle / inner turn in 10 s of speech, level-free,
    homing after). In pixels (real GPU, pose held by reduced motion, injected quiet / loud + onset / quiet): over
    7 598 lit gimbal pixels outside the horizon's band the frames differ by at most 5/255 (mean 2.4) — the bead's
    halo, which follows the voice by design, lying over them.
  - **The wave reads as a voice**: one source of truth in armilla.logic for both renderers (`HORIZON_K` [22, 46, 90],
    `HORIZON_GAIN` [1, 0.6, 0.2], the phase offsets, `HORIZON_DAMP` 0.85 so the wave still rolls at the ring's ends
    beyond the column, `R_BEAD` 0.235); the shader's GLSL is built from those constants and `horizonHeight()` is
    tested against a JS port of `horizonY()` (linear texture read) at several arcs and trace states. A band envelope
    (attack 30 ms, release 140 ms) feeds the trace; the fine band is off behind text.
  - **Crisp behind text**: `stageLook.behind` (1 in a conversation) sets the ring glow weight 0.16 → 0.04, the glow
    radius −40 %, the gimbal web 0.16 → 0.08, a longer, softer comet head (exp(−10k)) and the sweep ≤ 0.6. The cap
    curve is linear below 0.6 × cap and compresses only above (measured on a 2.25-DPR frame: line core ≈ 9.8 : 1
    over the glow 1.8 px away, median). Armilla renders at the real density behind text: DPR ≤ 2 (1 on low); the box
    is sized per mode for its speaking scale (conversation × 1.07, hero × 1.06) so CSS only shrinks it, and a mode
    change resizes the canvas (no remount; a FLIP keeps the shown size continuous). The composer runs only while a
    cap below 1 applies (a dark hero draws straight).
  - **The horizon leads**: gains [1, 0.62, 0.56, 0.5] full / [1, 0.55, 0.5, 0.45] behind text, the horizon +25 %
    while speaking (crossfaded on the look); the final cap is spatial — over the message column (760 px, the 808
    column less its 24 px gutters) dark 0.22 / light 0.18, outside it 0.40 / 0.33, with a 24 px smooth edge — so the
    ring's ends glow where no text sits. The horizon fades out over the last 24 px before the canvas edge.
  - **Light theme**: ink, no haze — no ring glow alpha and no halo alpha in ink; deeper line ink (`inkOf` lightness
    0.28, saturation × 1.4; gold ≈ #6b4a1e); behind text the bead is its shell and meniscus only; shell 0.6, the
    meniscus darkens (× 0.55). At the 0.18 coverage cap the lines read as fine sepia hairlines.
  - **Bead**: resting level −0.12 (the meniscus sits just under the horizon line), the top sheet 0.3 → 0.2 with a
    faint caustic.
  - **Phone (2D)**: speaking opacity 0.99 (the most the analytic bound allows; text-2 ≥ 4.5:1 over a pure-white
    pixel at the cap); the cap goes through the same curve per element (a line ≤ 0.7 × cap, the bead ≤ 0.4 × cap, the
    halo's peak ≤ 0.25 × cap — SVG cannot cap the composite, and a gimbal and the horizon cross in front of the bead); no CSS filters on moving elements (brightness is opacity,
    saturation is folded into the colours, the highlight's blur is a second wider circle, the horizon's glow a wider
    faint stroke); preallocated point buffers and matrices; ≤ 30 fps; the horizon fades out 24 px before the edge.
  - **Where it draws**: WebGL on the desktop (one pass, no bloom; the one canvas, D5); `Armilla2d` (SVG, same pose
    and horizon maths) on phones and without WebGL (`drawsIn2d`, prefs.logic.ts); phones keep Armilla in 2D, the 1.0
    WebGL styles fall back to `minimal2d` there as before. Light theme: Armilla lays ink (its own ink colours), no
    night window and no invert filter. Reduced motion: no rotation, no waves (states by brightness/colour); game mode:
    static (the scheduler's 10 fps while speaking, no scale-up). Rest at 0 fps unchanged.
  - **Layout** (`<ChatBackdrop>`, backdrop.logic.ts; from the v11-layout prototype): the one surface is a stage target
    (`backdrop`, priority 16) centred on the chat body — horizontally on the column, vertically at 48 % — behind the
    message list, `pointer-events: none`, never scrolling or remounting; size and strength change by CSS transform /
    opacity only. Armilla's box is 1.7× as wide as tall (its horizon spans the column), never wider than the chat
    area. At 1440×900 (chat body 1168×781): conversation 515 px tall (box 937 × 551), hero (empty chat, on the
    greeting's anchor) 328 (box 592 × 348); 1138×608: 323 / 205; phone 390×844: 273 / 218 tall, full width. Opacity in
    a conversation 0.64 idle, 0.74 busy, 0.86 listening, 0.92 speaking (scale ×1.035 / ×1.07: it comes forward a
    little), ×0.55 while the reader scrolls or selects; the hero ×1.06 while speaking. The tertiary ink over the
    backdrop moves to #b3aecb (dark) / #57526e (light).
  - **Contrast gate** (tests/e2e/contrast.ts, run by the owner-shot specs): per text run, the avatar layer alone
    behind its box (everything else in the chat body hidden — conservative: bubbles never mask it), over several
    frames, worst pixel; fails if body text < 7:1 in dark or text-1 / text-2 < 4.5:1. Measured on the real GPU:
    speaking dark body 11.2 / text-2 7.4; thinking (comet heads) dark 12.8 / 6.9; speaking light 13.0 / 5.4; thinking
    light 13.7 / 5.7; 1138×608 hero over the greeting 17.8 / 16.9 (dark / light body); phone 390×844 (2D, three runs)
    8.9–9.9 / 7.5–7.7.
    The analytic bound (backdrop.test.ts: brightest possible pixel × opacity) keeps body ≥ 7:1 and text-2 ≥ 4.5:1.
  - **Cost** (docs/research/07-presence-ux.md §5.5, timer queries): ≤ 0.046 ms GPU per frame at 1440×900, DPR 2,
    high (gate ≤ 0.5 ms); avatar JS ≤ 0.1 ms (timer resolution).
  - **Gone**: the top bar's 30 px compact stage (`#star-stage-compact`, `.shead__stage`), the 1.0.x chat stage band
    (`ChatStage`, stage.logic.ts, target kind `band`) and its "Hide/Show the Star above the chat" toggle. The top bar
    keeps the presence group: the state in words while something happens, the pause control (D9) while the avatar is
    active or paused (an idle avatar comes to rest by itself; /star pause and Settings always work), and "Hide Vesper behind the
    chat" / "Show Vesper behind the chat" (per device). The setting is now "Show the avatar behind the chat". Talk
    mode keeps its full stage; the wizard and galleries keep sized `<Star>` targets.
  - **Tests**: unit armilla / backdrop / state / settings; e2e presence "the avatar lives behind the chat…", "the chat
    backdrop: the hero of an empty chat, comes forward while Vesper speaks…", "the backdrop never takes clicks,
    scrolling or selection…" (both themes), no-WebGL and phone fallbacks to Armilla2d; owner shots, contrast gate,
    ring-pixel diff and GPU table in tests/e2e/electron|browser/v11-final.shots.spec.ts (opt-in `V11_FINAL=1`).
  - **v1.1.3 (owner feedback on 1.1.2; amends "The wave reads as a voice", "Layout" and the D9 notes above)**:
    - **The real waveform** ("use the actual media file from the text to voice … turn it into waves for the ring"): the
      horizon draws the audio that is playing. `AnalyserLevels.samples()` hands the renderer the time-domain samples
      its `read` already took (`getFloatTimeDomainData` into the preallocated buffer; the AudioEngine's analyser sits
      after the decoded TTS chunk and before the volume, so it is the provider's own audio; the mic's for the owner).
      12 times a second (`WAVE_SLOT_RATE`) `readCycle` cuts one stretch between two rising zero crossings at least
      5 ms apart (about one pitch period, ≤ 14 ms), lightly smoothed (one-pole 1 kHz, then [1 2 1] over its points),
      resampled to 16 points, into `WaveTrace` (RGBA8 ring of 1024 samples: sample 128 ± 127, level, who). Cuts join
      at zero (one continuous line); each voice is normalised by its peak, held 0.6 s and released over 1.2 s, with a
      0.06 floor (near-silence stays small); nothing playing writes zeros. Band levels no longer feed the horizon
      (`VoiceTrace`, `BandEnvelope`, `HORIZON_K/GAIN/PHASE/DAMP` are gone; the bead still answers the bands).
    - **Across, not out from the middle** ("start on one side and end on the other"): u = 0 at the left end … 1 at the
      right end; the AI's voice is read at age u × span — the newest audio enters at the left and flows right, fading in
      over the first 5 % and out over the last 20 % — and the owner's at (1 − u) × span (right → left). Only the front
      half carries it (the back half runs behind the bead). The span follows the horizon's width on screen (`waveSpan`:
      22 px per cut, 1–4.5 s; 3.26 s at 1440×900), so density and speed (≈ 264 px/s, a fifth of a cut per 60 fps
      frame: no strobing) are the same at every size; the swing is ±16 px, at most 0.07 world units (`waveAmp`); the
      read position glides between writes. One source of truth: `horizonWave` (armilla.logic); the GLSL `horizonY` is
      its transliteration (tested) and Armilla2d calls it (front points uniform in x, ~2.5 px apart). The horizon
      ribbon has 2048 / 1536 / 1024 segments (high / medium / low). Frames stay at the full rate until the last cut has
      crossed (`loudAge` < span), then the usual rest (0 fps). The onset ping rides the wave in from the left. The
      gimbals are unchanged and audio-blind (the shader test now also forbids `waveAt`/`uWavePos`/`uSpan`/`uAmp` there).
    - **Placed, never slid** (owner: "when switching between sessions, the avatar … appears as though it starts in the
      upper left and then moves smoothly into the center"): the chat remounts per session, and the box's first render
      was `translate(0, 0)` until the chat body was measured — the layout read in between let its 720 ms transform
      transition run from the corner. The box is now shown (`data-ready`) only once the body is measured and the view
      has settled (`<ChatBackdrop settled>`: no loading rows), and transitions (`data-animate`) and the mode-change FLIP
      start two frames after that. e2e presence "switching sessions or routes…": the first visible frame and the 23
      after it are centred within 2 px after three session switches, a route change and a reload (the 1.1.2 code: 115 px
      off on the first frame).
    - **Avatar visibility and size** (Settings → Presence & appearance; per account, additive):
      `appearance.star.visibility` 0.5–2 (1 = the 1.1 look) and `appearance.star.size` 0.8–1.2 (both modes,
      height-bounded). In `backdropLook`, below 100 % the opacity and caps scale down; above it the opacity moves up to
      80 % of the way to 1 and the column cap moves linearly to `CAP_MAX` at 200 %. `CAP_MAX` dark 0.38 / light 0.48 is
      the most that keeps message text (--text-0) ≥ 4.5:1 over the brightest possible pixel at opacity 1 (dark 0.384,
      light 0.487 from the tokens; backdrop.test.ts recomputes both and checks every visibility × state × device);
      --text-1/--text-2 keep 4.5:1 up to 100 %, and the hint says very high values make text over it harder to read.
      The cap outside the column follows up to 0.85; the hero only gets subtler. Measured on the real GPU at 200 % while
      speaking (contrast.ts): dark --text-0 6.3, --text-1 11.4, --text-2 5.8; light 8.0, 9.2, 4.9.
    - **Live previews**: `<AvatarPreview>` (presence barrel) is a stage target of kind `preview` (priority 18, above the
      backdrop) that PresenceHost draws like the backdrop (the cap pass, the stage look, the DPR, no night window): the
      one canvas moves into it while the page is open (07 D5; e2e checks the same canvas element and one context). It
      sets the conversation look for the theme, state, visibility and size behind sample text; "Preview speaking" plays
      a short synthetic clip (lib/audio/synth.ts, loaded on the click) through the real AudioEngine at the owner's
      volume, "Stop" or leaving the page stops it. The style cards show stills of each style per theme
      (src/web/features/settings/previews/, taken from the real renderers on the real GPU: V113_THUMBS=1).
    - **Tests**: unit armilla (a cut is the true shape, not a sine; fixed rate; normalisation; left → right and right →
      left travel; still after the span; a gap clears; the JS port equals the GLSL) and backdrop (the clamp from the
      tokens, size); e2e presence (centred first frame; the Settings preview: one canvas, sliders, the waveform entering
      at the left and moving right, still after; the 2D twin's waveform); owner shots and the contrast measurement at
      200 % in tests/e2e/electron/v113-avatar.shots.spec.ts (opt-in `V113_SHOTS=1`).
  - **v1.1.5 (owner feedback on 1.1.4; amends the v1.1.3 "real waveform" and "across, not out from the middle" notes)**:
    the owner: "I was hoping instead of them moving left to right, it was more stationary … points within the front of
    the ring create curves going up and some down depending on the voice / media coming through."
    - **A stationary oscilloscope**: the horizon's front (left end → right end; u uniform in screen x, so time runs
      evenly across) shows, every rendered frame, the current window of the real audio — nothing travels sideways.
      `scopeFrame` (armilla.logic): the newest SCOPE_WINDOW_S = 35 ms of the analyser's samples (≈ 4 periods of a
      120 Hz voice, 8 of 220 Hz), starting on a rising zero crossing of a trigger signal (zero-phase one-pole at
      300 Hz, forward + backward, so no phase shift; armed only after a dip below −12 % of its peak — a harmonic's
      wiggle near zero does not retrigger; sub-sample crossing; searched up to 20 ms back from the newest full
      window, ending ≥ 2 ms before the newest sample; free-running when there is none), read from the display signal
      (zero-phase one-pole at 1 kHz) at SCOPE_N = 128 points, [1 2 1] across them, tapered to 0 over the outer 14 % at
      each end (it joins the still ring). A steady tone draws the same curve every frame (to the byte).
    - **Normalised and calm**: per voice by a peak-hold envelope (floor 0.06, held 0.6 s, released over 1.2 s); a light
      persistence (the drawn shape eases toward each frame, τ 12 ms); the line's brightness follows an envelope of the
      level (attack 30 ms, release 250 ms), never a per-frame flicker. Silence (nothing playing) draws a flat ring.
      The travelling onset ping is gone (onsets still lift the horizon's brightness within D9, and the bead).
    - **Matched to what is heard**: the analyser sees audio one output latency before the speakers play it. `Scope`
      keeps a ring of the last 32 frames (shape, time, lag, peak, who; preallocated) and draws the one whose window
      centre is as old as the latency — the nearest to (latency − the window's own lag behind the newest sample:
      2 ms + half the window + the trigger offset, ≈ 20–30 ms for a voice) ago. The latency is
      `WebAudioEngine.outputDelayS()`: currentTime less the output timestamp (the clock `now()` reads), else
      `outputLatency + baseLatency`, else 0 (no delay); smoothed (τ 0.4 s), ≤ 0.25 s. The owner's voice (the mic) is
      drawn as it comes, in the owner's colour. Measured on this PC (Electron, real device, 48 kHz): outputLatency
      30 ms + baseLatency 10 ms; currentTime − output timestamp 38.2 ms; delay applied 35.7 ms (smoothed); the drawn
      audio 40.9 ms old (v115-scope.shots.spec.ts log).
    - **Its own analyser**: a 35 ms window plus the trigger search does not fit the levels' 1024-point analyser
      (21 ms at 48 kHz), so the engine and the mic each get an output-less waveform analyser beside it
      (`configureScope`: fftSize = the power of two ≥ 60 ms, 4096 at 48 kHz; `AnalyserLevels.attach(a, scope)`,
      `samples()` reads it); the levels, bands and onsets keep their analysis unchanged. Counted nodes +1 each.
    - **Unchanged**: the gimbals stay audio-blind (the shader test also forbids `uScope`/`scopeAt` there); the bead's
      band-driven answer; one WebGL context; one source of truth (`horizonWave` reads the drawn bytes exactly as the
      shader's LINEAR, clamped read of the 128 × 1 RGBA8 `uScope`; the GLSL `horizonY` is its transliteration,
      tested; Armilla2d calls it); the Settings preview ("Preview speaking" draws the oscilloscope); visibility/size;
      game mode (the scheduler's 10 fps while speaking: the oscilloscope updates at that rate). **Reduced motion**: the
      static ring (no oscilloscope; the voice shows by brightness only, as before). **0 fps at rest**: frames run
      while `Scope.busy` (a voice drawn, a voiced frame not yet heard, or the brightness envelope above 1 %) —
      about 1.2 s after the voice ends instead of 1.1.4's span + 0.3 s.
    - **Tests**: unit armilla "Armilla voice oscilloscope" (sizes; a sine draws the same phase-aligned shape whenever
      the frame was taken; the true shape of a harmonic voice, not a sine; silence flat, ends taper to zero, the back
      half still; no sideways motion — consecutive frames of a steady tone identical within one byte, centred;
      normalisation; the frame drawn is the one whose audio is the latency old, at 47 / 60 / 120 fps, the owner's
      live, unknown latency → no delay; a long gap clears; the JS port equals the GLSL); e2e presence (the Settings
      preview and the 2D twin: curves across the front, centred every time they are sampled, flat after Stop); the
      capture tests/e2e/electron/v115-scope.shots.spec.ts (opt-in `V115_SHOTS=1`: scope-dark.png and the latency log).
- **H-v111-firewall (v111-fw, owner request on 1.1.0; amends B2 "firewall allow", D8, H-auth-net-6) The firewall
  follows Local network access.** The owner asked that enabling it add the port to Windows Firewall and disabling it
  remove it, and couldn't find the address to type on the phone (they tried `http://vesper.localhost:41730` and a bare
  IP). In the desktop app (`platform.isDesktop`, `NetDeps.autoFirewall`, off in test mode; the standalone server never
  tries), a desktop change through `PUT /api/network` (Settings → Access & security, the wizard's Access step, the
  Tailscale switch) runs, after the reconcile and outside its queue (`syncFirewall`, src/server/net/manager.ts):
  - **On** (mode → `lan`, or a new LAN port/address while on): the probe (which now also reads each rule's
    `LocalPort`) decides; when no enabled "Vesper (LAN)" allow rule covers the listener's port on the active profile
    (`ownRuleAllows`; Windows' own all-ports "vesper.exe" rules don't count), or a block rule exists, ONE elevated
    command runs `firewallAllowLines` — `delete rule name=all program="<exe>" dir=in` first only when blocked, then
    `delete rule name="Vesper (LAN)"` and `add rule name="Vesper (LAN)" dir=in action=allow program="<exe>"
    protocol=TCP localport=<port> remoteip=localsubnet profile=private[,public|,domain] enable=yes` (Public / Domain
    when that is the active network's profile). A failed probe never prompts. A cancelled or failed prompt leaves LAN
    on; the panel shows the firewall state (blocked / unknown) with the manual "Allow in Windows Firewall…" button,
    which stays as the fallback. Audit `firewall.allow`.
  - **Off** (mode `lan` → `local`/`tailscale`): when the probe lists any inbound rule of this Vesper.exe, ONE elevated
    command runs `netsh advfirewall firewall delete rule name=all program="<exe>" dir=in` — "Vesper (LAN)" and the
    TCP/UDP all-ports rules Windows' "allow" dialog made, only for this installation's path. Audit `firewall.remove`.
  - **UI**: the apply bar (and the wizard step) says before the switch that Windows will ask for permission to add
    (or remove) the rule (`firewallSwitchNote`; nothing on loopback). The LAN panel leads with "On your phone, open"
    and the exact `https://<ip>:<port>` (copy, next to the QR code) plus "Your phone will warn about the certificate
    the first time — choose Advanced → Proceed."; the This PC card shows both addresses —
    `http://vesper.localhost:<port>` for this PC and "Phones and computers on your network: …" (copy) from the same
    `lanAddressForOthers`, or, with LAN off, that other devices can't reach Vesper until Local network access is on,
    with a button that picks it.
    README "Other devices" gives the form to type (`https://<PC address>:41731`) and says vesper.localhost is this PC
    only. Uninstall cleanup (H-auth-net-6) is unchanged.
  - **Tests**: unit firewall (exact lines, `ownRuleAllows`), firewall-auto (fake runner applying the netsh lines: on
    once with Public, already allowed → none, port change, off once with Windows' rules, nothing to remove → none,
    cancel keeps LAN on and blocked, standalone server and test mode never), web access logic; e2e access-ui (the phone
    line, both This PC card states, the apply-bar note).
- **H-v12-updates (v12-updater, owner decision on 1.1.3; adds to E8, B13, D12) Auto-updates from GitHub Releases; the
  project is open source.** One public GitHub repository holds the code and the releases. Pushing a `v*.*.*` tag
  publishes a release; installed copies check on the owner's interval, "super light on the network", and by default
  download quietly and install when Vesper closes.
  - **Settings** (additive, defaults, desktop-only): `updates.checkEvery` off | 5m | 15m | 1h (default) | 1d;
    `updates.mode` install-on-close (default) | ask | auto. A change applies at once (the schedule is recomputed from
    the last check; a check already due runs after 10 s).
  - **Updater** (`src/main/updater.ts` over `UpdateController` in `src/shared/updater.logic.ts`, pure and unit-tested):
    electron-updater's NSIS updater with a GitHub-based custom provider (`LatestYmlProvider`) whose check is ONE request,
    `https://github.com/<owner>/<repo>/releases/latest/download/latest.yml` (~400 bytes; GitHub redirects it to the
    latest published release's asset) — the stock GitHub provider would also read the releases Atom feed and the
    latest-release page. Downloads keep the stock paths (`releases/download/v<version>/<file>`), so the blockmap
    differential download works (the old blockmap's URL is the new one with the version swapped); tags are therefore
    always `v<package.json version>`. owner/repo come from package.json `repository` (the field electron-builder
    publishes with); while it names the placeholder owner `OWNER`, the updater does not run. Never in dev
    (unpackaged) or test runs. electron-updater loads on the first check, ~30 s after start; its logger is off; ours
    logs state changes and error codes only (`errorCode`: `ERR_…` / `HTTP <status>`, never messages, URLs or tokens).
    Failed checks back off (interval × 2ⁿ, capped at max(interval, 6 h)); no checks while a download runs or one is
    ready; a PC resume recomputes the schedule.
  - **Modes**: install-on-close = autoDownload + autoInstallOnAppQuit (+ "Restart to update" = `quitAndInstall(silent,
    run after)`); ask = no autoDownload, Download in Settings → About, then install on quit or Restart; auto = like
    install-on-close plus an unattended restart once idle: polled every 60 s, it needs no reply in flight (engine
    `active + starting`), no device streaming mic audio (dictation, push-to-talk, Talk mode), game mode off (07 D3) and
    no Vesper window or tab visible and focused on any device for 5 minutes. When the window was hidden then, a marker
    in the local data dir makes the `--updated` relaunch start in the tray (`consumeBackgroundRelaunch`). Portable
    (`PORTABLE_EXECUTABLE_DIR`): check only — "Version X is available" with the release page, never download/install.
  - **Server/API** (via the Platform seam: optional, assignable `platform.updater: PlatformUpdater`; the standalone
    server has none and reports `unsupported`): `GET /api/system/update` (device) → `UpdateStatus {state: idle |
    checking | available | downloading | ready | up-to-date | error | unsupported, currentVersion, version?, percent?,
    releaseUrl?, checkedUtc?, error?, portable?}`; `POST /api/system/update/check` (desktop; answers `unsupported`
    without an updater), `/download` and `/restart` (desktop; 501 without an updater, restart 409 when nothing is
    ready). Every change is broadcast as `{t:'update.state', …UpdateStatus}` (SystemServer's `UpdateRelay`). Test
    builds: `POST/GET /api/test/updater` attach and drive a fake updater (no network).
  - **UI**: Settings → About → Updates (`UpdatesGroup.tsx`): version, status line, Check now, "Check for updates"
    (Off · Every 5 minutes · Every 15 minutes · Hourly · Daily), "When a new version is out" (When I close Vesper ·
    Ask first · Automatically), progress, Download (ask), "Restart to update"; two Settings search entries. The desktop
    top bar shows "Update ready — Restart" (dismissible, once per version in localStorage; Talk mode has no top bar).
  - **Privacy** (B13): disclosure `updates` — "Update checks contact GitHub (github.com and its download servers): they
    see your IP address and Vesper's version. Turn checks off in Settings → About." — with its own "Update checks" group
    on the Privacy page (not listed among the services not in use). README intro, "Updates" and "Releasing" say the same.
  - **Publishing**: electron-builder.yml `publish: {provider: github, releaseType: release}`; package.json
    `repository.url` = `https://github.com/skyehosting/vesper.git` (filled in 2026-10-07; `OWNER` keeps the updater off in forks that haven't set it).
    `.github/workflows/release.yml` (tag `v*.*.*`, windows-latest, Node 24 + npm cache, `contents: write`): tag must
    equal `v` + package.json version, then `npm ci`, typecheck, `npm test`, `VESPER_BUILD_TEST=0 electron-vite build`,
    `electron-builder --win --x64 --publish always` with `GH_TOKEN = secrets.GITHUB_TOKEN`. `.github/workflows/ci.yml`
    (pull requests and pushes to main): `npm ci`, typecheck, `npm test` (the e2e suites need a GPU and a desktop).
    `npm run release <x.y.z>` (`scripts/release.mjs`, `--dry-run`): clean tree on main, newer version → `npm version
    --no-git-tag-version`, commit `Vesper x.y.z`, tag `vx.y.z`, `git push --atomic origin main vx.y.z`. CONTRIBUTING.md.
  - **Tests**: unit updater.logic (intervals, never dev/test/placeholder, portable check-only, schedule + backoff,
    modes, idle rule, state machine, error codes, once-per-version notice, the controller over a fake engine and clock),
    system/updates (auth levels, unsupported, the relay to other devices, 409/204 restart, the activity probe),
    settings coverage (+ `updates.` leaves, About section); e2e browser updates.spec.ts (fake updater: available →
    downloading → ready → restart requests from the pill and from About; dismissal survives a reload; axe).
