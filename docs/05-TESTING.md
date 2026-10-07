# 05 — Testing

Goal: every requirement R1–R23 has automated evidence; no feature needs a real API key to be tested; memory and DOM
stay bounded under long use. 07-AMENDMENTS overrides this file where they disagree.

## 1. Layers and how to run them
| Layer | Tool | Command | Covers |
| --- | --- | --- | --- |
| Unit | vitest on **Electron's Node** (`ELECTRON_RUN_AS_NODE=1`, `pool: forks`) | `npm test` (`npm test -- tests/unit/mocks` for a folder; `npm run test:watch`) | pure logic: tag filter (fuzzed), time/age formatting (DST), short ids, segmenter + reveal map, deterministic JSON, context assembly byte-stability, adapters vs the mock providers, auth (scrypt, guards), repositories (temp DB), search scoring/fusion, settings schema/migrations, the mocks themselves |
| Integration | vitest + `startServer()` + `fakePlatform()` + the mock provider server | `npm test` | REST + WS end to end on a temp data dir: chat turns with tool loops, memory across linked sessions, epochs, branching, speech pipeline chunks, STT with a recorded WAV |
| E2E desktop | Playwright `_electron` against `out/` (project `electron`) | `npm run e2e:electron` | wizard → first chat; sidebar/panel; commands; attachments; voice reveal with mock TTS; Talk mode; settings persistence; tray |
| E2E browser | Playwright headless Chromium against `out/main/server-node.js` (project `browser`) | `npm run e2e:browser` | login/lockout, request guards (Origin/Host/cookie/CSRF), LAN HTTPS with the self-signed cert (`ignoreHTTPSErrors`), phone viewport, PWA manifest |
| Both e2e projects | — | `npm run e2e` (builds first) | |
| Soak | Playwright + CDP heap / DOM counters, `GET /api/test/leaks` (heap after a full GC, handles, maps) (`playwright.soak.config.ts`, `tests/soak/**`) | `npm run soak` (opt-in, ~80 min, mandatory before Phase 5, 07 D14; `SOAK_SCALE=0.05` for a quick pass) | the LEAK-1 gate table + the D2 memory budgets — §12 |
| Perf | — | not built | no separate perf script: the soak gates and the D2 memory budgets (§12) cover memory and CPU over long use |

Other scripts: `npm run shot` (§7), `npm run req-coverage` (§8), `npm run deps:check` (exact version pins, 07 E9),
`npm run typecheck`, `npm run release:check` (release build into `out/release-check`, greps every bundle for test
hooks/routes/switches, §10), `npm run licenses` (regenerates `THIRD_PARTY_NOTICES.txt`; every build does it too),
`npm run live-check` (the owner's keys from the environment, §12), `npm run smoke:packaged` (release build, unpacked
package, `scripts/smoke-packaged.mjs` on the real exe, §12).

**Runtime parity (07 E6).** `npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`.
Verified on this machine (2026-10-05): vitest 5.0.2 with the forks pool runs reliably this way (5/5 identical runs,
failures propagate exit code 1, forked workers report `process.versions.electron` 44.x and SQLite 3.53.4). The guard
`tests/unit/runtime.test.ts` checks Electron 44, SQLite 3.53.4 and FTS5 when `ELECTRON_RUN_AS_NODE` is set and skips
(with a note) on plain Node. `npm run test:node` runs the same suite on the system Node 24.11 for a quick check only;
node:sqlite there is experimental and differs (research 03 §8). The browser e2e project also runs `server-node.js` on
Electron's Node by default (`launchServer({ runtime: 'node' })` to opt out).

## 2. Mock providers (`tests/mocks/`, one HTTP server, scripted per test)
`startMockServer({ port? })` → `{ url, port, recorder, script(...), reset(), close(), llm, voyage, tts, stt, models }`.
One `node:http` server on 127.0.0.1 (random port); one module per provider family, each in its own file owned by
the matching Phase 2 agent (07 E1): `llm.ts` (llm-engine), `voyage.ts` (memory), `tts.ts` + `audio.ts`
(voice-out-server), `stt.ts` + `github-models.ts` (voice-in-server). `server.ts`, `recorder.ts`, `http.ts` and
`module.ts` are foundation files.

**Pointing the app at the mock.** E2E passes `VESPER_MOCK_BASE=<mock.url>`. In test mode the server replaces the
*origin* of provider base URLs with that origin and keeps the path (`https://api.openai.com/v1` → `<mock>/v1`,
`https://api.anthropic.com` → `<mock>`, `https://api.groq.com/openai/v1` → `<mock>/openai/v1`). The mock routes by
path and auth header: `xi-api-key` → ElevenLabs, `anthropic-version`/`x-api-key` → Anthropic, otherwise
OpenAI-style. A path prefix forces a module and is stripped: `/openai`, `/anthropic`, `/voyage`, `/elevenlabs`,
`/stt`, `/groq`, `/gh` (e.g. a profile base URL `<mock>/anthropic`). Smoke specs use a `custom` profile at
`<mock>/v1` (`tests/e2e/helpers.ts → configureMockLlm`).

**Scripting.** `mock.script({ method?, path, status?, json?, body?, headers?, delayMs?, hang?, destroy?, handler?,
times? })` queues raw responses that win over the modules. Modules have semantic scripts (below). Unanswered
requests get a 404 and are recorded as `unhandled`; strict tests call `mock.recorder.assertNoUnhandled()`.

**Recorder.** Every request (method, path, query, lower-cased headers, body text/bytes, parsed JSON, answering module)
in arrival order: `all()`, `find(path|RegExp|fn, method?)`, `count()`, `last()`, `byModule()`, `waitFor(pred)`,
`clear()`. **`assertPrefixInvariant({ api?, ignoreKeys?, allow?, filter? })`** (07 C1): for consecutive requests of
one conversation (keyed by the `x-mock-conversation` header, else by the first user message), `system`, `tools` and
every message of request N must be repeated byte-for-byte (JSON with key order) in request N+1; `cache_control` keys
are ignored (moving a breakpoint does not change the cached prefix); dropping turns is a violation. `api` defaults
to Anthropic `/v1/messages`; `'openai'` or `'all'` also checks `/chat/completions`. Expected breaks (the thinking
strip of 07 C5, an edit that starts a branch) are excused with `allow`.

**LLM (`mock.llm`).** OpenAI-compatible `POST …/chat/completions` (SSE: role chunk, `reasoning_content` or
`reasoning` deltas, text deltas, parallel `tool_calls` deltas interleaved per index, finish chunk, usage chunk when
`stream_options.include_usage`, `[DONE]`; or JSON) and `GET …/models`; Anthropic `POST /v1/messages` (SSE
`message_start` · `ping` · `content_block_start/delta/stop` with `thinking_delta` + `signature_delta`, `text_delta`,
`input_json_delta` · `message_delta` · `message_stop`; or JSON) and `GET /v1/models[/:id]` with `capabilities`
objects (one model has `capabilities: null`). Default turn = **echo**: `Echo: <user words>` where the words are the
first text block of the last user message with the `[Now: …]` header (07 C2) and appended recall blocks removed;
after a tool result: `Echo: tool result received`. `mock.llm.script({ text?, reasoning?, reasoningField?,
toolCalls?: [{name, input, id?}], refusal?, stopReason?, usage?, error?: {status, type?, message?, retryAfterSec?},
midStreamError?: {afterEvents}, chunkChars?, delayMs?, firstByteDelayMs?, abortAfterEvents?, hang?, match?: {api?,
model?, lastUserIncludes?} })` queues turns (FIFO among matching). Also `setDefault()`, `requireKey()`,
`setModels()`, `assertConsumed()`. Validation like the real APIs: Anthropic thinking blocks must carry the signature
the mock issued (`thinkingSignature(text)`, else 400 "Invalid `signature` in `thinking` block"); tool_use ↔
tool_result and tool_calls ↔ tool messages must pair up (else 400). Errors use each provider's error shape (OpenAI
`{error:{message,type,code}}`, Anthropic `{type:'error',error:{type,message}}`, 529 overloaded, `retry-after`).

**Voyage (`mock.voyage`).** `POST /v1/embeddings`: deterministic vectors — each word (lower-cased, a few stop words
dropped) seeds a pseudo-random direction; a text is the normalised sum plus a small per-text part, so texts sharing
words are similar and unrelated texts near-orthogonal. `output_dimension` 256/512/1024/2048 (a prefix of the 2048-d
vector, re-normalised), `output_dtype` float/int8/uint8/binary/ubinary (int8 scaled to the largest component; binary
bit-packed, offset −128), `encoding_format: 'base64'`, `usage.total_tokens` (~chars/5), ≤ 1,000 inputs, per-model
token caps. `POST /v1/rerank`: score = share of query words in the document (+ small Jaccard tie-break), sorted,
`top_k`, `return_documents`. Body validated before the key (as the real API), errors `{detail}`. Modes: `mode('ok' |
'unauthorized' | 'rate-limited' | 'server-error' | 'free-trial')` (free trial = 3 RPM / 10K TPM → 429), `setKeys()`,
`failNext(status, n)`; `embeddedTexts()` / `rerankQueries()` for "nothing private reached Voyage" assertions. Pure
helpers `mockEmbedding`, `cosine`, `quantize`, `rerankScore` are exported for unit tests.

**TTS (`mock.tts`, audio from `audio.ts`).** ElevenLabs `GET /v1/voices`, `GET /v2/voices` (paged: `page_size`,
`next_page_token`, `search`, `category`), `GET /v1/models` (bare array incl. a non-TTS model), `GET
/v1/user/subscription`, `POST /v1/text-to-speech/:voice/with-timestamps` → `{audio_base64, alignment,
normalized_alignment}`, `POST /v1/text-to-speech/:voice[/stream]` → bytes, `GET /elevenlabs/preview/:voice` (the
`preview_url`). OpenAI `POST /v1/audio/speech` → 24 kHz WAV. The audio is a **real** PCM16 mono WAV (22,050 Hz by
default): each word a sine burst, each whitespace character silence, characters inside `[audio tags]` zero-length on
v3/v4 models; the alignment is sample-exact (start = offset / rate; the last character ends where the audio ends).
`output_format=pcm_<rate>` (or OpenAI `pcm`) returns raw PCM16 LE — the raw-PCM scenario (07 E10). MP3 cannot be
generated, so `mp3_*` requests receive WAV (header `x-mock-audio-format: wav`). Modes: `mode('no-audio')` (alignment
without audio, the reported v3 bug), `'bad-alignment'`, `'quota'`, `'no-voice-permission'`, `'unauthorized'`,
`'rate-limited'`, `'server-error'`; `failNext(status, n, provider?)`, `setDelay(ms)`, `setQuota(used, limit)`,
`synthTexts()`.

**STT (`mock.stt`).** `POST …/audio/transcriptions` (multipart; `json`, `text`, `verbose_json`, `srt`, `vtt`) returns
scripted transcripts: `script('text', …)`, `setDefault()`, `failNext()`, `setDelay()`, `received()` (model,
filename, bytes, WAV duration).

**Model downloads (`mock.models`).** `GET /k2-fsa/sherpa-onnx/releases/download/asr-models/<file>` → 302 to
`/gh-objects/<file>` (Range/206 for `.part` resume, ETag); `GET /redirect-elsewhere/<file>` → 302 to an untrusted
host. Archives are real `.tar.bz2` files built once from a deterministic ustar by `%SystemRoot%\System32\tar.exe` and
cached in `%TEMP%\vesper-mock-models-v1`: `fixture('ok' | 'tampered' | 'traversal' | 'link')` → `{url, directUrl,
size, sha256, bytes, dir, files}` (`tampered` keeps the ok digest with one byte flipped; `traversal` contains
`../escape.txt`; `link` a symlink out of the directory); `catalogEntry()` gives a `ModelEntry` for the model manager.
`throttle(bytesPerSec)`, `dropNextAfter(bytes)`, `failNext(status)`, `rangesRequested()`.

## 3. Fakes (`tests/fakes/`, 07 E2)
`FakeMemoryService` (searchable `corpus`, `addHit()`, recorded `calls`, `recallRefusal`, `delayMs`),
`FakeSpeechService` / `FakeSpeechSink` (records `push`/`tone`/`end`/`abort` in order, `text`, `tones`, calls after
close in `lateCalls`; `cancel()` aborts the sink as a barge-in), `FakeSttService`, `FakeChatService`,
`FakeWsClient` (records `sent` and `speech` frames, backpressure via `bufferedAmount`), `fakePlatform(dir, {isDesktop?,
secretsUnavailable?, now?})` (in-memory secrets, recorded notifications/openExternal, `forkWorker` via
`child_process.fork`, `setNow`/`advance`), `fakeLog()`, `tempDir()` / `removeTempDir()` / `removeTempDirs()`.

## 4. Test hooks and test endpoints
All of them exist only when the build constant `__VESPER_TEST__` is true **and** `VESPER_TEST=1` (07 B10); the
packaged smoke asserts `/api/test/ping` 404 and `window.__vesperTest` undefined.

`window.__vesperTest = { ready(): boolean, route(): string, go(path): void, errors: string[], ws: { connected():
boolean }, …namespaced }`, extended by feature agents with `registerTestHooks(ns, obj)`. Specs call hooks through
`hook('ns.fn', ...args)` / `waitHook('ns.fn')`; **never** `page.waitForFunction('string')` (the CSP forbids eval) —
only function predicates.

Server (loopback listener, test builds + test mode only):
| Endpoint | Effect |
| --- | --- |
| `GET /api/test/ping` | `{ok: true}` |
| `POST /api/test/login-as {kind: 'browser' \| 'desktop'}` | creates a device and sets its session cookie |
| `POST /api/test/seed {sessions?, messagesPerSession?, bigSession?}` | `{sessionUids: string[]}` |
| `POST /api/test/clock {offsetMs}` | shifts the server clock |
| `GET /api/test/stats` | `{clients, subscriptions, eventLoopDelayP99Ms, rssMB}` |

Product endpoints that tests lean on (normal auth, not test-only): `GET /api/system/resources` (process memory; app
metrics on the desktop), `POST /api/system/unload-voice`, `GET /api/bootstrap` (`mute`, `gameMode`). The
game-mode host is faked in unit tests with `setSystemTestDeps({spawn, hostEnabled, intervalMs, debounceMs,
startDelayMs, backoffMs})` (tests/unit/system/fakeHost.ts); `tests/unit/system/sysstate-real.test.ts` runs the real
read-only host once on Windows.

The standalone server `node out/main/server-node.js` prints `VESPER_READY <url>` once listening.

**Client hook namespaces (Phase 3)** — call as `hook('<ns>.<fn>', …)`; all registered with `registerTestHooks` in
test builds only. Counters/`stats` hooks return to their baseline when idle (leak gates, 07 D14).
| Namespace | Hooks | Registered by |
| --- | --- | --- |
| `chat` | `counters()` (bus, ticker, object URLs, delta buffers, speech overrides, feeds, kit, layers), `armSpeech(sessionUid, {charMs, gapMs, delayMs})` / `disarm()` (synthetic synced reveal without TTS), `speechLog()`, `clearSpeech()`, `stopSpeech()`; per open conversation `window()` (rows, lo/hi/lastSeq, DOM count, rendered range, atBottom), `scrollBy(px)`, `scrollToTop()`, `scrollToBottom()`, `jumpToSeq(seq)`, `pageSize()` | `features/chat/testHooks.ts`, `chat/window/MessageWindow.tsx` |
| `voice` | `state()`, `speech(replyId)`, `speechIds()`, `replays()`, `wantSpeech()`, `expect(replyId)`, `interrupt()`, `speakAgain(messageUid)`, `failures()`, `cancels()`, `stats()` (speech, mic, prefs listeners, earcon nodes, players, engine), `simulateInsecure(on)`, `cancelMic()`, `micEvents()`, `latency(on)` (Ctrl+Alt+L overlay), `latencyRows()` | `features/voice/install.ts` |
| `audio` | `counters()`, `idleArmed()`, `contextState()`, `unlocked()`, `setIdleMs(ms)`, `unlock()`, `now()`, `clock()`, `stats()`, `readOutput()`, `setMuted(m)`, `stop(replyId?)`, `events()` / `clearEvents()`, `revealLog()`, `revealProgress(replyId)`, `revealState(replyId)`, `micStats()` | `lib/audio/testHooks.ts` |
| `presence` | `frames()`, `resetFrames()`, `budget()`, `input()`, `surface()` (target, canvas, minimal2d, glyph, Star state), `gl()`, `driver()`, `setFocus(f)`, `watchPace()` | `features/presence/host/testHooks.ts` |
| `presenceLab` | `setState(state \| 'live')`, `setAccent(a)`, `setTheme('dark' \| 'light')` | `/presence-lab` page |
| `nav` | `stats()` (kit, layers, shortcuts.*, cache.*), `setGameMode(active, reason?)`, `ui()`, `active()` (`{uid, loaded}`), `sidebarRows()` | `features/sessions/testHooks.ts` |
| `kit` | `stats()` (listeners, timers, open layers), `highlighter()` (shiki worker), `setAppearance(theme, accent, reducedMotion?)`, `virtual()` | `/gallery` page |
| `audioGallery` | `playSpeech()`, `playMany()`, `revealDemo()`, `startMic()`, `stopMic()`, `demoText()`, `peaks()`, `resetPeaks()` | `/gallery` audio section |
| `access` | `hostStats()`, `fakeNetwork(patch)` (render Tailscale/Funnel/firewall states for screenshots), `pendingCount()`, `kitStats()`, `pendingPollers()` | `features/access/AccessHost.tsx`, `login/PendingApproval.tsx` |
| `memoryUi` | `stats()` (live feeds, blob URLs, import-preview workers), `runCommand(text, sessionUid)` (slash commands without the composer) | `features/memory/testHooks.ts` |
| `settings` | `saveIdle()` (no save pending), `kit()` | `features/settings/save.ts` |
| `wizard` | `step()` (the step shown) | `features/wizard/WizardPage.tsx` |

**Test-only pages** (`routes.ts` entries with `testOnly: true`, compiled out of the release build — §10 checks it):
| Route | What it shows |
| --- | --- |
| `/gallery` | every kit component in every state, theme/accent/motion controls, virtual list, audio section (`kit`, `audioGallery` hooks) |
| `/voice-lab` | the voice client on its own (mic control, speech playback, latency overlay) for e2e and screenshots |
| `/presence-lab` | the Star alone: every state, style, quality and accent (`presenceLab` hooks); test builds + test mode |
| `/test/memory-ui/:view?` | memory-ui parts that live inside other agents' screens (e.g. `picker`) |
| `/__test/access-wizard` | the wizard's Access step on its own |

## 5. Environment switches (all require a test build and `VESPER_TEST=1`)
Every switch is read through `testEnv()` (server: `src/server/testMode.ts`; main: `src/main/env.ts`), which returns
nothing unless the build has `__VESPER_TEST__` **and** the process runs with `VESPER_TEST=1` (07 B10). The release
build (`VESPER_BUILD_TEST=0`, `npm run dist`) compiles all of them out.

| Switch | Effect | Owner |
| --- | --- | --- |
| `VESPER_TEST=1` | test mode itself: test hooks, `/api/test/*`, every switch below | foundation |
| `VESPER_DATA_DIR` | roaming data dir instead of `%APPDATA%\Vesper` | foundation |
| `VESPER_LOCAL_DIR` | local data dir instead of `%LOCALAPPDATA%\Vesper` (models, logs, Chromium data) | foundation |
| `VESPER_PORT` | loopback port (0 = random); every e2e run uses 0 | foundation |
| `VESPER_WINDOW_SIZE` / `VESPER_WINDOW_POS` | test window content size (`1440x900`) / position (`x,y` or `corner`) | main |
| `VESPER_CLICK_THROUGH=1` | the real mouse passes through the test window | main |
| `VESPER_DIALOG_ANSWER` | native dialogs are not shown; answered with this button index or label (default: the cancel button); each prints a `VESPER_DIALOG …` line | main |
| `VESPER_FAKE_NOW` | the clock's starting point (ms); time then runs at real speed (07 G6) | foundation |
| `VESPER_MOCK_BASE` | origin of the mock provider server; LLM/Voyage/TTS/STT providers and model downloads go there | foundation + providers |
| `VESPER_FAKE_MIC=<wav>` | Chromium fake-media switches with that file as the microphone (main appends them before `ready`) | main |
| `VESPER_MUTE` | test runs are muted by default: the window's audio and `Bootstrap.mute` (clients set output gain 0); `VESPER_MUTE=0` makes both audible | main + platform-int |
| `VESPER_STT_FAKE=1` | the STT process uses the real Silero VAD and a scripted recognizer | voice-in |
| `VESPER_STT_FAKE_TEXT=a\|b` | the scripted transcripts, in order (default: what `tests/fixtures/audio/hello.wav` says) | voice-in |
| `VESPER_STT_MODEL_DIR` | pre-extracted real STT models (by archive directory name) count as installed (real-model tests) | voice-in |
| `VESPER_STT_TEST_CATALOG` | a JSON file of extra model catalogue entries (the mock GitHub server's archives) | voice-in |
| `VESPER_STT_IDLE_MS` | STT process idle-unload delay instead of `voice.stt.unloadAfterMin` | voice-in |
| `VESPER_EXTRACT_TIMEOUT_MS` / `VESPER_EXTRACT_IDLE_MS` | extract process: per-job timeout (default 30 s) / idle exit (default 60 s) | content |
| `VESPER_CHAT_SUMMARY_IDLE_MS` | idle delay before session summaries are refreshed (07 C13) | llm-engine |
| `VESPER_CHAT_RETRY_MS` | delay of the one automatic retry after overloaded/network errors | llm-engine |
| `VESPER_SYSSTATE=1` | run the real, read-only game-mode host (`resources/sysstate.ps1`) in a test run; off by default in tests | platform-int |
| `VESPER_SYSSTATE_INTERVAL_MS` | the host's poll interval (default 5000) | platform-int |
| `VESPER_GAMEMODE_DEBOUNCE_MS` | how long a detected change must hold (default: poll interval + 1 s = two polls) | platform-int |
| `VESPER_GAMEMODE_START_MS` | delay before the host starts in `auto` (default 10 s) | platform-int |
| `VESPER_TEMP_NO_SUBSCRIBER_MS` | a temporary chat ends after this long with no subscribed client (default 600 000) | engine-int |
| `VESPER_TEMP_SWEEP_MS` | how often temporary chats (and unsent temporary uploads) are checked (default 30 000) | engine-int |

Unit-test-only variables (read by test files, not by the app): `VESPER_STT_AUDIO_DIR` (fixture audio for the
real-model STT test, default `<model dir>/../audio`), `VESPER_STT_REPORT` (append per-model WER/load-time JSON lines to
this file), `VESPER_REPORT_STALL=1` (print the measured worst event-loop stall of the 30k export/import test).

Stdout markers of test runs (the launchers and specs read them): `VESPER_READY <url>` (server listening),
`VESPER_NOTIFY {title, body}` (a desktop notification that test mode prints instead of showing),
`VESPER_DIALOG …` (a native dialog that was answered automatically), `VESPER_RESTART` (Platform.restart in a test run:
the app quits without relaunching, so no instance escapes the harness).

Test-only server code paths (no switch, `__VESPER_TEST__` builds only): `setAccessTestDeps()` (access fakes),
`setSystemTestDeps()` (a fake system-state host, short timings), the memory link's `crashForTest()` (db.worker
crash/restart), the extract process' hang/crash markers (supervision tests).

Launcher/script-only variables: `VESPER_MAIN` (default `out/main/index.js`), `VESPER_SERVER_NODE` (default
`out/main/server-node.js`), `VESPER_E2E_CHROMIUM` (browser executable), `PW_OUT` (Playwright output dir; give each
worktree its own).

Dev window override (unpackaged builds, independent of test mode): `%TEMP%\vesper-dev-window.json`
`{"display":"secondary"}` keeps every window on the secondary display without focus (the owner games on the
primary). Delete the file to restore normal placement.

## 6. Launchers (`tests/e2e/launch.ts`)
- `launchApp({ mock?, size?, pos?, clickable?, dataDir?, localDir?, fakeNow?, fakeMic?, env? })` → `{ app, page,
  dataDir, localDir, errors, hook, waitHook, waitReady, api, assertNoErrors(), close({keepData?}) }`. Starts
  `out/main/index.js` with `VESPER_TEST=1`, temp data/local dirs, `VESPER_PORT=0`, `VESPER_WINDOW_SIZE=1440x900`,
  `VESPER_WINDOW_POS=corner`, `VESPER_CLICK_THROUGH=1`, `VESPER_MOCK_BASE` when a mock is given; removes
  `ELECTRON_RUN_AS_NODE`/`ELECTRON_RENDERER_URL` and inherited `VESPER_*`; waits for `__vesperTest.ready()`; collects
  console errors and page errors. `api` = REST from inside the page (desktop device). Relaunch on the same data with
  `close({ keepData: true })` + `launchApp({ dataDir, localDir })`.
- `launchServer({ mock?, runtime?: 'electron' | 'node', login?: 'browser' | 'desktop' | false, open?, viewport?, … })`
  → `{ url, proc, browser, context, page, api, login(kind), cookieHeader(), output(), hook, waitHook, waitReady,
  assertNoErrors(), close() }`. Spawns `server-node.js` (on Electron's Node by default), waits for `VESPER_READY`,
  launches headless Chromium (`--mute-audio`; fake-mic flags with `fakeMic`), signs the context in through
  `POST /api/test/login-as` with the context's own request so the cookie lands in the context, and opens the app.
  Playwright's request client and `context.cookies(url)` skip Secure cookies over http, so `api`/`cookieHeader` send
  the context's cookies explicitly. `login('desktop')` returns an `api` bound to a second (desktop) device — provider
  settings are desktop-only (07 B2). Chromium: Playwright's own build if installed, else the newest installed
  ms-playwright build, else Edge (`channel: 'msedge'`); nothing is downloaded.
- `pageApi(page)`, `rawRequest(url, {method, path, headers, body})` (exact headers, e.g. a forged Host),
  `sameOriginHeaders(url, cookie)`.
- `tests/e2e/helpers.ts`: `routes`, `configureMockLlm(api, mockUrl)`, `createSession`, `latestMessages`, and
  `wsTurn(page, sessionUid, text)` — one chat turn over a second WebSocket opened inside the page (hello → ready →
  subscribe → chat.send → reply.done), returning `{body, deltas, events}`.

Both launchers use fresh temp dirs and remove them on close; every e2e run uses `VESPER_PORT=0`, so parallel
worktrees never collide. `playwright.config.ts`: projects `electron` (`tests/e2e/electron/**`) and `browser`
(`tests/e2e/browser/**`), 1 worker, 0 retries, `outputDir` from `PW_OUT`, `tsconfig.e2e.json`.

## 7. Screenshots (`npm run shot -- --route settings --size 1440x900 --out .shots/settings.png`)
`scripts/shot.mjs` launches the built app like `launchApp` (temp dirs, test mode, click-through, the dev-window
marker's display), optionally seeds data (`--seed '{"sessions":3}'` → `/api/test/seed`), calls `go(route)`, waits for
`--until <hook>` (default `ready`) plus `--wait <ms>`, and saves the PNG. Also `--mock-base`, `--fake-now`, `--pos`,
`--keep-open <ms>`, `--full-page`, `--main`. Prints `{ok, out, route, errors}`; exit 1 on console/page errors. In Git
Bash pass the route without the leading slash (MSYS rewrites `/settings` into a Windows path).

**Screenshot specs.** Some run in every e2e pass (they also assert no console errors / no horizontal overflow); the
long review passes are opt-in and show as "skipped" otherwise (11 in a full run).
| Spec (browser project) | Runs | Flags | Output |
| --- | --- | --- | --- |
| `chat-ui-shots.spec.ts` | always | — | `$PW_OUT/…` (test output dir) |
| `sessions-ui.shots.spec.ts` | always | — | `test-results/sessions-ui-shots/` |
| `ui-kit.spec.ts` "screenshots" test | always | — | `$PW_OUT/…` |
| `settings-wizard-shots.spec.ts` | opt-in | `VESPER_SHOTS=1` (all sizes, dark + light; minutes) or `VESPER_SHOTS=quick` (1440×900 dark) | `$PW_OUT/shots` |
| `memory-ui.shots.spec.ts` | opt-in | `VESPER_SHOTS=1`; `SHOTS=<regex>` limits screens; `SHOTS_MEMORY_ON=1` adds the memory-on states | `$PW_OUT/…` |
| `presence-shots.spec.ts` | opt-in | `PRESENCE_SHOTS=1` | `test-results/presence-shots/` (outside PW_OUT) |
| `access-ui.shots.spec.ts` | opt-in | `ACCESS_SHOTS=1`; `ACCESS_SHOTS_ONLY=<regex>`; `ACCESS_SHOTS_DIR` | `test-results/access-ui-shots/` |
Example: `VESPER_SHOTS=quick PW_OUT=test-results/me npx playwright test --project browser settings-wizard-shots`.
Sizes used across the passes: 1440×900, 1138×608 (the owner's primary monitor in DIP) and 390×844 (phone).

## 8. Requirement → tests (07 E13)
Tests carry `@R<n>` tags in titles or comments. `npm run req-coverage` prints, per requirement of 00-BRIEF, the
number of tags and files (`--files` lists them, `--json` for tooling) and exits 1 when any of R1–R22 has none (R23 is
the Orrery handoff document). It is a gate: `npm test` runs it through `tests/unit/docs/owner-docs.test.ts`, which
fails while any of R1–R22 lacks a tag. Status (Phase 5): every requirement R1–R22 has tagged tests.

## 9. Platform tests (platform-int, Phase 3)
- **Workers.** `forkWorker` passes `execArgv` on every Platform (Electron utilityProcess needs an array; the node and
  fake platforms forward it to `child_process.fork`): `tests/unit/system/routes.test.ts` checks the heap cap reaches
  the child. Content tests bundle `db.worker.js` next to `extract.process.js` (`buildWorkers()`), so export, import
  and backup run on the real worker thread; `tests/unit/memory/*` keep the in-process engine (no built file).
- **Responsiveness.** Main-thread stalls are measured with a `setImmediate` chain (`worstStall()` in
  `tests/unit/content/data.test.ts`): it never lets the loop sleep, so a gap is real blocking time. A `setInterval`
  probe mostly measures Windows' 15.6 ms timer tick once the work has moved off the main thread.
- **Never in tests:** a real global shortcut (the hotkey logic runs against a fake `globalShortcut`; the electron spec
  only asserts nothing is registered), opening a folder (`openPath` is faked; the electron spec never calls it), a real
  relaunch (`VESPER_RESTART`), UAC or system settings. The game-mode host is read-only.

## 10. Integration tests (Phase 4, int-server)
- **Hub rings** (`tests/unit/server/hub-rings.test.ts`): `emit(…, {except: Set})` (every synced-reveal speaker), rings
  dropped with `dropSession` (temporary chat ended, trash purged) together with their subscriptions, unwatched rings
  aged out (`HubOptions.ringIdleMs`, default 10 min) and LRU-capped (`maxRings`, default 2048), and a ring created
  after a drop starts at the dropped high-water mark, so a stale `sinceEvSeq` always reads as "refetch".
- **Temporary-chat leaks** (`tests/unit/chat/temporary.test.ts`): 100 temporary chats with sent and unsent uploads →
  stores, temp files on disk, pending uploads, hub rings and engine counters back to baseline; unsent uploads go after
  the orphan grace (60 s, no live chat of the device) or the idle time (1 h) — `sweep(now)` takes the time.
- **Several speakers** (`tests/unit/chat/reveal.test.ts`, "several speaking clients"): `perDevice: 'all'` with two
  unlocked clients → neither gets deltas; a backpressured one alone gets the snapshot.
- **db.worker gone for good** (`tests/unit/content/worker-fallback.test.ts`): the worker is crashed for real
  (`crashForTest`) three times (restarted) and a fourth time during a 30k export, which is re-run in the main process;
  afterwards export, import and backup run in-process and the log says so.
- **Busy database** (`tests/unit/server/busy.test.ts`): a second connection holds the write lock (as db.worker would);
  the main connection gives up after 250 ms per statement, a chat turn's rows retry asynchronously and are all saved,
  the event loop never stalls for the hold, and other requests answer 503 `db_error` (retryable).
- **Session tokens and search filters** (`tests/unit/server/session-tokens-search.test.ts`): migration 9's totals and
  triggers; `GET /api/search` `role` / `from` / `to` with paging.
- **Release build** (`tests/unit/system/packaging.test.ts`, also `npm run release:check`): builds with
  `VESPER_BUILD_TEST=0` into a temp folder (`VESPER_OUT_DIR`; never `out/`), then greps main, preload and web for
  `__vesperTest`, `/api/test/*`, `login-as`, the test-only page routes and every `VESPER_*` switch (as code, not
  comments; `VESPER_READY` is the headless server's stdout marker and allowed). The same grep must find them in the
  test build. Also checks the notices (`scripts/licenses.mjs`: production dependencies + bundled devDependencies with
  their licence texts + `resources/licenses/models.json`), `/THIRD_PARTY_NOTICES.txt` serving, and that
  `electron-builder.yml` ships `resources/` (wintts.ps1, sysstate.ps1, Silero VAD) and the notices next to the exe.
- **Determinism fixes**: `sha256File` settles on the stream's `close` (a just-hashed `.part` deleted on Windows stayed
  "delete pending" in the folder listing under load); stale embedding batches are discarded after "delete index"
  (generation numbers are reused, so a batch in flight used to write into the new gen 1).

## 11. Rules
- Never call real paid APIs from tests; never require a key (`npm run live-check`, never in `npm test`, reads the
  owner's keys from the environment for the risks only real keys can settle).
- No test may depend on the machine's real AppData, real microphone or real speakers (muted window audio, fake media
  streams).
- Playwright never uses string `waitForFunction` (CSP forbids eval) — function predicates and hooks only.
- Windows open on the secondary display and never take focus; browsers are headless.
- Every e2e spec launches its own app/server on a random port and temp dirs; specs never share state through
  AppData.
- The owner's documents are tested like code (`tests/unit/docs/owner-docs.test.ts`): every quoted label in README.md
  and docs/OWNER-NOTES.md (the in-app Design notes) must exist in the app's source (settings-search keywords don't
  count), every "Settings → …" path must start at a real section, retired names (session, side panel, old access-mode
  names) fail, and specific claims are tied to the code that decides them (defaults, temporary-chat lifetime, sign-in
  lifetimes, live-check's variables, the installer config). Quote something that isn't Vesper's UI? Add it to the
  test's `NOT_UI` list.

## 12. Soak / leak gates (07 D14), owner checks and the packaged smoke

### `npm run soak` — tests/soak/** (07 §H-presence-4)
Builds the test flavour, then runs eight long scenarios on the built app (`playwright.soak.config.ts`, one worker,
~80 min). `SOAK_SCALE` scales every count and duration (`SOAK_SCALE=0.05 npx playwright test -c
playwright.soak.config.ts` is a 5-minute smoke of the harness). Each scenario warms up, takes a post-warm-up baseline,
runs, samples about ten times, and fails when the end value exceeds the baseline by more than the gate's threshold or
the second half of the run still trends upward (projected growth > half the threshold); exact counters must be back
to their baseline or zero. Every run writes `test-results/soak-results/<scenario>.json` and prints a table. All soak
specs pin `performance.gameMode` to off (a fullscreen game on this PC must not change a run).

Measurement (`tests/soak/soak.ts`): renderer — CDP `HeapProfiler.collectGarbage` ×2, `Runtime.getHeapUsage`,
`Memory.getDOMCounters`; a `getContext` wrapper (WebGL contexts) and a `createObjectURL`/`revokeObjectURL` wrapper
(blob URLs) installed before the app; server — `GET /api/test/leaks` (heap after a full GC, active handles by type,
hub / engine / speech / STT / auth / Windows-voice-host maps); end of every soak — the WAL once nobody is looking at
Vesper (≤ 64 MB: the WAL watcher truncates it then, data/checkpoint.ts) and no ERROR line in the log.

**Results — 2026-10-05, this PC, scale 1: 8 passed (1.2 h).**

| Scenario (spec) | Run | Gates (threshold) → measured |
| --- | --- | --- |
| 1,000 streamed text replies, ~4 kB with code + math (`text-replies`) | 1,000 replies, N = 100 | renderer heap after GC (+15 MB) 16.5 → 21.7 MB, trend +0.1; server heap (+10) 27.7 → 28.4; store rows ≤ 3N: 300; DOM nodes 2,555 (≤ empty chat 439 + 3N × 326); jsEventListeners on the empty chat 573 → 573; engine replies/controllers 0; WAL 162 MB while in use → 0 MB idle |
| 1M-message session: both ends twice (jump + 5 pages inward) + 200 jumps (`history-scroll`) | 1,000,000 rows seeded in 60 s | renderer heap (+20) 11.3 → 11.7 MB; worst store rows 251 (≤ 3N + 1); worst DOM messages 29; WAL 2.3 GB after the seed → 0 MB idle |
| 200 spoken replies (mock ElevenLabs, synced reveal) + 50 barge-ins by Stop (`voice-replies`) | 200 / 50 | live AudioBufferSourceNodes 0; AudioContexts 1; audio nodes back to baseline (2); decoded buffers 0; reveal bindings 0 after leaving the chat; Ranges in the 4 shared reveal highlights 0; speech records 65 (64 finished kept by design + 1); renderer heap (+15) 13.6 → 15.3 MB; server heap 28.1 → 26.2 MB; speech jobs 0 |
| Talk mode 30 min on a talking fake mic, then 100 Talk open/close + 100 session switches (`talk-mode`) | 150 spoken turns | WebGL contexts ever created 1, alive 1; mic tracks live ≤ 1 during, 0 streams / 0 worklet ports after; scheduler rAF callbacks over the display's own rate: 0/s (review F44); STT utility RSS (+50) 86 → 89 MB; renderer heap (+15) 9.7 → 11.9 MB; server heap (+10) 26.5 → 29.0 MB; WS listeners/subscriptions back to baseline; STT mic sessions 0 |
| 10,000 WS connect/disconnect, every 20th mid-reply, every 50th mid-STT (`ws-storm`) | 10,000 / 500 / 200 | server heap (+10) 26.0 → 27.7 MB, trend +0.15; active handles back to baseline (PipeWrap 2, TCPServerWrap 1, TCPSocketWrap 2, ProcessWrap 1); hub clients 0, subscriptions 0, rings 4; engine replies 0; STT mic + recognizer sessions 0; speech jobs 0 |
| 500 attachment paste/remove cycles (`attachments`) | 500 images | blob URLs outstanding 0 (500 made); composer counter 0; DOM nodes +0; renderer heap (+15) 10.0 → 10.8 MB |
| 200 replies in the Windows voice (WinRT host, `local-voice`; Kokoro is not shipped, 07 E7) | 200 | voice host private working set (+30) 75.8 → 83.5 MB (max 97); one host process for the run; 0 replies fell back to text; renderer heap 13.3 → 15.1 MB |
| D2 memory budgets, desktop app (`budgets`, Electron, secondary display) | private working set | window idle on a chat with the Star stage 230 MB (≤ 550); + speech recognition (scripted recognizer + Silero VAD, no Parakeet weights) 250 MB (≤ 850); tray only (renderer destroyed, voice unloaded) 151 MB (≤ 250). Commit charge for the record: 350 / 413 / 381 MB — in the tray the GPU process keeps ~245 MB committed (~67 MB resident) |

Found and fixed by these runs: the Windows voice host quit after every request and the 4th Windows-voice reply in 5
minutes failed (07 §H-presence-5); a chat left open at the live edge kept every message (1,700 rows after 1,000
replies; now trimmed to 3N, `tests/e2e/browser/chat-window-live.spec.ts`); the frame scheduler's forked rAF chains
(26,000 callbacks/s after six crossfades before the fix, review F44).

### `npm run live-check` — the owner's keys (07 E10)
`scripts/live-check.mjs`, for a source checkout: keys only from environment variables (`ANTHROPIC_API_KEY`,
`ELEVENLABS_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, and the other presets'
`<ID>_API_KEY`, each with an optional `<ID>_MODEL`), never saved or printed; with none set it calls nothing and exits 2.
One small request per risk (cents at most): ElevenLabs `/with-timestamps` alignment (Vesper's own validity rules, the
audio-tag prefix, timing vs audio length, quota), Voyage embed + rerank + whether the key is on the free-trial limits,
Anthropic thinking + tool call replayed byte for byte and a third turn over the whole history, `/models` (and an
optional 1-token chat) for every other provider, and cloud speech recognition on `hello.wav`. Prints PASS / WARN /
FAIL / skip per check; exit 1 on any failure. `tests/unit/scripts/live-check.test.ts` runs it against the mocks
(`LIVE_CHECK_MOCK_BASE`, loopback only). Never part of `npm test`.

### `npm run smoke:packaged` — the shipped exe (07 B10)
Builds the release flavour (`VESPER_BUILD_TEST=0`), packages it unpacked (`electron-builder --dir` into
`release/smoke`, the inspect fuse left on for Playwright) and runs `scripts/smoke-packaged.mjs --exe …`: the app starts
in a temporary Windows profile (USERPROFILE / APPDATA / LOCALAPPDATA, preflighted with a throwaway Electron app of
the same runtime — nothing launches if appData would not land there), as a login item would (`--background`: no
window, nothing takes focus); the server answers (page, notices, `/api/auth/state`), `/api/test/ping` and
`/api/test/login-as` are 404, the web client renders in a hidden window of the app's own session with the preload from
the asar and `window.__vesperTest` undefined, `VESPER_TEST=1` + `VESPER_*` paths in the environment are ignored, and
quitting exits with code 0 leaving no process behind. Result 2026-10-05: 16/16 checks passed. It leaves the release
build in `out/`: `npm run e2e` / `npm run soak` rebuild the test flavour first, a bare `npx playwright test` does not.
