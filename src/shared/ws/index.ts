/**
 * WebSocket protocol v1 (03 §4 + 07 C16/C21). One socket per client at /ws. JSON text frames for events; binary
 * frames for audio (see ./binary.ts). Client requests carry `id` and are answered with `ack` (or an error with the same
 * id). Every session-scoped server event carries `evSeq` (monotonic per session) so a reconnecting client can resume.
 */
import type { ApiError } from '../errors'
import type { InflightReply, Message, ReplyState, SessionSummary, Voice, ModelInfo, MemoryStatus, NetworkStatus } from '../types/domain'
import type { PublicSettings } from '../settings'

export const WS_PROTOCOL = 1
export const WS_PATH = '/ws'
export const WS_CLOSE = { auth: 4401, protocol: 4409, rate: 4429, replaced: 4410 } as const

export interface ClientState {
  visible: boolean
  focused: boolean
  audioUnlocked: boolean
}

// ── Client → server ───────────────────────────────────────────────────────────────────────────
export type ClientMsg =
  | { t: 'hello'; protocol: number; tz: string | null; tzOffset: number; client: ClientState; deviceName?: string }
  | { t: 'client.state'; client: ClientState }
  | { t: 'subscribe'; id?: string; sessionUid: string; sinceEvSeq?: number }
  | { t: 'unsubscribe'; sessionUid: string }
  | {
      t: 'chat.send'
      id: string
      sessionUid: string
      text: string
      /** Attachment SHA-256s (uploaded first via REST). */
      attachments: string[]
      client: { ts: number; tzOffset: number; tzName: string | null }
      speak: boolean
      interrupt?: boolean
      /** Sent from Talk mode: the reply uses the fast voice model and the Talk-mode budgets (07 D6). */
      talk?: boolean
      /**
       * Client-made id of this message, the same on every resend (Phase 4c, additive): a send the server already took
       * is answered with its original ack and never makes a second turn (a lost ack on a dropped socket).
       */
      clientMsgId?: string
    }
  | { t: 'chat.stop'; id?: string; sessionUid: string }
  | { t: 'chat.regenerate'; id: string; sessionUid: string; messageUid: string; speak: boolean; client: { ts: number; tzOffset: number; tzName: string | null } }
  | { t: 'chat.edit'; id: string; sessionUid: string; messageUid: string; text: string; attachments: string[]; speak: boolean; client: { ts: number; tzOffset: number; tzName: string | null } }
  | { t: 'speech.replay'; id?: string; messageUid: string }
  | { t: 'speech.played'; replyId: string; index: number; revealedChars: number }
  /**
   * Barge-in (07 C15). `beforeAudio` (additive, F31): this client had not started playing the reply's audio; if nobody
   * else can have heard it, the server stops speech but lets the reply finish as text (no interruption recorded).
   */
  | { t: 'speech.cancel'; replyId: string; spokenChars?: number; beforeAudio?: boolean }
  /**
   * This client gave up waiting for a reply's audio (07 C14 client-side 6 s rule): send it the text now (a targeted
   * `reply.snapshot`, then deltas) and no more audio. Speech continues for any other speaking device (additive).
   */
  | { t: 'speech.textFirst'; replyId: string }
  | { t: 'stt.start'; id: string; sessionUid: string | null; mode: 'dictate' | 'ptt' | 'conversation'; sampleRate: 16000; ttsActive: boolean }
  | { t: 'stt.tts-active'; active: boolean }
  | { t: 'stt.stop'; reason?: 'released' | 'send' }
  | { t: 'stt.cancel' }
  /** Load the speech model ahead of the first utterance (07 D6: Talk mode opened, mic armed or hovered). */
  | { t: 'stt.prewarm' }
  | { t: 'pong'; ts: number }
  /** Talk mode opened: warm the TTS provider (wintts host, HTTP keep-alive) so the first reply speaks fast (07 D6). */
  | { t: 'tts.prewarm' }

// ── Server → client ───────────────────────────────────────────────────────────────────────────
/** Events that belong to a session carry these. */
export interface SessionEvent {
  sessionUid: string
  evSeq: number
}

export type ServerMsg =
  /** `bootId` changes on every server start: clients then drop their sinceEvSeq values (evSeq restarts). */
  /** `clientId` (additive, fix5-client P22): this socket's own id, so the tab can name itself (e.g. the /continue speaker). */
  | { t: 'ready'; protocol: number; serverTime: number; deviceId: string; bootId: string; clientId?: string }
  | { t: 'ping'; ts: number }
  | { t: 'ack'; id: string; replyId?: string; messageUid?: string }
  | { t: 'error'; id?: string; error: ApiError }
  | { t: 'subscribed'; sessionUid: string; evSeq: number; inflight: InflightReply[]; replayed: number }
  | ({ t: 'message.created'; message: Message; lastSeq: number } & SessionEvent)
  | ({ t: 'message.updated'; message: Message } & SessionEvent)
  | ({ t: 'message.deleted'; messageUid: string } & SessionEvent)
  | ({ t: 'reply.status'; replyId: string; messageUid: string; state: ReplyState; detail?: string } & SessionEvent)
  | ({ t: 'reply.delta'; replyId: string; text: string } & SessionEvent)
  | ({ t: 'reply.reasoning'; replyId: string; text: string } & SessionEvent)
  | ({ t: 'reply.tool'; replyId: string; kind: 'search' | 'recall' | 'sessions' | 'auto'; query: string; count: number; sessions: string[] } & SessionEvent)
  | ({ t: 'reply.snapshot'; reply: InflightReply } & SessionEvent)
  | ({ t: 'reply.done'; replyId: string; message: Message } & SessionEvent)
  | ({ t: 'reply.error'; replyId: string | null; error: ApiError } & SessionEvent)
  | ({ t: 'reply.timing'; replyId: string; marks: Record<string, number> } & SessionEvent)
  | ({ t: 'speech.end'; replyId: string } & SessionEvent)
  | ({ t: 'speech.error'; replyId: string; index: number; error: ApiError } & SessionEvent)
  | ({ t: 'speech.degraded'; replyId: string; reason: 'backpressure' | 'speaker-left' } & SessionEvent)
  /**
   * Synthesis of the reply's first chunk started (sent to the speaking clients only, additive, F32). The client's 6 s
   * first-chunk deadline (07 C14) counts from here: before it the server is legitimately holding speech back (07 A2
   * waitForTone / 'end' placement, a first sentence still being written, a memory tool round).
   */
  | ({ t: 'speech.preparing'; replyId: string; index: number } & SessionEvent)
  /**
   * A device interrupted the reply's voice (speech.cancel, 07 C15/C16): every other device stops its audio too and
   * freezes the reveal where it is (additive).
   */
  | ({ t: 'speech.stopped'; replyId: string } & SessionEvent)
  | ({ t: 'session.updated'; session: SessionSummary } & SessionEvent)
  | ({ t: 'session.path_changed'; forkSeq: number; lastSeq: number } & SessionEvent)
  | ({ t: 'epoch.created'; epochId: number; startSeq: number } & SessionEvent)
  | { t: 'session.deleted'; sessionUid: string }
  | { t: 'session.ended'; sessionUid: string }
  | { t: 'sessions.changed' }
  | { t: 'stt.state'; state: 'warming-up' | 'listening' | 'transcribing' | 'idle' | 'error'; error?: ApiError }
  /** `endpointInMs` (with speaking:false, not in push-to-talk): time left until the utterance ends by itself (countdown ring). */
  | { t: 'stt.vad'; speaking: boolean; level?: number; endpointInMs?: number }
  | { t: 'stt.partial'; text: string }
  | { t: 'stt.final'; text: string; autoSend: boolean; durationMs: number }
  | { t: 'stt.model.progress'; id: string; bytes: number; total: number; state: 'downloading' | 'verifying' | 'extracting' | 'ready' | 'error'; error?: ApiError }
  | { t: 'tts.voices'; provider: string; voices: Voice[]; models: ModelInfo[]; quota?: { used: number; limit: number } }
  | { t: 'memory.progress'; status: MemoryStatus }
  | { t: 'settings.changed'; settings: PublicSettings }
  | { t: 'device.pending'; deviceId: string; name: string; ip: string | null }
  /** The device list changed (login, pairing, approval, revoke, logout); refetch GET /api/auth/devices. */
  | { t: 'devices.changed' }
  /** Access state changed (listeners, Tailscale, firewall, pause, warnings). */
  | { t: 'network.changed'; network: NetworkStatus }
  /** `deviceId`: a sign-in/pairing alert the desktop can answer with one-click Revoke (07 B16). */
  | { t: 'notify'; title: string; body: string; sessionUid?: string; deviceId?: string }
  | { t: 'toast'; tone: 'info' | 'success' | 'warning' | 'error'; text: string }
  /** Game mode turned on/off (07 D3): the Star goes static, voice models unload, backfill pauses, notifications wait. */
  | { t: 'gamemode.changed'; active: boolean; reason: GameModeReason }
  /**
   * The global push-to-talk hotkey (07 D6, opt-in) was pressed, sent to the focused (else last used) desktop client.
   * Electron reports key presses only, so the hotkey toggles: `down` alternates true/false per press (platform-int).
   */
  | { t: 'hotkey.ptt'; down: boolean }
  /** The prompt library changed (any device): refetch GET /api/prompts. */
  | { t: 'prompts.changed' }
  /** SystemHealth changed (settings recovered, low disk, a backup failed or worked again) — fix-platform, additive. */
  | { t: 'health.changed'; health: import('../api').SystemHealth }
  /** Progress of a bulk data job (export / import / backup), sent to the requesting device only. */
  | { t: 'job.progress'; job: 'export' | 'import' | 'backup'; phase: string; done: number; total: number | null }
  /** The updater's state changed (H-v12-updates, additive): the same shape as GET /api/system/update. */
  | ({ t: 'update.state' } & import('../api').UpdateStatus)

/** Why game mode is on: the user forced it, or auto-detection saw a fullscreen/D3D app in front (07 D3, §F S8). */
export type GameModeReason = 'off' | 'forced' | 'fullscreen' | 'd3d' | 'busy'

export type ServerMsgType = ServerMsg['t']
export type ClientMsgType = ClientMsg['t']

/** Session events are kept in a per-session ring (07 C16) for resume. */
export const EVENT_RING_SIZE = 512
export const PING_INTERVAL_MS = 20_000
/** Above this many buffered bytes, audio to that socket stops and the reply degrades to text (07 C16). */
export const AUDIO_BACKPRESSURE_BYTES = 1024 * 1024

export * from './binary'
