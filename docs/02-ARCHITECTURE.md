# 02 — Architecture

Decisions trace to the research reports in `docs/research/` (cited as R-01 … R-07). Requirements R1–R23 are in
`00-BRIEF.md`.

## 1. Process model
```
Vesper.exe (Electron 44 main process)
├─ Lifecycle: single instance, tray, "start with Windows (--background)", window(s), dev-window override
├─ Platform services: paths (%APPDATA%\Vesper), secrets (safeStorage async, DPAPI), notifications, open-external
├─ SERVER (Fastify 5, same process)                                         [R-06 D1–D3]
│   ├─ Listener A: http://127.0.0.1:<port>  (always; desktop window, local browsers, Tailscale Serve target)
│   ├─ Listener B: https://<lan-ip>:<port+1> (only in LAN mode; runtime self-signed EC P-256 cert)
│   ├─ REST /api/*, WebSocket /ws (one per client), static web client (out/web)
│   ├─ Chat engine, provider adapters (LLM / TTS / STT-cloud / Voyage), speech pipeline, commands
│   └─ DB (node:sqlite, WAL) — primary connection: sessions, messages, transcript, settings-adjacent data
├─ memory.worker (worker_thread): second DB connection; FTS + in-memory bit-vector search, embed queue,
│   Voyage calls for indexing, re-index, manifest export                  [R-02 §5]
├─ stt (utilityProcess): sherpa-onnx-node — Silero VAD + Parakeet/Moonshine/Whisper; isolated because of the
│   onnxruntime DLL clash and for crash isolation                          [R-05 §1.7]
├─ localtts (utilityProcess, on demand): Kokoro (kokoro-js) / Piper (sherpa) local neural voices   [R-04 §1.4]
└─ wintts host (child process, persistent PowerShell 5.1): WinRT SpeechSynthesizer → WAV + word cues [R-04 §1.3]

Renderer = the web client, loaded by the BrowserWindow from Listener A (desktop auto-login cookie, §5.4).
Browsers (same PC, LAN phones, remote via Tailscale) load the same client from Listener A/B.
```
The server package (`src/server`) never imports `electron`. It receives a `Platform` object (paths, secrets,
notifier, firewall/tailscale helpers, app version, isDesktop) so the whole server — DB, engine, providers, auth —
runs under plain Node in tests (vitest + Playwright against a headless server and a mock-provider server).

## 2. Repository layout
```
src/
  main/        Electron only: index.ts, window.ts, tray.ts, devWindow.ts, platform.ts (Platform impl), autostart.ts
  preload/     tiny bridge for the desktop window only: window controls, isDesktop, openExternal
  server/
    app.ts                 buildServer(platform, opts) → Fastify instance(s) + lifecycle
    http/                  route modules (auth, sessions, messages, search, memory, prompts, attachments,
                           settings, providers, voice, network, export)
    ws/                    hub (clients, subscriptions, auth on upgrade, origin check), protocol codec
    auth/                  password (scrypt), sessions/devices, pairing codes, csrf/origin/host guards, rate limits
    net/                   listeners, tls (selfsigned), firewall check/allow, tailscale status/serve, lan addresses, qr
    db/                    open(), migrations/, repositories (sessions, messages, transcript, links, prompts,
                           attachments, devices, kv)
    chat/                  engine.ts (turn orchestration), context.ts (wire transcript → request), tagFilter.ts,
                           tools.ts (memory tools, native + text), commands.ts, titles.ts, timefmt.ts, epochs.ts
    providers/llm/         openaiCompat.ts, anthropic.ts, presets.ts, capabilities.ts, errors.ts
    providers/tts/         elevenlabs.ts, openai.ts, windows.ts (wintts host client), local.ts, azure.ts(?), tone.ts
    providers/stt/         local.ts (utilityProcess client), openai.ts, groq.ts, deepgram.ts, elevenlabs.ts
    providers/voyage/      client.ts (thin fetch client; pa-/al- routing), catalogue.ts
    speech/                pipeline.ts (segmenter, synth queue, chunk timeline), estimate.ts (reveal timing)
    memory/                facade used by engine (talks to memory.worker), scope.ts, format.ts (memory_result)
    attachments/           store (content-addressed), images (downscale once), pdf/text extraction
    settings/              schema.ts (zod), defaults.ts, store.ts (settings.json), secrets.ts (via Platform)
  workers/     memory.worker.ts, stt.process.ts, localtts.process.ts, wintts.ps1
  shared/      types/ (domain), api.ts (REST contract), ws.ts (WS protocol), protocols-default.md,
               time.ts (formatting + relative ages, DST-safe), ids.ts (short session ids), tags.ts (tag grammar)
  web/         React 19 client (Vite): main.tsx, app/ (shell, routes), features/ (chat, sessions, panel, composer,
               search, settings, wizard, login, voice, presence), components/ (kit), lib/ (api, ws, store, audio
               engine, reveal engine, mic capture worklet, markdown), styles/
tests/  unit/ (vitest, plain Node), e2e/ (Playwright: Electron + Chromium-against-server), soak/, mocks/
        (mock LLM/Voyage/TTS/STT servers), fixtures/
scripts/ shot.mjs, perf.mjs, smoke-packaged.mjs, seed.mjs (synthetic million-message sessions), worktree.mjs
docs/
```

## 3. Data (SQLite, `%APPDATA%\Vesper\vesper.db`, WAL) [R-02 §5.1, R-03]
- `node:sqlite` (Electron 44: Node 24.21, SQLite 3.53.4, FTS5 verified; release-candidate stability, no warning).
  **Bind ids used in comparisons as BigInt** (node:sqlite binds JS numbers as REAL; FTS5 rowid ranges lose their
  index otherwise — R-03 §1). WAL, `synchronous=NORMAL`, `busy_timeout`.
- **Vectors without an extension** (R-03): Voyage int8 1024-d BLOBs in `vectors`; the memory worker keeps a bit
  vector (sign of each int8) per message in memory (128 MB per 1M, sharded ≤ 256 MiB — Electron caps one buffer
  at ~2 GiB), does a Hamming top-400 scan (≈40 ms / 1M single thread) and rescores those 400 with int8 dot
  products read from SQLite. sqlite-vec is not used.
- Tables: `sessions`, `session_links` (directional from→to), `messages` (UI + memory timeline: clean text, role
  tag `user response` / `ai response`, `ts_utc_ms`, `tz_offset_min`, `tz_name`, `device`, `seq`, branch fields,
  status, model, usage, attachments, tone), `transcript` (wire log: canonical provider-neutral blocks per turn,
  byte-stable JSON, epoch number, thinking blocks tagged with provider/model), `messages_fts` (FTS5 external
  content + triggers, `unicode61 remove_diacritics 2`, secure-delete), `vectors` (int8 1024-d BLOB), `embed_queue`,
  `memory_injections`, `prompts` (library), `attachments`, `devices` (auth sessions), `auth_log`, `kv`.
- Settings in `settings.json` (validated by schema; migrations by version); secrets in `secrets.json` as safeStorage
  ciphertext (never in the DB, never in exports).
- Attachments: `attachments/<sha256[0:2]>/<sha256>.<ext>` + thumbnails; images downscaled once at ingestion (bytes
  never change afterwards — a history-edit hazard for Anthropic, R-01 §2.2).

## 4. The chat turn [R-01, R-02, R-04]
1. Client sends `chat.send {sessionId, text, attachments, client: {ts, tzOffset, tzName, device}, voice}` over WS.
2. Server stores the user message (clean) and appends a transcript turn whose text is **prefixed once** with the
   sender's local timestamp (`[Mon 5 Oct 2026 14:03]`), stored byte-for-byte; if the previous message is > 6 h old a
   gap note is part of that same prefix. Nothing in older turns is ever re-rendered.
3. Context assembly (`context.ts`): system = protocols (stable) + session system prompt as of the session's epoch
   start + persona; tools declared from the session's first request (frozen `toolMode`: native or text); history =
   the current epoch's transcript replayed verbatim; the latest user turn additionally carries the `[Now: …]` line
   and, if auto-recall found something, a `<memory_result>` block (appended content, persisted with the turn).
4. Adapter renders canonical → provider wire format deterministically (Anthropic native / OpenAI-compatible).
   Thinking blocks are replayed only to the same provider+model; otherwise dropped.
5. Stream → `TagFilter` (strips `[tone=…]`, captures text-mode `[memory_search …]`/`[memory_recall …]`) and native
   tool calls → tool loop (≤ 3 calls per reply; results appended as tool results / memory_result messages).
6. Visible text goes to the client(s) as deltas — or, when voice reveal is on, into the speech pipeline, which
   releases each chunk's text with its audio (§6).
7. Done: persist the assistant message (clean), the transcript turn (raw wire), usage; enqueue embeddings; auto-title
   after the first exchange; broadcast.

**Session instructions changes (R11):** OpenAI-compatible providers are stateless — the current session prompt is
rendered into `system` each request. Anthropic native: `system` stays frozen for the epoch; an update is appended as a
mid-conversation `role:"system"` message (models that support it) or a text block in the next user turn.

**Edits and regenerate:** regenerate = new variant of the last assistant turn (variants kept, `‹ 2/3 ›`); editing
message *k* creates a **branch** from *k* (later messages of the old branch stay viewable). Never in-place edits that
keep later turns (preserved-thinking 400s, R-01 §2.3).

**Epochs (unlimited history vs. a finite context window):** when the epoch's transcript exceeds the model's budget
(context window × fill target), Vesper starts a new epoch: an LLM-written recap of the old epoch + the last few rounds
seed the new epoch's first user turn; nothing older is replayed. Everything stays searchable through memory. One
prefix change per epoch, no rolling truncation (cache- and thinking-safe). Recovery for an "Invalid signature" 400:
strip all thinking blocks of the epoch, persist the strip flag, retry once.

## 5. Network & security [R-06]
### 5.1 Modes (Settings → Access)
| Mode | Listeners | Requirements |
| --- | --- | --- |
| This PC only (default) | A | none (desktop auto-login; local browsers sign in with the password if one is set, else via a pairing link from the desktop app) |
| Local network | A + B (HTTPS, self-signed) bound to the chosen LAN interface | password; firewall check + user-initiated "Allow" (one UAC prompt); QR pairing |
| Remote via Tailscale | A, proxied by `tailscale serve` (trusted cert) | password; Tailscale installed & signed in; Funnel only behind an explicit public-Internet warning |
| Advanced (documented only) | port forwarding, Cloudflare Tunnel, mkcert CA | Help page with risks |

### 5.2 Hardening
scrypt (N=2^17, r=8, p=1, 64 B, maxmem 256 MiB) · opaque server sessions in `__Host-vesper_sid` (HttpOnly, Secure,
SameSite=Strict, Path=/) · exact `Origin` match + `Sec-Fetch-Site` + custom header `X-Vesper` on mutating requests ·
Host-header allow-list (DNS rebinding) · WS upgrade checks cookie + Origin · no CORS · @fastify/helmet CSP (self only;
`connect-src 'self'`; workers/wasm allowed for audio) · login rate limit + lockout · device list with revoke · login
audit log · API keys never leave the main process.

### 5.3 Desktop auto-login
At launch the main process creates a random 256-bit token, registers it as a device session, and sets the cookie in the
window's Electron session for the loopback origin before loading. Not reachable from the network.

## 6. Voice [R-04, R-05, R-07]
### 6.1 Speech out
`SpeechPipeline` per reply: TagFilter → sentence/paragraph segmenter (first chunk small for latency) → synth queue
(concurrency 2, chunk n+1 while n plays) → per chunk `{index, text, tone, audio (binary WS frame), timeline}` where
the timeline is provider alignment (ElevenLabs `/with-timestamps`; validated per response, with fallback) or the
estimator (character-weighted, silence-snapped; WinRT word cues when Windows voices are used). Tone adapters:
ElevenLabs v3/v4 → inline audio tag; ElevenLabs v2/flash → voice_settings preset; OpenAI → `instructions`;
Windows/local → prosody or none. The `[tone=…]` tag is accepted anywhere (start recommended; protocols say so) and is
never stored, shown or spoken.

Client: one `AudioContext`; chunks decoded to `AudioBuffer`s and scheduled back to back (`source → analyser → gain →
destination`); the RevealEngine shows each chunk's text when its audio starts and fades in characters by
`AudioContext.currentTime` against the timeline, so the last letter lands as the audio ends. Barge-in stops sources,
aborts synthesis, and reveals the remainder.

### 6.2 Speech in
Client: `getUserMedia` (echoCancellation, noiseSuppression, autoGainControl, mono) → AudioWorklet → 16 kHz Int16
frames (32 ms) → WS binary. Server: stt utilityProcess runs Silero VAD (pre-roll 400 ms) and the chosen model;
partial/final transcripts back over WS. Modes: dictate, push-to-talk, conversation (silence timeout setting, default
1500 ms, countdown ring). Cloud STT providers are optional alternatives. Mic permission is allowed for Vesper's own
origin only.

## 7. The Star [R-07]
react-three-fiber + three r186, WebGL2, GLSL: displaced icosphere (noise + audio bands) with fresnel rim + particle
halo; state machine idle/listening/transcribing/thinking/preparing-voice/speaking/muted/error; analyser → RMS + 3
bands → attack/release envelope (30/250 ms) + spectral-flux onsets → damped spring. DPR caps, pause when hidden,
reduced motion. Compact stage in chat, full stage in Talk mode.

## 8. Testing strategy (detail in 05-TESTING)
- Unit (vitest, plain Node): tag filter fuzz, time formatting (DST), segmenter/estimator, context assembly
  byte-stability, adapters against recorded/mock streams, auth guards, DB repositories, memory search scoring.
- Integration: server + mock providers (LLM SSE incl. tool calls/tags/thinking, Voyage embed/rerank deterministic
  vectors, ElevenLabs with alignment, OpenAI TTS) in plain Node.
- E2E (Playwright): Electron app and Chromium against the server; wizard, chat, scroll a 1M-message session, memory
  across sessions, voice reveal with mock TTS, Talk mode, LAN mode with self-signed HTTPS, login/lockout.
- Soak: heap and DOM bounds while streaming 1,000 replies and scrolling 1M messages; WebGL contexts; utility process
  memory; WS reconnects.
