/**
 * Domain types shared by server and web client (03-DATA-AND-API + 07-AMENDMENTS). Changes go through the
 * orchestrator; additive changes are noted in 07.
 */

export type Role = 'user' | 'assistant'
/** The role tags the owner asked for (R7). */
export type RoleTag = 'user response' | 'ai response'
export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error'
export type MemoryMode = 'inherit' | 'on' | 'off'
export type MemoryScope = 'this' | 'linked' | 'all'
export type ToolMode = 'native' | 'text'

export interface AttachmentRef {
  sha: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'pdf' | 'docx' | 'text' | 'other'
  width?: number
  height?: number
  /** Characters of extracted text (pdf/docx/text), when extraction succeeded. */
  textChars?: number
  /**
   * Text extraction outcome for pdf/docx/text (absent for images): 'truncated' = capped at
   * `chat.attachments.maxTextChars`; 'failed' = timeout, crash, refused archive or unreadable file (the bytes are kept).
   */
  textState?: 'ok' | 'truncated' | 'failed'
}

export interface Message {
  uid: string
  sessionUid: string
  seq: number
  role: Role
  tag: RoleTag
  /** Clean text (markdown) shown in the UI; no hidden tags. Empty for tombstones. */
  body: string
  /** PC clock, UTC ms (07 C2). */
  tsUtc: number
  /** Sender device's zone at send time (AI replies inherit the user turn's zone). */
  tzOffsetMin: number
  tzName: string | null
  device: string | null
  status: MessageStatus
  error?: { code: string; message: string }
  provider?: string
  model?: string
  usage?: Usage
  attachments: AttachmentRef[]
  /** Present when other versions exist at this seq (edit/regenerate). */
  variant?: { index: number; count: number }
  /** Hidden system-made user turns (e.g. the /continue opener) — not rendered in the timeline. */
  hidden?: boolean
  deleted?: boolean
  /** Voice: characters actually spoken before an interruption (07 C15). */
  spokenChars?: number | null
  interrupted?: boolean
  /** Recalled memories used for this AI reply (the "Remembered" chip). */
  recalled?: number
  /** The AI reply stopped at the model's output limit (finish_reason length / max_tokens; Phase 4c, additive). */
  truncated?: boolean
}

export interface Usage {
  in?: number
  out?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface SessionSummary {
  uid: string
  shortId: string
  title: string
  createdUtc: number
  updatedUtc: number
  lastMessageUtc: number | null
  lastSeq: number
  messageCount: number
  pinned: boolean
  archived: boolean
  private: boolean
  temporary: boolean
  hasPrompt: boolean
  linkCount: number
  memory: MemoryMode
  deletedUtc?: number | null
  /** Short LLM-written summary (07 C13), when available. */
  summary?: string | null
  /** Created by an import (07 A4): where it came from. memory-ui (Phase 3), additive. */
  imported?: 'vesper' | 'chatgpt' | 'claude' | null
}

export interface Session extends SessionSummary {
  systemPrompt: string
  promptId: number | null
  memoryScope: MemoryScope | 'inherit'
  llmProfile: string | null
  model: string | null
  voice: SessionVoice | null
  toolMode: ToolMode | null
  /** Outgoing links: sessions this one may recall. */
  links: SessionLink[]
  /** Incoming: sessions that may recall this one. */
  linkedFrom: SessionLink[]
  meta: { continuedIn?: string; continuedFrom?: string; backfill?: 'all' | 'new' | 'none' }
  epoch: { id: number; startSeq: number; hasRecap: boolean } | null
  /**
   * Token totals of this session's AI replies (sum of `messages.usage`), for the session panel's info section.
   * Optional (sessions-ui, additive): the panel shows "—" until the server fills it.
   */
  tokens?: { in: number; out: number; cacheRead?: number } | null
}

export interface SessionVoice {
  provider: string
  voiceId: string
  model?: string
}

export interface SessionLink {
  uid: string
  shortId: string
  title: string
  createdUtc: number
}

export interface Variant {
  branchId: number
  index: number
  createdUtc: number
  preview: string
  reason: 'root' | 'edit' | 'regenerate'
  active: boolean
}

export interface MessagePage {
  items: Message[]
  loSeq: number
  hiSeq: number
  lastSeq: number
  hasBefore: boolean
  hasAfter: boolean
}

export interface TimelineSample {
  seq: number
  tsUtc: number
}

export interface SearchHit {
  message: Message
  session: Pick<SessionSummary, 'uid' | 'shortId' | 'title'>
  /** Snippet with «…» marking matched text (rendered as plain text + highlight). */
  snippet: string
  onPath: boolean
  score?: number
}

/** One row of the memory viewer's timeline (GET /api/memory/timeline, R7). memory-ui (Phase 3), additive. */
export interface TimelineEntry {
  message: Message
  session: Pick<SessionSummary, 'uid' | 'shortId' | 'title' | 'private'>
}

/** Disk use of Vesper's data (GET /api/data/usage, Settings → Data). Bytes; null = unknown. memory-ui (Phase 3). */
export interface DataUsage {
  database: number
  /** The write-ahead log next to the database (folded in at idle). */
  wal: number
  attachments: number
  attachmentCount: number
  backups: number
  backupCount: number
  exports: number
  /** Speech models and other downloads (%LOCALAPPDATA%). */
  models: number
  logs: number
  /** Free space on the drive holding the database, when known. */
  freeDisk: number | null
}

export interface MemoryHit {
  messageUid: string
  sessionUid: string
  shortId: string
  sessionTitle: string
  tag: RoleTag
  body: string
  tsUtc: number
  tzOffsetMin: number
  tzName: string | null
  score: number
}

export type MemoryStatusState = 'disabled' | 'keyword-only' | 'loading' | 'ready' | 'degraded' | 'error'

export interface MemoryStatus {
  state: MemoryStatusState
  model: string | null
  dim: number | null
  indexed: number
  queued: number
  errors: number
  tier: 'free' | 'tier1' | 'tier2' | 'tier3' | 'unknown'
  queueEtaSec: number | null
  lastError?: { code: string; message: string; atUtc: number }
  /** Voyage requests in the current 60 s window (07 C11). */
  rpmUsed?: number
  /** A re-index (new generation, 07 C10) in progress: embedded / total messages of the new generation. */
  reindex?: { gen: number; done: number; total: number } | null
}

export interface Prompt {
  id: number
  name: string
  body: string
  createdUtc: number
  updatedUtc: number
}

export interface Fact {
  id: number
  text: string
  createdUtc: number
  updatedUtc: number
}

export type DeviceKind = 'desktop' | 'browser' | 'paired'
export type Listener = 'loopback' | 'lan' | 'tailnet'

export interface DeviceInfo {
  id: string
  name: string
  kind: DeviceKind
  listener: Listener
  createdUtc: number
  lastSeenUtc: number | null
  lastIp: string | null
  userAgent: string | null
  current: boolean
  pending: boolean
  revokedUtc: number | null
}

export type AccessMode = 'local' | 'lan' | 'tailscale'

export interface NetworkStatus {
  mode: AccessMode
  loopback: { port: number; url: string; browserUrl: string }
  lan: null | {
    address: string | null
    port: number
    url: string | null
    certFingerprint: string | null
    firewall: 'allowed' | 'blocked' | 'unknown' | 'not-needed'
    profile: 'public' | 'private' | 'domain' | 'unknown'
    /** Listener B is bound and serving (access-server). */
    running?: boolean
    /** Every address a LAN device can use (IP first, then <hostname>.local). */
    urls?: string[]
    /** QR code (SVG markup) of `url`, for the Access page. */
    qrSvg?: string | null
    certExpiresUtc?: number | null
  }
  tailscale: null | {
    installed: boolean
    running: boolean
    signedIn: boolean
    dnsName: string | null
    serving: boolean
    funnel: boolean
    url: string | null
    version?: string | null
    /** HTTPS certificates are enabled for the tailnet (needed by `tailscale serve --https`). */
    httpsEnabled?: boolean
    /** When the Funnel auto-off timer turns public access off (07 B14). */
    funnelUntilUtc?: number | null
    /** Listener C's port while it runs. */
    listenerPort?: number | null
    /** Tailscale asked the owner to approve Funnel/HTTPS in its admin console (open this URL on the PC). */
    consentUrl?: string | null
  }
  passwordSet: boolean
  portable: boolean
  capabilities: { mic: boolean; install: boolean; warningFree: boolean }
  /** Non-loopback IPv4 interfaces for the LAN address picker (the default-route one is `recommended`). */
  interfaces?: NetworkInterfaceInfo[]
  remote?: { paused: boolean; loginSuspended: boolean }
  warnings?: NetworkWarning[]
}

export interface NetworkInterfaceInfo {
  address: string
  name: string
  recommended: boolean
}

export type NetworkWarningCode =
  | 'password_required'
  | 'portable'
  | 'lan_address_missing'
  | 'port_unavailable'
  | 'cert_failed'
  | 'firewall_blocked'
  | 'firewall_unknown'
  | 'network_public'
  | 'tailscale_missing'
  | 'tailscale_stopped'
  | 'tailscale_signed_out'
  | 'tailscale_https_off'
  | 'tailscale_failed'
  | 'tailscale_consent'
  | 'funnel_public'
  | 'remote_paused'
  | 'login_suspended'

/** A plain-words problem with the current access setup (the Access page shows `message`). */
export interface NetworkWarning {
  code: NetworkWarningCode
  message: string
}

export interface ModelInfo {
  id: string
  label?: string
  contextWindow?: number | null
  maxOutput?: number | null
  caps?: { tools?: boolean; vision?: boolean; pdf?: boolean; reasoning?: boolean }
  /** TTS (07 C22): relative price per character (ElevenLabs `character_cost_multiplier`; 1 = the base price). */
  costMultiplier?: number
  /** TTS: reads inline `[audio tags]` for tone (ElevenLabs v3/v4). */
  audioTags?: boolean
  /** TTS: a low-latency model (Talk mode "fast voice", 07 D6). */
  fast?: boolean
  /** TTS: maximum characters per request. */
  maxChars?: number
}

export interface Voice {
  id: string
  name: string
  provider: string
  category?: string
  language?: string
  gender?: string
  description?: string
  previewable: boolean
}

export interface ProviderTestResult {
  ok: boolean
  kind?: 'auth' | 'url' | 'network' | 'quota' | 'model' | 'rate' | 'permission' | 'unknown'
  message: string
  detail?: string
  upstreamStatus?: number
  models?: ModelInfo[]
  voices?: Voice[]
  quota?: { used: number; limit: number; resetUtc?: number }
}

export type ReplyState =
  | 'queued'
  | 'thinking'
  | 'recalling'
  | 'writing'
  | 'summarizing'
  | 'recapping'
  | 'preparing-voice'
  | 'speaking'
  | 'done'
  | 'stopped'
  | 'error'

export interface InflightReply {
  replyId: string
  messageUid: string
  state: ReplyState
  text: string
  speakingDeviceId: string | null
}
