/**
 * REST contract (03 §3 + 07 B2/C21). Every route: `/api/...`, JSON, mutating requests need header `X-Vesper: 1`,
 * errors are `{error: ApiError}` with an HTTP status. `auth` is the minimum authorization level (07 B2):
 *   public (no session) · device (any signed-in device) · sudo (password within 10 min; desktop counts) · desktop.
 * The typed client (`web/lib/api.ts`) and the server route modules both use `Endpoints`.
 */
import type { ApiError, ErrorCode } from './errors'
import type {
  AccessMode,
  AttachmentRef,
  DataUsage,
  DeviceInfo,
  Fact,
  MemoryHit,
  MemoryStatus,
  MessagePage,
  ModelInfo,
  NetworkStatus,
  Prompt,
  ProviderTestResult,
  SearchHit,
  Session,
  SessionSummary,
  SessionVoice,
  TimelineEntry,
  TimelineSample,
  Variant,
  Voice
} from './types/domain'
import type { DeepPartial, PresetId, PublicSettings, Settings } from './settings'
import type { SttModelInfo } from './models'
import type { Preset } from './presets'
import type { GameModeReason } from './ws'

export const CSRF_HEADER = 'x-vesper'
export type AuthLevel = 'public' | 'device' | 'sudo' | 'desktop'

export interface Bootstrap {
  version: string
  desktop: boolean
  device: { id: string; kind: DeviceInfo['kind']; name: string; listener: DeviceInfo['listener']; sudo: boolean }
  settings: PublicSettings
  /** Names of saved secrets (never values). */
  secretsSet: string[]
  /** Secrets that exist but can't be decrypted on this Windows account (07 C19). */
  secretsInvalid: string[]
  network: NetworkStatus
  memory: MemoryStatus
  portable: boolean
  isTest: boolean
  /** Test builds: VESPER_MUTE (default on in test mode) — clients set their output gain to 0 (audio still runs). */
  mute?: boolean
  /** Game mode state at bootstrap time (then `gamemode.changed` events), 07 D3. */
  gameMode?: { active: boolean; reason: GameModeReason }
  dataPaths: { roaming: string; local: string } | null
  /** Things the owner must be told about (phase 4c fix-platform; then `health.changed`). Optional: older servers. */
  health?: SystemHealth
}

/**
 * settings.json could not be used as it was (07 C19, F59). `repaired`: some values were invalid and use their defaults;
 * `restored`: the file was unreadable, the last saved copy (settings.json.bak) is in use; `reset`: unreadable and no
 * usable copy — defaults are in use. `copy` names the copy of the damaged file kept next to it (null: copying failed).
 */
export interface SettingsRecovery {
  kind: 'repaired' | 'restored' | 'reset'
  copy: string | null
  /** `repaired`: the setting paths that fell back to their defaults. */
  dropped: string[]
  atUtc: number
}

/** Owner-facing health of the PC side (07 C19/C20): Bootstrap.health and the `health.changed` event. */
export interface SystemHealth {
  settingsRecovered: SettingsRecovery | null
  /** Free space on the data drive is below 200 MB: backups and memory backfill are paused (07 C19, F66). */
  lowDisk: { freeBytes: number; thresholdBytes: number; sinceUtc: number } | null
  /** The last backup failed (cleared by the next one that works). `kind` daily = the automatic one. */
  lastBackupError: { code: ErrorCode; message: string; atUtc: number; kind: 'daily' | 'manual' } | null
}

export interface AuthState {
  passwordSet: boolean
  pairingAvailable: boolean
  setupComplete: boolean
  version: string
  lockedUntilUtc: number | null
  /** Test build + test mode (lets the login page install test hooks). */
  isTest: boolean
  /** This request carried a valid, approved device cookie: the client may call /api/bootstrap. */
  signedIn: boolean
  /** This device signed in but still waits for approval on the PC (07 B16). */
  pendingApproval: boolean
}

/** What the auth core knows without a request; the route adds the per-request fields. */
export type AuthStateBase = Omit<AuthState, 'signedIn' | 'pendingApproval'>

export interface ListSessionsQuery {
  q?: string
  cursor?: string
  filter?: 'all' | 'pinned' | 'archived' | 'trash'
  limit?: number
}

export interface CreateSessionBody {
  title?: string
  systemPrompt?: string
  promptId?: number
  /** Short ids of sessions this one may recall. */
  links?: string[]
  /** `/continue #ID`: uid of the source session (07 C18). */
  continueFrom?: string
  /**
   * With `continueFrom` (additive, P22): speak the opening reply on the requesting device, as `chat.send.speak` does —
   * the device's "speak replies" is on. The sender is the tab named by `speakClientId`, else the device's tab showing the
   * source chat, else its focused, audio-unlocked tab.
   */
  speak?: boolean
  /** With `speak` (additive, P22): the requesting tab's own WebSocket client id (`ready.clientId`); used only when it
   *  is a live tab of the requesting device. */
  speakClientId?: string
  temporary?: boolean
  private?: boolean
}

export interface PatchSessionBody {
  title?: string
  pinned?: boolean
  archived?: boolean
  private?: boolean
  memory?: Session['memory']
  memoryScope?: Session['memoryScope']
  systemPrompt?: string
  promptId?: number | null
  llmProfile?: string | null
  model?: string | null
  voice?: SessionVoice | null
}

export interface MessagesQuery {
  mode: 'latest' | 'before' | 'after' | 'around'
  seq?: number
  limit?: number
}

export interface LocateResult {
  sessionUid: string
  seq: number
  onPath: boolean
  /** Fork choices to select (in order) so that the message is on the active path. */
  branchPath: { forkSeq: number; branchId: number }[]
}

export interface SearchQuery {
  q: string
  scope?: 'all' | 'session'
  session?: string
  mode?: 'keyword' | 'semantic'
  order?: 'relevance' | 'recent'
  cursor?: string
  limit?: number
  /**
   * Server-side filters (Phase 4, additive; the search page also filters its pages client-side): only messages of
   * this role, and only messages whose machine timestamp `tsUtc` is ≥ `from` and < `to` (UTC ms).
   */
  role?: 'user' | 'assistant'
  from?: number
  to?: number
}

/**
 * The memory viewer's timeline (R7; memory-ui, Phase 3, additive): visible on-path messages, newest first. With
 * `session` the order is the session's own (seq); otherwise by machine timestamp across all sessions (imports keep
 * their original times). `cursor` is the opaque `next` of the previous page.
 */
export interface MemoryTimelineQuery {
  session?: string
  role?: 'user' | 'assistant'
  /** Inclusive bounds on ts_utc (ms). */
  fromUtc?: number
  toUtc?: number
  cursor?: string
  limit?: number
}

export interface SecretPut {
  value: string
  /** For provider keys: the base URL (origin) this key is bound to (07 B1). */
  forUrl?: string
  /**
   * `false` skips the provider check on save (Phase 4, additive; default true): for a client that tests the key
   * itself right after saving and shows the mapped result there (the AI-provider editor in Settings and the wizard,
   * 07 D11) — one request instead of two, and no 10 s save when the provider does not answer.
   */
  check?: boolean
}

export interface NetworkPut {
  mode?: AccessMode
  port?: number
  lanAddress?: string | null
  lanPort?: number
  funnel?: boolean
  keepRemoteWhileClosed?: boolean
  /** Listener C's loopback port (07 E12, default 41732). */
  tailnetPort?: number
  /** Funnel auto-off timer in hours, 0 = never (07 B14). */
  funnelAutoOffHours?: number
  /** "Pause remote access" (tray / Access page): stops Listeners B and C until resumed; kept across restarts. */
  paused?: boolean
  /** Lift the suspension of password sign-in from other devices after too many failures (07 B15). */
  resumeRemoteLogin?: boolean
}

/** Which origin a pairing link points at (default: the current access mode). 'local' links open on this PC only. */
export type PairTarget = 'local' | 'lan' | 'tailnet'

export interface ExportQuery {
  session?: string
  format: 'md' | 'json'
}

export interface ImportResult {
  sessions: number
  messages: number
  attachments: number
  skipped: number
  source: 'vesper' | 'chatgpt' | 'claude'
}

/** One entry per route. `res` is the JSON body on success (void = 204). */
export interface Endpoints {
  // auth & devices
  'GET /api/auth/state': { auth: 'public'; res: AuthState }
  'POST /api/auth/login': { auth: 'public'; body: { password: string; deviceName: string }; res: { deviceId: string } }
  'POST /api/auth/logout': { auth: 'device'; res: void }
  'POST /api/auth/sudo': { auth: 'device'; body: { password: string }; res: { untilUtc: number } }
  'POST /api/auth/password': { auth: 'device'; body: { current?: string; next: string }; res: void }
  'GET /api/auth/devices': { auth: 'device'; res: DeviceInfo[] }
  'DELETE /api/auth/devices/:id': { auth: 'sudo'; res: void }
  'POST /api/auth/devices/:id/approve': { auth: 'desktop'; body: { allow: boolean }; res: void }
  'GET /api/auth/log': { auth: 'sudo'; res: { tsUtc: number; event: string; ip: string | null; detail: string | null }[] }
  'POST /api/auth/pair': { auth: 'desktop'; body: { target?: PairTarget }; res: { code: string; url: string; qrSvg: string; expiresUtc: number; target: PairTarget } }
  'POST /api/auth/pair/redeem': { auth: 'public'; body: { code: string; deviceName: string }; res: { deviceId: string; pending: boolean } }
  // bootstrap & settings
  'GET /api/bootstrap': { auth: 'device'; res: Bootstrap }
  'GET /api/settings': { auth: 'device'; res: PublicSettings }
  'PATCH /api/settings': { auth: 'device'; body: DeepPartial<Settings>; res: PublicSettings }
  'PUT /api/secrets/:name': { auth: 'desktop'; body: SecretPut; res: { ok: true; test?: ProviderTestResult } }
  'DELETE /api/secrets/:name': { auth: 'desktop'; res: void }
  'GET /api/protocols': { auth: 'device'; res: { text: string; isDefault: boolean; hash: string; warnings: string[] } }
  'PUT /api/protocols': { auth: 'desktop'; body: { text: string }; res: { hash: string; warnings: string[] } }
  'POST /api/protocols/reset': { auth: 'desktop'; res: { hash: string } }
  // sessions
  'GET /api/sessions': { auth: 'device'; query: ListSessionsQuery; res: { items: SessionSummary[]; next: string | null } }
  'POST /api/sessions': { auth: 'device'; body: CreateSessionBody; res: Session }
  'GET /api/sessions/:uid': { auth: 'device'; res: Session }
  'PATCH /api/sessions/:uid': { auth: 'device'; body: PatchSessionBody; res: Session }
  'DELETE /api/sessions/:uid': { auth: 'device'; res: void }
  'POST /api/sessions/:uid/restore': { auth: 'device'; res: Session }
  'POST /api/sessions/:uid/epoch': { auth: 'device'; body: { reason: 'apply-protocols' | 'refresh-context' }; res: { epochId: number } }
  'PUT /api/sessions/:uid/links/:shortId': { auth: 'device'; body: { bothWays?: boolean }; res: Session }
  'DELETE /api/sessions/:uid/links/:shortId': { auth: 'device'; res: Session }
  'POST /api/trash/empty': { auth: 'device'; res: { purged: number } }
  // messages
  'GET /api/sessions/:uid/messages': { auth: 'device'; query: MessagesQuery; res: MessagePage }
  'GET /api/sessions/:uid/timeline': { auth: 'device'; query: { samples?: number }; res: TimelineSample[] }
  'GET /api/sessions/:uid/variants/:seq': { auth: 'device'; res: Variant[] }
  'POST /api/sessions/:uid/variants/:seq': { auth: 'device'; body: { branchId: number }; res: { lastSeq: number } }
  'GET /api/messages/:uid/locate': { auth: 'device'; res: LocateResult }
  'DELETE /api/messages/:uid': { auth: 'device'; query: { refresh?: '1' }; res: void }
  /** The memories recalled for an AI reply (the "Remembered" chip, 07 A4); forgotten ones are left out. chat-ui, Phase 3. */
  'GET /api/messages/:uid/recalled': { auth: 'device'; res: MemoryHit[] }
  'POST /api/messages/:uid/restore': { auth: 'device'; res: void }
  // search & memory
  'GET /api/search': { auth: 'device'; query: SearchQuery; res: { items: SearchHit[]; next: string | null } }
  'GET /api/memory/status': { auth: 'device'; res: MemoryStatus }
  'POST /api/memory/recall': { auth: 'device'; body: { query: string; sessionUid: string }; res: MemoryHit[] }
  'POST /api/memory/reindex': { auth: 'sudo'; body: { scope: 'all' | 'missing' }; res: { queued: number } }
  'POST /api/memory/backfill': { auth: 'device'; body: { choice: 'all' | 'new' | 'sessions'; sessionUids?: string[] }; res: { queued: number; estTokens: number; estSeconds: number } }
  'GET /api/memory/backfill/estimate': { auth: 'device'; res: { messages: number; sessions: number; estTokens: number; estUsd: number; estSeconds: number } }
  'GET /api/memory/manifest': { auth: 'device'; res: { sessions: Array<SessionSummary & { links: string[]; linkedFrom: string[] }>; exportedUtc: number } }
  'DELETE /api/memory/messages/:uid': { auth: 'device'; res: void }
  'DELETE /api/memory/index': { auth: 'sudo'; res: void }
  'GET /api/memory/timeline': { auth: 'device'; query: MemoryTimelineQuery; res: { items: TimelineEntry[]; next: string | null } }
  'GET /api/facts': { auth: 'device'; res: Fact[] }
  'POST /api/facts': { auth: 'device'; body: { text: string }; res: Fact }
  'PATCH /api/facts/:id': { auth: 'device'; body: { text: string }; res: Fact }
  'DELETE /api/facts/:id': { auth: 'device'; res: void }
  // prompts library
  'GET /api/prompts': { auth: 'device'; res: Prompt[] }
  'POST /api/prompts': { auth: 'device'; body: { name: string; body: string }; res: Prompt }
  'PATCH /api/prompts/:id': { auth: 'device'; body: { name?: string; body?: string }; res: Prompt }
  'DELETE /api/prompts/:id': { auth: 'device'; res: void }
  // attachments (POST is multipart: field "file" + optional "thumb" + "meta" JSON {name, width, height})
  'POST /api/attachments': { auth: 'device'; res: AttachmentRef }
  'GET /api/attachments/:sha': { auth: 'device'; query: { thumb?: '1'; download?: '1' }; res: void }
  'GET /api/attachments/:sha/text': { auth: 'device'; res: { text: string; chars: number; truncated: boolean } }
  // providers (wizard / settings)
  'GET /api/providers/presets': { auth: 'device'; res: Preset[] }
  'POST /api/providers/llm/test': { auth: 'desktop'; body: { profileId?: string; preset: PresetId; baseUrl: string; model?: string; key?: string }; res: ProviderTestResult }
  'GET /api/providers/llm/models': { auth: 'device'; query: { profile: string }; res: ModelInfo[] }
  'POST /api/providers/voyage/test': { auth: 'desktop'; body: { key?: string; baseUrl?: string; model?: string }; res: ProviderTestResult }
  'POST /api/providers/tts/test': { auth: 'desktop'; body: { provider: string; key?: string; baseUrl?: string }; res: ProviderTestResult }
  'POST /api/providers/stt/test': { auth: 'desktop'; body: { provider: string; key?: string }; res: ProviderTestResult }
  'GET /api/tts/voices': { auth: 'device'; query: { provider: string; refresh?: '1' }; res: { voices: Voice[]; models: ModelInfo[]; quota?: { used: number; limit: number } } }
  'GET /api/tts/preview/:provider/:voiceId': { auth: 'device'; res: void }
  'POST /api/tts/sample': { auth: 'device'; body: { provider?: string; voiceId?: string; text: string }; res: void }
  // speech-to-text models
  'GET /api/stt/models': { auth: 'device'; res: SttModelInfo[] }
  'POST /api/stt/models/:id/download': { auth: 'desktop'; res: void }
  'DELETE /api/stt/models/:id': { auth: 'desktop'; res: void }
  'POST /api/stt/unload': { auth: 'device'; res: void }
  // network & access
  'GET /api/network': { auth: 'device'; res: NetworkStatus }
  'PUT /api/network': { auth: 'desktop'; body: NetworkPut; res: NetworkStatus }
  'POST /api/network/firewall/allow': { auth: 'desktop'; body: { publicToo?: boolean }; res: NetworkStatus }
  'POST /api/network/tailscale/serve': { auth: 'desktop'; body: { on: boolean; funnel?: boolean }; res: NetworkStatus }
  // data
  'GET /api/export': { auth: 'sudo'; query: ExportQuery; res: void }
  'POST /api/import': { auth: 'sudo'; res: ImportResult }
  'POST /api/backup': { auth: 'sudo'; res: { file: string; bytes: number } }
  'GET /api/backups': { auth: 'sudo'; res: { file: string; bytes: number; createdUtc: number }[] }
  'POST /api/backups/restore': { auth: 'desktop'; body: { file: string }; res: void }
  'GET /api/data/usage': { auth: 'device'; res: DataUsage }
  'GET /api/system/resources': { auth: 'device'; res: SystemResources }
  'POST /api/system/open-folder': { auth: 'desktop'; body: { which: OpenFolderTarget }; res: void }
  /** "Unload voice models now" (07 D2): STT process exits, the Windows voice host exits; `clientHints` for the client. */
  'POST /api/system/unload-voice': { auth: 'device'; res: UnloadVoiceResult }
  // updates (H-v12-updates): every device may see the state; only the desktop app controls it
  'GET /api/system/update': { auth: 'device'; res: UpdateStatus }
  /** Check now (also while automatic checks are off). Answers the state after the check. */
  'POST /api/system/update/check': { auth: 'desktop'; res: UpdateStatus }
  /** 'ask' mode: download the version that is available. */
  'POST /api/system/update/download': { auth: 'desktop'; res: UpdateStatus }
  /** "Restart to update": installs the downloaded version and starts Vesper again (409 when none is ready). */
  'POST /api/system/update/restart': { auth: 'desktop'; res: void }
}

/**
 * Where the updater is (H-v12-updates). 'unsupported': this host never updates itself (the standalone server, dev and
 * test runs, a build whose repository is still the placeholder). The portable build only checks: it reports
 * 'available' with `releaseUrl` and never downloads.
 */
export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error' | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The new version (available, downloading, ready). */
  version?: string
  /** Download progress, 0–100. */
  percent?: number
  /** The release page of `version` on GitHub. */
  releaseUrl?: string
  /** When the last check finished (UTC ms). */
  checkedUtc?: number
  /** A short owner-facing text (never an upstream message). */
  error?: string
  /** The portable build: checks only, never downloads or installs. */
  portable?: boolean
}

/**
 * Folders Settings may open in Explorer (desktop only). A FIXED set resolved by the server — never a client path.
 * 'roaming' = 'data' (%APPDATA%\Vesper), 'local' = %LOCALAPPDATA%\Vesper.
 */
export type OpenFolderTarget = 'roaming' | 'local' | 'backups' | 'exports' | 'data' | 'logs' | 'models'

export interface SystemProcessInfo {
  name: string
  pid: number
  /** Private working set (07 D2 budgets) where known, else the working set / RSS. */
  memMB: number
  cpu: number
  /** Electron process type (Browser, Tab, GPU, Utility, …); 'Server' for the standalone server. */
  type?: string
  /** Private bytes in MB (Windows desktop), null where unknown. */
  privateMB?: number | null
}

export interface SystemResources {
  processes: SystemProcessInfo[]
  /** Sum of the processes' private memory (desktop) — compare with `budgetsMB`. */
  totalMB?: number
  /** 07 D2 budgets: tray only ≤ 250 MB, window idle ≤ 550 MB, + speech recognition ≤ 850 MB. */
  budgetsMB?: { trayOnly: number; windowIdle: number; withStt: number }
  /** What is loaded right now. */
  voice?: { sttLoaded: boolean; winttsRunning: boolean }
  gameMode?: { active: boolean; reason: GameModeReason }
}

export interface UnloadVoiceResult {
  /** The speech-recognition process was stopped (open mics end). */
  stt: boolean
  /** The Windows voice host exited. */
  wintts: boolean
  /** What the client should release on its side: 'highlighter' = terminate the shiki worker (rebuilt on demand). */
  clientHints: 'highlighter'[]
}

export type EndpointKey = keyof Endpoints
export type EndpointRes<K extends EndpointKey> = Endpoints[K]['res']
export type EndpointBody<K extends EndpointKey> = Endpoints[K] extends { body: infer B } ? B : never
export type EndpointQuery<K extends EndpointKey> = Endpoints[K] extends { query: infer Q } ? Q : never

export interface ErrorBody {
  error: ApiError
}
